// Unit tests of the Schrijfassistent launcher card.   Run: cd admin && npm test
// No dependencies. Tests admin/lib/schrijfassistent-card.js directly and extracts the config sanitizer from the loader.js
// source text (it lives inside the IIFE).

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, statSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const lib = require(path.join(root, "admin", "lib", "schrijfassistent-card.js"));

// ── loader.js: extract the pure sanitizer ──────────────────────────
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found in loader.js`);
  let depth = 0;
  let i = source.indexOf("{", start);
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(start, i + 1);
  // Module constants the function may use (declared inside the loader IIFE).
  const consts = [...source.matchAll(/^\s*const (SA_[A-Z_]+) = ([^;]+);/gm)].map((m) => `const ${m[1]} = ${m[2]};`).join("\n");
  return new Function(`${consts}\n${body}; return ${name};`)();
}

const loaderPaths = [path.join(root, "admin", "defaults", "loader.js"), path.join(root, "loader.js")];

const sanitizers = loaderPaths.map((p) => extractFunction(readFileSync(p, "utf-8"), "sanitizeSchrijfassistentConfig"));
/** Source text of `[async ]function name(...) { ... }` (brace matching; no evaluation). */
function rawFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  let i = source.indexOf("{", start);
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

for (const [idx, sanitize] of sanitizers.entries()) {
  const tag = idx === 0 ? "defaults" : "root";
  test(`[${tag}] valid card passes through`, () => {
    const r = sanitize({ url: "https://app.example/", config: { asset_base_url: "/static/apps/schrijfassistent/", api_base_url: "/apps/schrijfassistent" } });
    assert.deepEqual(r, { assetBase: "/static/apps/schrijfassistent", apiBase: "/apps/schrijfassistent", b1MetricsDocUrl: "", warnings: [] });
  });
  test(`[${tag}] cross-origin asset_base_url and http api_base_url fall back to defaults`, () => {
    const r = sanitize({ config: { asset_base_url: "https://attacker.example/x", api_base_url: "http://attacker.example" } });
    assert.equal(r.assetBase, "/static/apps/schrijfassistent");
    assert.equal(r.apiBase, "/apps/schrijfassistent");
    assert.equal(r.warnings.length, 2);
    assert.equal(sanitize({ config: { asset_base_url: "//evil.example/x" } }).assetBase, "/static/apps/schrijfassistent");
    assert.equal(sanitize({ config: { api_base_url: "https://backend.example/base/" } }).apiBase, "https://backend.example/base");
  });
  test(`[${tag}] missing values get defaults and the card url plays no part any more`, () => {
    assert.deepEqual(sanitize(null, "app.example"), { assetBase: "/static/apps/schrijfassistent", apiBase: "/apps/schrijfassistent", b1MetricsDocUrl: "", warnings: [] });
    assert.ok(!("url" in sanitize({ url: "javascript:alert(1)", config: {} })));
  });
  test(`[${tag}] b1_metrics_doc_url: http(s) and path pass, javascript: is dropped with a warning`, () => {
    assert.equal(sanitize({ config: { b1_metrics_doc_url: "https://docs.example/b1" } }, "app.example").b1MetricsDocUrl, "https://docs.example/b1");
    assert.equal(sanitize({ config: { b1_metrics_doc_url: "/docs/b1" } }, "app.example").b1MetricsDocUrl, "/docs/b1");
    const bad = sanitize({ config: { b1_metrics_doc_url: "javascript:alert(1)" } }, "app.example");
    assert.equal(bad.b1MetricsDocUrl, "");
    assert.equal(bad.warnings.length, 1);
    assert.equal(sanitize({ config: { b1_metrics_doc_url: "//evil.example/x" } }, "app.example").b1MetricsDocUrl, "");
  });
  test(`[${tag}] local api allowance needs allow_local_api === true AND a localhost page`, () => {
    const card = (extra) => ({ config: { api_base_url: "http://localhost:8011", ...extra } });
    // flag set, page on localhost: accepted (also 127.0.0.1 and without port)
    assert.equal(sanitize(card({ allow_local_api: true }), "localhost").apiBase, "http://localhost:8011");
    assert.equal(sanitize({ config: { api_base_url: "http://127.0.0.1:8011/", allow_local_api: true } }, "127.0.0.1").apiBase, "http://127.0.0.1:8011");
    assert.equal(sanitize({ config: { api_base_url: "http://localhost", allow_local_api: true } }, "localhost").apiBase, "http://localhost");
    // production rules stay absolute: no flag, flag on a real host, flag with a non-true value, a non-local http host
    assert.equal(sanitize(card({}), "localhost").apiBase, "/apps/schrijfassistent");
    const prod = sanitize(card({ allow_local_api: true }), "flair-dev.ai.flevoland.nl");
    assert.equal(prod.apiBase, "/apps/schrijfassistent");
    assert.equal(prod.warnings.length, 2, "ignored flag and rejected url are both reported");
    for (const v of ["true", 1, "1", "yes"]) assert.equal(sanitize(card({ allow_local_api: v }), "localhost").apiBase, "/apps/schrijfassistent", String(v));
    for (const u of ["http://attacker.example", "http://localhost.evil.example:8011", "http://localhost@evil.example", "http://127.0.0.1.evil.example", "http://localhost:99999999", "http://evil.example/http://localhost"]) {
      assert.equal(sanitize({ config: { api_base_url: u, allow_local_api: true } }, "localhost").apiBase, "/apps/schrijfassistent", u);
    }
    // https still passes everywhere; the page host check does not widen anything else
    assert.equal(sanitize({ config: { api_base_url: "https://backend.example/base", allow_local_api: true } }, "localhost").apiBase, "https://backend.example/base");
  });
}


const jsonOf = (p) => JSON.parse(readFileSync(path.join(root, p), "utf-8"));
const appsJson = jsonOf("admin/defaults/apps.json");

test("apps.json: the card has the final shape (url '/', no mode, no lists)", () => {
  for (const data of [appsJson, jsonOf("apps.json")]) {
    const card = lib.findSchrijfassistentCard(data);
    assert.ok(card, "card missing");
    assert.equal(card.target, "schrijfassistent");
    assert.equal(card.name, "Schrijfassistent");
    assert.equal(card.url, "/");
    assert.deepEqual(Object.keys(card.config).sort(), ["api_base_url", "asset_base_url", "b1_metrics_doc_url"]);
    assert.equal(card.config.api_base_url, "/apps/schrijfassistent");
    assert.equal(card.config.asset_base_url, "/static/apps/schrijfassistent");
    assert.equal(data.enabled, true);
    assert.ok(data.apps.some((a) => a.id === "versimpelaar"), "versimpelaar card kept");
    assert.ok(data.apps.some((a) => a.id === "chat"), "chat card kept");
  }
});
test("prepareAppsForPublish: the published card equals the stored card; input untouched", () => {
  const out = lib.prepareAppsForPublish(appsJson);
  assert.deepEqual(out, appsJson);
  assert.notEqual(out, appsJson);
});
test("prepareAppsForPublish: mode and user-list fields are dropped, other config kept", () => {
  const stored = JSON.parse(JSON.stringify(appsJson));
  Object.assign(lib.findSchrijfassistentCard(stored).config, { mode: "external", embedded_for_emails: ["a@b.nl"], embedded_for_roles: ["admin"] });
  const card = lib.findSchrijfassistentCard(lib.prepareAppsForPublish(stored));
  assert.deepEqual(card.config, lib.findSchrijfassistentCard(appsJson).config);
  assert.ok(!JSON.stringify(card).includes("a@b.nl"));
});
test("prepareAppsForPublish: allow_local_api never comes from the stored card, only from the environment option", () => {
  const stored = JSON.parse(JSON.stringify(appsJson));
  lib.findSchrijfassistentCard(stored).config.allow_local_api = true;
  lib.findSchrijfassistentCard(stored).config.api_base_url = "http://localhost:8011";
  for (const opt of [undefined, {}, { allowLocalApi: false, localApiBaseUrl: "http://localhost:8011" }, { allowLocalApi: "1" }]) {
    const card = lib.findSchrijfassistentCard(lib.prepareAppsForPublish(stored, opt));
    assert.ok(!("allow_local_api" in card.config), JSON.stringify(opt));
  }
  const on = lib.findSchrijfassistentCard(lib.prepareAppsForPublish(appsJson, { allowLocalApi: true, localApiBaseUrl: "http://localhost:8011/" }));
  assert.equal(on.config.allow_local_api, true);
  assert.equal(on.config.api_base_url, "http://localhost:8011");
  for (const bad of ["https://evil.example", "http://evil.example", "http://localhost.evil.example", "javascript:1", ""]) {
    const c = lib.findSchrijfassistentCard(lib.prepareAppsForPublish(appsJson, { allowLocalApi: true, localApiBaseUrl: bad }));
    assert.equal(c.config.api_base_url, "/apps/schrijfassistent", bad);
  }
  assert.ok(!("allow_local_api" in lib.findSchrijfassistentCard(appsJson).config));
});
test("prepareAppsForPublish: no card or no apps -> unchanged copy; card without config gets an empty config", () => {
  const noCard = { title: "x", apps: [{ id: "chat" }] };
  assert.deepEqual(lib.prepareAppsForPublish(noCard), noCard);
  assert.equal(lib.prepareAppsForPublish(null), null);
  assert.deepEqual(lib.prepareAppsForPublish({ apps: [{ id: "schrijfassistent", url: "/" }] }).apps[0].config, {});
});
test("jsonForScript: escapes </script>, still valid JSON", () => {
  const out = lib.jsonForScript({ a: "</script><b>&$'\u2028" });
  assert.ok(!out.includes("<") && !out.includes(">") && !out.includes("&"));
  assert.deepEqual(JSON.parse(out), { a: "</script><b>&$'\u2028" });
});

for (const p of loaderPaths) {
  const label = path.relative(root, p);
  test(`${label}: the card only mounts the bundle`, () => {
    const src = readFileSync(p, "utf-8");
    const openFn = rawFunction(src, "openSchrijfassistent");
    assert.ok(!/window\.open|openIframeViewer/.test(openFn), "openSchrijfassistent only mounts the bundle");
    assert.match(openFn, /mountSchrijfassistent\(/);
    assert.match(openFn, /fetchOpenWebUIUser\(\)/);
  });
}
test("loader copies are byte-identical", () => {
  assert.equal(readFileSync(loaderPaths[0], "utf-8"), readFileSync(loaderPaths[1], "utf-8"));
  for (const f of ["custom.css", "apps.json"]) assert.equal(readFileSync(path.join(root, f), "utf-8"), readFileSync(path.join(root, "admin", "defaults", f), "utf-8"), f);
});
test("every `log-tokens` token of schrijfassistent/ops/kql/*.kql occurs in the backend source", () => {
  const dir = path.join(root, "schrijfassistent", "ops", "kql");
  assert.ok(existsSync(dir), "kql directory present");
  const files = readdirSync(dir).filter((f) => f.endsWith(".kql"));
  assert.ok(files.length >= 4, `at least four queries, found ${files.length}`);
  const py = [];
  (function walk(d) { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) { if (f !== "__pycache__" && f !== "tests") walk(p); } else if (f.endsWith(".py")) py.push(readFileSync(p, "utf-8")); } })(path.join(root, "schrijfassistent", "backend"));
  const source = py.join("\n");
  for (const f of files) {
    const m = readFileSync(path.join(dir, f), "utf-8").split("\n")[0].match(/^\/\/ log-tokens: (.+)$/);
    assert.ok(m, `${f}: first line is "// log-tokens: ..."`);
    for (const token of m[1].split(";").map((x) => x.trim()).filter(Boolean)) assert.ok(source.includes(token), `${f}: the backend no longer writes "${token}"`);
  }
});

for (const p of loaderPaths) {
  const src = readFileSync(p, "utf-8");
  const label = path.relative(root, p);
  test(`${label}: the body observer is paused when #sa-container is created and resumed when it is removed`, () => {
    const mountFn = rawFunction(src, "mountSchrijfassistent");
    assert.match(mountFn, /document\.body\.appendChild\(container\);\s*pauseSidebarObserver\(\);/, "paused right after the container is attached");
    const removeFn = rawFunction(src, "removeSchrijfassistentContainer");
    assert.match(removeFn, /el\.remove\(\);\s*resumeSidebarObserver\(\);/, "resumed after the container is removed");
    const pauseFn = rawFunction(src, "pauseSidebarObserver");
    assert.ok(pauseFn.includes("disconnect()"), "pause disconnects the observer");
    const resumeFn = rawFunction(src, "resumeSidebarObserver");
    assert.ok(resumeFn.includes("observe(document.body"), "resume observes the body again");
    assert.ok(resumeFn.includes("tryInjectSidebarItem"), "resume re-injects a sidebar entry that was lost while paused");
  });
}

