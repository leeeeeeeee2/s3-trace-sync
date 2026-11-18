import { createHash, createHmac } from "node:crypto";
import {
  DEFAULT_PATH_TEMPLATE,
  DEFAULT_PREFIX,
  validateBucketName,
  validateEndpointUrl,
} from "./config.mjs";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const MAX_OBJECT_KEY_BYTES = 1024; // R2 error 10020: Maximum key length is 1024 bytes.

/**
 * Official Cloudflare R2 S3-compatible error codes reference:
 * https://developers.cloudflare.com/r2/api/error-codes/
 */
export const R2_ERROR_CATALOG = Object.freeze({
  Unauthorized: {
    r2Code: 10002,
    status: 401,
    retriable: false,
    hint: "Verify your Cloudflare R2 API token Access Key ID and Secret Access Key.",
  },
  AccessDenied: {
    r2Code: 10003,
    status: 403,
    retriable: false,
    hint: "Check that your R2 API token has Object Write (or Object Read & Write) permission on this bucket.",
  },
  ExpiredRequest: {
    r2Code: 10018,
    status: 403,
    retriable: false,
    hint: "Request signature expired; check system clock synchronization (NTP).",
  },
  SignatureDoesNotMatch: {
    r2Code: 10035,
    status: 403,
    retriable: false,
    hint: "Verify your R2 Secret Access Key, Account ID endpoint, and region ('auto').",
  },
  NotEntitled: {
    r2Code: 10042,
    status: 403,
    retriable: false,
    hint: "Ensure your Cloudflare account has an active R2 subscription.",
  },
  InvalidBucketName: {
    r2Code: 10005,
    status: 400,
    retriable: false,
    hint: "Bucket names must be 3–63 chars of lowercase letters, numbers, and hyphens.",
  },
  NoSuchBucket: {
    r2Code: 10006,
    status: 404,
    retriable: false,
    hint: "Verify the bucket name exists under this Cloudflare Account ID and jurisdiction.",
  },
  NoSuchKey: {
    r2Code: 10007,
    status: 404,
    retriable: false,
    hint: "The specified object key does not exist in the bucket.",
  },
  InvalidObjectName: {
    r2Code: 10020,
    status: 400,
    retriable: false,
    hint: "Object key must be valid UTF-8 and <= 1024 bytes.",
  },
  EntityTooLarge: {
    r2Code: 100100,
    status: 400,
    retriable: false,
    hint: "Object exceeds R2 5 GiB single PUT limit.",
  },
  MetadataTooLarge: {
    r2Code: 10012,
    status: 400,
    retriable: false,
    hint: "Custom metadata exceeds R2 8,192-byte limit.",
  },
  ObjectLockedByBucketPolicy: {
    r2Code: 10069,
    status: 409,
    retriable: false,
    hint: "Object is protected by a bucket lock rule.",
  },
  MissingContentLength: {
    r2Code: 10033,
    status: 411,
    retriable: false,
    hint: "Content-Length header is required on PUT/POST requests.",
  },
  IncompleteBody: {
    r2Code: 10013,
    status: 400,
    retriable: true,
    hint: "Request body terminated early; check network stability.",
  },
  InvalidDigest: {
    r2Code: 10014,
    status: 400,
    retriable: false,
    hint: "Content-MD5 or checksum digest header is malformed.",
  },
  BadDigest: {
    r2Code: 10037,
    status: 400,
    retriable: true,
    hint: "Content-MD5 digest did not match uploaded payload.",
  },
  InvalidRange: {
    r2Code: 10039,
    status: 416,
    retriable: false,
    hint: "Requested byte range is out of bounds.",
  },
  PreconditionFailed: {
    r2Code: 10031,
    status: 412,
    retriable: false,
    hint: "Conditional header (If-Match / If-None-Match) failed.",
  },
  TooManyRequests: {
    r2Code: 10058,
    status: 429,
    retriable: true,
    hint: "R2 rate limit exceeded (1 write/second per object key); backing off.",
  },
  ClientDisconnect: {
    r2Code: 10054,
    status: 400,
    retriable: true,
    hint: "Client disconnected before upload completed.",
  },
  InternalError: {
    r2Code: 10001,
    status: 500,
    retriable: true,
    hint: "Cloudflare R2 transient internal error.",
  },
  ServiceUnavailable: {
    r2Code: 10043,
    status: 503,
    retriable: true,
    hint: "Cloudflare R2 temporarily unavailable; retry with backoff.",
  },
});

export function sha256Hex(input) {
  if (input === "" || input === undefined || input === null) return EMPTY_SHA256;
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (buf.length === 0) return EMPTY_SHA256;
  return createHash("sha256").update(buf).digest("hex");
}

export function md5Base64(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input || "");
  return createHash("md5").update(buf).digest("base64");
}

function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Strict RFC 3986 percent-encoding as required by AWS Signature Version 4.
 */
export function uriEncode(value, encodeSlash = true) {
  const str = String(value ?? "");
  let encoded = encodeURIComponent(str).replace(
    /[!'()*]/g,
    (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase()
  );
  if (!encodeSlash) {
    encoded = encoded.replace(/%2F/gi, "/");
  }
  return encoded;
}

export function formatAmzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

export function effectiveSigningRegion(config) {
  const raw = String(config.region ?? "").trim();
  if (config.provider === "r2") {
    // R2 S3 API uses region "auto" (empty and "us-east-1" also alias to "auto" on R2).
    return raw || "auto";
  }
  if (config.provider === "gcs") {
    return raw || "auto";
  }
  if (!raw || raw.toLowerCase() === "auto") {
    return "us-east-1";
  }
  return raw;
}

function canUseVirtualHost(bucket) {
  return (
    typeof bucket === "string" &&
    bucket.length >= 3 &&
    bucket.length <= 63 &&
    !bucket.includes(".") &&
    /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(bucket)
  );
}

/**
 * Resolve the target S3 HTTP URL, canonical URI path, and signing region for a request.
 */
export function resolveS3Target(config, objectKey = "", queryParams = {}) {
  const bucket = String(config.bucket ?? "").trim();
  if (!bucket) {
    throw new Error("Bucket name is required.");
  }
  const region = effectiveSigningRegion(config);
  const cleanKey = String(objectKey ?? "").replace(/^\/+/, "");

  let baseUrl;
  let usePathStyle = Boolean(config.forcePathStyle);

  if (config.provider === "gcs" && !config.endpoint) {
    baseUrl = new URL("https://storage.googleapis.com");
    usePathStyle = true;
  } else if (config.endpoint) {
    baseUrl = new URL(config.endpoint);
    if (config.provider !== "aws") {
      // Cloudflare R2, GCS, and custom S3-compatible services address buckets via path-style:
      // https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>/<KEY>
      usePathStyle = config.provider === "r2" ? true : Boolean(config.forcePathStyle ?? true);
    }
  } else if (config.provider === "r2") {
    throw new Error(
      "Cloudflare Account ID or R2 S3 Endpoint URL (https://<ACCOUNT_ID>.r2.cloudflarestorage.com) is required."
    );
  } else {
    // Standard AWS S3 endpoint
    if (!usePathStyle && canUseVirtualHost(bucket)) {
      baseUrl = new URL(`https://${bucket}.s3.${region}.amazonaws.com`);
    } else {
      baseUrl = new URL(`https://s3.${region}.amazonaws.com`);
      usePathStyle = true;
    }
  }

  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  let rawPath;
  if (usePathStyle) {
    const alreadyHasBucket = basePath === `/${bucket}` || basePath.endsWith(`/${bucket}`);
    const prefixPath = alreadyHasBucket ? basePath : `${basePath}/${uriEncode(bucket, true)}`;
    rawPath = cleanKey ? `${prefixPath}/${uriEncode(cleanKey, false)}` : `${prefixPath}/`;
  } else {
    rawPath = cleanKey ? `${basePath}/${uriEncode(cleanKey, false)}` : `${basePath || ""}/`;
  }
  if (!rawPath.startsWith("/")) rawPath = "/" + rawPath;

  // Build canonical query string sorted by encoded parameter name, then encoded value.
  // Supports valueless S3 subresources such as ?delete when value is "".
  const encodedPairs = [];
  for (const [k, v] of Object.entries(queryParams || {})) {
    if (v === undefined || v === null) continue;
    encodedPairs.push([uriEncode(k, true), uriEncode(String(v), true)]);
  }
  encodedPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = encodedPairs.map(([k, v]) => `${k}=${v}`).join("&");

  const fullUrl = `${baseUrl.origin}${rawPath}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return {
    url: fullUrl,
    host: baseUrl.host,
    canonicalUri: rawPath,
    canonicalQuery,
    region,
  };
}

/**
 * Compute AWS Signature V4 headers for an S3 HTTP request.
 */
export function signS3Request({
  method,
  target,
  accessKeyId,
  secretAccessKey,
  sessionToken = "",
  headers = {},
  body = "",
  now = new Date(),
}) {
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Access Key ID and Secret Access Key are required.");
  }
  const upperMethod = String(method || "GET").toUpperCase();
  const { amzDate, dateStamp } = formatAmzDate(now);
  const payloadHash = sha256Hex(body);

  const normalizedHeaders = new Map();
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null || v === "") continue;
    normalizedHeaders.set(k.toLowerCase().trim(), String(v).trim().replace(/\s+/g, " "));
  }
  normalizedHeaders.set("host", target.host);
  normalizedHeaders.set("x-amz-content-sha256", payloadHash);
  normalizedHeaders.set("x-amz-date", amzDate);
  if (sessionToken) {
    normalizedHeaders.set("x-amz-security-token", sessionToken.trim());
  }

  const sortedHeaderKeys = [...normalizedHeaders.keys()].sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${normalizedHeaders.get(k)}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    upperMethod,
    target.canonicalUri,
    target.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, target.region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders = {};
  for (const [k, v] of normalizedHeaders.entries()) {
    if (k === "host") continue;
    outHeaders[k] = v;
  }
  outHeaders.authorization = authorization;

  return {
    url: target.url,
    method: upperMethod,
    headers: outHeaders,
    canonicalRequest,
    stringToSign,
    signature,
    payloadHash,
  };
}

function sanitizeSegment(value, fallback = "unknown") {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function truncateKeyToUtf8Limit(key, maxBytes = MAX_OBJECT_KEY_BYTES) {
  if (Buffer.byteLength(key, "utf8") <= maxBytes) return key;
  const slash = key.lastIndexOf("/");
  if (slash <= 0) {
    return Buffer.from(key, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  const folder = key.slice(0, slash);
  const file = key.slice(slash + 1);
  const maxFolderBytes = Math.max(32, maxBytes - Buffer.byteLength(file, "utf8") - 1);
  const trimmedFolder = Buffer.from(folder, "utf8").subarray(0, maxFolderBytes).toString("utf8").replace(/\/+$/, "");
  const combined = trimmedFolder ? `${trimmedFolder}/${file}` : file;
  return Buffer.byteLength(combined, "utf8") <= maxBytes
    ? combined
    : Buffer.from(combined, "utf8").subarray(0, maxBytes).toString("utf8");
}

/**
 * Render an OpenRouter-compatible S3 Path Template into a safe folder prefix.
 * Supported variables: {prefix}, {date}, {year}, {month}, {day}, {hour}, {apiKeyName}, {agent}, {provider}, {model}, {session}, {origin}.
 */
export function renderPathTemplate(template, vars = {}) {
  const ts = vars.timestamp ? new Date(vars.timestamp) : new Date();
  const validDate = Number.isNaN(ts.getTime()) ? new Date() : ts;
  const iso = validDate.toISOString();
  const date = iso.slice(0, 10);
  const year = iso.slice(0, 4);
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const hour = iso.slice(11, 13);

  const prefixRaw = String(vars.prefix ?? DEFAULT_PREFIX)
    .split("/")
    .map((seg) => sanitizeSegment(seg, ""))
    .filter(Boolean)
    .join("/");

  const replacements = {
    prefix: prefixRaw || DEFAULT_PREFIX,
    date,
    year,
    month,
    day,
    hour,
    apiKeyName: sanitizeSegment(vars.apiKeyName, "unknown"),
    agent: sanitizeSegment(vars.agent, "unknown"),
    provider: sanitizeSegment(vars.provider, "unknown"),
    model: sanitizeSegment(vars.model, "unknown"),
    session: sanitizeSegment(vars.session, "sessionless"),
    origin: sanitizeSegment(vars.origin, "local"),
  };

  const rawTemplate = String(template || DEFAULT_PATH_TEMPLATE).trim() || DEFAULT_PATH_TEMPLATE;
  const rendered = rawTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
    Object.hasOwn(replacements, key) ? replacements[key] : sanitizeSegment(key, "var")
  );

  return rendered
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]+/g, "-"))
    .filter(Boolean)
    .join("/");
}

/**
 * Build the object key for a single trace ({traceId}-{timestamp}.json) or batch (batch-{timestamp}.json),
 * enforcing R2's 1024-byte UTF-8 key limit (error 10020).
 */
export function buildTraceObjectKey(config, meta = {}) {
  const timestampMs = Number.isFinite(meta.timestampMs) ? Math.trunc(meta.timestampMs) : Date.now();
  const folder = renderPathTemplate(config.pathTemplate, {
    prefix: config.prefix,
    timestamp: timestampMs,
    apiKeyName: meta.isBatch ? "unknown" : meta.apiKeyName || "local",
    agent: meta.agent || "magpie",
    provider: meta.provider || "unknown",
    model: meta.model || "unknown",
    session: meta.sessionId || "sessionless",
    origin: meta.origin || "local",
  });

  let rawKey;
  if (meta.isConnectionTest) {
    rawKey = `${folder}/.openrouter-connection-test.json`;
  } else if (meta.isBatch) {
    const suffix = meta.batchId ? `-${sanitizeSegment(meta.batchId, "0")}` : "";
    rawKey = `${folder}/batch-${timestampMs}${suffix}.json`;
  } else {
    const traceId = sanitizeSegment(meta.traceId, `trc-${timestampMs}`);
    const uniqueSuffix = meta.tiebreaker ? `-${sanitizeSegment(meta.tiebreaker, "1")}` : "";
    rawKey = `${folder}/${traceId}-${timestampMs}${uniqueSuffix}.json`;
  }
  return truncateKeyToUtf8Limit(rawKey, MAX_OBJECT_KEY_BYTES);
}

function decodeXmlEntities(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractXmlTag(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? decodeXmlEntities(m[1].trim()) : "";
}

/**
 * Parse S3 ListObjectsV2 XML response without external XML dependencies.
 */
export function parseListObjectsV2Xml(xml) {
  const isTruncated = extractXmlTag(xml, "IsTruncated").toLowerCase() === "true";
  const nextContinuationToken = extractXmlTag(xml, "NextContinuationToken") || null;
  const contents = [];
  const blockRegex = /<Contents>([\s\S]*?)<\/Contents>/gi;
  let match;
  while ((match = blockRegex.exec(xml)) !== null) {
    const block = match[1];
    const key = extractXmlTag(block, "Key");
    if (!key) continue;
    contents.push({
      key,
      lastModified: extractXmlTag(block, "LastModified") || null,
      size: Number(extractXmlTag(block, "Size") || 0),
      etag: extractXmlTag(block, "ETag").replace(/^"|"$/g, "") || null,
    });
  }
  return { contents, isTruncated, nextContinuationToken };
}

/**
 * Parse S3 / Cloudflare R2 XML error response into structured diagnostics.
 */
export function parseS3Error(xml, status, headers = null) {
  let s3Code = extractXmlTag(xml, "Code");
  let message = extractXmlTag(xml, "Message");

  if (!s3Code) {
    if (status === 401) s3Code = "Unauthorized";
    else if (status === 403) s3Code = "AccessDenied";
    else if (status === 404) s3Code = "NoSuchBucket";
    else if (status === 409) s3Code = "ObjectLockedByBucketPolicy";
    else if (status === 411) s3Code = "MissingContentLength";
    else if (status === 412) s3Code = "PreconditionFailed";
    else if (status === 416) s3Code = "InvalidRange";
    else if (status === 429) s3Code = "TooManyRequests";
    else if (status === 503) s3Code = "ServiceUnavailable";
    else if (status >= 500) s3Code = "InternalError";
  }

  const catalog = R2_ERROR_CATALOG[s3Code] || null;
  const r2Code = catalog?.r2Code ?? null;
  const hint = catalog?.hint || "";
  const retriable = catalog ? catalog.retriable : status === 429 || status >= 500;

  let retryAfterMs = 0;
  const retryAfterRaw = headers?.get?.("retry-after");
  if (retryAfterRaw) {
    const secs = Number(retryAfterRaw);
    if (Number.isFinite(secs) && secs > 0) {
      retryAfterMs = Math.min(60000, Math.round(secs * 1000));
    }
  } else if (status === 429) {
    // R2 10058 limit is 1 write/second per key.
    retryAfterMs = 1500;
  }

  const codeTag = r2Code ? `${s3Code} (R2 ${r2Code})` : s3Code || "S3Error";
  const snippet = !message ? String(xml || "").replace(/\s+/g, " ").trim().slice(0, 180) : "";
  const formatted = `${codeTag}${message ? `: ${message}` : snippet ? `: ${snippet}` : ""} (HTTP ${status})`;

  return {
    s3Code: s3Code || "S3Error",
    r2Code,
    status,
    message: message || snippet || `HTTP ${status}`,
    hint,
    retriable,
    retryAfterMs,
    formatted,
  };
}

export function parseS3ErrorXml(xml, status) {
  return parseS3Error(xml, status).formatted;
}

function buildS3Exception(xml, status, headers) {
  const info = parseS3Error(xml, status, headers);
  const err = new Error(info.formatted);
  err.status = status;
  err.s3Code = info.s3Code;
  err.r2Code = info.r2Code;
  err.r2Hint = info.hint;
  err.retriable = info.retriable;
  err.retryAfterMs = info.retryAfterMs;
  return err;
}

function buildSignal(externalSignal, timeoutMs = 8000) {
  const timeoutSignal = AbortSignal.timeout(Math.max(500, timeoutMs));
  return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
}

export class S3TraceClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Cloudflare R2 encrypts objects at rest automatically and does NOT implement
   * x-amz-server-side-encryption / x-amz-server-side-encryption-aws-kms-key-id on PutObject.
   * Only include SSE headers for AWS S3 / compatible endpoints when explicitly requested.
   */
  sseHeaders() {
    if (this.config.provider === "r2") return {};
    const headers = {};
    if (this.config.sse === "AES256") {
      headers["x-amz-server-side-encryption"] = "AES256";
    } else if (this.config.sse === "aws:kms") {
      headers["x-amz-server-side-encryption"] = "aws:kms";
      if (this.config.sseKmsKeyId) {
        headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.config.sseKmsKeyId;
      }
    }
    return headers;
  }

  storageClassHeaders() {
    // R2 supports STANDARD and STANDARD_IA (Infrequent Access). Only emit header for STANDARD_IA.
    if (this.config.storageClass === "STANDARD_IA") {
      return { "x-amz-storage-class": "STANDARD_IA" };
    }
    return {};
  }

  async headBucket({ signal, now } = {}) {
    const target = resolveS3Target(this.config, "");
    const signed = signS3Request({
      method: "HEAD",
      target,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      body: "",
      now,
    });
    const started = performance.now();
    const res = await this.fetchImpl(signed.url, {
      method: "HEAD",
      headers: signed.headers,
      signal: buildSignal(signal, this.config.s3TimeoutMs),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      throw buildS3Exception("", res.status, res.headers);
    }
    return { ok: true, status: res.status, latencyMs };
  }

  async putJson(objectKey, data, { signal, now, ifNoneMatch = false } = {}) {
    const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const target = resolveS3Target(this.config, objectKey);
    const extraHeaders = {
      "content-type": "application/json; charset=utf-8",
      "content-md5": md5Base64(body),
      ...this.storageClassHeaders(),
      ...this.sseHeaders(),
    };
    if (ifNoneMatch) {
      extraHeaders["if-none-match"] = "*";
    }

    const signed = signS3Request({
      method: "PUT",
      target,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      headers: extraHeaders,
      body,
      now,
    });

    const started = performance.now();
    const res = await this.fetchImpl(signed.url, {
      method: "PUT",
      headers: signed.headers,
      body,
      signal: buildSignal(signal, this.config.s3TimeoutMs),
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw buildS3Exception(errText, res.status, res.headers);
    }
    return {
      ok: true,
      status: res.status,
      key: objectKey,
      bytes: Buffer.byteLength(body, "utf8"),
      etag: (res.headers.get("etag") || "").replace(/^"|"$/g, "") || null,
      latencyMs,
    };
  }

  async getJson(objectKey, { signal, now } = {}) {
    const target = resolveS3Target(this.config, objectKey);
    const signed = signS3Request({
      method: "GET",
      target,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      body: "",
      now,
    });

    const res = await this.fetchImpl(signed.url, {
      method: "GET",
      headers: signed.headers,
      signal: buildSignal(signal, this.config.s3TimeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw buildS3Exception(text, res.status, res.headers);
    }
    return JSON.parse(text);
  }

  async deleteObject(objectKey, { signal, now } = {}) {
    const target = resolveS3Target(this.config, objectKey);
    const signed = signS3Request({
      method: "DELETE",
      target,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      body: "",
      now,
    });

    const res = await this.fetchImpl(signed.url, {
      method: "DELETE",
      headers: signed.headers,
      signal: buildSignal(signal, this.config.s3TimeoutMs),
    });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      throw buildS3Exception(text, res.status, res.headers);
    }
    return { ok: true, status: res.status, key: objectKey };
  }

  /**
   * Batch DeleteObjects (supported by Cloudflare R2 S3 API, up to 1000 keys per call).
   */
  async deleteObjects(keys = [], { signal, now } = {}) {
    const list = keys.filter(Boolean).slice(0, 1000);
    if (!list.length) return { ok: true, deleted: 0 };
    const xmlBody =
      `<?xml version="1.0" encoding="UTF-8"?><Delete>` +
      list.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("") +
      `</Delete>`;
    const target = resolveS3Target(this.config, "", { delete: "" });
    const signed = signS3Request({
      method: "POST",
      target,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "content-md5": md5Base64(xmlBody),
      },
      body: xmlBody,
      now,
    });
    const res = await this.fetchImpl(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: xmlBody,
      signal: buildSignal(signal, this.config.s3TimeoutMs),
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw buildS3Exception(text, res.status, res.headers);
    }
    return { ok: true, deleted: list.length };
  }

  async listObjects({ prefix = "", maxKeys = 100, continuationToken = "", signal, now } = {}) {
    const queryParams = {
      "list-type": "2",
      "max-keys": String(Math.min(1000, Math.max(1, maxKeys))),
    };
    if (prefix) queryParams.prefix = prefix;
    if (continuationToken) queryParams["continuation-token"] = continuationToken;

    const target = resolveS3Target(this.config, "", queryParams);
    const signed = signS3Request({
      method: "GET",
      target,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      sessionToken: this.config.sessionToken,
      body: "",
      now,
    });

    const res = await this.fetchImpl(signed.url, {
      method: "GET",
      headers: signed.headers,
      signal: buildSignal(signal, this.config.s3TimeoutMs),
    });
    const xml = await res.text();
    if (!res.ok) {
      throw buildS3Exception(xml, res.status, res.headers);
    }
    return parseListObjectsV2Xml(xml);
  }

  /**
   * OpenRouter-compatible S3 / Cloudflare R2 Connection Test:
   * 1) Validates bucket name, endpoint, and credentials
   * 2) Writes `.openrouter-connection-test.json` under the resolved path template prefix
   * 3) Optionally checks read/list capability via ListObjectsV2 (non-fatal for write-only tokens)
   */
  async testConnection({ signal, now } = {}) {
    if (this.config.endpointValid === false) {
      return { ok: false, status: 0, error: this.config.endpointError || "Invalid endpoint URL." };
    }
    const epCheck = validateEndpointUrl(this.config.endpoint, Boolean(this.config.allowInsecureHttp));
    if (!epCheck.ok) {
      return { ok: false, status: 0, error: epCheck.error };
    }
    if (this.config.bucketValid === false) {
      return { ok: false, status: 0, error: this.config.bucketError || "Invalid bucket name." };
    }
    const bCheck = validateBucketName(this.config.bucket, this.config.provider || "r2");
    if (!bCheck.ok) {
      return { ok: false, status: 0, error: bCheck.error };
    }
    if (!this.config.bucket || !this.config.accessKeyId || !this.config.secretAccessKey) {
      return {
        ok: false,
        status: 0,
        error: "Bucket Name, Access Key ID, and Secret Access Key are required.",
      };
    }
    if (this.config.provider === "r2" && !this.config.endpoint) {
      return {
        ok: false,
        status: 0,
        error:
          "Cloudflare Account ID or R2 S3 Endpoint URL (https://<ACCOUNT_ID>.r2.cloudflarestorage.com) is required for Cloudflare R2.",
      };
    }
    if (this.config.provider !== "aws" && this.config.provider !== "gcs" && !this.config.endpoint) {
      return {
        ok: false,
        status: 0,
        error: `Custom Endpoint URL is required for ${this.config.provider.toUpperCase()}.`,
      };
    }

    const ts = now ? now.getTime() : Date.now();
    const objectKey = buildTraceObjectKey(this.config, {
      timestampMs: ts,
      isConnectionTest: true,
    });
    const payload = {
      type: "openrouter-connection-test",
      source: "magpie-s3-trace-sync",
      timestamp: new Date(ts).toISOString(),
      bucket: this.config.bucket,
      provider: this.config.provider,
      region: effectiveSigningRegion(this.config),
    };

    try {
      const put = await this.putJson(objectKey, payload, { signal, now });
      let canRead = false;
      try {
        const prefix = objectKey.includes("/") ? objectKey.slice(0, objectKey.lastIndexOf("/") + 1) : "";
        await this.listObjects({ prefix, maxKeys: 1, signal, now });
        canRead = true;
      } catch {
        // Write-only tokens (R2 Object Write) succeed on PutObject and return 403 on ListObjectsV2.
        canRead = false;
      }
      return {
        ok: true,
        status: put.status,
        latencyMs: put.latencyMs,
        key: objectKey,
        bucket: this.config.bucket,
        provider: this.config.provider,
        endpoint: this.config.endpoint || "aws-s3",
        canWrite: true,
        canRead,
      };
    } catch (error) {
      return {
        ok: false,
        status: error?.status || 0,
        s3Code: error?.s3Code || "",
        r2Code: error?.r2Code ?? null,
        hint: error?.r2Hint || "",
        key: objectKey,
        bucket: this.config.bucket,
        provider: this.config.provider,
        error: error?.message || String(error),
      };
    }
  }
}
