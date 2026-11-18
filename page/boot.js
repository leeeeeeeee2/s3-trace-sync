(async () => {
  const DEFAULT_PORT = 3483;
  let port = DEFAULT_PORT;
  let theme = "";
  let lang = "en";
  let service = "";
  let bridgeErr = "";

  const bar = document.getElementById("bar");
  const msg = document.getElementById("msg");
  const say = (text, bad = false) => {
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle("bad", bad);
  };
  const setBar = (pct, bad = false) => {
    if (!bar) return;
    bar.style.width = `${pct}%`;
    if (bar.parentElement) bar.parentElement.classList.toggle("bad", bad);
  };

  setBar(20);
  const creep = setInterval(() => {
    const cur = parseFloat(bar?.style.width) || 20;
    setBar(Math.min(45, cur + 3));
  }, 300);

  const hasBridge = !!window.magpie;
  try {
    const ready = await window.magpie?.ready;
    if (ready) {
      if (typeof ready.lang === "string" && ready.lang) lang = ready.lang;
      if (typeof ready.dark === "boolean") theme = ready.dark ? "dark" : "light";
    }
  } catch (err) {
    bridgeErr = (err && err.message) || "bridge handshake failed";
  }

  try {
    const options = await window.magpie?.options?.get?.();
    const n = Number(options?.port);
    if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
  } catch {
    // Keep default port.
  }

  try {
    const s = window.magpie?.service;
    if (typeof s === "string" && /^https?:\/\//.test(s)) service = s;
  } catch {
    // Desktop window connects directly to loopback.
  }

  clearInterval(creep);

  if (bridgeErr) {
    setBar(40, true);
    say(`Bridge warning: ${bridgeErr} — opening local observability UI…`, true);
  } else if (!hasBridge) {
    setBar(75);
    say("Opening local observability UI…");
  } else {
    setBar(80);
    say(service ? "Located proxy service, opening…" : "Ready — opening S3 Trace Sync…");
  }

  let target = service || `http://127.0.0.1:${port}/`;
  try {
    const u = new URL(target, location.href);
    u.searchParams.set("lang", lang);
    if (theme) u.searchParams.set("theme", theme);
    target = u.href;
  } catch {
    target += `${target.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}${theme ? `&theme=${theme}` : ""}`;
  }

  const go = document.getElementById("go");
  if (go) go.setAttribute("content", `0;url=${target}`);

  setTimeout(() => {
    try {
      location.replace(target);
    } catch {
      // Meta refresh fallback navigates automatically.
    }
  }, 200);
})();
