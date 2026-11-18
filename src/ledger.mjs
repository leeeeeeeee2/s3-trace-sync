import fs from "node:fs/promises";
import path from "node:path";

const TAIL_BYTES = 128 * 1024;
const MAX_CLAIMED = 256;
const claimedKeys = new Set();

function rememberClaim(claimKey) {
  claimedKeys.add(claimKey);
  while (claimedKeys.size > MAX_CLAIMED) {
    const oldest = claimedKeys.values().next().value;
    claimedKeys.delete(oldest);
  }
}

function parseUsageTimestamp(raw) {
  if (typeof raw !== "string" || !raw) return NaN;
  // Trim sub-millisecond nanoseconds from Go RFC3339Nano timestamps if present.
  return Date.parse(raw.replace(/(\.\d{3})\d+/, "$1"));
}

function normalizeAgent(a) {
  return String(a ?? "").trim().toLowerCase();
}

function modelsRelated(ctxModel, row) {
  const m = String(ctxModel ?? "").trim().toLowerCase();
  if (!m) return true;
  const candidates = [row.req, row.model, row.served]
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => v.trim().toLowerCase());
  if (candidates.length === 0) return true;
  return candidates.some((c) => c === m || c.endsWith(`/${m}`) || m.endsWith(`/${c}`));
}

/**
 * Best-effort lookup of the matching gateway ledger row from the tail of Magpie's `usage.jsonl`.
 * Because Magpie's `serve` appends to `usage.jsonl` before `serveAgent` unwinds `gatewayHooks`,
 * the completed row is normally at the very end of `usage.jsonl` when `onResponse` runs.
 */
export async function findMatchingLedgerRecord({
  magpieConfigDir,
  usageFilePath,
  startedAtMs,
  endedAtMs,
  session = "",
  agent = "",
  model = "",
  replyId = "",
} = {}) {
  const file = usageFilePath || (magpieConfigDir ? path.join(magpieConfigDir, "usage.jsonl") : "");
  if (!file) return null;

  let fd;
  try {
    fd = await fs.open(file, "r");
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size === 0) return null;
    const readLen = Math.min(stat.size, TAIL_BYTES);
    const offset = stat.size - readLen;
    const buffer = Buffer.allocUnsafe(readLen);
    const { bytesRead } = await fd.read(buffer, 0, readLen, offset);
    let chunk = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      // Discard partial leading line when reading mid-file.
      const nl = chunk.indexOf("\n");
      if (nl >= 0) chunk = chunk.slice(nl + 1);
    }

    const lines = chunk.split("\n");
    const wantSession = String(session ?? "").trim();
    const wantAgent = normalizeAgent(agent);
    const wantReplyId = String(replyId ?? "").trim();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!row || typeof row !== "object") continue;
      if (row.kind === "model_list" || row.source === "probe") continue;

      const rowTs = parseUsageTimestamp(row.t);
      if (Number.isFinite(rowTs)) {
        // Magpie sets Record.Time = start of the request!
        if (startedAtMs && (rowTs < startedAtMs - 5000 || rowTs > (endedAtMs || Date.now()) + 3000)) {
          continue;
        }
      }

      if (wantReplyId && row.request_id && row.request_id === wantReplyId) {
        const claim = `${row.t}|${row.route_id ?? ""}|${row.request_id}`;
        if (!claimedKeys.has(claim)) {
          rememberClaim(claim);
          return normalizeLedgerRow(row);
        }
      }

      if (wantSession && row.session && row.session !== wantSession) continue;
      if (wantAgent && row.agent && normalizeAgent(row.agent) !== wantAgent) continue;
      if (!modelsRelated(model, row)) continue;

      const claim = `${row.t}|${row.route_id ?? ""}|${row.session ?? ""}|${row.model ?? ""}|${row.ms ?? ""}|${i}`;
      if (claimedKeys.has(claim)) continue;
      rememberClaim(claim);
      return normalizeLedgerRow(row);
    }
  } catch {
    // Missing or unreadable usage.jsonl is normal in standalone / unit tests; fail silently.
  } finally {
    await fd?.close().catch(() => {});
  }
  return null;
}

export function normalizeLedgerRow(row) {
  const input = Number.isFinite(row.in) ? row.in : 0;
  const output = Number.isFinite(row.out) ? row.out : 0;
  const cacheRead = Number.isFinite(row.cache_read) ? row.cache_read : 0;
  const cacheWrite = Number.isFinite(row.cache_write) ? row.cache_write : 0;
  const cacheWrite1h = Number.isFinite(row.cache_write_1h) ? row.cache_write_1h : 0;
  const reasoning = Number.isFinite(row.reasoning) ? row.reasoning : 0;
  const ms = Number.isFinite(row.ms) ? row.ms : null;
  const ownMs = Number.isFinite(row.own_ms) ? row.own_ms : null;
  const retriedMs = Number.isFinite(row.retried_ms) ? row.retried_ms : 0;
  const queuedMs = Number.isFinite(row.queued_ms) ? row.queued_ms : 0;
  const maskingMs = Number.isFinite(row.masking_ms) ? row.masking_ms : 0;
  const tries = Number.isFinite(row.tries) && row.tries > 0 ? row.tries : row.rejected ? 0 : 1;

  let providerMs = null;
  if (ms !== null) {
    providerMs = Math.max(0, ms - (ownMs ?? 0) - retriedMs - queuedMs);
  }

  return {
    provider: row.provider || "",
    upstream: row.upstream || null,
    callerKeyName: row.callerKeyName || "",
    requestedModel: row.req || "",
    servedModel: row.served || row.model || "",
    model: row.model || "",
    httpStatus: Number.isFinite(row.status) ? row.status : null,
    rejected: Boolean(row.rejected),
    errorMessage: row.err || "",
    errorType: row.err_type || "",
    requestId: row.request_id || "",
    endpoint: row.endpoint || "",
    latencyMs: ms,
    ttftMs: Number.isFinite(row.ttft_ms) && row.ttft_ms > 0 ? row.ttft_ms : null,
    sentMs: Number.isFinite(row.sent_ms) && row.sent_ms > 0 ? row.sent_ms : null,
    flowMs: Number.isFinite(row.flow_ms) && row.flow_ms > 0 ? row.flow_ms : null,
    effort: row.effort || "",
    tierServed: row.tier_served || "",
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: cacheWrite1h,
    reasoningTokens: reasoning,
    costUsd: typeof row.cost === "number" && Number.isFinite(row.cost) ? row.cost : null,
    routerTiming: {
      ...(ownMs !== null ? { router_ms: ownMs } : {}),
      ...(providerMs !== null && tries > 0 ? { provider_ms: providerMs } : {}),
      ...(tries > 0 ? { provider_failed_ms: retriedMs } : {}),
      ...(maskingMs > 0 || ownMs !== null ? { guardrails_ms: maskingMs } : {}),
      attempt_count: tries,
    },
  };
}
