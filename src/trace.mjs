import { createHash, randomUUID } from "node:crypto";

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]"],
  [/\bsk-(?:proj-|ant-|or-v1-|magpie-)?[A-Za-z0-9_-]{14,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED_GCP_KEY]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/(\bhttps?:\/\/[^/\s:@]+:)([^@\s/]+)(@)/gi, "$1[REDACTED]$3"],
];

const SENSITIVE_FIELD_NAME = /^(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|authorization|password|passwd|client[_-]?secret|private[_-]?key)$/i;

const DATA_URI_RE = /^data:([A-Za-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/;

export function sha256Short(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 16);
}

export function scrubSecretsInText(text) {
  if (typeof text !== "string" || text.length < 12) return text;
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Recursively sanitize an arbitrary JSON value:
 * - Strips heavy base64 multimodal blobs when stripMultimodal is true
 * - Redacts recognized API keys/tokens/credentials when redactSecrets is true
 */
export function sanitizePayload(value, { stripMultimodal = true, redactSecrets = true } = {}, depth = 0) {
  if (depth > 24 || value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (stripMultimodal && value.length > 128 && value.startsWith("data:")) {
      const m = DATA_URI_RE.exec(value);
      if (m) {
        const approxBytes = Math.floor((m[2].replace(/\s+/g, "").length * 3) / 4);
        return `[multimodal:${m[1]}:${approxBytes}B]`;
      }
    }
    return redactSecrets ? scrubSecretsInText(value) : value;
  }

  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item, { stripMultimodal, redactSecrets }, depth + 1));
  }

  // Anthropic base64 image/document block: { type: "base64", media_type: "image/png", data: "..." }
  if (stripMultimodal && value.type === "base64" && typeof value.data === "string" && value.data.length > 64) {
    const approxBytes = Math.floor((value.data.length * 3) / 4);
    return {
      ...value,
      data: `[multimodal:${value.media_type || "application/octet-stream"}:${approxBytes}B]`,
    };
  }

  // Gemini inlineData block: { mimeType: "image/jpeg", data: "..." }
  if (stripMultimodal && typeof value.mimeType === "string" && typeof value.data === "string" && value.data.length > 64) {
    const approxBytes = Math.floor((value.data.length * 3) / 4);
    return {
      ...value,
      data: `[multimodal:${value.mimeType}:${approxBytes}B]`,
    };
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (redactSecrets && SENSITIVE_FIELD_NAME.test(k) && typeof v === "string" && v.trim()) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizePayload(v, { stripMultimodal, redactSecrets }, depth + 1);
    }
  }
  return out;
}

function extractTextFromBlocks(blocks) {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) {
    if (blocks && typeof blocks === "object" && Array.isArray(blocks.parts)) {
      return extractTextFromBlocks(blocks.parts);
    }
    return "";
  }
  const parts = [];
  for (const b of blocks) {
    if (typeof b === "string") {
      parts.push(b);
    } else if (b && typeof b === "object") {
      if (typeof b.text === "string" && b.thought !== true && b.type !== "thinking") {
        parts.push(b.text);
      } else if (b.type === "image_url" || b.type === "input_image" || b.type === "image" || b.inlineData) {
        const placeholder =
          b.image_url?.url || b.image_url || b.source?.data || b.inlineData?.data || "[image]";
        parts.push(typeof placeholder === "string" ? placeholder : "[image]");
      }
    }
  }
  return parts.join("\n");
}

function parseJsonSafe(val) {
  if (typeof val !== "string") return val ?? {};
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

function normalizeModelParameters(body = {}, protocol = "chat") {
  const params = {};
  const gen = protocol === "gemini" && body.generationConfig && typeof body.generationConfig === "object"
    ? body.generationConfig
    : body;

  const numParam = (outKey, rawVal, min, max) => {
    if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
      if ((min === undefined || rawVal >= min) && (max === undefined || rawVal <= max)) {
        params[outKey] = rawVal;
      }
    }
  };

  numParam("temperature", gen.temperature, 0, 2);
  const topP = gen.top_p ?? gen.topP;
  if (typeof topP === "number" && Number.isFinite(topP) && topP > 0 && topP <= 1) {
    params.top_p = topP;
  }
  numParam("top_k", gen.top_k ?? gen.topK, 1, undefined);
  numParam("frequency_penalty", body.frequency_penalty, -2, 2);
  numParam("presence_penalty", body.presence_penalty, -2, 2);
  numParam("repetition_penalty", body.repetition_penalty, 0, undefined);
  numParam("min_p", body.min_p, 0, 1);
  numParam("top_a", body.top_a, 0, 1);
  if (Number.isInteger(body.seed)) params.seed = body.seed;

  const maxTok =
    body.max_completion_tokens ??
    body.max_tokens ??
    body.max_output_tokens ??
    gen.maxOutputTokens;
  if (Number.isInteger(maxTok) && maxTok > 0) {
    params.max_tokens = maxTok;
  }

  const stop = body.stop ?? body.stop_sequences ?? gen.stopSequences;
  if (typeof stop === "string" && stop) {
    params.stop_sequences = [stop];
  } else if (Array.isArray(stop) && stop.length > 0) {
    params.stop_sequences = stop.filter((s) => typeof s === "string");
  }

  const effort =
    body.reasoning_effort ??
    (typeof body.reasoning === "object" && body.reasoning ? body.reasoning.effort : undefined);
  if (typeof effort === "string" && effort) {
    params.reasoning_effort = effort;
  }

  return params;
}

/**
 * Normalize request input across Chat Completions, Responses, Anthropic Messages, and Gemini.
 */
export function extractRequestInfo(rawBody, protocol = "chat", sanitizeOpts = {}) {
  const body = rawBody && typeof rawBody === "object" ? sanitizePayload(rawBody, sanitizeOpts) : {};
  const messages = [];
  let system = "";

  if (protocol === "responses") {
    system = extractTextFromBlocks(body.instructions);
    if (typeof body.input === "string") {
      messages.push({ role: "user", content: body.input });
    } else if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "function_call") {
          messages.push({
            role: "assistant",
            content: "",
            tool_calls: [{ id: item.call_id || item.id || "", name: item.name || "", arguments: parseJsonSafe(item.arguments) }],
          });
        } else if (item.type === "function_call_output") {
          messages.push({
            role: "tool",
            tool_call_id: item.call_id || "",
            content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
          });
        } else if (item.role) {
          messages.push({
            role: item.role,
            content: extractTextFromBlocks(item.content),
          });
        }
      }
    }
  } else if (protocol === "anthropic") {
    system = extractTextFromBlocks(body.system);
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!m || typeof m !== "object") continue;
        if (typeof m.content === "string") {
          messages.push({ role: m.role || "user", content: m.content });
          continue;
        }
        if (Array.isArray(m.content)) {
          const textParts = [];
          const toolCalls = [];
          let reasoning = "";
          for (const block of m.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string") {
              textParts.push(block.text);
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
              reasoning += (reasoning ? "\n" : "") + block.thinking;
            } else if (block.type === "tool_use") {
              toolCalls.push({ id: block.id || "", name: block.name || "", arguments: block.input ?? {} });
            } else if (block.type === "tool_result") {
              messages.push({
                role: "tool",
                tool_call_id: block.tool_use_id || "",
                content: extractTextFromBlocks(block.content),
              });
            } else if (block.type === "image" || block.type === "document") {
              textParts.push(block.source?.data || `[${block.type}]`);
            }
          }
          if (textParts.length > 0 || toolCalls.length > 0 || reasoning) {
            messages.push({
              role: m.role || "user",
              content: textParts.join("\n"),
              ...(reasoning ? { reasoning } : {}),
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            });
          }
        }
      }
    }
  } else if (protocol === "gemini") {
    system = extractTextFromBlocks(body.systemInstruction);
    if (Array.isArray(body.contents)) {
      for (const c of body.contents) {
        if (!c || typeof c !== "object") continue;
        const role = c.role === "model" ? "assistant" : "user";
        const parts = Array.isArray(c.parts) ? c.parts : [];
        const textParts = [];
        const toolCalls = [];
        let reasoning = "";
        for (const p of parts) {
          if (!p || typeof p !== "object") continue;
          if (typeof p.text === "string") {
            if (p.thought === true) reasoning += (reasoning ? "\n" : "") + p.text;
            else textParts.push(p.text);
          } else if (p.functionCall) {
            toolCalls.push({
              id: p.functionCall.id || "",
              name: p.functionCall.name || "",
              arguments: p.functionCall.args ?? {},
            });
          } else if (p.functionResponse) {
            messages.push({
              role: "tool",
              name: p.functionResponse.name || "",
              tool_call_id: p.functionResponse.id || "",
              content: JSON.stringify(p.functionResponse.response ?? {}),
            });
          } else if (p.inlineData) {
            textParts.push(p.inlineData.data || `[${p.inlineData.mimeType || "media"}]`);
          }
        }
        if (textParts.length > 0 || toolCalls.length > 0 || reasoning) {
          messages.push({
            role,
            content: textParts.join("\n"),
            ...(reasoning ? { reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      }
    }
  } else {
    // OpenAI Chat Completions (default)
    if (Array.isArray(body.messages)) {
      const sysParts = [];
      for (const m of body.messages) {
        if (!m || typeof m !== "object") continue;
        if (m.role === "system" || m.role === "developer") {
          const s = extractTextFromBlocks(m.content);
          if (s) sysParts.push(s);
          messages.push({ role: m.role, content: s });
          continue;
        }
        const toolCalls = Array.isArray(m.tool_calls)
          ? m.tool_calls
              .filter((tc) => tc && typeof tc === "object")
              .map((tc) => ({
                id: tc.id || "",
                name: tc.function?.name || tc.name || "",
                arguments: parseJsonSafe(tc.function?.arguments ?? tc.arguments),
              }))
          : [];
        if (m.function_call && typeof m.function_call === "object") {
          toolCalls.push({
            id: "",
            name: m.function_call.name || "",
            arguments: parseJsonSafe(m.function_call.arguments),
          });
        }
        const reasoning =
          typeof m.reasoning_content === "string"
            ? m.reasoning_content
            : typeof m.reasoning === "string"
              ? m.reasoning
              : "";
        messages.push({
          role: m.role || "user",
          content: extractTextFromBlocks(m.content),
          ...(m.name ? { name: m.name } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      system = sysParts.join("\n\n");
    }
  }

  // OpenRouter Broadcast S3 convention: rawRequest is the request body excluding input messages.
  const rawRequest = { ...body };
  delete rawRequest.messages;
  delete rawRequest.input;
  delete rawRequest.contents;

  const tools = body.tools ?? body.config?.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;

  const userId =
    typeof body.user === "string" && body.user.trim()
      ? body.user.trim().slice(0, 128)
      : typeof body.metadata?.user_id === "string" && body.metadata.user_id.trim()
        ? body.metadata.user_id.trim().slice(0, 128)
        : null;

  const bodySessionId =
    typeof body.session_id === "string" && body.session_id.trim()
      ? body.session_id.trim().slice(0, 256)
      : null;

  const customTrace =
    body.trace && typeof body.trace === "object" && !Array.isArray(body.trace)
      ? { ...body.trace }
      : null;

  return {
    system,
    messages,
    rawRequest,
    tools: hasTools ? tools : null,
    hasTools,
    toolDefinitionsCount: hasTools ? tools.length : 0,
    modelParameters: normalizeModelParameters(body, protocol),
    userId,
    bodySessionId,
    customTrace,
  };
}

/**
 * Normalize completed reply across Chat Completions, Responses, Anthropic Messages, and Gemini.
 */
export function extractResponseInfo(rawReply, protocol = "chat", sanitizeOpts = {}) {
  if (!rawReply || typeof rawReply !== "object") {
    return {
      replyId: "",
      servedModel: "",
      finishReason: null,
      messages: [],
      toolCallsCount: 0,
      protocolUsage: null,
      rawUsage: null,
      rawResponse: null,
      errorText: "",
    };
  }

  const reply = sanitizePayload(rawReply, sanitizeOpts);
  const messages = [];
  let replyId = typeof reply.id === "string" ? reply.id : typeof reply.responseId === "string" ? reply.responseId : "";
  let servedModel = typeof reply.model === "string" ? reply.model : typeof reply.modelVersion === "string" ? reply.modelVersion : "";
  let finishReason = null;
  let toolCallsCount = 0;
  let errorText = "";

  if (reply.error) {
    errorText =
      typeof reply.error === "string"
        ? reply.error
        : typeof reply.error?.message === "string"
          ? reply.error.message
          : JSON.stringify(reply.error);
  }

  if (protocol === "responses") {
    finishReason = reply.incomplete_details?.reason || reply.status || null;
    if (Array.isArray(reply.output)) {
      const textParts = [];
      const reasoningParts = [];
      const toolCalls = [];
      for (const item of reply.output) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message") {
          const txt = extractTextFromBlocks(item.content);
          if (txt) textParts.push(txt);
        } else if (item.type === "reasoning") {
          const summaries = Array.isArray(item.summary) ? item.summary.map((s) => s?.text || "").filter(Boolean) : [];
          const contents = Array.isArray(item.content) ? item.content.map((c) => c?.text || "").filter(Boolean) : [];
          const rTxt = [...summaries, ...contents].join("\n");
          if (rTxt) reasoningParts.push(rTxt);
        } else if (item.type === "function_call") {
          toolCalls.push({
            id: item.call_id || item.id || "",
            name: item.name || "",
            arguments: parseJsonSafe(item.arguments),
          });
        }
      }
      toolCallsCount = toolCalls.length;
      if (textParts.length > 0 || toolCalls.length > 0 || reasoningParts.length > 0) {
        messages.push({
          role: "assistant",
          content: textParts.join("\n"),
          ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("\n") } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      if (toolCallsCount > 0 && finishReason === "completed") {
        finishReason = "tool_calls";
      }
    }
  } else if (protocol === "anthropic") {
    finishReason = reply.stop_reason || null;
    if (Array.isArray(reply.content)) {
      const textParts = [];
      const reasoningParts = [];
      const toolCalls = [];
      for (const block of reply.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          reasoningParts.push(block.thinking);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || "",
            name: block.name || "",
            arguments: block.input ?? {},
          });
        }
      }
      toolCallsCount = toolCalls.length;
      messages.push({
        role: "assistant",
        content: textParts.join("\n"),
        ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("\n") } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  } else if (protocol === "gemini") {
    const cand = Array.isArray(reply.candidates) ? reply.candidates[0] : null;
    if (cand && typeof cand === "object") {
      finishReason = cand.finishReason || null;
      const parts = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
      const textParts = [];
      const reasoningParts = [];
      const toolCalls = [];
      for (const p of parts) {
        if (!p || typeof p !== "object") continue;
        if (typeof p.text === "string") {
          if (p.thought === true) reasoningParts.push(p.text);
          else textParts.push(p.text);
        } else if (p.functionCall) {
          toolCalls.push({
            id: p.functionCall.id || "",
            name: p.functionCall.name || "",
            arguments: p.functionCall.args ?? {},
          });
        }
      }
      toolCallsCount = toolCalls.length;
      messages.push({
        role: "assistant",
        content: textParts.join("\n"),
        ...(reasoningParts.length > 0 ? { reasoning: reasoningParts.join("\n") } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  } else {
    // OpenAI Chat Completions
    const choice = Array.isArray(reply.choices) ? reply.choices[0] : null;
    if (choice && typeof choice === "object") {
      finishReason = choice.finish_reason || null;
      const msg = choice.message || {};
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
            .filter((tc) => tc && typeof tc === "object")
            .map((tc) => ({
              id: tc.id || "",
              name: tc.function?.name || tc.name || "",
              arguments: parseJsonSafe(tc.function?.arguments ?? tc.arguments),
            }))
        : [];
      if (msg.function_call && typeof msg.function_call === "object") {
        toolCalls.push({
          id: "",
          name: msg.function_call.name || "",
          arguments: parseJsonSafe(msg.function_call.arguments),
        });
      }
      toolCallsCount = toolCalls.length;
      const reasoning =
        typeof msg.reasoning_content === "string"
          ? msg.reasoning_content
          : typeof msg.reasoning === "string"
            ? msg.reasoning
            : "";
      messages.push({
        role: msg.role || "assistant",
        content: extractTextFromBlocks(msg.content),
        ...(reasoning ? { reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  const rawUsage = reply.usage ?? reply.usageMetadata ?? null;
  const protocolUsage = parseProtocolUsage(rawUsage, protocol);

  return {
    replyId,
    servedModel,
    finishReason,
    messages,
    toolCallsCount,
    protocolUsage,
    rawUsage,
    rawResponse: reply,
    errorText,
  };
}

function parseProtocolUsage(u, protocol) {
  if (!u || typeof u !== "object") return null;

  if (protocol === "gemini") {
    const promptTokens = Number(u.promptTokenCount || 0);
    const reasoningTokens = Number(u.thoughtsTokenCount || 0);
    const completionTokens = Number(u.candidatesTokenCount || 0) + reasoningTokens;
    const cachedTokens = Number(u.cachedContentTokenCount || 0);
    const totalTokens = Number(u.totalTokenCount || promptTokens + completionTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      ephemeral5mTokens: 0,
      ephemeral1hTokens: 0,
      reasoningTokens,
    };
  }

  if (protocol === "anthropic") {
    const uncachedIn = Number(u.input_tokens || 0);
    const cachedTokens = Number(u.cache_read_input_tokens || 0);
    const cacheWriteTokens = Number(u.cache_creation_input_tokens || 0);
    const promptTokens = uncachedIn + cachedTokens + cacheWriteTokens;
    const completionTokens = Number(u.output_tokens || 0);
    const ephemeral5m = Number(u.cache_creation?.ephemeral_5m_input_tokens || 0);
    const ephemeral1h = Number(u.cache_creation?.ephemeral_1h_input_tokens || 0);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens,
      cacheWriteTokens,
      ephemeral5mTokens: ephemeral5m || (cacheWriteTokens > 0 && ephemeral1h === 0 ? cacheWriteTokens : 0),
      ephemeral1hTokens: ephemeral1h,
      reasoningTokens: 0,
    };
  }

  if (protocol === "responses") {
    const promptTokens = Number(u.input_tokens || 0);
    const completionTokens = Number(u.output_tokens || 0);
    const cachedTokens = Number(u.input_tokens_details?.cached_tokens || 0);
    const reasoningTokens = Number(u.output_tokens_details?.reasoning_tokens || 0);
    const totalTokens = Number(u.total_tokens || promptTokens + completionTokens);
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      ephemeral5mTokens: 0,
      ephemeral1hTokens: 0,
      reasoningTokens,
    };
  }

  // OpenAI Chat Completions
  const promptTokens = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const completionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  const cachedTokens = Number(u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0);
  const cacheWriteTokens = Number(u.prompt_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens ?? 0);
  const reasoningTokens = Number(u.completion_tokens_details?.reasoning_tokens ?? 0);
  const totalTokens = Number(u.total_tokens || promptTokens + completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens,
    ephemeral5mTokens: cacheWriteTokens,
    ephemeral1hTokens: 0,
    reasoningTokens,
  };
}

function buildCombinedUsage(protocolUsage, ledger) {
  let promptTokens = protocolUsage?.promptTokens ?? 0;
  let completionTokens = protocolUsage?.completionTokens ?? 0;
  let cachedTokens = protocolUsage?.cachedTokens ?? 0;
  let cacheWriteTokens = protocolUsage?.cacheWriteTokens ?? 0;
  let ephemeral5m = protocolUsage?.ephemeral5mTokens ?? 0;
  let ephemeral1h = protocolUsage?.ephemeral1hTokens ?? 0;
  let reasoningTokens = protocolUsage?.reasoningTokens ?? 0;

  if (ledger) {
    // Magpie's ledger stores uncached input in `in` and separate `cache_read` / `cache_write`.
    const ledgerTotalPrompt = (ledger.inputTokens || 0) + (ledger.cacheReadTokens || 0) + (ledger.cacheWriteTokens || 0);
    if (promptTokens === 0 && ledgerTotalPrompt > 0) promptTokens = ledgerTotalPrompt;
    if (completionTokens === 0 && ledger.outputTokens > 0) completionTokens = ledger.outputTokens;
    if (cachedTokens === 0 && ledger.cacheReadTokens > 0) cachedTokens = ledger.cacheReadTokens;
    if (cacheWriteTokens === 0 && ledger.cacheWriteTokens > 0) {
      cacheWriteTokens = ledger.cacheWriteTokens;
      ephemeral1h = ledger.cacheWrite1hTokens || 0;
      ephemeral5m = Math.max(0, cacheWriteTokens - ephemeral1h);
    }
    if (reasoningTokens === 0 && ledger.reasoningTokens > 0) reasoningTokens = ledger.reasoningTokens;
  }

  const totalTokens = promptTokens + completionTokens;
  const totalCost = ledger?.costUsd ?? null;

  const promptTokensDetails = {
    cachedTokens,
    cacheWriteTokens,
    ...(cacheWriteTokens > 0
      ? {
          cacheCreation: {
            ephemeral_5m_input_tokens: ephemeral5m,
            ephemeral_1h_input_tokens: ephemeral1h,
          },
        }
      : {}),
  };

  const completionTokensDetails = {
    reasoningTokens,
  };

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    promptTokensDetails,
    completionTokensDetails,
    inputCost: null,
    outputCost: null,
    totalCost,
  };
}

/**
 * Evaluate request-time capture eligibility before routing.
 */
export function evaluatePreRequestGate(ctx = {}, config) {
  if (!config.enabled) return { allowed: false, reason: "disabled" };

  const origin = String(ctx.origin ?? "").trim();
  const isOwnMachine = origin === "local" || origin === "magpie-key";
  const isRemoteOrSharedKey = origin === "gateway-key" || origin === "remote";

  if (!isOwnMachine && !(isRemoteOrSharedKey && config.captureRemote)) {
    return { allowed: false, reason: "origin_filtered" };
  }

  if (config.skipSubagents && ctx.kind === "subagent") {
    return { allowed: false, reason: "subagent_skipped" };
  }

  const agentNorm = String(ctx.agent ?? "").trim().toLowerCase();
  if (agentNorm && config.skipAgents.some((a) => a.toLowerCase() === agentNorm)) {
    return { allowed: false, reason: "agent_skipped" };
  }

  const modelNorm = String(ctx.model ?? "").trim().toLowerCase();
  if (
    modelNorm &&
    config.excludedModels.some((m) => {
      const target = m.toLowerCase();
      return modelNorm === target || modelNorm.endsWith(`/${target}`);
    })
  ) {
    return { allowed: false, reason: "model_excluded" };
  }

  return { allowed: true, reason: "ok" };
}

/**
 * Evaluate post-response API key filter (matching OpenRouter's Included/Excluded API Keys rules:
 * exclusions take precedence over inclusions).
 */
export function evaluateApiKeyFilter(apiKeyName, config) {
  const keyNorm = String(apiKeyName ?? "").trim().toLowerCase();
  if (config.excludedApiKeys.length > 0) {
    if (config.excludedApiKeys.some((k) => k.toLowerCase() === keyNorm)) {
      return false;
    }
  }
  if (config.includedApiKeys.length > 0) {
    return config.includedApiKeys.some((k) => k.toLowerCase() === keyNorm);
  }
  return true;
}

function inferProviderFromModel(model = "") {
  const str = String(model || "").trim();
  if (str.includes("/")) return str.split("/")[0];
  const lower = str.toLowerCase();
  if (lower.startsWith("claude-")) return "anthropic";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || lower.startsWith("codex")) return "openai";
  if (lower.startsWith("gemini-")) return "google";
  if (lower.startsWith("deepseek-")) return "deepseek";
  return "magpie";
}

function deriveConversationTitle(reqInfo, query = "") {
  const q = String(query ?? "").trim();
  if (q) {
    const firstLine = q.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (firstLine) return firstLine.slice(0, 100);
  }
  const firstUser = reqInfo.messages.find((m) => m.role === "user" && m.content?.trim());
  if (firstUser) {
    const line = firstUser.content.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (line) return line.slice(0, 100);
  }
  return "";
}

/**
 * Build an OpenRouter Broadcast S3-compatible Trace JSON document from Magpie hook data + optional ledger row.
 */
export function buildOpenRouterTrace({
  requestBody,
  replyBody,
  ctx = {},
  startedAtMs,
  endedAtMs,
  ledger = null,
  config,
}) {
  const startMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const endMs = Number.isFinite(endedAtMs) && endedAtMs >= startMs ? endedAtMs : Math.max(startMs, Date.now());
  const protocol = ctx.protocol || "chat";
  const sanitizeOpts = {
    stripMultimodal: config.stripMultimodal !== false,
    redactSecrets: config.redactSecrets !== false,
  };

  const reqInfo = extractRequestInfo(requestBody, protocol, sanitizeOpts);
  const resInfo = extractResponseInfo(replyBody, protocol, sanitizeOpts);
  const usage = buildCombinedUsage(resInfo.protocolUsage, ledger);

  const customTrace = reqInfo.customTrace || {};
  const traceId =
    (typeof customTrace.trace_id === "string" && customTrace.trace_id.trim()) ||
    resInfo.replyId ||
    ledger?.requestId ||
    `trc_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const requestedModel = ledger?.requestedModel || ctx.model || requestBody?.model || "unknown";
  const servedModel = resInfo.servedModel || ledger?.servedModel || requestedModel;
  const provider = ledger?.provider || inferProviderFromModel(servedModel || requestedModel);
  const modelSlug = servedModel.includes("/") ? servedModel : `${provider}/${servedModel}`;

  const traceName =
    (typeof customTrace.trace_name === "string" && customTrace.trace_name.trim()) ||
    servedModel ||
    requestedModel;
  const generationName =
    (typeof customTrace.generation_name === "string" && customTrace.generation_name.trim()) ||
    (typeof customTrace.span_name === "string" && customTrace.span_name.trim()) ||
    servedModel ||
    requestedModel;

  const sessionId = ctx.session || reqInfo.bodySessionId || null;
  const userId = reqInfo.userId || null;
  const apiKeyName =
    ledger?.callerKeyName ||
    (ctx.origin === "local" || ctx.origin === "magpie-key" ? "local" : ctx.origin || "default");

  const wallLatencyMs = Math.max(0, Math.round(endMs - startMs));
  const latencyMs = ledger?.latencyMs ?? wallLatencyMs;
  const ttftMs = ledger?.ttftMs ?? null;

  const isSuccess = ctx.success !== false && (!ledger?.httpStatus || ledger.httpStatus < 400) && !resInfo.errorText;
  const httpStatus = ledger?.httpStatus ?? (isSuccess ? 200 : 500);
  const status = isSuccess ? "completed" : "error";

  const routerTiming = ledger?.routerTiming || {
    provider_ms: isSuccess ? latencyMs : 0,
    ...(isSuccess ? { provider_failed_ms: 0 } : { provider_failed_ms: latencyMs }),
    attempt_count: 1,
  };

  const privacyMode = Boolean(config.privacyMode);
  const ioLogging = Boolean(config.inputOutputLogging) && !privacyMode;

  // Custom metadata excluding reserved naming keys, merged with Magpie & OpenRouter generation metadata
  const customMetaRest = { ...customTrace };
  delete customMetaRest.trace_id;
  delete customMetaRest.trace_name;
  delete customMetaRest.span_name;
  delete customMetaRest.generation_name;

  const openrouterGenerationMeta = {
    cache_write_tokens: usage.promptTokensDetails.cacheWriteTokens,
    ...(usage.promptTokensDetails.cacheCreation
      ? { cache_creation: usage.promptTokensDetails.cacheCreation }
      : {}),
    usage_is_estimated: !resInfo.rawUsage && !ledger,
    upstream_raw_response_usage: privacyMode
      ? null
      : resInfo.rawUsage
        ? sanitizePayload(resInfo.rawUsage, sanitizeOpts)
        : null,
    ...(privacyMode ? { upstream_raw_response_usage_suppression_reason: "privacy_mode" } : {}),
  };

  const metadata = {
    ...customMetaRest,
    source: "magpie-s3-trace-sync",
    agent: ctx.agent || "unknown",
    origin: ctx.origin || "unknown",
    protocol,
    kind: ctx.kind || "main",
    ...(ctx.cwd ? { cwdHash: sha256Short(ctx.cwd) } : {}),
    hasTools: reqInfo.hasTools,
    toolDefinitionsCount: reqInfo.toolDefinitionsCount,
    toolCallsCount: resInfo.toolCallsCount,
    ...(ledger?.tierServed ? { serviceTier: ledger.tierServed } : {}),
    openrouter_generation: openrouterGenerationMeta,
  };

  // Follow OpenRouter Broadcast S3 rule for `tools`: when model called tools, move `tools` from rawRequest to output.tools.
  const rawReqOut = { ...reqInfo.rawRequest };
  let outputTools;
  if (resInfo.toolCallsCount > 0 && reqInfo.tools) {
    delete rawReqOut.tools;
    outputTools = reqInfo.tools;
  }

  const inputSection = ioLogging
    ? {
        ...(reqInfo.system ? { system: reqInfo.system } : {}),
        messages: reqInfo.messages,
      }
    : null;

  const outputSection = ioLogging
    ? {
        messages: resInfo.messages,
        ...(outputTools ? { tools: outputTools } : {}),
        rawRequest: rawReqOut,
        ...(resInfo.rawResponse ? { rawResponse: resInfo.rawResponse } : {}),
        ...(!isSuccess && (resInfo.errorText || ledger?.errorMessage)
          ? { error: scrubSecretsInText(resInfo.errorText || ledger.errorMessage) }
          : {}),
      }
    : null;

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  const observationId = `obs_${sha256Short(`${traceId}:${startMs}`)}`;
  const generationObservation = {
    id: observationId,
    traceId,
    ...(customTrace.parent_span_id ? { parentObservationId: String(customTrace.parent_span_id) } : {}),
    type: "GENERATION",
    name: generationName,
    model: modelSlug,
    provider,
    startTime: startIso,
    endTime: endIso,
    completionStartTime: ttftMs !== null ? new Date(startMs + ttftMs).toISOString() : null,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    promptTokensDetails: usage.promptTokensDetails,
    completionTokensDetails: usage.completionTokensDetails,
    inputCost: usage.inputCost,
    outputCost: usage.outputCost,
    totalCost: usage.totalCost,
    modelParameters: reqInfo.modelParameters,
    finishReason: resInfo.finishReason,
    statusMessage: !isSuccess && !privacyMode ? scrubSecretsInText(resInfo.errorText || ledger?.errorMessage || "") || null : null,
    input: ioLogging ? reqInfo.messages : null,
    output: ioLogging ? resInfo.messages : null,
    metadata,
  };

  const title = ioLogging ? deriveConversationTitle(reqInfo, ctx.query) : "";

  return {
    schema: "openrouter.broadcast.s3.v1",
    id: traceId,
    name: traceName,
    ...(title ? { title } : {}),
    timestamp: endIso,
    startTime: startIso,
    endTime: endIso,
    userId,
    sessionId,
    gatewayKey: apiKeyName,
    apiKeyName,
    origin: ctx.origin || "local",
    agent: ctx.agent || "unknown",
    protocol,
    path: ctx.path || "",
    stream: Boolean(ctx.stream),
    status,
    httpStatus,
    ...(ledger?.errorType ? { errorType: ledger.errorType } : {}),
    model: modelSlug,
    requestedModel,
    servedModel,
    provider,
    upstream: ledger?.upstream || null,
    finishReason: resInfo.finishReason,
    latencyMs,
    ttftMs,
    ...(ledger?.flowMs ? { flowMs: ledger.flowMs } : {}),
    modelParameters: reqInfo.modelParameters,
    routerTiming,
    usage,
    privacyMode,
    inputOutputLogging: ioLogging,
    input: inputSection,
    output: outputSection,
    metadata,
    trace: {
      id: traceId,
      name: traceName,
      userId,
      sessionId,
      startTime: startIso,
      endTime: endIso,
      routerTiming,
      metadata,
      observations: [generationObservation],
    },
  };
}
