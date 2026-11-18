import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { onRequest, onResponse } from "../s3-trace-sync.hooks.mjs";
import { resolveConfig } from "../src/config.mjs";
import { findMatchingLedgerRecord } from "../src/ledger.mjs";
import { TraceStore } from "../src/store.mjs";
import { buildOpenRouterTrace, evaluateApiKeyFilter } from "../src/trace.mjs";

test("buildOpenRouterTrace normalizes Chat, Responses, Anthropic, and Gemini protocols", () => {
  const cfg = resolveConfig({ ignoreOverlay: true, inputOutputLogging: true, redactSecrets: true });

  // 1. Anthropic with thinking, tool_use, and cache_creation
  const anthTrace = buildOpenRouterTrace({
    requestBody: {
      model: "claude-sonnet-4-5",
      system: "You are helpful.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Search config with sk-ant-1234567890abcdef" }] },
      ],
      tools: [{ name: "read_file", input_schema: { type: "object" } }],
      trace: { trace_id: "wf_1", trace_name: "Code Review", environment: "prod" },
    },
    replyBody: {
      id: "msg_1",
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "Let me inspect the file." },
        { type: "text", text: "Checking file..." },
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "README.md" } },
      ],
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
        output_tokens: 45,
      },
    },
    ctx: { protocol: "anthropic", agent: "claude", origin: "local", session: "ses_1", success: true },
    startedAtMs: 1000,
    endedAtMs: 1850,
    config: cfg,
  });

  assert.equal(anthTrace.id, "wf_1");
  assert.equal(anthTrace.name, "Code Review");
  assert.equal(anthTrace.metadata.environment, "prod");
  assert.equal(anthTrace.usage.promptTokens, 800);
  assert.equal(anthTrace.usage.promptTokensDetails.cachedTokens, 500);
  assert.equal(anthTrace.usage.promptTokensDetails.cacheWriteTokens, 200);
  // Secrets scrubbed
  assert.match(anthTrace.input.messages[0].content, /\[REDACTED_API_KEY\]/);
  assert.ok(!JSON.stringify(anthTrace).includes("sk-ant-1234567890abcdef"));
  // OpenRouter Broadcast rule: tools moved from rawRequest to output.tools when toolCallsCount > 0
  assert.equal(anthTrace.output.rawRequest.tools, undefined);
  assert.equal(anthTrace.output.tools.length, 1);

  // 2. Gemini with multimodal inlineData stripped and thoughtsTokenCount
  const gemTrace = buildOpenRouterTrace({
    requestBody: {
      contents: [
        {
          role: "user",
          parts: [
            { text: "Describe this image" },
            { inlineData: { mimeType: "image/png", data: "A".repeat(200) } },
          ],
        },
      ],
      generationConfig: { temperature: 0.3, topP: 0.9 },
    },
    replyBody: {
      responseId: "gem_1",
      modelVersion: "gemini-2.5-pro",
      candidates: [
        {
          finishReason: "STOP",
          content: {
            role: "model",
            parts: [
              { thought: true, text: "Analyzing image..." },
              { text: "It is an icon." },
            ],
          },
        },
      ],
      usageMetadata: {
        promptTokenCount: 250,
        candidatesTokenCount: 15,
        thoughtsTokenCount: 35,
        cachedContentTokenCount: 100,
      },
    },
    ctx: { protocol: "gemini", agent: "gemini", origin: "magpie-key", model: "gemini-2.5-pro", success: true },
    config: cfg,
  });
  assert.equal(gemTrace.usage.completionTokens, 50);
  assert.equal(gemTrace.usage.completionTokensDetails.reasoningTokens, 35);
  assert.match(gemTrace.input.messages[0].content, /\[multimodal:image\/png:/);
  assert.equal(gemTrace.modelParameters.temperature, 0.3);

  // 3. Responses protocol
  const respTrace = buildOpenRouterTrace({
    requestBody: { model: "gpt-5", instructions: "Be terse", input: "Hi" },
    replyBody: {
      id: "resp_1",
      model: "gpt-5",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello!" }] }],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    },
    ctx: { protocol: "responses", agent: "codex", origin: "local", success: true },
    config: cfg,
  });
  assert.equal(respTrace.output.messages[0].content, "Hello!");
  assert.equal(respTrace.usage.totalTokens, 15);
});

test("Privacy Mode suppresses prompt, completion, error text, and raw usage while keeping metrics", () => {
  const cfg = resolveConfig({ ignoreOverlay: true, privacyMode: true, inputOutputLogging: true });
  const trace = buildOpenRouterTrace({
    requestBody: { model: "gpt-4o", messages: [{ role: "user", content: "Top secret text" }], temperature: 0.5 },
    replyBody: {
      id: "chatcmpl_priv",
      model: "gpt-4o",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Secret reply" } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    },
    ctx: { protocol: "chat", agent: "opencode", origin: "local", success: true },
    config: cfg,
  });
  assert.equal(trace.privacyMode, true);
  assert.equal(trace.inputOutputLogging, false);
  assert.equal(trace.input, null);
  assert.equal(trace.output, null);
  assert.equal(trace.metadata.openrouter_generation.upstream_raw_response_usage, null);
  assert.equal(
    trace.metadata.openrouter_generation.upstream_raw_response_usage_suppression_reason,
    "privacy_mode"
  );
  assert.equal(trace.usage.totalTokens, 30);
  assert.equal(trace.modelParameters.temperature, 0.5);
});

test("API key filter gives exclusions precedence over inclusions", () => {
  assert.equal(evaluateApiKeyFilter("team-a", { includedApiKeys: ["team-a", "team-b"], excludedApiKeys: [] }), true);
  assert.equal(evaluateApiKeyFilter("team-c", { includedApiKeys: ["team-a", "team-b"], excludedApiKeys: [] }), false);
  assert.equal(
    evaluateApiKeyFilter("team-a", { includedApiKeys: ["team-a"], excludedApiKeys: ["team-a"] }),
    false
  );
});

test("findMatchingLedgerRecord parses Magpie usage.jsonl and computes routerTiming", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-trace-ledger-"));
  try {
    const now = Date.now();
    const row = {
      t: new Date(now - 500).toISOString(),
      route_id: 42,
      agent: "claude",
      provider: "anthropic-direct",
      callerKeyName: "dev-macbook",
      model: "claude-sonnet-4",
      req: "claude-sonnet-4",
      served: "claude-sonnet-4-20250514",
      in: 120,
      out: 80,
      cache_read: 400,
      cache_write: 50,
      ms: 900,
      ttft_ms: 210,
      own_ms: 15,
      retried_ms: 100,
      masking_ms: 4,
      tries: 2,
      status: 200,
      request_id: "req_ledger_1",
      session: "ses_abc",
    };
    fs.writeFileSync(path.join(tmpDir, "usage.jsonl"), JSON.stringify(row) + "\n", "utf8");

    const found = await findMatchingLedgerRecord({
      magpieConfigDir: tmpDir,
      startedAtMs: now - 600,
      endedAtMs: now,
      session: "ses_abc",
      agent: "claude",
      model: "claude-sonnet-4",
      replyId: "req_ledger_1",
    });

    assert.ok(found);
    assert.equal(found.provider, "anthropic-direct");
    assert.equal(found.callerKeyName, "dev-macbook");
    assert.equal(found.routerTiming.router_ms, 15);
    assert.equal(found.routerTiming.provider_failed_ms, 100);
    assert.equal(found.routerTiming.guardrails_ms, 4);
    assert.equal(found.routerTiming.attempt_count, 2);
    assert.equal(found.routerTiming.provider_ms, 785);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TraceStore uploads to R2, retries transient 429 (10058), batches, and pulls historical traces", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-trace-store-"));
  try {
    const bucketObjects = new Map();
    let putCalls = 0;

    const mockFetch = async (url, init) => {
      const u = new URL(url);
      if (init.method === "PUT") {
        putCalls++;
        if (putCalls === 1) {
          return new Response(
            `<Error><Code>TooManyRequests</Code><Message>Rate limited</Message></Error>`,
            { status: 429, headers: { "retry-after": "1" } }
          );
        }
        const key = decodeURIComponent(u.pathname.replace(/^\/my-r2-bucket\//, ""));
        bucketObjects.set(key, init.body);
        return new Response("", { status: 200, headers: { etag: `"etag_${putCalls}"` } });
      }
      if (init.method === "GET" && u.searchParams.get("list-type") === "2") {
        const itemsXml = [...bucketObjects.entries()]
          .map(
            ([k, body]) =>
              `<Contents><Key>${k}</Key><LastModified>2026-11-18T04:00:00Z</LastModified><ETag>"abc"</ETag><Size>${Buffer.byteLength(body)}</Size></Contents>`
          )
          .join("");
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated>${itemsXml}</ListBucketResult>`, {
          status: 200,
        });
      }
      if (init.method === "GET") {
        const key = decodeURIComponent(u.pathname.replace(/^\/my-r2-bucket\//, ""));
        const body = bucketObjects.get(key);
        if (!body) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
        return new Response(body, { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    };

    const store = new TraceStore({ fetchImpl: mockFetch });
    const cfg = resolveConfig(
      {
        ignoreOverlay: true,
        stateDir: tmpDir,
        enabled: true,
        provider: "r2",
        accountId: "acct999",
        bucket: "my-r2-bucket",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      },
      {}
    );

    const t1 = buildOpenRouterTrace({
      requestBody: { model: "gpt-4o", messages: [{ role: "user", content: "First question" }] },
      replyBody: {
        id: "trc_retry_1",
        model: "gpt-4o",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Answer 1" } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
      ctx: { protocol: "chat", agent: "opencode", origin: "local", session: "ses_1", success: true },
      config: cfg,
    });

    const recorded = await store.recordAndSync(t1, cfg);
    assert.equal(recorded.s3Sync.state, "retrying");
    assert.equal(recorded.s3Sync.r2Code, 10058);

    // Wait briefly for retry worker
    await new Promise((r) => setTimeout(r, 1700));
    const afterRetry = await store.getTrace(cfg, "trc_retry_1");
    assert.equal(afterRetry.s3Sync.state, "synced");
    assert.equal(bucketObjects.size, 1);

    // Clear local cache and pull back from mocked R2!
    await store.clearLocalCache(cfg);
    const emptyLogs = await store.queryLogs(cfg, { range: "all" });
    assert.equal(emptyLogs.total, 0);

    const syncRes = await store.syncFromS3(cfg, { maxObjects: 50 });
    assert.equal(syncRes.imported, 1);
    const restoredLogs = await store.queryLogs(cfg, { range: "all" });
    assert.equal(restoredLogs.total, 1);
    assert.equal(restoredLogs.items[0].id, "trc_retry_1");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Hooks onRequest and onResponse skip non-local origins unless captureRemote is enabled", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-trace-hooks-"));
  try {
    const reports = [];
    const ctxRemote = {
      origin: "remote",
      protocol: "chat",
      model: "gpt-4o",
      agent: "curl",
      options: { stateDir: tmpDir, ignoreOverlay: true, enabled: true, captureRemote: false },
      state: {},
      report: (code) => reports.push(code),
    };
    await onRequest({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, ctxRemote);
    assert.deepEqual(reports, ["skipped"]);
    assert.equal(ctxRemote.state.s3TraceSync, undefined);

    const ctxLocal = {
      origin: "local",
      protocol: "chat",
      model: "gpt-4o",
      agent: "claude",
      options: { stateDir: tmpDir, ignoreOverlay: true, enabled: true, localCache: true },
      state: {},
      report: (code) => reports.push(code),
    };
    await onRequest({ model: "gpt-4o", messages: [{ role: "user", content: "hello local" }] }, ctxLocal);
    assert.ok(ctxLocal.state.s3TraceSync);
    await onResponse(
      {
        id: "hook_trc_1",
        model: "gpt-4o",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "world" } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
      { ...ctxLocal, success: true }
    );
    assert.ok(reports.includes("ready"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
