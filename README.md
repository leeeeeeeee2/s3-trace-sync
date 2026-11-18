# S3 Trace Sync (`s3-trace-sync`)

**OpenRouter-style Observability and Conversation Trace Sync for [Magpie](https://github.com/yetone/magpie)** — preferring **S3-compatible Cloudflare R2** (with zero egress fees) alongside AWS S3, Google Cloud Storage, and MinIO / NAS object storage.

`s3-trace-sync` captures only conversation traces (requests, completions, token/cache usage, latency waterfalls, and session context) without modifying or syncing your Magpie `providers.json` or gateway configuration. It ships with **zero external npm dependencies**, native **AWS Signature Version 4** signing over `fetch`, asynchronous non-blocking gateway hooks (`onRequest` / `onResponse`), and a built-in English Observability UI inside Magpie's window.

---

## Why Cloudflare R2 is Preferred

Cloudflare R2 is the default and preferred backend for `s3-trace-sync` because LLM conversation archives grow over time and R2 provides **zero egress fees** when querying, re-indexing, or browsing traces across devices.

This plugin is engineered specifically around Cloudflare's official [R2 S3 API Compatibility](https://developers.cloudflare.com/r2/api/s3/api/) and [R2 Error Codes](https://developers.cloudflare.com/r2/api/error-codes/) specifications:

- **Zero-config R2 Endpoint Builder**: Enter your **Cloudflare Account ID** and optionally choose a jurisdiction (`Default`, `eu`, or `fedramp`), and the plugin constructs `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` with `region = "auto"` and path-style addressing.
- **Spec-Compliant `PutObject` Headers**: R2 encrypts all objects at rest automatically and does not implement AWS `x-amz-server-side-encryption` / `x-amz-server-side-encryption-aws-kms-key-id` headers (`❌` in R2's S3 matrix), so those headers are automatically omitted for `provider: "r2"`.
- **Storage Class Support**: Supports both `STANDARD` and `STANDARD_IA` (`x-amz-storage-class: STANDARD_IA`) for lower-cost infrequent-access trace archiving.
- **Integrity Verification**: Includes base64 `Content-MD5` headers (`✅` in R2) alongside AWS SigV4 `x-amz-content-sha256`.
- **R2 Bucket & Key Guardrails**: Validates bucket names locally against R2's naming rules (error `10005`: 3–63 chars of lowercase letters, numbers, and hyphens) and caps keys at `<= 1024` UTF-8 bytes (error `10020`).
- **Rate-Limit & Collision Protection (`10058`)**: R2 limits writes to 1 write/second per object key (`TooManyRequests` / `10058`). `s3-trace-sync` assigns unique millisecond/tiebroken keys per trace and backs off automatically using `Retry-After` on transient `429`, `500`, and `503` responses.
- **Write-Only Token Friendly Connection Tests**: `Test Connection` writes `.openrouter-connection-test.json` to verify write access (`Object Write`), and checks `ListObjectsV2` non-fatally so scoped write-only R2 API tokens still pass connection verification.

---

## OpenRouter Observability Feature Parity

| OpenRouter Feature | `s3-trace-sync` Implementation |
| --- | --- |
| **Logs** | Searchable, filterable Generations table with 24-bucket volume histogram, model/provider/agent/API-key/status/sync facets, and slide-over **Generation Detail Drawer** (Overview, Router Timing waterfall, Prompt & Completion bubbles, Raw JSON). |
| **Sessions** | Groups traces by `sessionId` (or standalone single generations) with chronological multi-turn thread inspection. |
| **Activity & Explore** | Headline KPIs (requests, prompt/completion/cached/reasoning tokens, cache hit rate, avg/P95 latency, avg TTFT, R2 sync count), time-series charts, ranked breakdowns, and an **Explore** builder with **CSV Export**. |
| **Input & Output Logging** | Toggleable full prompt/completion + `rawRequest`/`rawResponse` capture across Chat Completions, Responses, Anthropic Messages, and Gemini protocols. |
| **Privacy Mode** | Strips prompt, completion, error text, and `upstream_raw_response_usage` (`null` with `privacy_mode` suppression reason) while retaining tokens, latency, routing, and custom metadata. |
| **Broadcast to S3 / R2** | Non-blocking async export in **Single** (`{traceId}-{timestamp}.json`) or **Batch** (`batch-{timestamp}.json` with `traces[]`) mode, with Path Templates, API key inclusion/exclusion filters, and `trace` custom metadata support. |

---

## Installation in Magpie

### Option 1: Install from GitHub

```bash
magpie plugin add github:leeeeeeeee2/s3-trace-sync
```

### Option 2: Install from Local Clone (e.g. Docker / NAS)

```bash
git clone https://github.com/leeeeeeeee2/s3-trace-sync.git
magpie plugin add ./s3-trace-sync
```

> **Tip (GitHub Discover):** Adding the `magpie-plugin` topic to your GitHub repository allows Magpie's **Plugins > Discover** page to detect and install it automatically.

After adding the plugin, open **S3 Trace Sync** in Magpie's sidebar under **Plugins**, switch to **Broadcast & R2**, and configure your Cloudflare R2 bucket.

### Option 3: Headless Configuration via CLI or Docker Environment

For headless servers or Docker containers, configure Cloudflare R2 via Magpie CLI options:

```bash
magpie plugin options s3-trace-sync '{
  "enabled": true,
  "provider": "r2",
  "accountId": "<YOUR_CLOUDFLARE_ACCOUNT_ID>",
  "bucket": "magpie-traces",
  "folder": "openrouter-traces",
  "pathTemplate": "{folder}/{date}",
  "tracePreset": "common",
  "accessKeyId": "<R2_ACCESS_KEY_ID>",
  "secretAccessKey": "<R2_SECRET_ACCESS_KEY>"
}'
```

Or pass environment variables in `compose.yaml` (auto-enables trace sync when bucket, keys, and `R2_ACCOUNT_ID` are set):

```yaml
environment:
  R2_ACCOUNT_ID: "<YOUR_CLOUDFLARE_ACCOUNT_ID>"
  R2_BUCKET: "magpie-traces"
  R2_ACCESS_KEY_ID: "<R2_ACCESS_KEY_ID>"
  R2_SECRET_ACCESS_KEY: "<R2_SECRET_ACCESS_KEY>"
  S3_TRACE_FOLDER: "openrouter-traces"
  S3_TRACE_PATH_TEMPLATE: "{folder}/{date}"
  S3_TRACE_PRESET: "common"
```

---

## Cloudflare R2 Setup Walkthrough

1. **Create an R2 Bucket**:
   - In the Cloudflare Dashboard, go to **R2 Object Storage > Create bucket**.
   - Create a bucket (the plugin defaults to `magpie-traces`; any lowercase alphanumeric/hyphen name of 3–63 characters works).
2. **Create an R2 API Token**:
   - Go to **R2 > Manage R2 API Tokens > Create API token**.
   - Grant **Object Read & Write** (recommended if you also want to use **Pull from R2** to browse historical traces from multiple machines) or **Object Write** (write-only archiving), scoped to your bucket.
   - Copy the **Access Key ID**, **Secret Access Key**, and your **Cloudflare Account ID** (shown on the R2 overview / Cloudflare sidebar, or inside the `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` S3 API URL).
3. **Configure in Magpie**:
   - Open **S3 Trace Sync > Broadcast & R2**.
   - Ensure **Cloudflare R2 (Preferred)** is selected.
   - Enter your **Cloudflare Account ID** (endpoint auto-fills to `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`), **Bucket Name** (pre-filled as `magpie-traces`), **Access Key ID**, and **Secret Access Key**.
   - Adjust **Storage Folder** (defaults to `openrouter-traces` with path template `{folder}/{date}`) and **Traced JSON Fields** (defaults to the **`common`** preset) if needed.
   - Click **Test R2 / S3 Connection** — this writes `.openrouter-connection-test.json` under your configured folder/path template.
   - Toggle **Enable Conversation Trace Sync** on and click **Save Configuration**.

---

## Using Other S3-Compatible Providers

While Cloudflare R2 is preferred, you can select any of the following in **Broadcast & R2**:

| Provider | Endpoint | Region | Notes |
| --- | --- | --- | --- |
| **Cloudflare R2** *(Preferred)* | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (`.eu.` / `.fedramp.` supported) | `auto` | Path-style enforced; supports `STANDARD` & `STANDARD_IA`; omits AWS-only `x-amz-server-side-encryption` headers. |
| **AWS S3** | Standard regional endpoint (leave blank) | e.g. `us-east-1` | Supports `AES256` (SSE-S3) and `aws:kms` (SSE-KMS). |
| **Google Cloud Storage** | `https://storage.googleapis.com` | `auto` | Uses GCS S3 interoperability HMAC keys. |
| **Custom S3 / MinIO / NAS** | Your S3 API URL (e.g. `https://s3.home.arpa`) | e.g. `us-east-1` | Enable **Allow Plain HTTP** only if targeting a trusted non-loopback LAN host without TLS. |

---

## Configuration & Environment Variables

Settings are resolved in this order (highest precedence first):

1. **Local Web UI Configuration** (`<magpie-config>/plugin-work/s3-trace-sync/config.json`, saved with mode `0600`)
2. **Magpie Plugin Options** (`plugins.json` via `magpie plugin options s3-trace-sync '{...}'`)
3. **Environment Variables**
4. **Built-in Defaults** (`provider: "r2"`, `region: "auto"`, `bucket: "magpie-traces"`, `folder: "openrouter-traces"`, `pathTemplate: "{folder}/{date}"`, `tracePreset: "common"`)

### Environment Variables

| Variable | Aliases | Description |
| --- | --- | --- |
| `R2_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID`, `S3_TRACE_ACCOUNT_ID`, `BACKUP_S3_ACCOUNT_ID` | Cloudflare Account ID used to construct the R2 S3 endpoint |
| `R2_JURISDICTION` | `S3_TRACE_R2_JURISDICTION` | `default`, `eu`, or `fedramp` |
| `R2_BUCKET` | `S3_TRACE_BUCKET`, `BACKUP_S3_BUCKET` | Target bucket name (default: `magpie-traces`) |
| `R2_ENDPOINT` | `S3_TRACE_ENDPOINT`, `BACKUP_S3_ENDPOINT` | Explicit S3 endpoint URL (optional when `R2_ACCOUNT_ID` is set) |
| `R2_ACCESS_KEY_ID` | `S3_TRACE_ACCESS_KEY_ID`, `BACKUP_S3_AK`, `AWS_ACCESS_KEY_ID` | S3 / R2 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | `S3_TRACE_SECRET_ACCESS_KEY`, `BACKUP_S3_SK`, `AWS_SECRET_ACCESS_KEY` | S3 / R2 Secret Access Key |
| `S3_TRACE_ENABLED` | — | `"true"` or `"false"` (auto-enabled if AK + SK + endpoint/accountId are provided via env; uses default bucket `magpie-traces` unless overridden) |
| `S3_TRACE_PROVIDER` | — | `r2` (default), `aws`, `gcs`, or `custom` |
| `S3_TRACE_REGION` | `BACKUP_S3_REGION`, `AWS_REGION` | Defaults to `auto` for R2/GCS, `us-east-1` for AWS/Custom |
| `S3_TRACE_STORAGE_CLASS` | — | `STANDARD` (default) or `STANDARD_IA` |
| `S3_TRACE_FOLDER` | `S3_TRACE_PREFIX` | Base folder inside the bucket for JSON traces (default: `openrouter-traces`) |
| `S3_TRACE_PATH_TEMPLATE` | — | Object key folder layout template (default: `{folder}/{date}`) |
| `S3_TRACE_PRESET` | — | Field selection preset: `common` (default), `full`, `minimal`, or `custom` |
| `S3_TRACE_FIELDS` | — | JSON object (e.g. `'{"rawRequest":false}'`) or comma-separated list of fields to enable on top of `minimal` |
| `S3_TRACE_EXPORT_MODE` | — | `single` (default) or `batch` |
| `S3_TRACE_IO_LOGGING` | — | `"true"` (default) or `"false"` |
| `S3_TRACE_PRIVACY_MODE` | — | `"false"` (default) or `"true"` |
| `S3_TRACE_CAPTURE_REMOTE` | — | `"false"` (default) or `"true"` (include remote/shared gateway keys) |
| `S3_TRACE_INCLUDED_API_KEYS` | — | Comma-separated gateway key names to include |
| `S3_TRACE_EXCLUDED_API_KEYS` | — | Comma-separated gateway key names to exclude (takes precedence) |
| `S3_TRACE_PORT` | `PORT` | Local dashboard service port (default `3483`) |

### Path Template Variables

Customize both the target `bucket` (default: `magpie-traces`), base `folder` (default: `openrouter-traces`), and subdirectory layout inside your R2/S3 bucket:

- `{folder}` (alias `{prefix}`) — configured storage folder inside the bucket (default: `openrouter-traces`)
- `{date}` — UTC date (`YYYY-MM-DD`)
- `{year}`, `{month}`, `{day}`, `{hour}` — UTC date/time segments
- `{apiKeyName}` — Magpie caller gateway key name (or `local`, `unknown` for batches/connection tests)
- `{agent}` — client harness (e.g., `claude`, `codex`, `opencode`, `pi`)
- `{provider}` — upstream provider ID from Magpie's ledger
- `{model}` — served model ID
- `{session}` — session ID (or `sessionless`)
- `{origin}` — `local`, `magpie-key`, `gateway-key`, or `remote`

Preset examples:
- `{folder}/{date}`
- `{folder}` (flat folder storage)
- `{folder}/{agent}/{date}`
- `{folder}/{apiKeyName}/{date}`
- `{folder}/{year}/{month}/{day}`

### Traced JSON Fields (`tracePreset` & `traceFields`)

Control exactly which sections are written into each uploaded trace JSON document:

- **`common` (default)** — Balanced OpenRouter observability payload. Includes `timestamps`, `session`, `routing`, `status`, `timing`, `usage`, `modelParameters`, `systemPrompt`, `inputMessages`, `outputMessages`, `reasoning`, `toolCalls`, `rawRequest`, `rawUsage`, `customMetadata`, and `otelObservations`, while disabling `rawResponse` by default to avoid duplicating normalized `output.messages` and inflating R2/S3 storage.
- **`full`** — Enables all 17 fields including raw upstream `rawResponse`.
- **`minimal`** — Compact trace keeping core identifiers alongside `timestamps`, `status`, `usage`, `inputMessages`, and `outputMessages`.
- **`custom`** — Any individual combination toggled in the Settings UI under **3. Traced JSON Fields** or passed via `traceFields` / `S3_TRACE_FIELDS`.

Available `traceFields` toggles:

| Field | `common` (default) | `full` | `minimal` | Description |
| --- | --- | --- | --- | --- |
| `timestamps` | `true` | `true` | `true` | `startTime`, `endTime` (`timestamp` is always included) |
| `session` | `true` | `true` | `false` | `userId`, `sessionId` |
| `routing` | `true` | `true` | `false` | `gatewayKey`, `apiKeyName`, `origin`, `agent`, `protocol`, `path`, `stream`, `model`, `requestedModel`, `servedModel`, `provider`, `upstream` |
| `status` | `true` | `true` | `true` | `status`, `httpStatus`, `errorType`, `finishReason`, `output.error` |
| `timing` | `true` | `true` | `false` | `latencyMs`, `ttftMs`, `flowMs`, `routerTiming` |
| `usage` | `true` | `true` | `true` | Normalized `usage` token counts & cost fields |
| `modelParameters` | `true` | `true` | `false` | `modelParameters` (`temperature`, `max_tokens`, etc.) |
| `systemPrompt` | `true` | `true` | `false` | Extracted `input.system`, system-role messages, and system fields inside `output.rawRequest` |
| `inputMessages` | `true` | `true` | `true` | Normalized `input.messages` (and conversation `title` derivation) |
| `outputMessages` | `true` | `true` | `true` | Normalized `output.messages` |
| `reasoning` | `true` | `true` | `false` | Reasoning / thinking blocks within `input.messages` and `output.messages` |
| `toolCalls` | `true` | `true` | `false` | Tool/function calls & schemas (`output.tools`, tool blocks in messages, `tools` inside `output.rawRequest`) |
| `rawRequest` | `true` | `true` | `false` | Sanitized `output.rawRequest` request payload |
| `rawResponse` | `false` | `true` | `false` | Sanitized `output.rawResponse` response payload (disabled in `common` by default) |
| `rawUsage` | `true` | `true` | `false` | `metadata.openrouter_generation.upstream_raw_response_usage` |
| `customMetadata` | `true` | `true` | `false` | `metadata` (`source`, `agent`, `origin`, `protocol`, `cwdHash`, `openrouter_generation`, custom OpenRouter metadata) |
| `otelObservations` | `true` | `true` | `false` | OpenRouter/OTel generation span in `trace.observations` |

---

## Trace JSON Schema & Querying with DuckDB / Athena

Each trace file (`{traceId}-{timestamp}.json`) follows an OpenRouter Broadcast S3 structure (`schema: "openrouter.broadcast.s3.v1"`). By default (`tracePreset: "common"`), `output.rawRequest` is included while `output.rawResponse` is omitted unless `rawResponse` (or `tracePreset: "full"`) is enabled:

```json
{
  "schema": "openrouter.broadcast.s3.v1",
  "id": "msg_01XYZ...",
  "name": "claude-sonnet-4-5",
  "title": "Refactor the R2 retry queue",
  "timestamp": "2026-11-18T04:00:00.000Z",
  "sessionId": "ses_abc123",
  "apiKeyName": "local",
  "agent": "claude",
  "protocol": "anthropic",
  "status": "completed",
  "httpStatus": 200,
  "model": "anthropic/claude-sonnet-4-5",
  "provider": "anthropic",
  "latencyMs": 1240,
  "ttftMs": 280,
  "routerTiming": {
    "router_ms": 12,
    "provider_ms": 1228,
    "provider_failed_ms": 0,
    "guardrails_ms": 0,
    "attempt_count": 1
  },
  "usage": {
    "promptTokens": 1200,
    "completionTokens": 340,
    "totalTokens": 1540,
    "promptTokensDetails": {
      "cachedTokens": 800,
      "cacheWriteTokens": 200,
      "cacheCreation": {
        "ephemeral_5m_input_tokens": 200,
        "ephemeral_1h_input_tokens": 0
      }
    },
    "completionTokensDetails": {
      "reasoningTokens": 0
    }
  },
  "input": { "system": "...", "messages": [...] },
  "output": { "messages": [...], "rawRequest": {...}, "rawResponse": {...} },
  "trace": {
    "id": "msg_01XYZ...",
    "observations": [{ "type": "GENERATION", "..." : "..." }]
  }
}
```

### Querying R2 Traces Directly with DuckDB

```sql
CREATE SECRET r2_secret (
  TYPE R2,
  KEY_ID '<R2_ACCESS_KEY_ID>',
  SECRET '<R2_SECRET_ACCESS_KEY>',
  ACCOUNT_ID '<CLOUDFLARE_ACCOUNT_ID>'
);

SELECT
  strftime(timestamp::TIMESTAMP, '%Y-%m-%d') AS day,
  model,
  COUNT(*) AS requests,
  SUM(usage.totalTokens) AS tokens,
  ROUND(AVG(latencyMs)) AS avg_ms
FROM read_json_auto('r2://magpie-traces/openrouter-traces/**/*.json')
GROUP BY 1, 2
ORDER BY 1 DESC, tokens DESC;
```

---

## Cloudflare R2 Error Code Handling

`s3-trace-sync` parses R2 XML `<Error>` responses and maps them to Cloudflare's documented error codes (`https://developers.cloudflare.com/r2/api/error-codes/`):

| S3 Code | R2 Code | HTTP | Retriable | Meaning & Action |
| --- | --- | --- | --- | --- |
| `TooManyRequests` | `10058` | 429 | Yes | Exceeded 1 write/second per key; automatically retries with `Retry-After` backoff. |
| `ServiceUnavailable` | `10043` | 503 | Yes | Temporary R2 unavailability; retries with backoff. |
| `InternalError` | `10001` | 500 | Yes | Transient R2 error; retries with backoff. |
| `IncompleteBody` / `ClientDisconnect` | `10013` / `10054` | 400 | Yes | Network interruption mid-upload; retries automatically. |
| `Unauthorized` | `10002` | 401 | No | Invalid Access Key ID or Secret Access Key. |
| `AccessDenied` | `10003` | 403 | No | R2 token lacks `Object Write` / `Object Read & Write` permission for the bucket. |
| `SignatureDoesNotMatch` | `10035` | 403 | No | Check Secret Access Key, Account ID endpoint, and `auto` region. |
| `InvalidBucketName` | `10005` | 400 | No | Bucket name must be 3–63 lowercase alphanumeric characters or hyphens. |
| `NoSuchBucket` | `10006` | 404 | No | Bucket does not exist in this Cloudflare Account ID / jurisdiction. |
| `InvalidObjectName` | `10020` | 400 | No | Key exceeds 1024 UTF-8 bytes or contains invalid characters. |

---

## Security & Privacy

- **Loopback-Only UI & Auth**: The local dashboard binds to `127.0.0.1` by default, checks `Host` against DNS rebinding, blocks foreign `Origin` headers (while permitting `Origin: null` for Magpie's sandboxed iframe and `magpie web` reverse proxy), and protects all `/api/*` endpoints with an ephemeral per-process `x-dash-key`.
- **Credential Protection**: Secrets saved via the UI are written with `0600` file permissions to `<magpie-config>/plugin-work/s3-trace-sync/config.json` and are never returned in plaintext to the browser.
- **Secret Redaction**: Enabled by default (`redactSecrets: true`), scrubbing Bearer tokens, API keys (`sk-...`, `AKIA...`, `ghp_...`, `AIza...`), PEM private keys, URL credentials, and sensitive JSON key names before local caching or R2 upload.
- **Provenance Gating**: By default, only requests originating from `local` or `magpie-key` (this machine's Magpie sharing key) are captured. Remote or shared `gateway-key` traffic requires explicitly enabling `captureRemote`.
- **Non-Blocking Execution**: `onResponse` executes asynchronously after Magpie completes delivery to the client; upload failures never block or alter model responses.

---

## Architecture & Repository Layout

```text
s3-trace-sync/
├── package.json              # Magpie plugin manifest (hooks + window page + service + defaults)
├── index.mjs                 # Magpie OpenCode/Bun server entry (starts local dashboard)
├── s3-trace-sync.hooks.mjs   # Async gateway hooks (onRequest / onResponse)
├── server.mjs                # Standalone & proxied HTTP API + observability UI server
├── page/                     # Sandboxed Magpie iframe bridge handoff
│   ├── index.html
│   ├── boot.js
│   └── icon.svg
├── static/                   # Zero-dependency English Observability UI (Logs, Sessions, Activity, Explore, Broadcast & R2)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/
│   ├── config.mjs            # R2-preferred config resolution, validation & 0600 local persistence
│   ├── s3.mjs                # Native fetch AWS SigV4 client + Cloudflare R2 compatibility & error catalog
│   ├── trace.mjs             # OpenRouter Broadcast S3 v1 normalizer, Privacy Mode & secret redaction
│   ├── ledger.mjs            # Magpie usage.jsonl tail matcher & routerTiming calculator
│   └── store.mjs             # Uploader, R2 10058 backoff retry queue, batching, cache & analytics
└── test/                     # Automated unit & HTTP integration tests
```

## Development & Verification

```bash
# Run the test suite (Node.js >= 20, zero external dependencies)
npm test

# Start the standalone observability dashboard locally (reads R2 / local cache)
npm start
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
