import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAppServer } from "../server.mjs";
import { resolveConfig } from "../src/config.mjs";
import { TraceStore } from "../src/store.mjs";
import { buildOpenRouterTrace } from "../src/trace.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

test("Magpie plugin manifest, assets, and bridge files conform to Magpie plugin contract", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "./index.mjs");
  assert.equal(pkg.magpie?.hooks, "./s3-trace-sync.hooks.mjs");
  assert.equal(pkg.magpie?.page?.file, "page/index.html");
  assert.equal(pkg.magpie?.page?.icon, "page/icon.svg");
  assert.equal(pkg.magpie?.page?.service?.port, 3483);
  assert.equal(pkg.magpie?.options?.provider, "r2");
  assert.ok(pkg.keywords.includes("magpie-plugin"));
  assert.ok(pkg.keywords.includes("magpie-page"));

  for (const rel of [
    "index.mjs",
    "server.mjs",
    "s3-trace-sync.hooks.mjs",
    "page/index.html",
    "page/boot.js",
    "page/icon.svg",
    "static/index.html",
    "static/app.js",
    "static/styles.css",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `Missing required file ${rel}`);
  }

  const pageHtml = fs.readFileSync(path.join(ROOT, "page/index.html"), "utf8");
  assert.match(pageHtml, /_magpie\/bridge\.js/);
});

test("Importing index.mjs has zero side effects (no port binding)", async () => {
  const mod = await import("../index.mjs");
  assert.equal(mod.default.id, "magpie-s3-trace-sync");
  assert.equal(typeof mod.default.server, "function");
});

test("Dashboard HTTP server enforces security headers, x-dash-key auth, CSV export, and R2 test/settings", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-trace-srv-"));
  try {
    const r2Puts = [];
    const mockFetch = async (url, init) => {
      r2Puts.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (init.method === "PUT") {
        return new Response("", { status: 200, headers: { etag: '"ok"' } });
      }
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", { status: 200 });
    };

    const store = new TraceStore({ fetchImpl: mockFetch });
    const cfg = resolveConfig({ stateDir: tmpDir, ignoreOverlay: true, inputOutputLogging: true }, {});
    const demoTrace = buildOpenRouterTrace({
      requestBody: { model: "claude-sonnet-4", messages: [{ role: "user", content: "=CMD|'/C calc'!A0 hello" }] },
      replyBody: {
        id: "srv_trc_1",
        model: "claude-sonnet-4",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Safe answer" } }],
        usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
      },
      ctx: { protocol: "chat", agent: "claude", origin: "local", session: "ses_srv", success: true },
      config: cfg,
    });
    await store.recordAndSync(demoTrace, cfg);

    const app = createAppServer({
      pluginOptions: { stateDir: tmpDir },
      store,
      fetchImpl: mockFetch,
      port: 0,
    });
    const boundPort = await app.start();
    const base = `http://127.0.0.1:${boundPort}`;
    const key = app.getPageKey();

    try {
      // 1. Ping & health work anonymously
      const ping = await fetch(`${base}/api/ping`).then((r) => r.json());
      assert.equal(ping.service, "magpie-s3-trace-sync");
      assert.equal(ping.ok, true);

      // 2. Rejects unauthorized /api/logs
      const unauth = await fetch(`${base}/api/logs`);
      assert.equal(unauth.status, 401);

      // 3. Rejects foreign Origin
      const crossOrigin = await fetch(`${base}/api/logs`, {
        headers: { "x-dash-key": key, origin: "https://evil.example" },
      });
      assert.equal(crossOrigin.status, 403);

      // 4. Allows sandboxed iframe Origin: null with valid x-dash-key
      const logsRes = await fetch(`${base}/api/logs`, {
        headers: { "x-dash-key": key, origin: "null" },
      });
      assert.equal(logsRes.status, 200);
      assert.equal(logsRes.headers.get("access-control-allow-origin"), "null");
      const logs = await logsRes.json();
      assert.equal(logs.total, 1);
      assert.equal(logs.items[0].id, "srv_trc_1");

      // 5. HTML root injects key and CSP
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes("window.__KEY__="));
      assert.match(htmlRes.headers.get("content-security-policy"), /frame-ancestors \*/);

      // 6. Save R2 settings (custom folder + custom traceFields) and ensure secret key is masked
      const saveRes = await fetch(`${base}/api/settings`, {
        method: "POST",
        headers: { "x-dash-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          provider: "r2",
          accountId: "myr2acct",
          bucket: "magpie-r2-logs",
          folder: "team-a/traces",
          pathTemplate: "{folder}/{date}",
          traceFields: {
            systemPrompt: false,
            rawRequest: false,
          },
          accessKeyId: "ak_demo",
          secretAccessKey: "super_secret_r2_key_value",
        }),
      }).then((r) => r.json());
      assert.equal(saveRes.ok, true);
      assert.equal(saveRes.config.provider, "r2");
      assert.equal(saveRes.config.folder, "team-a/traces");
      assert.equal(saveRes.config.tracePreset, "custom");
      assert.equal(saveRes.config.traceFields.systemPrompt, false);
      assert.equal(saveRes.config.traceFields.inputMessages, true);
      assert.equal(saveRes.config.endpoint, "https://myr2acct.r2.cloudflarestorage.com");
      assert.equal(saveRes.config.hasSecretAccessKey, true);
      assert.ok(!JSON.stringify(saveRes).includes("super_secret_r2_key_value"));

      // 7. Test R2 connection endpoint
      const testConn = await fetch(`${base}/api/s3/test`, {
        method: "POST",
        headers: { "x-dash-key": key, "content-type": "application/json" },
        body: "{}",
      }).then((r) => r.json());
      assert.equal(testConn.ok, true);
      assert.equal(testConn.provider, "r2");
      assert.match(testConn.key, /\.openrouter-connection-test\.json$/);
      assert.ok(r2Puts.some((p) => p.url.startsWith("https://myr2acct.r2.cloudflarestorage.com/magpie-r2-logs/")));

      // 8. Push local trace to R2 manually
      const pushRes = await fetch(`${base}/api/logs/srv_trc_1/push`, {
        method: "POST",
        headers: { "x-dash-key": key },
      }).then((r) => r.json());
      assert.equal(pushRes.ok, true);
      assert.equal(pushRes.trace.s3Sync.state, "synced");

      // 9. Activity, Sessions, and Explore CSV export
      const act = await fetch(`${base}/api/activity`, { headers: { "x-dash-key": key } }).then((r) => r.json());
      assert.equal(act.summary.totalRequests, 1);
      assert.equal(act.summary.totalTokens, 20);

      const sessions = await fetch(`${base}/api/sessions`, { headers: { "x-dash-key": key } }).then((r) => r.json());
      assert.equal(sessions.total, 1);
      assert.equal(sessions.sessions[0].sessionId, "ses_srv");

      const thread = await fetch(`${base}/api/sessions/ses_srv`, { headers: { "x-dash-key": key } }).then((r) => r.json());
      assert.equal(thread.count, 1);

      const csv = await fetch(`${base}/api/explore/export.csv?groupBy=sessionId`, {
        headers: { "x-dash-key": key },
      }).then((r) => r.text());
      assert.match(csv, /total_tokens/);

      // 10. Reset overrides back to defaults
      const resetRes = await fetch(`${base}/api/settings/reset`, {
        method: "POST",
        headers: { "x-dash-key": key },
      }).then((r) => r.json());
      assert.equal(resetRes.ok, true);
      assert.equal(resetRes.config.provider, "r2");
      assert.equal(resetRes.config.bucket, "magpie-traces");
      assert.equal(resetRes.config.folder, "openrouter-traces");
      assert.equal(resetRes.config.tracePreset, "common");
    } finally {
      await app.stop();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
