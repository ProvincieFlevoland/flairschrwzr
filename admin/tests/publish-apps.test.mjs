// Unit tests for admin/lib/publish-apps.js: bundle files before the manifest, atomic
// writes, manifest.prev.json, pruning of older hashes, no temporary files left behind.
//   Run: cd admin && npm test
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const { publishAppsDir } = require(path.join(root, "admin", "lib", "publish-apps.js"));
const quiet = { log() {}, warn() {} };

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "publish-apps-"));
function release(src, hash, extra = {}) {
  const dir = path.join(src, "schrijfassistent");
  mkdirSync(path.join(dir, "fonts"), { recursive: true });
  writeFileSync(path.join(dir, `schrijfassistent.${hash}.js`), `js ${hash}`);
  writeFileSync(path.join(dir, `schrijfassistent.${hash}.css`), `css ${hash}`);
  writeFileSync(path.join(dir, "logo_flevoland.png"), "png");
  writeFileSync(path.join(dir, "fonts", "Phosphor.aaaaaaaa.woff2"), "font");
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ hash, js: `schrijfassistent.${hash}.js`, css: `schrijfassistent.${hash}.css`, version: "t", builtAt: "x", ...extra }));
}
const hashes = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"];
const names = (dir) => readdirSync(dir).sort();

test("first publish copies everything, manifest.json last, no temp files left", () => {
  const src = tmp(), dst = tmp();
  release(src, hashes[0]);
  const order = [];
  const fsReal = require("node:fs");
  const orig = fsReal.renameSync;
  fsReal.renameSync = (a, b) => { order.push(path.basename(b)); return orig(a, b); };
  let r;
  try { r = publishAppsDir(src, path.join(dst, "apps"), quiet); } finally { fsReal.renameSync = orig; }
  assert.equal(r.ok, true);
  assert.equal(r.files, 5);
  assert.equal(order[order.length - 1], "manifest.json", `order was ${order.join(",")}`);
  assert.ok(order.indexOf("schrijfassistent.aaaaaaaaaaaa.js") < order.indexOf("manifest.json"));
  assert.ok(order.indexOf("schrijfassistent.aaaaaaaaaaaa.css") < order.indexOf("manifest.json"));
  const out = path.join(dst, "apps", "schrijfassistent");
  assert.deepEqual(names(out), ["fonts", "logo_flevoland.png", "manifest.json", `schrijfassistent.${hashes[0]}.css`, `schrijfassistent.${hashes[0]}.js`]);
  assert.ok(!names(out).some((n) => n.includes(".tmp-")));
  assert.ok(!existsSync(path.join(out, "manifest.prev.json")), "no previous release yet");
});

test("republish of identical content writes nothing", () => {
  const src = tmp(), dst = tmp();
  release(src, hashes[0]);
  publishAppsDir(src, path.join(dst, "apps"), quiet);
  const r = publishAppsDir(src, path.join(dst, "apps"), quiet);
  assert.equal(r.files, 0);
  assert.equal(r.pruned, 0);
});

test("second release keeps the previous release's files and manifest.prev.json, third release prunes the first", () => {
  const src = tmp(), dst = tmp();
  const target = path.join(dst, "apps");
  const out = path.join(target, "schrijfassistent");
  release(src, hashes[0]);
  publishAppsDir(src, target, quiet);
  rmSync(path.join(src, "schrijfassistent"), { recursive: true });
  release(src, hashes[1]);
  let r = publishAppsDir(src, target, quiet);
  assert.equal(r.pruned, 0, "the previous release stays for one release");
  assert.ok(existsSync(path.join(out, `schrijfassistent.${hashes[0]}.js`)));
  assert.equal(JSON.parse(readFileSync(path.join(out, "manifest.prev.json"), "utf-8")).hash, hashes[0]);
  assert.equal(JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf-8")).hash, hashes[1]);
  rmSync(path.join(src, "schrijfassistent"), { recursive: true });
  release(src, hashes[2]);
  r = publishAppsDir(src, target, quiet);
  assert.equal(r.pruned, 2, "the first release's js and css are removed");
  assert.deepEqual(names(out).filter((n) => /\.(js|css)$/.test(n)), [`schrijfassistent.${hashes[1]}.css`, `schrijfassistent.${hashes[1]}.js`, `schrijfassistent.${hashes[2]}.css`, `schrijfassistent.${hashes[2]}.js`]);
  assert.equal(JSON.parse(readFileSync(path.join(out, "manifest.prev.json"), "utf-8")).hash, hashes[1]);
  assert.ok(existsSync(path.join(out, "fonts", "Phosphor.aaaaaaaa.woff2")), "fonts are not pruned");
  assert.ok(existsSync(path.join(out, "logo_flevoland.png")));
});

test("a failure is reported as { ok: false, error } and does not throw", () => {
  const src = tmp(), dst = tmp();
  release(src, hashes[0]);
  writeFileSync(path.join(dst, "apps"), "a file where the target directory should be");
  const r = publishAppsDir(src, path.join(dst, "apps"), quiet);
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test("missing source directory is a no-op", () => {
  assert.deepEqual(publishAppsDir(path.join(tmp(), "nope"), path.join(tmp(), "apps"), quiet), { ok: true, files: 0, pruned: 0, error: "" });
});

