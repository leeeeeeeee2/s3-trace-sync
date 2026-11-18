import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureSecureDir } from "./config.mjs";
import { buildTraceObjectKey, renderPathTemplate, S3TraceClient } from "./s3.mjs";

const MAX_CACHE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RETRY_QUEUE = 128;

function parseTimeMs(trace) {
  const t = Date.parse(trace.endTime || trace.timestamp || trace.startTime || "");
  return Number.isFinite(t) ? t : 0;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function extractSearchText(trace) {
  const parts = [
    trace.id,
    trace.name,
    trace.title,
    trace.sessionId,
    trace.userId,
    trace.model,
    trace.requestedModel,
    trace.servedModel,
    trace.provider,
    trace.agent,
    trace.apiKeyName,
    trace.finishReason,
    trace.s3Sync?.key,
  ];
  if (trace.input) {
    if (trace.input.system) parts.push(trace.input.system);
    if (Array.isArray(trace.input.messages)) {
      for (const m of trace.input.messages) {
        if (m?.content) parts.push(m.content);
        if (Array.isArray(m?.tool_calls)) {
          for (const tc of m.tool_calls) parts.push(tc?.name);
        }
      }
    }
  }
  if (trace.output && Array.isArray(trace.output.messages)) {
    for (const m of trace.output.messages) {
      if (m?.content) parts.push(m.content);
      if (m?.reasoning) parts.push(m.reasoning);
      if (Array.isArray(m?.tool_calls)) {
        for (const tc of m.tool_calls) parts.push(tc?.name);
      }
    }
  }
  return parts.filter(Boolean).join("\n").toLowerCase();
}

function summarizeTrace(trace) {
  const firstUserMsg =
    trace.title ||
    trace.input?.messages?.find((m) => m.role === "user" && m.content?.trim())?.content?.trim()?.slice(0, 140) ||
    "";
  const lastAssistantMsg =
    trace.output?.messages?.find((m) => m.role === "assistant" && m.content?.trim())?.content?.trim()?.slice(0, 140) ||
    "";

  return {
    id: trace.id,
    name: trace.name,
    title: firstUserMsg,
    previewCompletion: lastAssistantMsg,
    timestamp: trace.timestamp || trace.endTime,
    startTime: trace.startTime,
    endTime: trace.endTime,
    sessionId: trace.sessionId || null,
    userId: trace.userId || null,
    apiKeyName: trace.apiKeyName || trace.gatewayKey || "local",
    origin: trace.origin || "local",
    agent: trace.agent || "unknown",
    protocol: trace.protocol || "chat",
    stream: Boolean(trace.stream),
    status: trace.status || "completed",
    httpStatus: trace.httpStatus ?? 200,
    model: trace.model,
    requestedModel: trace.requestedModel || trace.model,
    servedModel: trace.servedModel || trace.model,
    provider: trace.provider || "unknown",
    finishReason: trace.finishReason || null,
    latencyMs: trace.latencyMs ?? null,
    ttftMs: trace.ttftMs ?? null,
    usage: trace.usage || {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      promptTokensDetails: { cachedTokens: 0, cacheWriteTokens: 0 },
      completionTokensDetails: { reasoningTokens: 0 },
      totalCost: null,
    },
    privacyMode: Boolean(trace.privacyMode),
    inputOutputLogging: Boolean(trace.inputOutputLogging),
    toolCallsCount: trace.metadata?.toolCallsCount || 0,
    attemptCount: trace.routerTiming?.attempt_count ?? 1,
    s3Sync: trace.s3Sync || { state: "unknown" },
  };
}

function resolveRangeBounds(filters = {}, nowMs = Date.now()) {
  if (Number.isFinite(Number(filters.sinceMs)) && Number(filters.sinceMs) > 0) {
    return {
      sinceMs: Number(filters.sinceMs),
      untilMs: Number.isFinite(Number(filters.untilMs)) ? Number(filters.untilMs) : nowMs,
    };
  }
  const range = String(filters.range || "7d").toLowerCase();
  const spans = {
    "1h": 3600 * 1000,
    "24h": 24 * 3600 * 1000,
    "7d": 7 * 24 * 3600 * 1000,
    "30d": 30 * 24 * 3600 * 1000,
    "90d": 90 * 24 * 3600 * 1000,
  };
  if (range === "all" || !spans[range]) {
    return { sinceMs: 0, untilMs: nowMs };
  }
  return { sinceMs: nowMs - spans[range], untilMs: nowMs };
}

function csvCell(value) {
  let str = value === null || value === undefined ? "" : String(value);
  // Mitigate spreadsheet formula injection when opened in Excel / Google Sheets.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export class TraceStore {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.tracesById = new Map(); // id -> trace
    this.diskState = { file: "", mtimeMs: -1, lineCount: 0 };
    this.batchBuffer = [];
    this.batchTimer = null;
    this.lastBatchConfig = null;
    this.retryQueue = [];
    this.retryTimer = null;
    this.recentKeySeq = new Map(); // baseKey -> { atMs, seq } to avoid R2 10058 1 write/s/key collisions
    this.stats = {
      captured: 0,
      synced: 0,
      failed: 0,
      retried: 0,
      batchesSent: 0,
      lastSyncAt: null,
      lastError: null,
    };
  }

  allocateUniqueObjectKey(config, meta) {
    const baseKey = buildTraceObjectKey(config, meta);
    const now = Date.now();
    // Prune stale entries older than 2 seconds.
    for (const [k, entry] of this.recentKeySeq) {
      if (now - entry.atMs > 2000) this.recentKeySeq.delete(k);
    }
    const prev = this.recentKeySeq.get(baseKey);
    if (!prev) {
      this.recentKeySeq.set(baseKey, { atMs: now, seq: 0 });
      return baseKey;
    }
    const nextSeq = prev.seq + 1;
    this.recentKeySeq.set(baseKey, { atMs: now, seq: nextSeq });
    return buildTraceObjectKey(config, { ...meta, tiebreaker: String(nextSeq) });
  }

  setFetchImpl(fn) {
    this.fetchImpl = fn;
  }

  cacheFilePath(config) {
    return path.join(config.stateDir, "recent-traces.jsonl");
  }

  async syncWithDiskCache(config) {
    if (!config?.localCache || !config?.stateDir) return;
    const file = this.cacheFilePath(config);
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile()) return;
      if (this.diskState.file === file && this.diskState.mtimeMs === stat.mtimeMs) return;

      const raw = await fsp.readFile(file, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && typeof parsed.id === "string") {
            const existing = this.tracesById.get(parsed.id);
            // Prefer synced state if one copy has finished uploading.
            if (!existing || (parsed.s3Sync?.state === "synced" && existing.s3Sync?.state !== "synced")) {
              this.tracesById.set(parsed.id, parsed);
            }
          }
        } catch {
          // Ignore malformed tail lines.
        }
      }
      this.trimMemory(config.maxLocalTraces);
      this.diskState = { file, mtimeMs: stat.mtimeMs, lineCount: lines.length };
    } catch (err) {
      if (err?.code !== "ENOENT") {
        // Non-fatal: in-memory store still operates.
      }
    }
  }

  trimMemory(maxTraces = 500) {
    if (this.tracesById.size <= maxTraces) return;
    const sorted = [...this.tracesById.values()].sort((a, b) => parseTimeMs(a) - parseTimeMs(b));
    const toRemove = sorted.length - maxTraces;
    for (let i = 0; i < toRemove; i++) {
      this.tracesById.delete(sorted[i].id);
    }
  }

  async persistTraceToDisk(trace, config) {
    if (!config?.localCache || !config?.stateDir) return;
    try {
      await ensureSecureDir(config.stateDir);
      const file = this.cacheFilePath(config);
      const line = JSON.stringify(trace) + "\n";
      await fsp.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
      this.diskState.lineCount += 1;

      const stat = await fsp.stat(file);
      this.diskState.file = file;
      this.diskState.mtimeMs = stat.mtimeMs;

      if (
        this.diskState.lineCount > Math.ceil(config.maxLocalTraces * 1.5) ||
        stat.size > MAX_CACHE_FILE_BYTES
      ) {
        await this.compactDiskCache(config);
      }
    } catch {
      // Never fail request observation due to local disk cache issues.
    }
  }

  async compactDiskCache(config) {
    if (!config?.localCache || !config?.stateDir) return;
    const file = this.cacheFilePath(config);
    this.trimMemory(config.maxLocalTraces);
    const ordered = [...this.tracesById.values()].sort((a, b) => parseTimeMs(a) - parseTimeMs(b));
    const content = ordered.map((t) => JSON.stringify(t)).join("\n") + (ordered.length ? "\n" : "");
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(tmp, file);
    const stat = await fsp.stat(file);
    this.diskState = { file, mtimeMs: stat.mtimeMs, lineCount: ordered.length };
  }

  async clearLocalCache(config) {
    this.tracesById.clear();
    this.batchBuffer.length = 0;
    this.retryQueue.length = 0;
    if (config?.stateDir) {
      const file = this.cacheFilePath(config);
      await fsp.rm(file, { force: true }).catch(() => {});
      this.diskState = { file: "", mtimeMs: -1, lineCount: 0 };
    }
  }

  upsertInMemory(trace, maxTraces = 500) {
    this.tracesById.delete(trace.id);
    this.tracesById.set(trace.id, trace);
    this.trimMemory(maxTraces);
  }

  /**
   * Record a trace in memory/disk and export it to S3 according to config (single or batch).
   */
  async recordAndSync(trace, config, { signal } = {}) {
    this.stats.captured += 1;
    await this.syncWithDiskCache(config);

    if (!config.s3Configured) {
      trace.s3Sync = {
        state: "local_only",
        reason: "s3_not_configured",
        updatedAt: new Date().toISOString(),
      };
      this.upsertInMemory(trace, config.maxLocalTraces);
      await this.persistTraceToDisk(trace, config);
      return trace;
    }

    if (config.exportMode === "batch") {
      trace.s3Sync = {
        state: "queued_batch",
        updatedAt: new Date().toISOString(),
      };
      this.upsertInMemory(trace, config.maxLocalTraces);
      this.lastBatchConfig = config;
      this.batchBuffer.push(trace);

      if (this.batchBuffer.length >= config.batchMaxItems) {
        await this.flushBatch(config, { signal });
      } else {
        this.scheduleBatchTimer(config);
        await this.persistTraceToDisk(trace, config);
      }
      return trace;
    }

    // Single-trace S3 Broadcast mode: {pathTemplate}/{traceId}-{timestamp}.json
    const tsMs = parseTimeMs(trace) || Date.now();
    const objectKey = this.allocateUniqueObjectKey(config, {
      timestampMs: tsMs,
      traceId: trace.id,
      apiKeyName: trace.apiKeyName,
      agent: trace.agent,
      provider: trace.provider,
      model: trace.servedModel || trace.model,
      sessionId: trace.sessionId,
      origin: trace.origin,
    });

    const client = new S3TraceClient(config, this.fetchImpl);
    try {
      const s3Payload = { ...trace };
      delete s3Payload.s3Sync;
      const res = await client.putJson(objectKey, s3Payload, { signal });
      const nowIso = new Date().toISOString();
      trace.s3Sync = {
        state: "synced",
        key: objectKey,
        bucket: config.bucket,
        provider: config.provider,
        bytes: res.bytes,
        etag: res.etag,
        latencyMs: res.latencyMs,
        syncedAt: nowIso,
      };
      this.stats.synced += 1;
      this.stats.lastSyncAt = nowIso;
      this.stats.lastError = null;
    } catch (err) {
      const errMsg = err?.message || String(err);
      this.stats.lastError = errMsg;
      if (err?.retriable !== false && !signal?.aborted) {
        trace.s3Sync = {
          state: "retrying",
          key: objectKey,
          bucket: config.bucket,
          provider: config.provider,
          error: errMsg,
          r2Code: err?.r2Code ?? null,
          hint: err?.r2Hint || "",
          attempts: 1,
          updatedAt: new Date().toISOString(),
        };
        this.enqueueRetry(trace, objectKey, config, err?.retryAfterMs || 1500);
      } else {
        this.stats.failed += 1;
        trace.s3Sync = {
          state: "failed",
          key: objectKey,
          bucket: config.bucket,
          provider: config.provider,
          error: errMsg,
          r2Code: err?.r2Code ?? null,
          hint: err?.r2Hint || "",
          updatedAt: new Date().toISOString(),
        };
      }
    }

    this.upsertInMemory(trace, config.maxLocalTraces);
    await this.persistTraceToDisk(trace, config);
    return trace;
  }

  scheduleBatchTimer(config) {
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch(this.lastBatchConfig || config).catch(() => {});
    }, config.batchFlushIntervalMs);
    this.batchTimer.unref?.();
  }

  async flushBatch(config = this.lastBatchConfig, { signal } = {}) {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (!this.batchBuffer.length || !config?.s3Configured) {
      return { flushed: 0 };
    }

    const items = this.batchBuffer.splice(0, config.batchMaxItems || 100);
    const tsMs = Date.now();
    const objectKey = this.allocateUniqueObjectKey(config, {
      timestampMs: tsMs,
      isBatch: true,
      batchId: String(this.stats.batchesSent + 1),
    });

    const cleanTraces = items.map((t) => {
      const copy = { ...t };
      delete copy.s3Sync;
      return copy;
    });

    const batchPayload = {
      schema: "openrouter.broadcast.s3.batch.v1",
      exportedAt: new Date(tsMs).toISOString(),
      count: cleanTraces.length,
      traces: cleanTraces,
    };

    const client = new S3TraceClient(config, this.fetchImpl);
    try {
      const res = await client.putJson(objectKey, batchPayload, { signal });
      const nowIso = new Date().toISOString();
      this.stats.batchesSent += 1;
      this.stats.synced += items.length;
      this.stats.lastSyncAt = nowIso;
      this.stats.lastError = null;
      for (const item of items) {
        item.s3Sync = {
          state: "synced",
          mode: "batch",
          key: objectKey,
          bucket: config.bucket,
          provider: config.provider,
          bytes: res.bytes,
          etag: res.etag,
          latencyMs: res.latencyMs,
          syncedAt: nowIso,
        };
        this.upsertInMemory(item, config.maxLocalTraces);
        await this.persistTraceToDisk(item, config);
      }
      return { flushed: items.length, key: objectKey, ok: true };
    } catch (err) {
      const errMsg = err?.message || String(err);
      this.stats.failed += items.length;
      this.stats.lastError = errMsg;
      for (const item of items) {
        item.s3Sync = {
          state: "failed",
          mode: "batch",
          key: objectKey,
          bucket: config.bucket,
          provider: config.provider,
          error: errMsg,
          r2Code: err?.r2Code ?? null,
          hint: err?.r2Hint || "",
          updatedAt: new Date().toISOString(),
        };
        this.upsertInMemory(item, config.maxLocalTraces);
        await this.persistTraceToDisk(item, config);
      }
      return { flushed: 0, key: objectKey, ok: false, error: errMsg, r2Code: err?.r2Code ?? null, hint: err?.r2Hint || "" };
    }
  }

  enqueueRetry(trace, objectKey, config, delayMs = 1500) {
    if (this.retryQueue.length >= MAX_RETRY_QUEUE) {
      this.retryQueue.shift();
    }
    this.retryQueue.push({
      trace,
      objectKey,
      config,
      attempts: 1,
      nextAt: Date.now() + Math.max(1100, delayMs),
    });
    this.scheduleRetryWorker();
  }

  scheduleRetryWorker() {
    if (this.retryTimer || this.retryQueue.length === 0) return;
    const earliest = Math.min(...this.retryQueue.map((j) => j.nextAt));
    const waitMs = Math.max(200, earliest - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.processRetryQueue().catch(() => {});
    }, waitMs);
    this.retryTimer.unref?.();
  }

  async processRetryQueue() {
    const now = Date.now();
    const remaining = [];
    for (const job of this.retryQueue.splice(0)) {
      if (job.nextAt > now) {
        remaining.push(job);
        continue;
      }
      const client = new S3TraceClient(job.config, this.fetchImpl);
      try {
        const s3Payload = { ...job.trace };
        delete s3Payload.s3Sync;
        const res = await client.putJson(job.objectKey, s3Payload);
        const nowIso = new Date().toISOString();
        job.trace.s3Sync = {
          state: "synced",
          key: job.objectKey,
          bucket: job.config.bucket,
          provider: job.config.provider,
          bytes: res.bytes,
          etag: res.etag,
          latencyMs: res.latencyMs,
          syncedAt: nowIso,
          attempts: job.attempts + 1,
        };
        this.stats.retried += 1;
        this.stats.synced += 1;
        this.stats.lastSyncAt = nowIso;
        this.stats.lastError = null;
        this.upsertInMemory(job.trace, job.config.maxLocalTraces);
        await this.persistTraceToDisk(job.trace, job.config);
      } catch (err) {
        job.attempts += 1;
        const errMsg = err?.message || String(err);
        this.stats.lastError = errMsg;
        if (err?.retriable !== false && job.attempts < 3) {
          const backoff = Math.max(err?.retryAfterMs || 0, job.attempts * 3000);
          job.nextAt = Date.now() + backoff;
          remaining.push(job);
        } else {
          this.stats.failed += 1;
          job.trace.s3Sync = {
            state: "failed",
            key: job.objectKey,
            bucket: job.config.bucket,
            provider: job.config.provider,
            error: errMsg,
            r2Code: err?.r2Code ?? null,
            hint: err?.r2Hint || "",
            attempts: job.attempts,
            updatedAt: new Date().toISOString(),
          };
          this.upsertInMemory(job.trace, job.config.maxLocalTraces);
          await this.persistTraceToDisk(job.trace, job.config);
        }
      }
    }
    this.retryQueue.push(...remaining);
    if (this.retryQueue.length > 0) {
      this.scheduleRetryWorker();
    }
  }

  /**
   * Manually push/retry a stored local or failed trace to the configured S3/R2 bucket.
   */
  async pushTrace(config, traceId, { signal } = {}) {
    if (!config.s3Configured) {
      throw new Error("Cloudflare R2 / S3 destination is not configured yet.");
    }
    await this.syncWithDiskCache(config);
    const trace = this.tracesById.get(traceId);
    if (!trace) {
      throw new Error(`Trace ${traceId} not found.`);
    }
    const tsMs = parseTimeMs(trace) || Date.now();
    const objectKey =
      trace.s3Sync?.key && trace.s3Sync?.state !== "synced"
        ? trace.s3Sync.key
        : this.allocateUniqueObjectKey(config, {
            timestampMs: tsMs,
            traceId: trace.id,
            apiKeyName: trace.apiKeyName,
            agent: trace.agent,
            provider: trace.provider,
            model: trace.servedModel || trace.model,
            sessionId: trace.sessionId,
            origin: trace.origin,
          });
    const client = new S3TraceClient(config, this.fetchImpl);
    const s3Payload = { ...trace };
    delete s3Payload.s3Sync;
    const res = await client.putJson(objectKey, s3Payload, { signal });
    const nowIso = new Date().toISOString();
    trace.s3Sync = {
      state: "synced",
      key: objectKey,
      bucket: config.bucket,
      provider: config.provider,
      bytes: res.bytes,
      etag: res.etag,
      latencyMs: res.latencyMs,
      syncedAt: nowIso,
    };
    this.stats.synced += 1;
    this.stats.lastSyncAt = nowIso;
    this.stats.lastError = null;
    this.upsertInMemory(trace, config.maxLocalTraces);
    await this.persistTraceToDisk(trace, config);
    return trace;
  }

  /**
   * Pull & index trace JSON files directly from the configured S3 bucket so users can browse
   * historical or multi-machine S3 traces in Logs, Activity, and Sessions.
   */
  async syncFromS3(config, { prefix, maxObjects = 100, signal } = {}) {
    if (!config.s3Configured) {
      throw new Error("S3 destination is not configured yet.");
    }
    await this.syncWithDiskCache(config);

    // Derive fixed prefix before the first template variable if caller did not supply an explicit prefix.
    let listPrefix = typeof prefix === "string" ? prefix.trim().replace(/^\/+/, "") : "";
    if (!listPrefix) {
      const rawTpl = String(config.pathTemplate || "");
      const varIdx = rawTpl.indexOf("{");
      if (varIdx > 0) {
        listPrefix = rawTpl.slice(0, varIdx).replace(/^\/+|\/+$/g, "");
      } else if (rawTpl.startsWith("{prefix}")) {
        listPrefix = renderPathTemplate("{prefix}", { prefix: config.prefix });
      }
    }

    const client = new S3TraceClient(config, this.fetchImpl);
    const listed = await client.listObjects({
      prefix: listPrefix,
      maxKeys: Math.min(250, Math.max(1, maxObjects)),
      signal,
    });

    const candidates = listed.contents
      .filter(
        (obj) =>
          obj.key.endsWith(".json") &&
          !obj.key.endsWith(".openrouter-connection-test.json") &&
          obj.size > 0 &&
          obj.size <= 8 * 1024 * 1024
      )
      .sort((a, b) => String(b.lastModified || "").localeCompare(String(a.lastModified || "")))
      .slice(0, maxObjects);

    const existingKeys = new Set();
    for (const t of this.tracesById.values()) {
      if (t.s3Sync?.key) existingKeys.add(t.s3Sync.key);
    }

    let imported = 0;
    let skipped = 0;
    for (const obj of candidates) {
      if (existingKeys.has(obj.key)) {
        skipped += 1;
        continue;
      }
      try {
        const doc = await client.getJson(obj.key, { signal });
        const items = Array.isArray(doc?.traces) ? doc.traces : doc?.id ? [doc] : [];
        for (const item of items) {
          if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
          item.s3Sync = {
            state: "synced",
            key: obj.key,
            bucket: config.bucket,
            bytes: obj.size,
            etag: obj.etag,
            syncedAt: obj.lastModified || new Date().toISOString(),
          };
          this.upsertInMemory(item, config.maxLocalTraces);
          await this.persistTraceToDisk(item, config);
          imported += 1;
        }
      } catch {
        // Skip unreadable or non-trace JSON objects gracefully.
      }
    }

    return {
      ok: true,
      prefix: listPrefix,
      scanned: candidates.length,
      imported,
      skipped,
      totalInStore: this.tracesById.size,
    };
  }

  async getFilteredTraces(config, filters = {}) {
    await this.syncWithDiskCache(config);
    const nowMs = Date.now();
    const { sinceMs, untilMs } = resolveRangeBounds(filters, nowMs);
    const q = String(filters.q || "").trim().toLowerCase();
    const wantModel = String(filters.model || "").trim().toLowerCase();
    const wantProvider = String(filters.provider || "").trim().toLowerCase();
    const wantAgent = String(filters.agent || "").trim().toLowerCase();
    const wantApiKey = String(filters.apiKeyName || "").trim().toLowerCase();
    const wantSession = String(filters.sessionId || "").trim();
    const wantStatus = String(filters.status || "").trim().toLowerCase();
    const wantOrigin = String(filters.origin || "").trim().toLowerCase();
    const wantSync = String(filters.syncState || "").trim().toLowerCase();

    const all = [...this.tracesById.values()];
    const facets = {
      models: new Set(),
      providers: new Set(),
      agents: new Set(),
      apiKeys: new Set(),
      origins: new Set(),
    };

    const matched = [];
    for (const trace of all) {
      if (trace.model) facets.models.add(trace.model);
      if (trace.provider) facets.providers.add(trace.provider);
      if (trace.agent) facets.agents.add(trace.agent);
      if (trace.apiKeyName) facets.apiKeys.add(trace.apiKeyName);
      if (trace.origin) facets.origins.add(trace.origin);

      const tMs = parseTimeMs(trace);
      if (sinceMs > 0 && tMs < sinceMs) continue;
      if (untilMs > 0 && tMs > untilMs + 60000) continue;

      if (wantModel) {
        const m = String(trace.model || "").toLowerCase();
        const reqM = String(trace.requestedModel || "").toLowerCase();
        const srvM = String(trace.servedModel || "").toLowerCase();
        if (m !== wantModel && reqM !== wantModel && srvM !== wantModel) continue;
      }
      if (wantProvider && String(trace.provider || "").toLowerCase() !== wantProvider) continue;
      if (wantAgent && String(trace.agent || "").toLowerCase() !== wantAgent) continue;
      if (wantApiKey && String(trace.apiKeyName || "").toLowerCase() !== wantApiKey) continue;
      if (wantSession && trace.sessionId !== wantSession) continue;
      if (wantStatus && String(trace.status || "").toLowerCase() !== wantStatus) continue;
      if (wantOrigin && String(trace.origin || "").toLowerCase() !== wantOrigin) continue;
      if (wantSync && String(trace.s3Sync?.state || "").toLowerCase() !== wantSync) continue;
      if (q && !extractSearchText(trace).includes(q)) continue;

      matched.push(trace);
    }

    matched.sort((a, b) => parseTimeMs(b) - parseTimeMs(a));

    return {
      matched,
      sinceMs,
      untilMs,
      facets: {
        models: [...facets.models].sort(),
        providers: [...facets.providers].sort(),
        agents: [...facets.agents].sort(),
        apiKeys: [...facets.apiKeys].sort(),
        origins: [...facets.origins].sort(),
      },
    };
  }

  /**
   * OpenRouter Logs view: paginated generation summaries + request volume histogram + facet options.
   */
  async queryLogs(config, filters = {}) {
    const { matched, sinceMs, untilMs, facets } = await this.getFilteredTraces(config, filters);
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
    const offset = Math.max(0, Number(filters.offset) || 0);

    // Build 24-bucket volume histogram over the active time span.
    const bucketCount = 24;
    let spanStart = sinceMs;
    if (!spanStart && matched.length > 0) {
      spanStart = parseTimeMs(matched[matched.length - 1]);
    }
    if (!spanStart || untilMs <= spanStart) {
      spanStart = untilMs - 24 * 3600 * 1000;
    }
    const stepMs = Math.max(60 * 1000, Math.ceil((untilMs - spanStart) / bucketCount));
    const histogram = Array.from({ length: bucketCount }, (_, idx) => {
      const bStart = spanStart + idx * stepMs;
      return {
        startMs: bStart,
        endMs: bStart + stepMs,
        label: new Date(bStart).toISOString().slice(5, 16).replace("T", " "),
        completed: 0,
        errors: 0,
        total: 0,
      };
    });

    for (const t of matched) {
      const ts = parseTimeMs(t);
      if (ts < spanStart) continue;
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((ts - spanStart) / stepMs)));
      histogram[idx].total += 1;
      if (t.status === "error") histogram[idx].errors += 1;
      else histogram[idx].completed += 1;
    }

    return {
      total: matched.length,
      offset,
      limit,
      items: matched.slice(offset, offset + limit).map(summarizeTrace),
      histogram,
      facets,
    };
  }

  async getTrace(config, traceId) {
    await this.syncWithDiskCache(config);
    return this.tracesById.get(traceId) || null;
  }

  /**
   * OpenRouter Activity view: headline metrics, time-series trends, and ranked breakdowns.
   */
  async queryActivity(config, filters = {}) {
    const { matched, sinceMs, untilMs, facets } = await this.getFilteredTraces(config, filters);

    let completedRequests = 0;
    let errorRequests = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    let cachedTokens = 0;
    let cacheWriteTokens = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let costCount = 0;
    let s3SyncedCount = 0;
    let s3PendingOrFailedCount = 0;
    const latencies = [];
    const ttfts = [];

    const byModel = new Map();
    const byProvider = new Map();
    const byAgent = new Map();
    const byApiKey = new Map();

    const useHourly = untilMs - (sinceMs || untilMs - 7 * 86400e3) <= 48 * 3600 * 1000 && sinceMs > 0;
    const seriesMap = new Map();

    const bumpGroup = (map, key, trace) => {
      const name = key || "unknown";
      let entry = map.get(name);
      if (!entry) {
        entry = {
          name,
          requests: 0,
          errors: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          latencySum: 0,
          latencyCount: 0,
        };
        map.set(name, entry);
      }
      entry.requests += 1;
      if (trace.status === "error") entry.errors += 1;
      const u = trace.usage || {};
      entry.promptTokens += u.promptTokens || 0;
      entry.completionTokens += u.completionTokens || 0;
      entry.cachedTokens += u.promptTokensDetails?.cachedTokens || 0;
      entry.reasoningTokens += u.completionTokensDetails?.reasoningTokens || 0;
      entry.totalTokens += u.totalTokens || 0;
      if (typeof u.totalCost === "number") entry.totalCost += u.totalCost;
      if (typeof trace.latencyMs === "number" && trace.latencyMs >= 0) {
        entry.latencySum += trace.latencyMs;
        entry.latencyCount += 1;
      }
    };

    for (const trace of matched) {
      if (trace.status === "error") errorRequests += 1;
      else completedRequests += 1;

      const u = trace.usage || {};
      const pTok = u.promptTokens || 0;
      const cTok = u.completionTokens || 0;
      const rTok = u.completionTokensDetails?.reasoningTokens || 0;
      const cacheRead = u.promptTokensDetails?.cachedTokens || 0;
      const cacheWrite = u.promptTokensDetails?.cacheWriteTokens || 0;
      const tTok = u.totalTokens || pTok + cTok;

      promptTokens += pTok;
      completionTokens += cTok;
      reasoningTokens += rTok;
      cachedTokens += cacheRead;
      cacheWriteTokens += cacheWrite;
      totalTokens += tTok;

      if (typeof u.totalCost === "number" && Number.isFinite(u.totalCost)) {
        totalCost += u.totalCost;
        costCount += 1;
      }
      if (typeof trace.latencyMs === "number" && trace.latencyMs >= 0) {
        latencies.push(trace.latencyMs);
      }
      if (typeof trace.ttftMs === "number" && trace.ttftMs > 0) {
        ttfts.push(trace.ttftMs);
      }

      if (trace.s3Sync?.state === "synced") s3SyncedCount += 1;
      else if (trace.s3Sync?.state === "failed" || trace.s3Sync?.state === "retrying" || trace.s3Sync?.state === "queued_batch") {
        s3PendingOrFailedCount += 1;
      }

      bumpGroup(byModel, trace.model, trace);
      bumpGroup(byProvider, trace.provider, trace);
      bumpGroup(byAgent, trace.agent, trace);
      bumpGroup(byApiKey, trace.apiKeyName, trace);

      const ts = parseTimeMs(trace);
      if (ts > 0) {
        const iso = new Date(ts).toISOString();
        const bucketKey = useHourly ? `${iso.slice(0, 13)}:00Z` : iso.slice(0, 10);
        let bucket = seriesMap.get(bucketKey);
        if (!bucket) {
          bucket = {
            bucket: bucketKey,
            requests: 0,
            errors: 0,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
            totalCost: 0,
          };
          seriesMap.set(bucketKey, bucket);
        }
        bucket.requests += 1;
        if (trace.status === "error") bucket.errors += 1;
        bucket.promptTokens += pTok;
        bucket.completionTokens += cTok;
        bucket.cachedTokens += cacheRead;
        bucket.reasoningTokens += rTok;
        bucket.totalTokens += tTok;
        if (typeof u.totalCost === "number") bucket.totalCost += u.totalCost;
      }
    }

    const finalizeGroups = (map) =>
      [...map.values()]
        .map((g) => ({
          ...g,
          avgLatencyMs: g.latencyCount > 0 ? Math.round(g.latencySum / g.latencyCount) : null,
          cacheHitRate: g.promptTokens > 0 ? Number(((g.cachedTokens / g.promptTokens) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);

    const totalRequests = matched.length;
    const avgLatencyMs = latencies.length
      ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length)
      : null;
    const avgTtftMs = ttfts.length ? Math.round(ttfts.reduce((s, x) => s + x, 0) / ttfts.length) : null;

    return {
      summary: {
        totalRequests,
        completedRequests,
        errorRequests,
        errorRate: totalRequests > 0 ? Number(((errorRequests / totalRequests) * 100).toFixed(1)) : 0,
        promptTokens,
        completionTokens,
        reasoningTokens,
        cachedTokens,
        cacheWriteTokens,
        totalTokens,
        cacheHitRate: promptTokens > 0 ? Number(((cachedTokens / promptTokens) * 100).toFixed(1)) : 0,
        totalCost: costCount > 0 ? Number(totalCost.toFixed(6)) : null,
        avgLatencyMs,
        p95LatencyMs: percentile(latencies, 95),
        avgTtftMs,
        s3SyncedCount,
        s3PendingOrFailedCount,
      },
      granularity: useHourly ? "hour" : "day",
      trends: [...seriesMap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
      breakdowns: {
        models: finalizeGroups(byModel),
        providers: finalizeGroups(byProvider),
        agents: finalizeGroups(byAgent),
        apiKeys: finalizeGroups(byApiKey),
      },
      facets,
      syncStats: { ...this.stats, pendingRetries: this.retryQueue.length, bufferedBatch: this.batchBuffer.length },
    };
  }

  /**
   * OpenRouter Activity -> Explore builder + CSV export.
   */
  async queryExplore(config, { filters = {}, metric = "totalTokens", groupBy = "model", subgroupBy = "none", rollup = "none", limit = 25 } = {}) {
    const { matched } = await this.getFilteredTraces(config, filters);
    const dimOf = (trace, dim) => {
      switch (dim) {
        case "model":
          return trace.model || "unknown";
        case "provider":
          return trace.provider || "unknown";
        case "agent":
          return trace.agent || "unknown";
        case "apiKeyName":
          return trace.apiKeyName || "local";
        case "sessionId":
          return trace.sessionId || "(sessionless)";
        case "origin":
          return trace.origin || "local";
        case "status":
          return trace.status || "completed";
        case "finishReason":
          return trace.finishReason || "(none)";
        default:
          return "all";
      }
    };

    const bucketOf = (trace) => {
      if (rollup === "none" || !rollup) return "all";
      const ts = parseTimeMs(trace);
      if (!ts) return "unknown";
      const iso = new Date(ts).toISOString();
      return rollup === "hour" ? `${iso.slice(0, 13)}:00Z` : iso.slice(0, 10);
    };

    const rowsMap = new Map();
    for (const trace of matched) {
      const g1 = dimOf(trace, groupBy);
      const g2 = subgroupBy && subgroupBy !== "none" ? dimOf(trace, subgroupBy) : "";
      const timeBucket = bucketOf(trace);
      const key = `${timeBucket}\u0000${g1}\u0000${g2}`;
      let row = rowsMap.get(key);
      if (!row) {
        row = {
          timeBucket,
          group: g1,
          subgroup: g2,
          requests: 0,
          errorCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          latencySum: 0,
          latencyCount: 0,
        };
        rowsMap.set(key, row);
      }
      const u = trace.usage || {};
      row.requests += 1;
      if (trace.status === "error") row.errorCount += 1;
      row.promptTokens += u.promptTokens || 0;
      row.completionTokens += u.completionTokens || 0;
      row.cachedTokens += u.promptTokensDetails?.cachedTokens || 0;
      row.reasoningTokens += u.completionTokensDetails?.reasoningTokens || 0;
      row.totalTokens += u.totalTokens || 0;
      if (typeof u.totalCost === "number") row.totalCost += u.totalCost;
      if (typeof trace.latencyMs === "number" && trace.latencyMs >= 0) {
        row.latencySum += trace.latencyMs;
        row.latencyCount += 1;
      }
    }

    const rows = [...rowsMap.values()].map((r) => {
      const avgLatencyMs = r.latencyCount > 0 ? Math.round(r.latencySum / r.latencyCount) : 0;
      const out = {
        ...(rollup !== "none" ? { timeBucket: r.timeBucket } : {}),
        group: r.group,
        ...(subgroupBy && subgroupBy !== "none" ? { subgroup: r.subgroup } : {}),
        requests: r.requests,
        errorCount: r.errorCount,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        cachedTokens: r.cachedTokens,
        reasoningTokens: r.reasoningTokens,
        totalTokens: r.totalTokens,
        avgLatencyMs,
        totalCost: Number(r.totalCost.toFixed(6)),
      };
      out.metricValue = out[metric] ?? out.totalTokens;
      return out;
    });

    rows.sort((a, b) => b.metricValue - a.metricValue || b.requests - a.requests);
    const maxRows = Math.min(500, Math.max(1, Number(limit) || 25));

    return {
      metric,
      groupBy,
      subgroupBy,
      rollup,
      totalRows: rows.length,
      rows: rows.slice(0, maxRows),
    };
  }

  async exportExploreCsv(config, params = {}) {
    const res = await this.queryExplore(config, { ...params, limit: 500 });
    const headers = [
      ...(res.rollup !== "none" ? ["time_bucket"] : []),
      res.groupBy,
      ...(res.subgroupBy && res.subgroupBy !== "none" ? [res.subgroupBy] : []),
      "requests",
      "errors",
      "prompt_tokens",
      "completion_tokens",
      "cached_tokens",
      "reasoning_tokens",
      "total_tokens",
      "avg_latency_ms",
      "total_cost_usd",
    ];
    const lines = [headers.map(csvCell).join(",")];
    for (const r of res.rows) {
      const cols = [
        ...(res.rollup !== "none" ? [r.timeBucket] : []),
        r.group,
        ...(res.subgroupBy && res.subgroupBy !== "none" ? [r.subgroup] : []),
        r.requests,
        r.errorCount,
        r.promptTokens,
        r.completionTokens,
        r.cachedTokens,
        r.reasoningTokens,
        r.totalTokens,
        r.avgLatencyMs,
        r.totalCost,
      ];
      lines.push(cols.map(csvCell).join(","));
    }
    return lines.join("\n") + "\n";
  }

  /**
   * OpenRouter Logs -> Sessions grouped projection.
   */
  async querySessions(config, filters = {}) {
    const { matched } = await this.getFilteredTraces(config, filters);
    const sessionsMap = new Map();

    for (const trace of matched) {
      const sid = trace.sessionId || `single:${trace.id}`;
      let s = sessionsMap.get(sid);
      const ts = parseTimeMs(trace);
      if (!s) {
        s = {
          sessionId: sid,
          isSessionless: !trace.sessionId,
          title: "",
          agent: trace.agent || "unknown",
          apiKeyName: trace.apiKeyName || "local",
          models: new Set(),
          providers: new Set(),
          requestCount: 0,
          errorCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          totalCost: 0,
          firstAtMs: ts,
          lastAtMs: ts,
          firstAt: trace.startTime || trace.timestamp,
          lastAt: trace.endTime || trace.timestamp,
        };
        sessionsMap.set(sid, s);
      }
      s.requestCount += 1;
      if (trace.status === "error") s.errorCount += 1;
      if (trace.model) s.models.add(trace.model);
      if (trace.provider) s.providers.add(trace.provider);
      const u = trace.usage || {};
      s.promptTokens += u.promptTokens || 0;
      s.completionTokens += u.completionTokens || 0;
      s.totalTokens += u.totalTokens || 0;
      if (typeof u.totalCost === "number") s.totalCost += u.totalCost;

      if (ts && ts <= s.firstAtMs) {
        s.firstAtMs = ts;
        s.firstAt = trace.startTime || trace.timestamp;
        if (trace.title) s.title = trace.title;
      }
      if (!s.title && trace.title) s.title = trace.title;
      if (ts && ts >= s.lastAtMs) {
        s.lastAtMs = ts;
        s.lastAt = trace.endTime || trace.timestamp;
      }
    }

    const sessions = [...sessionsMap.values()]
      .map((s) => ({
        sessionId: s.sessionId,
        isSessionless: s.isSessionless,
        title: s.title || (s.isSessionless ? "Single Generation" : s.sessionId),
        agent: s.agent,
        apiKeyName: s.apiKeyName,
        models: [...s.models],
        providers: [...s.providers],
        requestCount: s.requestCount,
        errorCount: s.errorCount,
        promptTokens: s.promptTokens,
        completionTokens: s.completionTokens,
        totalTokens: s.totalTokens,
        totalCost: Number(s.totalCost.toFixed(6)),
        firstAt: s.firstAt,
        lastAt: s.lastAt,
      }))
      .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));

    return {
      total: sessions.length,
      sessions: sessions.slice(0, 200),
    };
  }

  async getSessionThread(config, sessionId) {
    await this.syncWithDiskCache(config);
    const turns = [];
    for (const trace of this.tracesById.values()) {
      const sid = trace.sessionId || `single:${trace.id}`;
      if (sid === sessionId) {
        turns.push(trace);
      }
    }
    turns.sort((a, b) => parseTimeMs(a) - parseTimeMs(b));
    return turns;
  }
}

export const sharedStore = new TraceStore();
