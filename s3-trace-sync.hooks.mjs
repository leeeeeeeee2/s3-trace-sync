// OpenRouter-style S3 Trace Sync & Observability hook for Magpie Gateway.
// Captures completed agent conversations across Chat Completions, Responses,
// Anthropic Messages, and Gemini protocols without modifying requests or blocking streams.

import { resolveConfig } from "./src/config.mjs";
import { findMatchingLedgerRecord } from "./src/ledger.mjs";
import { sharedStore } from "./src/store.mjs";
import {
  buildOpenRouterTrace,
  evaluateApiKeyFilter,
  evaluatePreRequestGate,
} from "./src/trace.mjs";

export async function onRequest(body, ctx = {}) {
  ctx.state ??= {};
  const config = resolveConfig(ctx.options);
  const gate = evaluatePreRequestGate(ctx, config);
  if (!gate.allowed) {
    ctx.report?.("skipped");
    return undefined;
  }

  ctx.state.s3TraceSync = {
    startedAtMs: Date.now(),
    requestSnapshot: body,
  };
  ctx.report?.("ready", 0);
  return undefined;
}

export async function onResponse(reply, ctx = {}) {
  const bound = ctx.state?.s3TraceSync;
  if (!bound) return;

  try {
    const endedAtMs = Date.now();
    const config = resolveConfig(ctx.options);
    if (!config.enabled) {
      ctx.report?.("skipped");
      return;
    }
    if (ctx.success === false && !config.captureErrors) {
      ctx.report?.("skipped");
      return;
    }

    const requestBody = ctx.request ?? bound.requestSnapshot ?? {};
    const replyId =
      reply && typeof reply === "object"
        ? reply.id || reply.responseId || ""
        : "";

    const ledger = await findMatchingLedgerRecord({
      magpieConfigDir: config.magpieConfigDir,
      usageFilePath: ctx.options?.usageFilePath,
      startedAtMs: bound.startedAtMs,
      endedAtMs,
      session: ctx.session || "",
      agent: ctx.agent || "",
      model: ctx.model || requestBody?.model || "",
      replyId,
    });

    const apiKeyName =
      ledger?.callerKeyName ||
      (ctx.origin === "local" || ctx.origin === "magpie-key"
        ? "local"
        : ctx.origin || "default");

    if (!evaluateApiKeyFilter(apiKeyName, config)) {
      ctx.report?.("skipped");
      return;
    }

    const trace = buildOpenRouterTrace({
      requestBody,
      replyBody: reply,
      ctx,
      startedAtMs: bound.startedAtMs,
      endedAtMs,
      ledger,
      config,
    });

    const recorded = await sharedStore.recordAndSync(trace, config, {
      signal: ctx.signal,
    });

    const bytes = Math.min(32768, recorded.s3Sync?.bytes || 0);
    ctx.report?.("ready", bytes);
  } catch {
    ctx.report?.("unavailable");
  }
}

export const _internal = {
  store: sharedStore,
};
