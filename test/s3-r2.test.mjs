import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildR2Endpoint,
  parseR2Endpoint,
  publicConfigView,
  resolveConfig,
  sanitizeSettingsPatch,
  validateBucketName,
  validateEndpointUrl,
} from "../src/config.mjs";
import {
  buildTraceObjectKey,
  effectiveSigningRegion,
  parseListObjectsV2Xml,
  parseS3Error,
  renderPathTemplate,
  resolveS3Target,
  S3TraceClient,
  signS3Request,
} from "../src/s3.mjs";

test("Cloudflare R2 is the preferred default provider with auto region and endpoint synthesis", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-trace-cfg-"));
  try {
    const cfg = resolveConfig({ stateDir: tmpDir }, {});
    assert.equal(cfg.provider, "r2");
    assert.equal(cfg.region, "auto");
    assert.equal(cfg.forcePathStyle, true);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.s3Configured, false);

    // R2 environment variables automatically construct the endpoint and enable sync
    const envCfg = resolveConfig(
      { stateDir: tmpDir },
      {
        R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        R2_BUCKET: "magpie-traces",
        R2_ACCESS_KEY_ID: "ak_r2_test",
        R2_SECRET_ACCESS_KEY: "sk_r2_secret",
      }
    );
    assert.equal(envCfg.provider, "r2");
    assert.equal(envCfg.endpoint, "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    assert.equal(envCfg.region, "auto");
    assert.equal(envCfg.enabled, true);
    assert.equal(envCfg.s3Configured, true);

    const view = publicConfigView(envCfg);
    assert.equal(view.hasSecretAccessKey, true);
    assert.ok(!JSON.stringify(view).includes("sk_r2_secret"));

    // Jurisdictions
    assert.equal(
      buildR2Endpoint("abc12345", "eu"),
      "https://abc12345.eu.r2.cloudflarestorage.com"
    );
    assert.equal(
      buildR2Endpoint("abc12345", "fedramp"),
      "https://abc12345.fedramp.r2.cloudflarestorage.com"
    );
    assert.deepEqual(parseR2Endpoint("https://abc12345.eu.r2.cloudflarestorage.com/"), {
      accountId: "abc12345",
      jurisdiction: "eu",
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R2 bucket naming (10005) and endpoint security validations enforce constraints", () => {
  assert.equal(validateBucketName("magpie-traces-01", "r2").ok, true);
  assert.equal(validateBucketName("Magpie_Bad", "r2").ok, false);
  assert.equal(validateBucketName("ab", "r2").ok, false);

  assert.equal(validateEndpointUrl("https://acc123.r2.cloudflarestorage.com").ok, true);
  assert.equal(validateEndpointUrl("http://127.0.0.1:9000", false).ok, true);
  assert.equal(validateEndpointUrl("http://minio.lan:9000", false).ok, false);
  assert.equal(validateEndpointUrl("http://minio.lan:9000", true).ok, true);
  assert.equal(validateEndpointUrl("https://user:pass@r2.example.com").ok, false);

  const patch = sanitizeSettingsPatch({
    provider: "r2",
    accountId: "0123456789ABCDEF0123456789ABCDEF",
    r2Jurisdiction: "eu",
    bucket: "prod-traces",
    storageClass: "STANDARD_IA",
  });
  assert.equal(patch.endpoint, "https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com");
  assert.equal(patch.storageClass, "STANDARD_IA");
});

test("AWS SigV4 signing & R2 path-style URL resolution work accurately", () => {
  const cfg = {
    provider: "r2",
    accountId: "acct12345",
    endpoint: "https://acct12345.r2.cloudflarestorage.com",
    bucket: "llm-traces",
    region: "auto",
    forcePathStyle: true,
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "SECRET_TEST",
  };
  assert.equal(effectiveSigningRegion(cfg), "auto");
  const target = resolveS3Target(cfg, "openrouter-traces/2026-11-18/trc 1.json");
  assert.equal(
    target.url,
    "https://acct12345.r2.cloudflarestorage.com/llm-traces/openrouter-traces/2026-11-18/trc%201.json"
  );
  assert.equal(target.host, "acct12345.r2.cloudflarestorage.com");

  const signed = signS3Request({
    method: "PUT",
    target,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
    now: new Date("2026-11-18T00:00:00.000Z"),
  });
  assert.match(
    signed.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/20261118\/auto\/s3\/aws4_request, SignedHeaders=.*, Signature=[a-f0-9]{64}$/
  );
  assert.equal(signed.headers["x-amz-date"], "20261118T000000Z");
  assert.ok(signed.headers["x-amz-content-sha256"]);
});

test("R2 PutObject omits unsupported SSE headers, supports STANDARD_IA + Content-MD5, and enforces 1024B key limit", async () => {
  const capturedCalls = [];
  const mockFetch = async (url, init) => {
    capturedCalls.push({ url, init });
    if (init.method === "PUT") {
      return new Response("", { status: 200, headers: { etag: '"abc123"' } });
    }
    return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
  };

  const r2Client = new S3TraceClient(
    {
      provider: "r2",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "traces",
      region: "auto",
      forcePathStyle: true,
      accessKeyId: "ak",
      secretAccessKey: "sk",
      sse: "aws:kms", // should be omitted for R2 per Cloudflare R2 S3 API spec
      sseKmsKeyId: "arn:aws:kms:...",
      storageClass: "STANDARD_IA",
      s3TimeoutMs: 5000,
    },
    mockFetch
  );

  const testRes = await r2Client.testConnection({ now: new Date("2026-11-18T04:00:00Z") });
  // Write-only token should pass testConnection even when ListObjectsV2 returns 403!
  assert.equal(testRes.ok, true);
  assert.equal(testRes.canWrite, true);
  assert.equal(testRes.canRead, false);

  const putHeaders = capturedCalls[0].init.headers;
  assert.equal(putHeaders["x-amz-server-side-encryption"], undefined);
  assert.equal(putHeaders["x-amz-server-side-encryption-aws-kms-key-id"], undefined);
  assert.equal(putHeaders["x-amz-storage-class"], "STANDARD_IA");
  assert.ok(putHeaders["content-md5"]);

  // Verify 1024-byte key enforcement (R2 error 10020)
  const hugeKey = buildTraceObjectKey(
    { prefix: "openrouter-traces", pathTemplate: "{prefix}/" + "a/".repeat(700) + "{date}" },
    { traceId: "trc_abc", timestampMs: 1763438400000 }
  );
  assert.ok(Buffer.byteLength(hugeKey, "utf8") <= 1024);

  // HeadBucket and batch DeleteObjects
  const mockOps = [];
  const opsClient = new S3TraceClient(
    {
      provider: "r2",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      bucket: "traces",
      region: "auto",
      forcePathStyle: true,
      accessKeyId: "ak",
      secretAccessKey: "sk",
      s3TimeoutMs: 5000,
    },
    async (url, init) => {
      mockOps.push({ url, method: init.method, body: init.body });
      return new Response("", { status: 200 });
    }
  );
  const hb = await opsClient.headBucket();
  assert.equal(hb.ok, true);
  assert.equal(mockOps[0].method, "HEAD");

  const del = await opsClient.deleteObjects(["a/1.json", "a/2.json"]);
  assert.equal(del.deleted, 2);
  assert.equal(mockOps[1].method, "POST");
  assert.match(mockOps[1].url, /\?delete=$/);
  assert.match(mockOps[1].body, /<Key>a\/1\.json<\/Key>/);
});

test("R2 error catalog maps official R2 error codes and retriability accurately", () => {
  const rateLimit = parseS3Error(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>TooManyRequests</Code><Message>Reduce your request rate.</Message></Error>`,
    429,
    new Headers({ "retry-after": "2" })
  );
  assert.equal(rateLimit.s3Code, "TooManyRequests");
  assert.equal(rateLimit.r2Code, 10058);
  assert.equal(rateLimit.retriable, true);
  assert.equal(rateLimit.retryAfterMs, 2000);
  assert.match(rateLimit.hint, /1 write\/second/);

  const sigErr = parseS3Error(
    `<Error><Code>SignatureDoesNotMatch</Code><Message>Signature mismatch</Message></Error>`,
    403
  );
  assert.equal(sigErr.r2Code, 10035);
  assert.equal(sigErr.retriable, false);

  const badBucket = parseS3Error(`<Error><Code>NoSuchBucket</Code></Error>`, 404);
  assert.equal(badBucket.r2Code, 10006);
  assert.equal(badBucket.retriable, false);
});

test("Path templates and ListObjectsV2 XML parser handle variables and traversal safely", () => {
  const rendered = renderPathTemplate("{apiKeyName}/{year}/{month}/{day}/../{agent}", {
    timestamp: Date.UTC(2026, 10, 18, 5, 0, 0),
    apiKeyName: "Team Key/1",
    agent: "claude",
  });
  assert.equal(rendered, "Team-Key-1/2026/11/18/claude");

  const parsed = parseListObjectsV2Xml(`<?xml version="1.0" encoding="UTF-8"?>
    <ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>tok_2</NextContinuationToken>
      <Contents>
        <Key>openrouter-traces/2026-11-18/trc_1-1000.json</Key>
        <LastModified>2026-11-18T03:00:00.000Z</LastModified>
        <ETag>&quot;deadbeef&quot;</ETag>
        <Size>1234</Size>
      </Contents>
    </ListBucketResult>`);
  assert.equal(parsed.isTruncated, true);
  assert.equal(parsed.nextContinuationToken, "tok_2");
  assert.equal(parsed.contents.length, 1);
  assert.equal(parsed.contents[0].etag, "deadbeef");
  assert.equal(parsed.contents[0].size, 1234);
});
