// Dev harness for the Schrijfassistent bundle (dev-only). Mirrors the mount sequence of
// admin/defaults/loader.js: container -> manifest.json -> css + js -> mount(container, props),
// and the close sequence: the app calls onClose -> unmount() -> container removed. The identity, the token
// and the backend URL come from the query string (see dev/index.html). Kept dependency-free and in the same
// style as loader.js so differences between the two are easy to spot.
(function () {
  "use strict";

  const SA_ASSET_BASE = "/static/apps/schrijfassistent";
  const SA_LOAD_TIMEOUT_MS = 20000;
  const SA_LOAD_ERROR_TEXT = "De Schrijfassistent kan niet geladen worden. Probeer het later opnieuw.";

  const params = new URLSearchParams(window.location.search);
  const settings = {
    apiBase: (params.get("api") || "http://localhost:8001").replace(/\/+$/, ""),
    token: params.get("token") || "dev-token",
    user: {
      id: params.get("user") || "test-a",
      email: params.get("email") || ((params.get("user") || "test-a") + "@example.test"),
      name: params.get("name") || "Test Auteur",
      role: params.get("role") || "user",
    },
    dark: params.get("dark") === "1",
    autostart: params.get("autostart") !== "0",
  };

  // Exposed for the end-to-end tests (read-only inspection of what the harness passed to mount()).
  window.__saHarness = { settings, mounted: false, mountCount: 0, closedCount: 0, lastError: null };

  const statusEl = document.getElementById("host-status");
  const infoEl = document.getElementById("host-info");
  infoEl.textContent = `api=${settings.apiBase} user=${settings.user.id} (${settings.user.role})`;
  if (settings.dark) document.documentElement.classList.add("dark");

  function setStatus(text) { statusEl.textContent = text; }

  // ---- same helpers as loader.js ------------------------------------------------------------
  function readToken() { return settings.token; }

  function fetchManifest(assetBase) {
    return fetch(assetBase + "/manifest.json", { cache: "no-cache", credentials: "same-origin" }).then((resp) => {
      if (!resp.ok) throw new Error("manifest status " + resp.status);
      return resp.json();
    });
  }

  function bundleFiles(manifest, assetBase) {
    const m = manifest || {};
    const hash = String(m.hash || "").trim();
    const js = String(m.js || (hash ? "schrijfassistent." + hash + ".js" : "")).trim();
    const css = String(m.css || (hash ? "schrijfassistent." + hash + ".css" : "")).trim();
    if (!js || !css || /[\/\\:]/.test(js) || /[\/\\:]/.test(css)) throw new Error("manifest zonder bruikbare bestandsnamen");
    return { js: assetBase + "/" + js, css: assetBase + "/" + css };
  }

  function loadBundle(files) {
    return new Promise((resolve, reject) => {
      if (!document.getElementById("sa-bundle-css")) {
        const link = document.createElement("link");
        link.id = "sa-bundle-css";
        link.rel = "stylesheet";
        link.href = files.css;
        document.head.appendChild(link);
      }
      if (window.SchrijfassistentApp && typeof window.SchrijfassistentApp.mount === "function") { resolve(); return; }
      const existing = document.getElementById("sa-bundle-js");
      if (existing) existing.remove();
      const script = document.createElement("script");
      script.id = "sa-bundle-js";
      script.src = files.js;
      script.async = true;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => { script.remove(); reject(new Error("script error")); }, { once: true });
      document.head.appendChild(script);
    });
  }

  function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + " duurde langer dan " + ms + " ms")), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function removeContainer() {
    const el = document.getElementById("sa-container");
    if (el) el.remove();
  }

  function closeButton() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "vs-btn-secondary sa-loading-close";
    b.textContent = "Sluiten";
    b.addEventListener("click", closeSchrijfassistent);   // unmount() when a bundle instance exists
    return b;
  }

  function showLoadError(container) {
    container.textContent = "";
    const status = document.createElement("div");
    status.className = "sa-loading sa-loading-error";
    const text = document.createElement("div");
    text.className = "sa-loading-text";
    text.textContent = SA_LOAD_ERROR_TEXT;
    status.appendChild(text);
    status.appendChild(closeButton());
    container.appendChild(status);
  }

  // ---- mount sequence (loader.js mountSchrijfassistent) --------------------------------------
  async function openSchrijfassistent() {
    if (document.getElementById("sa-container")) return;
    const container = document.createElement("div");
    container.id = "sa-container";
    container.className = "sa-root";
    const status = document.createElement("div");
    status.className = "sa-loading";
    const statusText = document.createElement("div");
    statusText.className = "sa-loading-text";
    statusText.textContent = "Schrijfassistent wordt geladen...";
    status.appendChild(statusText);
    status.appendChild(closeButton());
    container.appendChild(status);
    document.body.appendChild(container);
    setStatus("Laden...");

    try {
      await withTimeout((async () => {
        const manifest = await fetchManifest(SA_ASSET_BASE);
        window.__saHarness.manifest = manifest;
        const files = bundleFiles(manifest, SA_ASSET_BASE);
        await loadBundle(files);
      })(), SA_LOAD_TIMEOUT_MS, "laden van de bundle");
      if (!window.SchrijfassistentApp || typeof window.SchrijfassistentApp.mount !== "function") {
        throw new Error("window.SchrijfassistentApp.mount ontbreekt");
      }
    } catch (err) {
      console.error("[harness] Laden mislukt:", err);
      window.__saHarness.lastError = String(err);
      if (document.getElementById("sa-container")) showLoadError(container);
      setStatus("Laden mislukt: " + err.message);
      return;
    }
    if (!document.getElementById("sa-container")) return;

    const mountConfig = {
      api_base_url: settings.apiBase,
      asset_base_url: SA_ASSET_BASE,
      b1_metrics_doc_url: "",
    };
    container.textContent = "";
    try {
      window.SchrijfassistentApp.mount(container, {
        getToken: readToken,
        user: settings.user,
        config: mountConfig,
        onClose: closeSchrijfassistent,
      });
      window.__saHarness.mounted = true;
      window.__saHarness.mountCount += 1;
      setStatus("Geopend.");
    } catch (err) {
      console.error("[harness] mount() mislukt:", err);
      window.__saHarness.lastError = String(err);
      showLoadError(container);
    }
  }

  // ---- close sequence (loader.js closeSchrijfassistent) --------------------------------------
  async function closeSchrijfassistent() {
    try {
      if (window.SchrijfassistentApp && typeof window.SchrijfassistentApp.unmount === "function") {
        await window.SchrijfassistentApp.unmount();
      }
    } catch (err) {
      console.error("[harness] unmount() mislukt:", err);
    }
    removeContainer();
    window.__saHarness.mounted = false;
    window.__saHarness.closedCount += 1;
    setStatus("Gesloten door de app (onClose). Klik op 'Open Schrijfassistent' om opnieuw te openen.");
  }

  document.getElementById("host-open").addEventListener("click", () => { openSchrijfassistent(); });
  document.getElementById("host-dark").addEventListener("click", () => { document.documentElement.classList.toggle("dark"); });

  window.__saHarness.open = openSchrijfassistent;
  window.__saHarness.close = closeSchrijfassistent;

  if (settings.autostart) openSchrijfassistent();
})();
