#!/usr/bin/env node
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  publicConfigView,
  resolveConfig,
  sanitizeSettingsPatch,
  writeLocalOverlay,
} from "./src/config.mjs";
import { S3TraceClient } from "./src/s3.mjs";
import { sharedStore, TraceStore } from "./src/store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(ROOT, "static");

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "0.1.0";
  } catch {
    return "0.1.0";
  }
})();

const BUILD_FILES = [
  "server.mjs",
  "index.mjs",
  "package.json",
  "s3-trace-sync.hooks.mjs",
  "src/config.mjs",
  "src/s3.mjs",
  "src/store.mjs",
  "src/trace.mjs",
  "src/ledger.mjs",
  "static/index.html",
  "static/app.js",
  "static/styles.css",
];

const BUILD_ID = (() => {
  try {
    const h = createHash("sha256");
    for (const rel of BUILD_FILES) {
      const full = path.join(ROOT, rel);
      if (fs.existsSync(full)) {
        h.update(rel);
        h.update("\0");
        h.update(fs.readFileSync(full));
      }
    }
    return h.digest("hex").slice(0, 16);
  } catch {
    return `ver:${VERSION}`;
  }
})();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 256 * 1024) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error("Request body too large.");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("Malformed JSON request body.");
    err.status = 400;
    throw err;
  }
}

function parseFilters(searchParams) {
  const get = (k) => searchParams.get(k) || "";
  return {
    range: get("range") || "7d",
    sinceMs: get("sinceMs"),
    untilMs: get("untilMs"),
    q: get("q"),
    model: get("model"),
    provider: get("provider"),
    agent: get("agent"),
    apiKeyName: get("apiKeyName"),
    sessionId: get("sessionId"),
    status: get("status"),
    origin: get("origin"),
    syncState: get("syncState"),
    limit: get("limit"),
    offset: get("offset"),
  };
}

export function createAppServer({
  pluginOptions = {},
  store = sharedStore,
  fetchImpl,
  host = process.env.HOST || "127.0.0.1",
  port,
  pageKey,
} = {}) {
  if (fetchImpl) store.setFetchImpl(fetchImpl);

  const HOST = host;
  const URL_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST.includes(":") ? `[${HOST}]` : HOST;
  const LOOPBACK_BIND = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
  const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  const envKey = pageKey !== undefined ? pageKey : process.env.PAGE_KEY;
  const PAGE_KEY = envKey !== undefined ? String(envKey) : randomBytes(24).toString("base64url");

  let boundServer = null;

  function currentConfig() {
    return resolveConfig(pluginOptions);
  }

  function sameKey(given) {
    if (!PAGE_KEY) return true;
    if (typeof given !== "string" || Buffer.byteLength(given) !== Buffer.byteLength(PAGE_KEY)) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(PAGE_KEY));
  }

  function authed(req) {
    if (!PAGE_KEY) return true;
    return sameKey(String(req.headers["x-dash-key"] || ""));
  }

  function hostAllowed(req) {
    const raw = String(req.headers.host || "").toLowerCase();
    if (!raw) return false;
    const m = raw.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!m) return false;
    const name = m[1];
    const reqPort = Number(m[2] || 0);
    const bound = boundServer?.address()?.port || 0;
    if (ALLOWED_HOSTS.includes(name) || ALLOWED_HOSTS.includes(raw)) return true;
    if (name === "127.0.0.1" || name === "localhost" || name === "[::1]") return true;
    if (reqPort && bound && reqPort !== bound) return false;
    if (!LOOPBACK_BIND) {
      if (name === HOST.toLowerCase()) return true;
      for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
          if (iface.address.toLowerCase() === name) return true;
        }
      }
    }
    return false;
  }

  function loopbackOrigin(origin, boundPort) {
    if (!boundPort) return false;
    return (
      origin === `http://127.0.0.1:${boundPort}` ||
      origin === `http://localhost:${boundPort}` ||
      origin === `http://[::1]:${boundPort}`
    );
  }

  function originOk(req) {
    const o = req.headers.origin;
    if (!o || o === "null") return true;
    return loopbackOrigin(o, boundServer?.address()?.port || 0);
  }

  function cors(req, res) {
    const o = req.headers.origin;
    const allow = (value) => {
      res.setHeader("Access-Control-Allow-Origin", value);
      res.setHeader("Vary", "Origin");
      return true;
    };
    if (o === undefined || o === "null") return allow("null");
    if (loopbackOrigin(o, boundServer?.address()?.port || 0)) return allow(o);
    return false;
  }

  function setSecurityHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
  }

  async function buildOverviewPayload(cfg, range = "7d") {
    const [activity, logs] = await Promise.all([
      store.queryActivity(cfg, { range }),
      store.queryLogs(cfg, { range, limit: 50, offset: 0 }),
    ]);
    return {
      config: publicConfigView(cfg),
      activity,
      logs,
      version: VERSION,
      build: BUILD_ID,
    };
  }

  async function handleRequest(req, res, url) {
    setSecurityHeaders(res);
    if (!hostAllowed(req)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("invalid host");
    }

    const pathname = url.pathname;

    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/ping" && req.method === "GET") {
        return sendJson(res, 200, {
          service: "magpie-s3-trace-sync",
          ok: true,
          build: BUILD_ID,
          version: VERSION,
        });
      }

      if (req.method === "OPTIONS") {
        if (!cors(req, res)) {
          res.writeHead(403);
          return res.end();
        }
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "x-dash-key, content-type",
          "Access-Control-Max-Age": "86400",
        });
        return res.end();
      }

      if (!cors(req, res)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("cross-origin requests not allowed");
      }

      if (pathname === "/api/health" && req.method === "GET") {
        const cfg = currentConfig();
        return sendJson(res, 200, {
          ok: true,
          enabled: cfg.enabled,
          provider: cfg.provider,
          s3Configured: cfg.s3Configured,
        });
      }

      if (!authed(req)) {
        return sendJson(res, 401, { error: "unauthorized: missing or invalid x-dash-key header" });
      }

      const cfg = currentConfig();

      if (pathname === "/api/overview" && req.method === "GET") {
        const range = url.searchParams.get("range") || "7d";
        return sendJson(res, 200, await buildOverviewPayload(cfg, range));
      }

      if (pathname === "/api/logs" && req.method === "GET") {
        const filters = parseFilters(url.searchParams);
        return sendJson(res, 200, await store.queryLogs(cfg, filters));
      }

      if (pathname.startsWith("/api/logs/") && pathname.endsWith("/push") && req.method === "POST") {
        const id = decodeURIComponent(pathname.slice("/api/logs/".length, -"/push".length));
        if (!id) return sendJson(res, 400, { error: "trace id is required" });
        try {
          const updated = await store.pushTrace(cfg, id);
          return sendJson(res, 200, { ok: true, trace: updated });
        } catch (err) {
          return sendJson(res, err?.status || 502, {
            ok: false,
            error: err?.message || String(err),
            r2Code: err?.r2Code ?? null,
            hint: err?.r2Hint || "",
          });
        }
      }

      if (pathname.startsWith("/api/logs/") && req.method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/logs/".length));
        if (!id) return sendJson(res, 400, { error: "trace id is required" });
        const trace = await store.getTrace(cfg, id);
        if (!trace) return sendJson(res, 404, { error: "trace not found" });
        return sendJson(res, 200, trace);
      }

      if (pathname === "/api/activity" && req.method === "GET") {
        const filters = parseFilters(url.searchParams);
        return sendJson(res, 200, await store.queryActivity(cfg, filters));
      }

      if (pathname === "/api/explore" && req.method === "GET") {
        const filters = parseFilters(url.searchParams);
        return sendJson(
          res,
          200,
          await store.queryExplore(cfg, {
            filters,
            metric: url.searchParams.get("metric") || "totalTokens",
            groupBy: url.searchParams.get("groupBy") || "model",
            subgroupBy: url.searchParams.get("subgroupBy") || "none",
            rollup: url.searchParams.get("rollup") || "none",
            limit: url.searchParams.get("limit") || 50,
          })
        );
      }

      if (pathname === "/api/explore/export.csv" && req.method === "GET") {
        const filters = parseFilters(url.searchParams);
        const csv = await store.exportExploreCsv(cfg, {
          filters,
          metric: url.searchParams.get("metric") || "totalTokens",
          groupBy: url.searchParams.get("groupBy") || "model",
          subgroupBy: url.searchParams.get("subgroupBy") || "none",
          rollup: url.searchParams.get("rollup") || "none",
        });
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="s3-trace-sync-activity.csv"',
          "Cache-Control": "no-store",
        });
        return res.end(csv);
      }

      if (pathname === "/api/sessions" && req.method === "GET") {
        const filters = parseFilters(url.searchParams);
        return sendJson(res, 200, await store.querySessions(cfg, filters));
      }

      if (pathname.startsWith("/api/sessions/") && req.method === "GET") {
        const sid = decodeURIComponent(pathname.slice("/api/sessions/".length));
        if (!sid) return sendJson(res, 400, { error: "session id is required" });
        const turns = await store.getSessionThread(cfg, sid);
        return sendJson(res, 200, { sessionId: sid, count: turns.length, turns });
      }

      if (pathname === "/api/settings" && req.method === "GET") {
        return sendJson(res, 200, { config: publicConfigView(cfg) });
      }

      if (pathname === "/api/settings" && req.method === "POST") {
        let body;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err?.status || 400, { error: err?.message || "Invalid JSON" });
        }
        try {
          const patch = sanitizeSettingsPatch(body, cfg.provider);
          await writeLocalOverlay(cfg.stateDir, patch);
          const next = currentConfig();
          return sendJson(res, 200, { ok: true, config: publicConfigView(next) });
        } catch (err) {
          return sendJson(res, 400, { error: err?.message || "Invalid settings update" });
        }
      }

      if (pathname === "/api/settings/reset" && req.method === "POST") {
        const file = path.join(cfg.stateDir, "config.json");
        await fsp.rm(file, { force: true }).catch(() => {});
        const next = resolveConfig({ ...pluginOptions, ignoreOverlay: true });
        return sendJson(res, 200, { ok: true, config: publicConfigView(next) });
      }

      if (pathname === "/api/s3/test" && req.method === "POST") {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err?.status || 400, { ok: false, error: err?.message || "Invalid JSON" });
        }
        let testCfg = cfg;
        if (body && typeof body === "object" && Object.keys(body).length > 0) {
          try {
            const patch = sanitizeSettingsPatch(body, cfg.provider);
            // Build temporary effective config by overlaying non-null draft fields on current saved config.
            const mergedDraft = { ...cfg };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete mergedDraft[k];
              else mergedDraft[k] = v;
            }
            mergedDraft.ignoreOverlay = true;
            testCfg = resolveConfig(mergedDraft);
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err?.message || "Invalid test configuration" });
          }
        }
        const client = new S3TraceClient(testCfg, store.fetchImpl);
        const result = await client.testConnection();
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/s3/sync" && req.method === "POST") {
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, err?.status || 400, { ok: false, error: err?.message || "Invalid JSON" });
        }
        try {
          const result = await store.syncFromS3(cfg, {
            prefix: typeof body.prefix === "string" ? body.prefix : undefined,
            maxObjects: Number.isInteger(Number(body.maxObjects)) ? Math.min(250, Math.max(1, Number(body.maxObjects))) : 100,
          });
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, err?.status || 502, {
            ok: false,
            error: err?.message || String(err),
            r2Code: err?.r2Code ?? null,
            hint: err?.r2Hint || "",
          });
        }
      }

      if (pathname === "/api/s3/flush" && req.method === "POST") {
        const result = await store.flushBatch(cfg);
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/cache/clear" && req.method === "POST") {
        await store.clearLocalCache(cfg);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: "not found" });
    }

    // Static asset serving
    const file = pathname === "/" ? "/index.html" : pathname;
    const full = path.resolve(STATIC_DIR, `.${file}`);
    const rel = path.relative(STATIC_DIR, full);
    let isFile = false;
    try {
      isFile = !rel.startsWith("..") && !path.isAbsolute(rel) && fs.statSync(full).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }

    if (file === "/index.html") {
      if (!originOk(req)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("cross-origin page read not allowed");
      }
      if (!LOOPBACK_BIND) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("dashboard page is loopback-only; API routes accept x-dash-key");
      }
      const hostName = (String(req.headers.host || "").toLowerCase().match(/^(\[[^\]]+\]|[^:]+)/) || [])[1] || "";
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostName)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("dashboard page answers loopback hosts only");
      }

      let html = await fsp.readFile(full, "utf8");
      const cfg = currentConfig();
      const range = url.searchParams.get("range") || "7d";
      let initial = null;
      try {
        initial = await buildOverviewPayload(cfg, range);
      } catch {
        initial = { config: publicConfigView(cfg), activity: null, logs: null, version: VERSION, build: BUILD_ID };
      }

      const safeJson = (val) =>
        JSON.stringify(val)
          .replace(/</g, "\\u003c")
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029");
      const keyInject = PAGE_KEY ? `<script>window.__KEY__=${safeJson(PAGE_KEY)};</script>` : "";
      const dataInject = `<script>window.__INITIAL__=${safeJson(initial)};</script>`;
      html = html.replace("<head>", () => `<head>${keyInject}${dataInject}`);

      const boundPort = boundServer?.address()?.port || 0;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:${boundPort} http://localhost:${boundPort}; object-src 'none'; base-uri 'none'; frame-ancestors *`,
      });
      return res.end(html);
    }

    const ext = path.extname(full).toLowerCase();
    const headers = {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    };
    if (ext === ".svg") {
      headers["Content-Security-Policy"] = "sandbox";
    }
    res.writeHead(200, headers);
    return res.end(await fsp.readFile(full));
  }

  boundServer = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("bad request");
    }
    handleRequest(req, res, url).catch((err) => {
      console.error(`[s3-trace-sync] request error: ${err?.message || err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("internal server error");
      } else {
        try {
          res.end();
        } catch {
          // Ignore already closed socket.
        }
      }
    });
  });

  async function probeExisting(hp) {
    try {
      const r = await fetch(`http://${hp}/api/ping`, { signal: AbortSignal.timeout(1200) });
      const j = await r.json();
      if (j && j.service === "magpie-s3-trace-sync") {
        return { build: String(j.build || ""), version: String(j.version || "") };
      }
    } catch {
      // Not listening or different protocol.
    }
    return null;
  }

  function bindOnce(targetPort) {
    return new Promise((resolve, reject) => {
      const onListen = () => {
        cleanup();
        resolve({ bound: true, port: boundServer.address().port });
      };
      const onErr = (err) => {
        cleanup();
        if (err.code === "EADDRINUSE" || err.code === "EACCES") {
          resolve({ bound: false, error: err });
          return;
        }
        reject(err);
      };
      const cleanup = () => {
        boundServer.off("listening", onListen);
        boundServer.off("error", onErr);
      };
      boundServer.once("listening", onListen);
      boundServer.once("error", onErr);
      boundServer.listen(targetPort, HOST);
    });
  }

  async function start() {
    const cfg = currentConfig();
    const targetPort = port !== undefined ? port : cfg.port || DEFAULT_PORT;

    // Port 0 allows ephemeral port assignment for tests.
    if (targetPort === 0) {
      const res = await bindOnce(0);
      if (!res.bound) throw res.error;
      return res.port;
    }

    const deadline = Date.now() + 8000;
    while (true) {
      const res = await bindOnce(targetPort);
      if (res.bound) {
        console.log(
          `[s3-trace-sync] listening on http://${URL_HOST}:${res.port}/ (provider=${cfg.provider}, enabled=${cfg.enabled})`
        );
        return res.port;
      }

      const existing = await probeExisting(`${URL_HOST}:${targetPort}`);
      if (existing && existing.build === BUILD_ID) {
        await new Promise((r) => setTimeout(r, 1200));
        const confirm = await probeExisting(`${URL_HOST}:${targetPort}`);
        if (confirm && confirm.build === BUILD_ID) {
          console.log(`[s3-trace-sync] reusing existing build ${BUILD_ID} on port ${targetPort}`);
          return targetPort;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          existing
            ? `Port ${targetPort} is held by another build (${existing.build || "unknown"}).`
            : `Port ${targetPort} is already in use.`
        );
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  function stop() {
    return new Promise((resolve) => {
      if (!boundServer.listening) return resolve();
      boundServer.close(() => resolve());
    });
  }

  return {
    server: boundServer,
    start,
    stop,
    getPageKey: () => PAGE_KEY,
  };
}

let bootPromise = null;

export function startServer({ port, pluginOptions = {} } = {}) {
  if (bootPromise) return bootPromise;
  const app = createAppServer({ port, pluginOptions });
  bootPromise = app.start().catch((err) => {
    bootPromise = null;
    throw err;
  });
  return bootPromise;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((err) => {
    console.error(`[s3-trace-sync] failed to start: ${err?.message || err}`);
    process.exit(1);
  });
}

export { TraceStore };
