(() => {
  const PAGE_KEY = window.__KEY__ || "";
  const INITIAL = window.__INITIAL__ || null;

  const state = {
    tab: "logs",
    range: "7d",
    offset: 0,
    limit: 50,
    filters: {
      q: "",
      model: "",
      provider: "",
      agent: "",
      apiKeyName: "",
      status: "",
      syncState: "",
    },
    explore: {
      metric: "totalTokens",
      groupBy: "model",
      subgroupBy: "none",
      rollup: "none",
    },
    config: INITIAL?.config || null,
    logs: INITIAL?.logs || null,
    activity: INITIAL?.activity || null,
    sessions: null,
    drawerMode: "trace", // "trace" | "session"
    drawerTab: "overview",
    drawerTrace: null,
    drawerSession: null,
    clearSecret: false,
  };

  const $ = (id) => document.getElementById(id);

  function esc(val) {
    return String(val ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function apiUrl(relPath, params = {}) {
    const clean = relPath.replace(/^\/+/, "");
    const u = new URL(clean, location.href);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v) !== "") {
        u.searchParams.set(k, String(v));
      }
    }
    return u.href;
  }

  async function apiFetch(relPath, { method = "GET", params = {}, body } = {}) {
    const headers = {};
    if (PAGE_KEY) headers["x-dash-key"] = PAGE_KEY;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(apiUrl(relPath, params), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP ${res.status}`);
      err.data = json;
      throw err;
    }
    return json;
  }

  function showBanner(msg, kind = "ok") {
    const el = $("banner");
    el.textContent = msg;
    el.className = `banner ${kind}`;
    el.hidden = false;
    clearTimeout(showBanner._timer);
    showBanner._timer = setTimeout(() => {
      el.hidden = true;
    }, 6000);
  }

  function fmtNum(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
    return Number(n).toLocaleString();
  }

  function fmtCompact(n) {
    const num = Number(n || 0);
    if (!Number.isFinite(num)) return "0";
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 10_000) return `${(num / 1_000).toFixed(1)}k`;
    return num.toLocaleString();
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function fmtDuration(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
    const n = Number(ms);
    if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
    return `${Math.round(n)}ms`;
  }

  function providerLabel(p) {
    if (p === "r2") return "Cloudflare R2";
    if (p === "aws") return "AWS S3";
    if (p === "gcs") return "Google Cloud Storage";
    return "Custom S3";
  }

  function syncBadge(sync) {
    const s = sync?.state || "local_only";
    if (s === "synced") return '<span class="badge badge-ok">Synced</span>';
    if (s === "retrying") return '<span class="badge badge-warn">Retrying</span>';
    if (s === "queued_batch") return '<span class="badge badge-warn">Queued</span>';
    if (s === "failed") return '<span class="badge badge-bad">Failed</span>';
    return '<span class="badge badge-neutral">Local</span>';
  }

  function renderHeaderStatus() {
    const cfg = state.config;
    if (!cfg) return;
    const pBadge = $("provider-badge");
    pBadge.textContent = providerLabel(cfg.provider);
    pBadge.className = `badge ${cfg.provider === "r2" ? "badge-r2" : "badge-s3"}`;

    const pill = $("sync-status-pill");
    if (cfg.enabled && cfg.s3Configured) {
      pill.textContent = `Active · ${cfg.bucket}`;
      pill.className = "status-pill ok";
    } else if (cfg.enabled && !cfg.s3Configured) {
      pill.textContent = "Enabled · Needs R2/S3 Bucket";
      pill.className = "status-pill warn";
    } else if (cfg.s3Configured) {
      pill.textContent = "Configured · Sync Paused";
      pill.className = "status-pill neutral";
    } else {
      pill.textContent = "Setup Required";
      pill.className = "status-pill neutral";
    }

    $("btn-pull-s3").textContent = cfg.provider === "r2" ? "Pull from R2" : "Pull from S3";
    $("btn-pull-s3").disabled = !cfg.s3Configured;
  }

  function populateSelect(el, values, placeholder) {
    const prev = el.value;
    el.innerHTML = `<option value="">${esc(placeholder)}</option>` +
      values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    if (values.includes(prev)) el.value = prev;
  }

  function renderHistogram(histogram) {
    const el = $("logs-histogram");
    if (!Array.isArray(histogram) || histogram.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:16px">No requests in selected window</div>';
      return;
    }
    const maxTotal = Math.max(1, ...histogram.map((b) => b.total || 0));
    const w = 800;
    const h = 68;
    const step = w / histogram.length;
    const barW = Math.max(8, step - 4);
    const bars = histogram
      .map((b, i) => {
        const x = i * step + 2;
        const okCount = Math.max(0, (b.completed || 0));
        const errCount = Math.max(0, (b.errors || 0));
        const okH = Math.round((okCount / maxTotal) * (h - 14));
        const errH = Math.round((errCount / maxTotal) * (h - 14));
        const okY = h - 6 - okH;
        const errY = okY - errH;
        const title = `${b.label} UTC: ${b.total} req (${b.errors} err)`;
        return `<g>
          <title>${esc(title)}</title>
          <rect x="${x}" y="${okY}" width="${barW}" height="${Math.max(okCount ? 2 : 0, okH)}" rx="2" fill="var(--accent)" opacity="0.88"/>
          ${errCount ? `<rect x="${x}" y="${errY}" width="${barW}" height="${Math.max(2, errH)}" rx="2" fill="var(--bad)"/>` : ""}
        </g>`;
      })
      .join("");
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
  }

  function renderLogs() {
    const data = state.logs;
    if (!data) return;

    if (data.facets) {
      populateSelect($("filter-model"), data.facets.models || [], "All models");
      populateSelect($("filter-provider"), data.facets.providers || [], "All providers");
      populateSelect($("filter-agent"), data.facets.agents || [], "All agents");
      populateSelect($("filter-apikey"), data.facets.apiKeys || [], "All API keys");
    }

    renderHistogram(data.histogram || []);
    $("logs-count-label").textContent = `${fmtNum(data.total)} generation${data.total === 1 ? "" : "s"}`;

    const tbody = $("logs-tbody");
    const items = data.items || [];
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        No traces recorded in this window yet.<br>
        <small>Enable sync under <strong>Broadcast &amp; R2</strong> and send requests through Magpie, or click <strong>Pull from R2</strong>.</small>
      </div></td></tr>`;
    } else {
      tbody.innerHTML = items
        .map((item) => {
          const u = item.usage || {};
          const cached = u.promptTokensDetails?.cachedTokens || 0;
          const errDot = item.status === "error" ? '<span class="badge badge-bad">Error</span> ' : "";
          const preview = item.privacyMode
            ? '<span class="muted">Privacy Mode (content omitted)</span>'
            : !item.inputOutputLogging
              ? '<span class="muted">Metadata only</span>'
              : esc(item.title || item.previewCompletion || "(no prompt text)");
          return `<tr class="clickable" data-trace-id="${esc(item.id)}">
            <td>
              <div class="cell-main">${esc(fmtTime(item.timestamp))}</div>
              <div class="cell-sub mono">${esc(item.id.slice(0, 20))}</div>
            </td>
            <td>
              <div class="cell-main">${errDot}${esc(item.servedModel || item.model)}</div>
              <div class="cell-sub">${esc(item.provider)} · ${esc(item.protocol)}${item.stream ? " · stream" : ""}</div>
            </td>
            <td>
              <div class="preview-text">${preview}</div>
              ${item.sessionId ? `<div class="cell-sub mono">session: ${esc(item.sessionId)}</div>` : ""}
            </td>
            <td>
              <div class="cell-main">${esc(item.agent)}</div>
              <div class="cell-sub">${esc(item.apiKeyName)} (${esc(item.origin)})</div>
            </td>
            <td class="num">
              <div class="cell-main">${fmtNum(u.totalTokens || 0)}</div>
              <div class="cell-sub">${fmtNum(u.promptTokens || 0)} in / ${fmtNum(u.completionTokens || 0)} out${cached ? ` · ${fmtNum(cached)} cached` : ""}</div>
            </td>
            <td class="num">
              <div class="cell-main">${esc(fmtDuration(item.latencyMs))}</div>
              <div class="cell-sub">${item.ttftMs ? `TTFT ${esc(fmtDuration(item.ttftMs))}` : esc(item.finishReason || "—")}</div>
            </td>
            <td>${syncBadge(item.s3Sync)}</td>
          </tr>`;
        })
        .join("");
    }

    const start = data.total === 0 ? 0 : data.offset + 1;
    const end = Math.min(data.total, data.offset + items.length);
    $("logs-page-info").textContent = `Showing ${start}–${end} of ${fmtNum(data.total)}`;
    $("btn-prev-page").disabled = data.offset <= 0;
    $("btn-next-page").disabled = data.offset + items.length >= data.total;
  }

  function renderSessions() {
    const data = state.sessions;
    if (!data) return;
    $("sessions-count-label").textContent = `${fmtNum(data.total)} session${data.total === 1 ? "" : "s"}`;
    const tbody = $("sessions-tbody");
    const list = data.sessions || [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state">No sessions found in this range.</div></td></tr>';
      return;
    }
    tbody.innerHTML = list
      .map(
        (s) => `<tr class="clickable" data-session-id="${esc(s.sessionId)}">
          <td>
            <div class="cell-main">${esc(fmtTime(s.lastAt))}</div>
            <div class="cell-sub">started ${esc(fmtTime(s.firstAt))}</div>
          </td>
          <td>
            <div class="cell-main preview-text">${esc(s.title)}</div>
            <div class="cell-sub mono">${esc(s.sessionId)}</div>
          </td>
          <td>
            <div class="cell-main">${esc((s.models || []).slice(0, 3).join(", ") || "—")}</div>
            <div class="cell-sub">${esc((s.providers || []).join(", "))}</div>
          </td>
          <td>
            <div class="cell-main">${esc(s.agent)}</div>
            <div class="cell-sub">${esc(s.apiKeyName)}</div>
          </td>
          <td class="num">
            <div class="cell-main">${fmtNum(s.requestCount)}</div>
            ${s.errorCount ? `<div class="cell-sub" style="color:var(--bad)">${fmtNum(s.errorCount)} err</div>` : ""}
          </td>
          <td class="num">
            <div class="cell-main">${fmtNum(s.totalTokens)}</div>
            <div class="cell-sub">${fmtNum(s.promptTokens)} in / ${fmtNum(s.completionTokens)} out</div>
          </td>
        </tr>`
      )
      .join("");
  }

  function renderBarChart(container, series, valueFn, secondaryFn, colorPrimary, colorSecondary) {
    if (!Array.isArray(series) || series.length === 0) {
      container.innerHTML = '<div class="empty-state">No time-series data yet.</div>';
      return;
    }
    const w = 640;
    const h = 175;
    const padB = 24;
    const maxV = Math.max(1, ...series.map((d) => valueFn(d) + (secondaryFn ? secondaryFn(d) : 0)));
    const step = w / series.length;
    const bw = Math.max(6, Math.min(36, step - 6));

    const bars = series
      .map((d, i) => {
        const v1 = Math.max(0, valueFn(d));
        const v2 = secondaryFn ? Math.max(0, secondaryFn(d)) : 0;
        const x = i * step + (step - bw) / 2;
        const h1 = Math.round((v1 / maxV) * (h - padB - 12));
        const h2 = Math.round((v2 / maxV) * (h - padB - 12));
        const y1 = h - padB - h1;
        const y2 = y1 - h2;
        const label = d.bucket.length > 10 ? d.bucket.slice(5, 16) : d.bucket.slice(5);
        const showLabel = series.length <= 12 || i % Math.ceil(series.length / 8) === 0;
        return `<g>
          <title>${esc(`${d.bucket}: ${fmtNum(v1)}${secondaryFn ? ` (+ ${fmtNum(v2)})` : ""}`)}</title>
          <rect x="${x}" y="${y1}" width="${bw}" height="${Math.max(v1 ? 2 : 0, h1)}" rx="3" fill="${colorPrimary}" opacity="0.9"/>
          ${v2 ? `<rect x="${x}" y="${y2}" width="${bw}" height="${Math.max(2, h2)}" rx="3" fill="${colorSecondary}"/>` : ""}
          ${showLabel ? `<text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(label)}</text>` : ""}
        </g>`;
      })
      .join("");
    container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${bars}</svg>`;
  }

  function renderBreakdownTable(tableEl, rows) {
    if (!rows || rows.length === 0) {
      tableEl.innerHTML = '<tbody><tr><td><div class="empty-state" style="padding:18px">No data</div></td></tr></tbody>';
      return;
    }
    const body = rows
      .slice(0, 12)
      .map(
        (r) => `<tr>
          <td><div class="cell-main">${esc(r.name)}</div></td>
          <td class="num">${fmtNum(r.requests)}</td>
          <td class="num">${fmtCompact(r.totalTokens)}</td>
          <td class="num">${r.cacheHitRate}%</td>
          <td class="num">${esc(fmtDuration(r.avgLatencyMs))}</td>
        </tr>`
      )
      .join("");
    tableEl.innerHTML = `
      <thead><tr><th>Name</th><th class="num">Reqs</th><th class="num">Tokens</th><th class="num">Cache</th><th class="num">Avg Lat</th></tr></thead>
      <tbody>${body}</tbody>`;
  }

  function renderActivity() {
    const data = state.activity;
    if (!data) return;
    const s = data.summary || {};
    $("activity-kpis").innerHTML = [
      ["Requests", fmtNum(s.totalRequests), `${fmtNum(s.errorRequests)} errors (${s.errorRate || 0}%)`],
      ["Total Tokens", fmtCompact(s.totalTokens), `${fmtCompact(s.promptTokens)} in / ${fmtCompact(s.completionTokens)} out`],
      ["Cache Hit Rate", `${s.cacheHitRate || 0}%`, `${fmtCompact(s.cachedTokens)} cached · ${fmtCompact(s.cacheWriteTokens)} write`],
      ["Reasoning Tokens", fmtCompact(s.reasoningTokens), "Captured model thinking tokens"],
      ["Avg Latency", fmtDuration(s.avgLatencyMs), `P95 ${fmtDuration(s.p95LatencyMs)} · TTFT ${fmtDuration(s.avgTtftMs)}`],
      ["R2 / S3 Synced", fmtNum(s.s3SyncedCount), `${fmtNum(s.s3PendingOrFailedCount)} pending/failed`],
    ]
      .map(
        ([label, val, sub]) => `<div class="kpi">
          <div class="kpi-label">${esc(label)}</div>
          <div class="kpi-value">${esc(val)}</div>
          <div class="kpi-sub">${esc(sub)}</div>
        </div>`
      )
      .join("");

    $("activity-granularity").textContent = data.granularity === "hour" ? "Hourly" : "Daily";
    $("activity-sync-summary").textContent = `${fmtNum(data.syncStats?.synced || 0)} synced · ${fmtNum(data.syncStats?.failed || 0)} failed`;

    renderBarChart(
      $("activity-tokens-chart"),
      data.trends || [],
      (d) => d.promptTokens || 0,
      (d) => d.completionTokens || 0,
      "var(--blue)",
      "var(--accent)"
    );
    renderBarChart(
      $("activity-requests-chart"),
      data.trends || [],
      (d) => Math.max(0, (d.requests || 0) - (d.errors || 0)),
      (d) => d.errors || 0,
      "var(--ok)",
      "var(--bad)"
    );

    renderBreakdownTable($("tbl-by-model"), data.breakdowns?.models);
    renderBreakdownTable($("tbl-by-provider"), data.breakdowns?.providers);
    renderBreakdownTable($("tbl-by-agent"), data.breakdowns?.agents);
    renderBreakdownTable($("tbl-by-apikey"), data.breakdowns?.apiKeys);
  }

  function renderExplore(data) {
    if (!data) return;
    const hasRollup = data.rollup !== "none";
    const hasSub = data.subgroupBy && data.subgroupBy !== "none";
    $("explore-thead").innerHTML = `<tr>
      ${hasRollup ? "<th>Time Bucket</th>" : ""}
      <th>${esc(data.groupBy)}</th>
      ${hasSub ? `<th>${esc(data.subgroupBy)}</th>` : ""}
      <th class="num">Requests</th>
      <th class="num">Errors</th>
      <th class="num">Prompt</th>
      <th class="num">Completion</th>
      <th class="num">Cached</th>
      <th class="num">Total Tokens</th>
      <th class="num">Avg Latency</th>
    </tr>`;
    const rows = data.rows || [];
    if (!rows.length) {
      $("explore-tbody").innerHTML = '<tr><td colspan="10"><div class="empty-state">No rows match the selected range.</div></td></tr>';
      return;
    }
    $("explore-tbody").innerHTML = rows
      .map(
        (r) => `<tr>
          ${hasRollup ? `<td class="mono">${esc(r.timeBucket)}</td>` : ""}
          <td><strong>${esc(r.group)}</strong></td>
          ${hasSub ? `<td>${esc(r.subgroup)}</td>` : ""}
          <td class="num">${fmtNum(r.requests)}</td>
          <td class="num">${fmtNum(r.errorCount)}</td>
          <td class="num">${fmtNum(r.promptTokens)}</td>
          <td class="num">${fmtNum(r.completionTokens)}</td>
          <td class="num">${fmtNum(r.cachedTokens)}</td>
          <td class="num"><strong>${fmtNum(r.totalTokens)}</strong></td>
          <td class="num">${esc(fmtDuration(r.avgLatencyMs))}</td>
        </tr>`
      )
      .join("");
  }

  function updateProviderUi(provider) {
    document.querySelectorAll(".provider-card").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.provider === provider);
    });
    const isR2 = provider === "r2";
    const isAws = provider === "aws";
    $("wrap-account-id").hidden = !isR2;
    $("wrap-jurisdiction").hidden = !isR2;
    $("r2-callout").hidden = !isR2;
    $("wrap-sse").hidden = isR2;
    $("wrap-sse-kms").hidden = isR2 || $("cfg-sse").value !== "aws:kms";
    $("wrap-insecure-http").hidden = isR2 || isAws || provider === "gcs";
    $("hint-region").innerHTML = isR2
      ? "Use <code>auto</code> for Cloudflare R2 (default)."
      : isAws
        ? "AWS region slug, e.g. <code>us-east-1</code>."
        : "S3 signing region (e.g. <code>us-east-1</code> or <code>auto</code>).";
    $("hint-endpoint").textContent = isR2
      ? "Auto-generated from Cloudflare Account ID, or enter a custom R2 jurisdiction URL."
      : isAws
        ? "Leave blank for standard AWS S3 endpoints."
        : provider === "gcs"
          ? "Leave blank for https://storage.googleapis.com."
          : "Required for MinIO, Synology, Ceph, or self-hosted S3.";
    $("hint-bucket").textContent = isR2
      ? "Default: magpie-traces. R2 rule (code 10005): 3–63 chars, lowercase letters, numbers, and hyphens."
      : "Default: magpie-traces. Bucket name (3–63 chars).";
  }

  function maybeAutoBuildR2Endpoint() {
    const activeProvider = document.querySelector(".provider-card.active")?.dataset.provider || "r2";
    if (activeProvider !== "r2") return;
    const id = $("cfg-account-id").value.trim().toLowerCase();
    if (!id) return;
    const jur = $("cfg-r2-jurisdiction").value;
    const host =
      jur === "eu"
        ? `${id}.eu.r2.cloudflarestorage.com`
        : jur === "fedramp"
          ? `${id}.fedramp.r2.cloudflarestorage.com`
          : `${id}.r2.cloudflarestorage.com`;
    $("cfg-endpoint").value = `https://${host}`;
  }

  const TRACE_PRESETS = {
    common: {
      timestamps: true,
      session: true,
      routing: true,
      status: true,
      timing: true,
      usage: true,
      modelParameters: true,
      systemPrompt: true,
      inputMessages: true,
      outputMessages: true,
      reasoning: true,
      toolCalls: true,
      rawRequest: true,
      rawResponse: false,
      rawUsage: true,
      customMetadata: true,
      otelObservations: true,
    },
    full: {
      timestamps: true,
      session: true,
      routing: true,
      status: true,
      timing: true,
      usage: true,
      modelParameters: true,
      systemPrompt: true,
      inputMessages: true,
      outputMessages: true,
      reasoning: true,
      toolCalls: true,
      rawRequest: true,
      rawResponse: true,
      rawUsage: true,
      customMetadata: true,
      otelObservations: true,
    },
    minimal: {
      timestamps: false,
      session: true,
      routing: true,
      status: true,
      timing: true,
      usage: true,
      modelParameters: false,
      systemPrompt: false,
      inputMessages: true,
      outputMessages: true,
      reasoning: false,
      toolCalls: false,
      rawRequest: false,
      rawResponse: false,
      rawUsage: false,
      customMetadata: false,
      otelObservations: false,
    },
  };

  function detectTracePresetFromForm() {
    const cur = collectTraceFieldsFromForm();
    for (const name of ["common", "full", "minimal"]) {
      const target = TRACE_PRESETS[name];
      if (Object.keys(target).every((k) => Boolean(cur[k]) === Boolean(target[k]))) {
        return name;
      }
    }
    return "custom";
  }

  function collectTraceFieldsFromForm() {
    const out = {};
    document.querySelectorAll("[data-trace-field]").forEach((cb) => {
      out[cb.dataset.traceField] = cb.checked;
    });
    return out;
  }

  function applyTraceFieldsToForm(fields = {}, explicitPreset = null) {
    const merged = { ...TRACE_PRESETS.common, ...fields };
    document.querySelectorAll("[data-trace-field]").forEach((cb) => {
      cb.checked = Boolean(merged[cb.dataset.traceField]);
    });
    const preset = explicitPreset || detectTracePresetFromForm();
    updateTracePresetBadge(preset);
  }

  function updateTracePresetBadge(preset) {
    const badge = $("trace-preset-badge");
    if (!badge) return;
    if (preset === "common") badge.textContent = "Common (Default)";
    else if (preset === "full") badge.textContent = "Full";
    else if (preset === "minimal") badge.textContent = "Minimal";
    else badge.textContent = "Custom";
  }

  function updatePathPreview() {
    const bucket = ($("cfg-bucket").value || "magpie-traces").trim() || "magpie-traces";
    const folder = ($("cfg-folder").value || "openrouter-traces").trim().replace(/^\/+|\/+$/g, "") || "openrouter-traces";
    const tpl = ($("cfg-path-template").value || "{folder}/{date}").trim() || "{folder}/{date}";
    const now = new Date();
    const iso = now.toISOString();
    const map = {
      folder,
      prefix: folder,
      date: iso.slice(0, 10),
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      apiKeyName: "local",
      agent: "claude",
      provider: "anthropic",
      model: "claude-sonnet-4",
      session: "ses_demo",
      origin: "local",
    };
    const rendered = tpl
      .replace(/\{([A-Za-z0-9_]+)\}/g, (_, k) => map[k] || k)
      .replace(/^\/+|\/+$/g, "");
    const suffix =
      $("cfg-export-mode").value === "batch"
        ? `batch-${now.getTime()}.json`
        : `trc_demo-${now.getTime()}.json`;
    $("path-preview").textContent = `${bucket}/${rendered ? `${rendered}/` : ""}${suffix}`;
  }

  function populateSettingsForm() {
    const c = state.config;
    if (!c) return;
    $("cfg-enabled").checked = Boolean(c.enabled);
    $("cfg-account-id").value = c.accountId || "";
    $("cfg-r2-jurisdiction").value = c.r2Jurisdiction || "default";
    $("cfg-bucket").value = c.bucket || "magpie-traces";
    $("cfg-region").value = c.region || (c.provider === "r2" ? "auto" : "us-east-1");
    $("cfg-endpoint").value = c.endpoint || "";
    $("cfg-ak").value = c.accessKeyId || "";
    $("cfg-sk").value = "";
    $("cfg-sk").placeholder = c.hasSecretAccessKey
      ? `Saved (${c.secretAccessKeyHint}) — leave blank to keep`
      : "Enter R2 / S3 Secret Access Key";
    $("btn-clear-sk").hidden = !c.hasSecretAccessKey;
    state.clearSecret = false;
    $("cfg-st").value = "";
    $("cfg-st").placeholder = c.hasSessionToken ? `Saved (${c.sessionTokenHint})` : "Optional temporary session token";
    $("cfg-storage-class").value = c.storageClass || "STANDARD";
    $("cfg-sse").value = c.sse || "none";
    $("cfg-sse-kms").value = c.sseKmsKeyId || "";
    $("cfg-path-style").checked = Boolean(c.forcePathStyle);
    $("cfg-insecure-http").checked = Boolean(c.allowInsecureHttp);

    $("hint-ak").textContent = c.credentialSources?.accessKeyFromEnv
      ? "Currently inherited from environment variable."
      : "";
    if (c.credentialSources?.secretKeyFromEnv) {
      $("hint-sk").textContent = "Currently inherited from environment variable; entering a key here saves a local override.";
    } else {
      $("hint-sk").textContent = "Stored locally in mode 0600 config.json; never returned to the browser.";
    }

    $("cfg-folder").value = c.folder || c.prefix || "openrouter-traces";
    $("cfg-path-template").value = c.pathTemplate || "{folder}/{date}";
    $("cfg-export-mode").value = c.exportMode || "single";
    $("cfg-batch-max").value = c.batchMaxItems ?? 20;
    $("cfg-batch-flush").value = c.batchFlushIntervalMs ?? 10000;
    $("cfg-s3-timeout").value = c.s3TimeoutMs ?? 8000;

    applyTraceFieldsToForm(c.traceFields, c.tracePreset);

    $("cfg-io-logging").checked = c.inputOutputLogging !== false;
    $("cfg-privacy-mode").checked = Boolean(c.privacyMode);
    $("cfg-strip-multimodal").checked = c.stripMultimodal !== false;
    $("cfg-redact-secrets").checked = c.redactSecrets !== false;
    $("cfg-capture-errors").checked = c.captureErrors !== false;
    $("cfg-capture-remote").checked = Boolean(c.captureRemote);
    $("cfg-skip-subagents").checked = Boolean(c.skipSubagents);
    $("cfg-local-cache").checked = c.localCache !== false;

    $("cfg-inc-keys").value = (c.includedApiKeys || []).join(", ");
    $("cfg-exc-keys").value = (c.excludedApiKeys || []).join(", ");
    $("cfg-skip-agents").value = (c.skipAgents || []).join(", ");
    $("cfg-exc-models").value = (c.excludedModels || []).join(", ");
    $("cfg-max-local").value = c.maxLocalTraces ?? 500;

    updateProviderUi(c.provider || "r2");
    updatePathPreview();
  }

  function collectSettingsPayload() {
    const provider = document.querySelector(".provider-card.active")?.dataset.provider || "r2";
    const folder = $("cfg-folder").value.trim() || "openrouter-traces";
    const traceFields = collectTraceFieldsFromForm();
    const tracePreset = detectTracePresetFromForm();
    const payload = {
      enabled: $("cfg-enabled").checked,
      provider,
      accountId: $("cfg-account-id").value.trim(),
      r2Jurisdiction: $("cfg-r2-jurisdiction").value,
      bucket: $("cfg-bucket").value.trim() || "magpie-traces",
      region: $("cfg-region").value.trim() || (provider === "r2" ? "auto" : "us-east-1"),
      endpoint: $("cfg-endpoint").value.trim(),
      accessKeyId: $("cfg-ak").value.trim(),
      storageClass: $("cfg-storage-class").value,
      sse: $("cfg-sse").value,
      sseKmsKeyId: $("cfg-sse-kms").value.trim(),
      forcePathStyle: $("cfg-path-style").checked,
      allowInsecureHttp: $("cfg-insecure-http").checked,
      folder,
      prefix: folder,
      pathTemplate: $("cfg-path-template").value.trim() || "{folder}/{date}",
      exportMode: $("cfg-export-mode").value,
      batchMaxItems: Number($("cfg-batch-max").value || 20),
      batchFlushIntervalMs: Number($("cfg-batch-flush").value || 10000),
      s3TimeoutMs: Number($("cfg-s3-timeout").value || 8000),
      tracePreset,
      traceFields,
      inputOutputLogging: $("cfg-io-logging").checked,
      privacyMode: $("cfg-privacy-mode").checked,
      stripMultimodal: $("cfg-strip-multimodal").checked,
      redactSecrets: $("cfg-redact-secrets").checked,
      captureErrors: $("cfg-capture-errors").checked,
      captureRemote: $("cfg-capture-remote").checked,
      skipSubagents: $("cfg-skip-subagents").checked,
      localCache: $("cfg-local-cache").checked,
      includedApiKeys: $("cfg-inc-keys").value,
      excludedApiKeys: $("cfg-exc-keys").value,
      skipAgents: $("cfg-skip-agents").value,
      excludedModels: $("cfg-exc-models").value,
      maxLocalTraces: Number($("cfg-max-local").value || 500),
    };
    const sk = $("cfg-sk").value.trim();
    if (state.clearSecret) payload.clearSecretAccessKey = true;
    else if (sk) payload.secretAccessKey = sk;

    const st = $("cfg-st").value.trim();
    if (st) payload.sessionToken = st;
    return payload;
  }

  // Drawer helpers
  function openDrawer() {
    $("drawer-backdrop").hidden = false;
    $("detail-drawer").hidden = false;
  }

  function closeDrawer() {
    $("drawer-backdrop").hidden = true;
    $("detail-drawer").hidden = true;
    state.drawerTrace = null;
    state.drawerSession = null;
  }

  function renderTraceDrawer() {
    const t = state.drawerTrace;
    if (!t) return;
    $("drawer-title").textContent = t.servedModel || t.model || t.name || "Generation Details";
    $("drawer-subtitle").textContent = `${t.id} · ${fmtTime(t.timestamp)} · ${t.provider || "—"}`;
    $("drawer-tabs").hidden = false;
    $("btn-drawer-push").hidden = !state.config?.s3Configured;
    $("btn-drawer-push").textContent = state.config?.provider === "r2" ? "Push to R2" : "Push to S3";
    $("btn-drawer-copy").hidden = false;
    $("btn-drawer-download").hidden = false;

    document.querySelectorAll(".dtab").forEach((b) => {
      b.classList.toggle("active", b.dataset.dtab === state.drawerTab);
    });

    const body = $("drawer-body");
    if (state.drawerTab === "raw") {
      const pre = document.createElement("pre");
      pre.className = "code-pre";
      pre.textContent = JSON.stringify(t, null, 2);
      body.innerHTML = "";
      body.appendChild(pre);
      return;
    }

    if (state.drawerTab === "messages") {
      if (t.privacyMode) {
        body.innerHTML = '<div class="empty-state">Privacy Mode was enabled for this trace. Prompts and completions were not stored.</div>';
        return;
      }
      if (!t.inputOutputLogging) {
        body.innerHTML = '<div class="empty-state">Input &amp; Output Logging was disabled when this trace was recorded.</div>';
        return;
      }
      const list = document.createElement("div");
      list.className = "msg-list";
      const addMsg = (role, text, extra) => {
        const card = document.createElement("div");
        card.className = `msg-bubble ${["user", "assistant", "system", "tool"].includes(role) ? role : "user"}`;
        const rEl = document.createElement("div");
        rEl.className = "msg-role";
        rEl.textContent = role + (extra ? ` · ${extra}` : "");
        const pEl = document.createElement("pre");
        pEl.className = "msg-content";
        pEl.textContent = text || "(empty)";
        card.append(rEl, pEl);
        list.appendChild(card);
      };

      if (t.input?.system) addMsg("system", t.input.system, "system prompt");
      for (const m of t.input?.messages || []) {
        if (m.role === "system" && t.input?.system) continue;
        let content = m.content || "";
        if (m.tool_calls?.length) {
          content += (content ? "\n\n" : "") + "Tool calls:\n" + JSON.stringify(m.tool_calls, null, 2);
        }
        addMsg(m.role, content, m.tool_call_id || m.name || "");
      }
      for (const m of t.output?.messages || []) {
        if (m.reasoning) addMsg("assistant", m.reasoning, "thinking / reasoning");
        let content = m.content || "";
        if (m.tool_calls?.length) {
          content += (content ? "\n\n" : "") + "Tool calls:\n" + JSON.stringify(m.tool_calls, null, 2);
        }
        addMsg("assistant", content, "completion");
      }
      if (t.output?.error) addMsg("tool", t.output.error, "provider error");
      body.innerHTML = "";
      body.appendChild(list);
      return;
    }

    // Overview tab
    const u = t.usage || {};
    const rt = t.routerTiming || {};
    const totalRt = Math.max(1, (rt.router_ms || 0) + (rt.provider_ms || 0) + (rt.provider_failed_ms || 0) + (rt.guardrails_ms || 0));
    const pct = (v) => `${Math.round(((v || 0) / totalRt) * 100)}%`;

    body.innerHTML = `
      <div class="kv-grid">
        <div class="kv-box"><div class="k">Status</div><div class="v">${esc(t.status || "—")}${t.httpStatus ? ` (HTTP ${esc(t.httpStatus)})` : ""}</div></div>
        <div class="kv-box"><div class="k">Model</div><div class="v">${esc(t.model || t.name || "—")}</div></div>
        <div class="kv-box"><div class="k">Provider / Upstream</div><div class="v">${esc(t.provider || "—")}${t.upstream ? ` → ${esc(t.upstream)}` : ""}</div></div>
        <div class="kv-box"><div class="k">Agent / Origin</div><div class="v">${esc(t.agent || "—")}${t.origin ? ` (${esc(t.origin)})` : ""}</div></div>
        <div class="kv-box"><div class="k">Gateway Key</div><div class="v">${esc(t.apiKeyName || "—")}</div></div>
        <div class="kv-box"><div class="k">Finish Reason</div><div class="v">${esc(t.finishReason || "—")}</div></div>
        <div class="kv-box"><div class="k">Total Latency</div><div class="v">${esc(fmtDuration(t.latencyMs))}</div></div>
        <div class="kv-box"><div class="k">Time to First Token</div><div class="v">${esc(fmtDuration(t.ttftMs))}</div></div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">S3 / R2 Broadcast Sync</span>${syncBadge(t.s3Sync)}</div>
        <div class="kv-grid" style="margin-bottom:0">
          <div class="kv-box"><div class="k">Bucket</div><div class="v">${esc(t.s3Sync?.bucket || "—")}</div></div>
          <div class="kv-box"><div class="k">Bytes / Upload Latency</div><div class="v">${t.s3Sync?.bytes ? `${fmtNum(t.s3Sync.bytes)} B` : "—"} ${t.s3Sync?.latencyMs ? `(${t.s3Sync.latencyMs}ms)` : ""}</div></div>
          <div class="kv-box" style="grid-column:span 2"><div class="k">Object Key</div><div class="v mono">${esc(t.s3Sync?.key || "Not uploaded yet")}</div></div>
        </div>
        ${t.s3Sync?.error ? `<p class="muted" style="color:var(--bad);margin-top:8px">${esc(t.s3Sync.error)}${t.s3Sync.hint ? ` — ${esc(t.s3Sync.hint)}` : ""}</p>` : ""}
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Router Timing Waterfall</span><span class="muted">${fmtNum(rt.attempt_count ?? 1)} attempt(s)</span></div>
        <div class="waterfall-bar">
          <div class="wf-router" style="width:${pct(rt.router_ms)}" title="router_ms: ${rt.router_ms || 0}ms"></div>
          <div class="wf-guard" style="width:${pct(rt.guardrails_ms)}" title="guardrails_ms: ${rt.guardrails_ms || 0}ms"></div>
          <div class="wf-failed" style="width:${pct(rt.provider_failed_ms)}" title="provider_failed_ms: ${rt.provider_failed_ms || 0}ms"></div>
          <div class="wf-provider" style="width:${pct(rt.provider_ms)}" title="provider_ms: ${rt.provider_ms || 0}ms"></div>
        </div>
        <div class="muted">
          Router: ${fmtNum(rt.router_ms ?? 0)}ms · Guardrails/Masking: ${fmtNum(rt.guardrails_ms ?? 0)}ms · Failed tries: ${fmtNum(rt.provider_failed_ms ?? 0)}ms · Provider: ${fmtNum(rt.provider_ms ?? 0)}ms
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Token Usage</span></div>
        <div class="kv-grid" style="margin-bottom:0">
          <div class="kv-box"><div class="k">Prompt Tokens</div><div class="v">${fmtNum(u.promptTokens)}</div></div>
          <div class="kv-box"><div class="k">Completion Tokens</div><div class="v">${fmtNum(u.completionTokens)}</div></div>
          <div class="kv-box"><div class="k">Cached Read</div><div class="v">${fmtNum(u.promptTokensDetails?.cachedTokens)}</div></div>
          <div class="kv-box"><div class="k">Cache Write</div><div class="v">${fmtNum(u.promptTokensDetails?.cacheWriteTokens)}</div></div>
          <div class="kv-box"><div class="k">Reasoning</div><div class="v">${fmtNum(u.completionTokensDetails?.reasoningTokens)}</div></div>
          <div class="kv-box"><div class="k">Total Tokens</div><div class="v">${fmtNum(u.totalTokens)}</div></div>
        </div>
      </div>
    `;
  }

  function renderSessionDrawer() {
    const s = state.drawerSession;
    if (!s) return;
    $("drawer-title").textContent = `Session ${s.sessionId}`;
    $("drawer-subtitle").textContent = `${s.count} turn(s)`;
    $("drawer-tabs").hidden = true;
    $("btn-drawer-push").hidden = true;
    $("btn-drawer-copy").hidden = true;
    $("btn-drawer-download").hidden = true;

    const body = $("drawer-body");
    body.innerHTML = "";
    const list = document.createElement("div");
    list.className = "msg-list";
    for (const t of s.turns || []) {
      const card = document.createElement("div");
      card.className = "card";
      const head = document.createElement("div");
      head.className = "card-head";
      head.innerHTML = `<span class="card-title">${esc(fmtTime(t.timestamp))} · ${esc(t.servedModel || t.model)}</span><span class="muted">${fmtNum(t.usage?.totalTokens || 0)} tok · ${esc(fmtDuration(t.latencyMs))}</span>`;
      card.appendChild(head);

      const lastUser = (t.input?.messages || []).filter((m) => m.role === "user").at(-1);
      const reply = (t.output?.messages || []).at(-1);

      if (lastUser?.content) {
        const uDiv = document.createElement("div");
        uDiv.className = "msg-bubble user";
        uDiv.innerHTML = '<div class="msg-role">User</div>';
        const pre = document.createElement("pre");
        pre.className = "msg-content";
        pre.textContent = lastUser.content;
        uDiv.appendChild(pre);
        card.appendChild(uDiv);
      }
      if (reply?.content) {
        const aDiv = document.createElement("div");
        aDiv.className = "msg-bubble assistant";
        aDiv.style.marginTop = "8px";
        aDiv.innerHTML = '<div class="msg-role">Assistant</div>';
        const pre = document.createElement("pre");
        pre.className = "msg-content";
        pre.textContent = reply.content;
        aDiv.appendChild(pre);
        card.appendChild(aDiv);
      }
      list.appendChild(card);
    }
    body.appendChild(list);
  }

  // Data loading
  async function loadLogs() {
    state.logs = await apiFetch("api/logs", {
      params: {
        range: state.range,
        limit: state.limit,
        offset: state.offset,
        ...state.filters,
      },
    });
    renderLogs();
  }

  async function loadSessions() {
    state.sessions = await apiFetch("api/sessions", {
      params: { range: state.range, ...state.filters },
    });
    renderSessions();
  }

  async function loadActivity() {
    state.activity = await apiFetch("api/activity", {
      params: { range: state.range, ...state.filters },
    });
    renderActivity();
  }

  async function loadExplore() {
    const data = await apiFetch("api/explore", {
      params: { range: state.range, ...state.explore, limit: 100 },
    });
    renderExplore(data);
  }

  async function refreshActiveTab() {
    if (state.tab === "logs") await loadLogs();
    else if (state.tab === "sessions") await loadSessions();
    else if (state.tab === "activity") await loadActivity();
    else if (state.tab === "explore") await loadExplore();
    else if (state.tab === "settings") {
      const res = await apiFetch("api/settings");
      state.config = res.config;
      renderHeaderStatus();
      populateSettingsForm();
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.id !== `tab-${tab}`;
    });
    refreshActiveTab().catch((err) => showBanner(err.message, "bad"));
  }

  // Event wiring
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("global-range").addEventListener("change", (e) => {
    state.range = e.target.value;
    state.offset = 0;
    refreshActiveTab().catch((err) => showBanner(err.message, "bad"));
  });

  $("btn-refresh").addEventListener("click", () => {
    refreshActiveTab().catch((err) => showBanner(err.message, "bad"));
  });

  $("btn-pull-s3").addEventListener("click", async () => {
    const btn = $("btn-pull-s3");
    btn.disabled = true;
    try {
      const res = await apiFetch("api/s3/sync", { method: "POST", body: { maxObjects: 100 } });
      showBanner(`Pulled from ${providerLabel(state.config?.provider)}: scanned ${res.scanned}, imported ${res.imported}, skipped ${res.skipped}.`, "ok");
      await refreshActiveTab();
    } catch (err) {
      const hint = err.data?.hint ? ` — ${err.data.hint}` : "";
      showBanner(`${err.message}${hint}`, "bad");
    } finally {
      btn.disabled = !state.config?.s3Configured;
    }
  });

  let searchDebounce = null;
  $("filter-q").addEventListener("input", (e) => {
    state.filters.q = e.target.value;
    state.offset = 0;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadLogs().catch((err) => showBanner(err.message, "bad")), 220);
  });

  for (const [id, key] of [
    ["filter-model", "model"],
    ["filter-provider", "provider"],
    ["filter-agent", "agent"],
    ["filter-apikey", "apiKeyName"],
    ["filter-status", "status"],
    ["filter-sync", "syncState"],
  ]) {
    $(id).addEventListener("change", (e) => {
      state.filters[key] = e.target.value;
      state.offset = 0;
      loadLogs().catch((err) => showBanner(err.message, "bad"));
    });
  }

  $("btn-clear-filters").addEventListener("click", () => {
    state.filters = { q: "", model: "", provider: "", agent: "", apiKeyName: "", status: "", syncState: "" };
    state.offset = 0;
    $("filter-q").value = "";
    $("filter-model").value = "";
    $("filter-provider").value = "";
    $("filter-agent").value = "";
    $("filter-apikey").value = "";
    $("filter-status").value = "";
    $("filter-sync").value = "";
    loadLogs().catch((err) => showBanner(err.message, "bad"));
  });

  $("btn-prev-page").addEventListener("click", () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadLogs().catch((err) => showBanner(err.message, "bad"));
  });

  $("btn-next-page").addEventListener("click", () => {
    state.offset += state.limit;
    loadLogs().catch((err) => showBanner(err.message, "bad"));
  });

  $("logs-tbody").addEventListener("click", async (e) => {
    const row = e.target.closest("tr[data-trace-id]");
    if (!row) return;
    try {
      const trace = await apiFetch(`api/logs/${encodeURIComponent(row.dataset.traceId)}`);
      state.drawerMode = "trace";
      state.drawerTab = "overview";
      state.drawerTrace = trace;
      openDrawer();
      renderTraceDrawer();
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  $("sessions-tbody").addEventListener("click", async (e) => {
    const row = e.target.closest("tr[data-session-id]");
    if (!row) return;
    try {
      const data = await apiFetch(`api/sessions/${encodeURIComponent(row.dataset.sessionId)}`);
      state.drawerMode = "session";
      state.drawerSession = data;
      openDrawer();
      renderSessionDrawer();
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  for (const [id, key] of [
    ["exp-metric", "metric"],
    ["exp-group", "groupBy"],
    ["exp-subgroup", "subgroupBy"],
    ["exp-rollup", "rollup"],
  ]) {
    $(id).addEventListener("change", (e) => {
      state.explore[key] = e.target.value;
      loadExplore().catch((err) => showBanner(err.message, "bad"));
    });
  }

  $("btn-export-csv").addEventListener("click", async () => {
    try {
      const res = await fetch(
        apiUrl("api/explore/export.csv", { range: state.range, ...state.explore }),
        { headers: PAGE_KEY ? { "x-dash-key": PAGE_KEY } : {} }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `s3-trace-sync-${state.range}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  // Provider cards & R2 form behavior
  document.querySelectorAll(".provider-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = btn.dataset.provider;
      updateProviderUi(p);
      if (p === "r2") {
        if (!$("cfg-region").value.trim() || $("cfg-region").value.trim() === "us-east-1") {
          $("cfg-region").value = "auto";
        }
        $("cfg-path-style").checked = true;
        maybeAutoBuildR2Endpoint();
      } else if (p === "aws") {
        if ($("cfg-region").value.trim() === "auto") $("cfg-region").value = "us-east-1";
        $("cfg-path-style").checked = false;
        if ($("cfg-endpoint").value.includes("r2.cloudflarestorage.com")) $("cfg-endpoint").value = "";
      } else if (p === "gcs") {
        $("cfg-region").value = "auto";
        $("cfg-path-style").checked = true;
        if (!$("cfg-endpoint").value || $("cfg-endpoint").value.includes("r2.cloudflarestorage.com")) {
          $("cfg-endpoint").value = "https://storage.googleapis.com";
        }
      } else if (p === "custom") {
        $("cfg-path-style").checked = true;
        if ($("cfg-endpoint").value.includes("r2.cloudflarestorage.com")) $("cfg-endpoint").value = "";
      }
    });
  });

  $("cfg-account-id").addEventListener("input", maybeAutoBuildR2Endpoint);
  $("cfg-r2-jurisdiction").addEventListener("change", maybeAutoBuildR2Endpoint);
  $("cfg-sse").addEventListener("change", () => {
    const activeProvider = document.querySelector(".provider-card.active")?.dataset.provider || "r2";
    $("wrap-sse-kms").hidden = activeProvider === "r2" || $("cfg-sse").value !== "aws:kms";
  });

  $("cfg-bucket").addEventListener("input", updatePathPreview);
  $("cfg-folder").addEventListener("input", updatePathPreview);
  $("cfg-path-template").addEventListener("input", updatePathPreview);
  $("cfg-export-mode").addEventListener("change", updatePathPreview);

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("cfg-path-template").value = btn.dataset.tpl;
      updatePathPreview();
    });
  });

  document.querySelectorAll(".trace-preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tracePreset;
      if (TRACE_PRESETS[name]) {
        applyTraceFieldsToForm(TRACE_PRESETS[name], name);
      }
    });
  });

  document.querySelectorAll("[data-trace-field]").forEach((cb) => {
    cb.addEventListener("change", () => {
      updateTracePresetBadge(detectTracePresetFromForm());
    });
  });

  $("btn-toggle-sk").addEventListener("click", () => {
    const inp = $("cfg-sk");
    const isPass = inp.type === "password";
    inp.type = isPass ? "text" : "password";
    $("btn-toggle-sk").textContent = isPass ? "Hide" : "Show";
  });

  $("btn-clear-sk").addEventListener("click", () => {
    state.clearSecret = !state.clearSecret;
    if (state.clearSecret) $("cfg-sk").value = "";
    $("btn-clear-sk").textContent = state.clearSecret ? "Undo Clear" : "Clear";
  });

  $("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const payload = collectSettingsPayload();
      const res = await apiFetch("api/settings", { method: "POST", body: payload });
      state.config = res.config;
      renderHeaderStatus();
      populateSettingsForm();
      showBanner("Configuration saved securely (takes effect immediately).", "ok");
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  $("btn-test-conn").addEventListener("click", async () => {
    const box = $("test-result");
    box.className = "test-result";
    box.textContent = "Testing bucket write permission (.openrouter-connection-test.json)…";
    box.hidden = false;
    try {
      const payload = collectSettingsPayload();
      const res = await apiFetch("api/s3/test", { method: "POST", body: payload });
      if (res.ok) {
        box.className = "test-result ok";
        box.innerHTML = `<strong>Connection verified (${esc(res.latencyMs)}ms)</strong><br>
          Provider: <code>${esc(providerLabel(res.provider))}</code> · Bucket: <code>${esc(res.bucket)}</code><br>
          Test object written: <code>${esc(res.key)}</code><br>
          Permissions: Write <strong>OK</strong> · Read/List <strong>${res.canRead ? "OK" : "Write-only token (List skipped)"}</strong>`;
      } else {
        box.className = "test-result bad";
        box.innerHTML = `<strong>Connection failed</strong>: ${esc(res.error)}
          ${res.hint ? `<br><span>Tip: ${esc(res.hint)}</span>` : ""}`;
      }
    } catch (err) {
      box.className = "test-result bad";
      box.textContent = err.message;
    }
  });

  $("btn-flush-batch").addEventListener("click", async () => {
    try {
      const res = await apiFetch("api/s3/flush", { method: "POST" });
      showBanner(
        res.flushed ? `Flushed ${res.flushed} trace(s) to ${res.key}.` : "No buffered batch traces to flush.",
        res.ok === false ? "bad" : "ok"
      );
      await refreshActiveTab();
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  $("btn-clear-cache").addEventListener("click", async () => {
    try {
      await apiFetch("api/cache/clear", { method: "POST" });
      showBanner("Local trace cache cleared (remote bucket objects untouched).", "ok");
      await refreshActiveTab();
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  $("btn-reset-cfg").addEventListener("click", async () => {
    try {
      const res = await apiFetch("api/settings/reset", { method: "POST" });
      state.config = res.config;
      renderHeaderStatus();
      populateSettingsForm();
      showBanner("Local UI overrides reset to Magpie / environment defaults.", "ok");
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  // Drawer listeners
  $("btn-drawer-close").addEventListener("click", closeDrawer);
  $("drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("detail-drawer").hidden) closeDrawer();
  });

  document.querySelectorAll(".dtab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.drawerTab = btn.dataset.dtab;
      renderTraceDrawer();
    });
  });

  $("btn-drawer-copy").addEventListener("click", async () => {
    if (!state.drawerTrace) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.drawerTrace, null, 2));
      showBanner("Trace JSON copied to clipboard.", "ok");
    } catch {
      showBanner("Clipboard write unavailable inside this frame; use Download instead.", "bad");
    }
  });

  $("btn-drawer-download").addEventListener("click", () => {
    if (!state.drawerTrace) return;
    const blob = new Blob([JSON.stringify(state.drawerTrace, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.drawerTrace.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $("btn-drawer-push").addEventListener("click", async () => {
    if (!state.drawerTrace) return;
    try {
      const res = await apiFetch(`api/logs/${encodeURIComponent(state.drawerTrace.id)}/push`, { method: "POST" });
      state.drawerTrace = res.trace;
      renderTraceDrawer();
      showBanner(`Trace uploaded to ${res.trace.s3Sync?.key}`, "ok");
      if (state.tab === "logs") await loadLogs();
    } catch (err) {
      showBanner(err.message, "bad");
    }
  });

  // Initial paint from server-injected snapshot
  renderHeaderStatus();
  renderLogs();
  populateSettingsForm();
  if (!INITIAL?.logs) {
    loadLogs().catch((err) => showBanner(err.message, "bad"));
  }
})();
