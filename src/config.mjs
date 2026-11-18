import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 3483;
export const DEFAULT_PATH_TEMPLATE = "openrouter-traces/{date}";
export const DEFAULT_PREFIX = "openrouter-traces";
// Cloudflare R2 is the preferred default S3-compatible provider.
export const PROVIDERS = ["r2", "aws", "gcs", "custom"];
export const R2_JURISDICTIONS = ["default", "eu", "fedramp"];
export const STORAGE_CLASSES = ["STANDARD", "STANDARD_IA"];
export const EXPORT_MODES = ["single", "batch"];

export const DEFAULT_OPTIONS = Object.freeze({
  enabled: false,
  provider: "r2", // Preferred: Cloudflare R2 S3-compatible storage
  accountId: "", // Cloudflare Account ID (auto-builds https://<ACCOUNT_ID>.r2.cloudflarestorage.com)
  r2Jurisdiction: "default", // "default" | "eu" | "fedramp"
  bucket: "",
  region: "auto",
  endpoint: "",
  forcePathStyle: true,
  allowInsecureHttp: false,
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  storageClass: "STANDARD", // R2 supports STANDARD and STANDARD_IA
  sse: "none", // AWS/Custom only ("none" | "AES256" | "aws:kms"); R2 encrypts at rest automatically
  sseKmsKeyId: "",
  prefix: DEFAULT_PREFIX,
  pathTemplate: DEFAULT_PATH_TEMPLATE,
  exportMode: "single", // "single" | "batch"
  batchMaxItems: 20,
  batchFlushIntervalMs: 10000,
  inputOutputLogging: true,
  privacyMode: false,
  stripMultimodal: true,
  redactSecrets: true,
  captureErrors: true,
  captureRemote: false,
  skipSubagents: false,
  includedApiKeys: [],
  excludedApiKeys: [],
  skipAgents: [],
  excludedModels: [],
  localCache: true,
  maxLocalTraces: 500,
  s3TimeoutMs: 8000,
  gatewayTimeoutMs: 10000,
  port: DEFAULT_PORT,
});

/**
 * Build the official Cloudflare R2 S3 API endpoint from Account ID and optional jurisdiction.
 */
export function buildR2Endpoint(accountId, jurisdiction = "default") {
  const id = String(accountId ?? "").trim().toLowerCase();
  if (!id || !/^[a-f0-9]{32}$/i.test(id) && !/^[a-z0-9-]{6,64}$/i.test(id)) {
    return "";
  }
  const jur = String(jurisdiction ?? "default").trim().toLowerCase();
  if (jur === "eu") return `https://${id}.eu.r2.cloudflarestorage.com`;
  if (jur === "fedramp") return `https://${id}.fedramp.r2.cloudflarestorage.com`;
  return `https://${id}.r2.cloudflarestorage.com`;
}

/**
 * Extract Account ID and jurisdiction if an R2 endpoint URL was provided directly.
 */
export function parseR2Endpoint(endpoint) {
  const m = /^https:\/\/([a-z0-9-]+)\.(?:(eu|fedramp)\.)?r2\.cloudflarestorage\.com\/?$/i.exec(
    String(endpoint ?? "").trim()
  );
  if (!m) return null;
  return {
    accountId: m[1].toLowerCase(),
    jurisdiction: (m[2] || "default").toLowerCase(),
  };
}

/**
 * Resolve Magpie's configuration directory without creating directories at import time.
 * Inside Magpie's plugin host, process.cwd() is Magpie's config directory (beside plugins.json / usage.jsonl).
 */
export function resolveMagpieConfigDir(env = process.env, cwd = process.cwd()) {
  if (env.MAGPIE_CONFIG_DIR && path.isAbsolute(env.MAGPIE_CONFIG_DIR)) {
    return env.MAGPIE_CONFIG_DIR;
  }
  try {
    if (
      fs.existsSync(path.join(cwd, "plugins.json")) ||
      fs.existsSync(path.join(cwd, "providers.json")) ||
      fs.existsSync(path.join(cwd, "usage.jsonl"))
    ) {
      return cwd;
    }
  } catch {
    // Ignore permission errors during directory probing.
  }
  if (env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) {
    return path.join(env.XDG_CONFIG_HOME, "magpie");
  }
  return path.join(os.homedir(), ".config", "magpie");
}

export function resolveStateDir(options = {}, env = process.env, cwd = process.cwd()) {
  if (typeof options.stateDir === "string" && options.stateDir.trim() && path.isAbsolute(options.stateDir.trim())) {
    return options.stateDir.trim();
  }
  if (env.S3_TRACE_STATE_DIR && path.isAbsolute(env.S3_TRACE_STATE_DIR)) {
    return env.S3_TRACE_STATE_DIR;
  }
  return path.join(resolveMagpieConfigDir(env, cwd), "plugin-work", "s3-trace-sync");
}

export async function ensureSecureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      await fsp.chmod(dir, 0o700);
    } catch {
      // Best effort on restricted mounts.
    }
  }
}

let cachedOverlay = { file: "", mtimeMs: -1, data: {} };

export function readLocalOverlaySync(stateDir) {
  const file = path.join(stateDir, "config.json");
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return {};
    if (cachedOverlay.file === file && cachedOverlay.mtimeMs === stat.mtimeMs) {
      return cachedOverlay.data;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cachedOverlay = { file, mtimeMs: stat.mtimeMs, data: parsed };
      return parsed;
    }
  } catch {
    // Missing or unreadable overlay simply returns empty object.
  }
  return {};
}

export async function writeLocalOverlay(stateDir, updates) {
  await ensureSecureDir(stateDir);
  const file = path.join(stateDir, "config.json");
  const current = readLocalOverlaySync(stateDir);
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(next, null, 2) + "\n";
  await fsp.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, file);
  cachedOverlay = { file: "", mtimeMs: -1, data: {} };
  return next;
}

export function parseStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v ?? "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    return [...new Set(value.split(/[,;\n]+/).map((v) => v.trim()).filter(Boolean))];
  }
  return [];
}

function parseBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(v)) return true;
    if (["0", "false", "no", "off"].includes(v)) return false;
  }
  return fallback;
}

function clampInt(value, fallback, min, max) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return "";
}

function inferProvider(explicitProvider, endpoint, accountId) {
  const p = String(explicitProvider ?? "").trim().toLowerCase();
  if (PROVIDERS.includes(p)) return p;
  const ep = String(endpoint ?? "").trim().toLowerCase();
  if (ep.includes(".r2.cloudflarestorage.com")) return "r2";
  if (ep.includes("storage.googleapis.com")) return "gcs";
  if (ep.includes("amazonaws.com")) return "aws";
  if (accountId) return "r2";
  if (ep) return "custom";
  // Preferred default is Cloudflare R2
  return "r2";
}

/**
 * Validate an endpoint URL for safety: no embedded user:pass credentials,
 * no query/hash, and HTTP allowed only on loopback or when allowInsecureHttp is true.
 */
export function validateEndpointUrl(rawEndpoint, allowInsecureHttp = false) {
  const trimmed = String(rawEndpoint ?? "").trim();
  if (!trimmed) return { ok: true, url: "" };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Custom endpoint must be a valid http:// or https:// URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Custom endpoint protocol must be https:// or http://." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "Custom endpoint URL must not embed credentials." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: "Custom endpoint URL must not include query parameters or fragments." };
  }
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol === "http:" && !isLoopback && !allowInsecureHttp) {
    return {
      ok: false,
      error: "Plain HTTP to a non-loopback S3 endpoint requires enabling 'Allow Insecure HTTP' first.",
    };
  }
  return { ok: true, url: trimmed.replace(/\/+$/, "") };
}

/**
 * Validate bucket name according to Cloudflare R2 (error 10005 InvalidBucketName) & S3 rules.
 */
export function validateBucketName(bucket, provider = "r2") {
  const b = String(bucket ?? "").trim();
  if (!b) return { ok: true };
  if (provider === "r2") {
    // R2 error 10005: Bucket names must be 3-63 chars, lowercase alphanumeric and hyphens, start/end with alphanumeric.
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b)) {
      return {
        ok: false,
        error:
          "Cloudflare R2 bucket names (code 10005) must be 3–63 characters of lowercase letters, numbers, and hyphens, starting and ending with a letter or number.",
      };
    }
    return { ok: true };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/.test(b)) {
    return {
      ok: false,
      error: "Bucket name must be 3–63 characters of letters, numbers, dots, underscores, or hyphens.",
    };
  }
  return { ok: true };
}

/**
 * Merge local UI config overlay -> Magpie plugin options -> environment variables -> defaults.
 */
export function resolveConfig(pluginOptions = {}, env = process.env, cwd = process.cwd()) {
  const opts = pluginOptions && typeof pluginOptions === "object" ? pluginOptions : {};
  const stateDir = resolveStateDir(opts, env, cwd);
  const overlay = opts.ignoreOverlay ? {} : readLocalOverlaySync(stateDir);
  const merged = { ...opts, ...overlay };

  const envAccountId = pickString(
    env.R2_ACCOUNT_ID,
    env.CLOUDFLARE_ACCOUNT_ID,
    env.S3_TRACE_ACCOUNT_ID,
    env.BACKUP_S3_ACCOUNT_ID
  );
  const envJurisdiction = pickString(env.R2_JURISDICTION, env.S3_TRACE_R2_JURISDICTION);
  const envBucket = pickString(env.R2_BUCKET, env.S3_TRACE_BUCKET, env.BACKUP_S3_BUCKET);
  const envEndpoint = pickString(env.R2_ENDPOINT, env.S3_TRACE_ENDPOINT, env.BACKUP_S3_ENDPOINT);
  const envRegion = pickString(env.S3_TRACE_REGION, env.BACKUP_S3_REGION, env.AWS_REGION, env.AWS_DEFAULT_REGION);
  const envAk = pickString(
    env.R2_ACCESS_KEY_ID,
    env.S3_TRACE_ACCESS_KEY_ID,
    env.BACKUP_S3_AK,
    env.AWS_ACCESS_KEY_ID
  );
  const envSk = pickString(
    env.R2_SECRET_ACCESS_KEY,
    env.S3_TRACE_SECRET_ACCESS_KEY,
    env.BACKUP_S3_SK,
    env.AWS_SECRET_ACCESS_KEY
  );
  const envToken = pickString(env.S3_TRACE_SESSION_TOKEN, env.BACKUP_S3_SESSION_TOKEN, env.AWS_SESSION_TOKEN);

  let accountId = pickString(merged.accountId, envAccountId);
  const r2JurisdictionRaw = pickString(merged.r2Jurisdiction, envJurisdiction, "default").toLowerCase();
  let r2Jurisdiction = R2_JURISDICTIONS.includes(r2JurisdictionRaw) ? r2JurisdictionRaw : "default";

  let rawEndpoint = pickString(merged.endpoint, envEndpoint);
  const provider = inferProvider(merged.provider ?? env.S3_TRACE_PROVIDER, rawEndpoint, accountId);

  if (provider === "r2") {
    if (!rawEndpoint && accountId) {
      rawEndpoint = buildR2Endpoint(accountId, r2Jurisdiction);
    } else if (rawEndpoint && !accountId) {
      const parsedR2 = parseR2Endpoint(rawEndpoint);
      if (parsedR2) {
        accountId = parsedR2.accountId;
        r2Jurisdiction = parsedR2.jurisdiction;
      }
    }
  }

  const bucket = pickString(merged.bucket, envBucket);
  const defaultRegion = provider === "r2" || provider === "gcs" ? "auto" : "us-east-1";
  const region = pickString(merged.region, envRegion, defaultRegion);
  const accessKeyId = pickString(merged.accessKeyId, envAk);
  const secretAccessKey = pickString(merged.secretAccessKey, envSk);
  const sessionToken = pickString(merged.sessionToken, envToken);

  const implicitEnvEnable = Boolean(
    envBucket &&
      envAk &&
      envSk &&
      (provider === "aws" || provider === "gcs" || rawEndpoint || accountId)
  );
  const enabled =
    merged.enabled !== undefined
      ? parseBool(merged.enabled, DEFAULT_OPTIONS.enabled)
      : env.S3_TRACE_ENABLED !== undefined
        ? parseBool(env.S3_TRACE_ENABLED, false)
        : implicitEnvEnable;

  const allowInsecureHttp = parseBool(
    merged.allowInsecureHttp ?? env.S3_TRACE_ALLOW_INSECURE_HTTP,
    DEFAULT_OPTIONS.allowInsecureHttp
  );
  const defaultPathStyle = provider !== "aws";
  const forcePathStyle = parseBool(merged.forcePathStyle ?? env.S3_TRACE_FORCE_PATH_STYLE, defaultPathStyle);

  const storageClassRaw = pickString(merged.storageClass, env.S3_TRACE_STORAGE_CLASS, "STANDARD").toUpperCase();
  const storageClass = STORAGE_CLASSES.includes(storageClassRaw) ? storageClassRaw : "STANDARD";

  const sseRaw = pickString(merged.sse, env.S3_TRACE_SSE, "none");
  const sse = ["none", "AES256", "aws:kms"].includes(sseRaw) ? sseRaw : "none";
  const sseKmsKeyId = pickString(merged.sseKmsKeyId, env.S3_TRACE_SSE_KMS_KEY_ID);

  const prefix =
    pickString(merged.prefix, env.S3_TRACE_PREFIX, DEFAULT_PREFIX).replace(/^\/+|\/+$/g, "") || DEFAULT_PREFIX;
  const pathTemplate =
    pickString(merged.pathTemplate, env.S3_TRACE_PATH_TEMPLATE, DEFAULT_PATH_TEMPLATE).replace(/^\/+|\/+$/g, "") ||
    DEFAULT_PATH_TEMPLATE;

  const exportModeRaw = pickString(merged.exportMode, env.S3_TRACE_EXPORT_MODE, "single").toLowerCase();
  const exportMode = EXPORT_MODES.includes(exportModeRaw) ? exportModeRaw : "single";

  const config = {
    enabled,
    provider,
    accountId,
    r2Jurisdiction,
    bucket,
    region,
    endpoint: rawEndpoint,
    forcePathStyle,
    allowInsecureHttp,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    storageClass,
    sse,
    sseKmsKeyId,
    prefix,
    pathTemplate,
    exportMode,
    batchMaxItems: clampInt(merged.batchMaxItems ?? env.S3_TRACE_BATCH_MAX_ITEMS, DEFAULT_OPTIONS.batchMaxItems, 1, 500),
    batchFlushIntervalMs: clampInt(
      merged.batchFlushIntervalMs ?? env.S3_TRACE_BATCH_FLUSH_MS,
      DEFAULT_OPTIONS.batchFlushIntervalMs,
      1000,
      300000
    ),
    inputOutputLogging: parseBool(
      merged.inputOutputLogging ?? env.S3_TRACE_IO_LOGGING,
      DEFAULT_OPTIONS.inputOutputLogging
    ),
    privacyMode: parseBool(merged.privacyMode ?? env.S3_TRACE_PRIVACY_MODE, DEFAULT_OPTIONS.privacyMode),
    stripMultimodal: parseBool(
      merged.stripMultimodal ?? env.S3_TRACE_STRIP_MULTIMODAL,
      DEFAULT_OPTIONS.stripMultimodal
    ),
    redactSecrets: parseBool(merged.redactSecrets ?? env.S3_TRACE_REDACT_SECRETS, DEFAULT_OPTIONS.redactSecrets),
    captureErrors: parseBool(merged.captureErrors ?? env.S3_TRACE_CAPTURE_ERRORS, DEFAULT_OPTIONS.captureErrors),
    captureRemote: parseBool(merged.captureRemote ?? env.S3_TRACE_CAPTURE_REMOTE, DEFAULT_OPTIONS.captureRemote),
    skipSubagents: parseBool(merged.skipSubagents ?? env.S3_TRACE_SKIP_SUBAGENTS, DEFAULT_OPTIONS.skipSubagents),
    includedApiKeys: parseStringList(merged.includedApiKeys ?? env.S3_TRACE_INCLUDED_API_KEYS),
    excludedApiKeys: parseStringList(merged.excludedApiKeys ?? env.S3_TRACE_EXCLUDED_API_KEYS),
    skipAgents: parseStringList(merged.skipAgents ?? env.S3_TRACE_SKIP_AGENTS),
    excludedModels: parseStringList(merged.excludedModels ?? env.S3_TRACE_EXCLUDED_MODELS),
    localCache: parseBool(merged.localCache ?? env.S3_TRACE_LOCAL_CACHE, DEFAULT_OPTIONS.localCache),
    maxLocalTraces: clampInt(
      merged.maxLocalTraces ?? env.S3_TRACE_MAX_LOCAL_TRACES,
      DEFAULT_OPTIONS.maxLocalTraces,
      10,
      5000
    ),
    s3TimeoutMs: clampInt(merged.s3TimeoutMs ?? env.S3_TRACE_TIMEOUT_MS, DEFAULT_OPTIONS.s3TimeoutMs, 500, 30000),
    gatewayTimeoutMs: clampInt(merged.gatewayTimeoutMs, DEFAULT_OPTIONS.gatewayTimeoutMs, 100, 30000),
    port: clampInt(merged.port ?? env.PORT ?? env.S3_TRACE_PORT, DEFAULT_PORT, 1, 65535),
    stateDir,
    magpieConfigDir: resolveMagpieConfigDir(env, cwd),
    credentialSources: {
      accountIdFromEnv: !merged.accountId && Boolean(envAccountId),
      bucketFromEnv: !merged.bucket && Boolean(envBucket),
      accessKeyFromEnv: !merged.accessKeyId && Boolean(envAk),
      secretKeyFromEnv: !merged.secretAccessKey && Boolean(envSk),
      sessionTokenFromEnv: !merged.sessionToken && Boolean(envToken),
    },
  };

  const epValidation = validateEndpointUrl(config.endpoint, config.allowInsecureHttp);
  config.endpointValid = epValidation.ok;
  config.endpointError = epValidation.error || "";
  if (epValidation.ok) config.endpoint = epValidation.url;

  const bucketValidation = validateBucketName(config.bucket, config.provider);
  config.bucketValid = bucketValidation.ok;
  config.bucketError = bucketValidation.error || "";

  config.s3Configured = Boolean(
    config.bucket &&
      config.bucketValid &&
      config.accessKeyId &&
      config.secretAccessKey &&
      config.endpointValid &&
      (config.provider === "aws" || config.provider === "gcs" || Boolean(config.endpoint))
  );

  return config;
}

export function maskSecret(value) {
  if (!value || typeof value !== "string") return "";
  if (value.length <= 6) return "••••••";
  return `${value.slice(0, 2)}••••••${value.slice(-4)}`;
}

/**
 * Serialize config safely for browser clients — NEVER expose raw secretAccessKey or sessionToken!
 */
export function publicConfigView(config) {
  return {
    enabled: config.enabled,
    s3Configured: config.s3Configured,
    provider: config.provider,
    accountId: config.accountId,
    r2Jurisdiction: config.r2Jurisdiction,
    bucket: config.bucket,
    bucketValid: config.bucketValid,
    bucketError: config.bucketError,
    region: config.region,
    endpoint: config.endpoint,
    endpointValid: config.endpointValid,
    endpointError: config.endpointError,
    forcePathStyle: config.forcePathStyle,
    allowInsecureHttp: config.allowInsecureHttp,
    accessKeyId: config.accessKeyId,
    hasSecretAccessKey: Boolean(config.secretAccessKey),
    secretAccessKeyHint: maskSecret(config.secretAccessKey),
    hasSessionToken: Boolean(config.sessionToken),
    sessionTokenHint: maskSecret(config.sessionToken),
    credentialSources: config.credentialSources,
    storageClass: config.storageClass,
    sse: config.sse,
    sseKmsKeyId: config.sseKmsKeyId,
    prefix: config.prefix,
    pathTemplate: config.pathTemplate,
    exportMode: config.exportMode,
    batchMaxItems: config.batchMaxItems,
    batchFlushIntervalMs: config.batchFlushIntervalMs,
    inputOutputLogging: config.inputOutputLogging,
    privacyMode: config.privacyMode,
    stripMultimodal: config.stripMultimodal,
    redactSecrets: config.redactSecrets,
    captureErrors: config.captureErrors,
    captureRemote: config.captureRemote,
    skipSubagents: config.skipSubagents,
    includedApiKeys: config.includedApiKeys,
    excludedApiKeys: config.excludedApiKeys,
    skipAgents: config.skipAgents,
    excludedModels: config.excludedModels,
    localCache: config.localCache,
    maxLocalTraces: config.maxLocalTraces,
    s3TimeoutMs: config.s3TimeoutMs,
    gatewayTimeoutMs: config.gatewayTimeoutMs,
    port: config.port,
  };
}

/**
 * Validate and sanitize incoming settings updates from the UI before persisting.
 */
export function sanitizeSettingsPatch(body = {}, defaultProvider = "r2") {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Settings payload must be a JSON object.");
  }
  const patch = {};
  const boolFields = [
    "enabled",
    "forcePathStyle",
    "allowInsecureHttp",
    "inputOutputLogging",
    "privacyMode",
    "stripMultimodal",
    "redactSecrets",
    "captureErrors",
    "captureRemote",
    "skipSubagents",
    "localCache",
  ];
  for (const key of boolFields) {
    if (key in body && typeof body[key] === "boolean") {
      patch[key] = body[key];
    }
  }

  let effectiveProvider = PROVIDERS.includes(String(defaultProvider).toLowerCase())
    ? String(defaultProvider).toLowerCase()
    : "r2";
  if ("provider" in body) {
    const p = String(body.provider ?? "").trim().toLowerCase();
    if (!PROVIDERS.includes(p)) throw new Error(`Unsupported S3 provider: ${body.provider}`);
    patch.provider = p;
    effectiveProvider = p;
  }

  if ("r2Jurisdiction" in body) {
    const j = String(body.r2Jurisdiction ?? "default").trim().toLowerCase();
    if (!R2_JURISDICTIONS.includes(j)) throw new Error(`Unsupported R2 jurisdiction: ${body.r2Jurisdiction}`);
    patch.r2Jurisdiction = j;
  }

  if ("storageClass" in body) {
    const sc = String(body.storageClass ?? "STANDARD").trim().toUpperCase();
    if (!STORAGE_CLASSES.includes(sc)) throw new Error(`Unsupported storage class: ${body.storageClass}`);
    patch.storageClass = sc;
  }

  const textFields = [
    "accountId",
    "bucket",
    "region",
    "endpoint",
    "accessKeyId",
    "sseKmsKeyId",
    "prefix",
    "pathTemplate",
  ];
  for (const key of textFields) {
    if (key in body) {
      if (body[key] === null) {
        patch[key] = null;
      } else if (typeof body[key] === "string") {
        const cleaned = body[key].trim();
        if (/[\u0000-\u001f\u007f]/.test(cleaned)) {
          throw new Error(`Invalid control characters in ${key}.`);
        }
        patch[key] = cleaned;
      }
    }
  }

  if ("accountId" in patch && patch.accountId) {
    if (!/^[A-Za-z0-9-]{6,64}$/.test(patch.accountId)) {
      throw new Error("Cloudflare Account ID must contain only letters, numbers, or hyphens.");
    }
    patch.accountId = patch.accountId.toLowerCase();
  }

  if (effectiveProvider === "r2" && !patch.endpoint && patch.accountId) {
    patch.endpoint = buildR2Endpoint(patch.accountId, patch.r2Jurisdiction || body.r2Jurisdiction || "default");
  }

  if ("endpoint" in patch && patch.endpoint) {
    const allowHttp = Boolean(patch.allowInsecureHttp ?? body.allowInsecureHttp);
    const check = validateEndpointUrl(patch.endpoint, allowHttp);
    if (!check.ok) throw new Error(check.error);
    patch.endpoint = check.url;
  }

  if ("bucket" in patch && patch.bucket) {
    const bCheck = validateBucketName(patch.bucket, effectiveProvider);
    if (!bCheck.ok) throw new Error(bCheck.error);
  }

  if ("sse" in body) {
    const sse = String(body.sse ?? "none").trim();
    if (!["none", "AES256", "aws:kms"].includes(sse)) throw new Error("Invalid SSE mode.");
    patch.sse = sse;
  }

  if ("exportMode" in body) {
    const mode = String(body.exportMode ?? "single").trim().toLowerCase();
    if (!EXPORT_MODES.includes(mode)) throw new Error("Export mode must be 'single' or 'batch'.");
    patch.exportMode = mode;
  }

  const intSpecs = [
    ["batchMaxItems", 1, 500],
    ["batchFlushIntervalMs", 1000, 300000],
    ["maxLocalTraces", 10, 5000],
    ["s3TimeoutMs", 500, 30000],
    ["gatewayTimeoutMs", 100, 30000],
    ["port", 1024, 65535],
  ];
  for (const [key, min, max] of intSpecs) {
    if (key in body && body[key] !== "" && body[key] !== null) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`${key} must be an integer between ${min} and ${max}.`);
      }
      patch[key] = n;
    }
  }

  const listFields = ["includedApiKeys", "excludedApiKeys", "skipAgents", "excludedModels"];
  for (const key of listFields) {
    if (key in body) {
      patch[key] = parseStringList(body[key]);
    }
  }

  if (body.clearSecretAccessKey === true) {
    patch.secretAccessKey = null;
  } else if (typeof body.secretAccessKey === "string" && body.secretAccessKey.trim() !== "") {
    if (/[\u0000-\u001f\u007f]/.test(body.secretAccessKey)) {
      throw new Error("Invalid control characters in secretAccessKey.");
    }
    patch.secretAccessKey = body.secretAccessKey.trim();
  }

  if (body.clearSessionToken === true) {
    patch.sessionToken = null;
  } else if (typeof body.sessionToken === "string" && body.sessionToken.trim() !== "") {
    if (/[\u0000-\u001f\u007f]/.test(body.sessionToken)) {
      throw new Error("Invalid control characters in sessionToken.");
    }
    patch.sessionToken = body.sessionToken.trim();
  }

  return patch;
}
