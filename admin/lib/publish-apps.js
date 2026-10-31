// Publishes the built Schrijfassistent bundle (admin/defaults/apps/) to PUBLISH_DIR/apps/.
// Pure fs code, no express: server.js calls it from publishAll() and
// admin/tests/publish-apps.test.mjs tests it.
//
// Order and atomicity. A browser that reads the new manifest.json must find the bundle files it names, so every
// file except a `manifest.json` is copied first and the manifests last. Each file is written to a temporary name
// next to its target and renamed, so a reader sees the old or the new file, never half of one. Before a changed
// manifest.json replaces the old one, the old one is kept as `manifest.prev.json`.
//
// Pruning. The files of the previous release for browsers with a cached manifest. In a directory
// that has a manifest.json, hashed bundle files (`<name>.<12 hex>.js|css`) that are named neither by the current
// nor by the previous manifest are removed, so a persistent volume does not collect one pair per release.
// Font files under fonts/ carry a content hash and are small; they are not pruned.

const fs = require("fs");
const path = require("path");

const HASHED_BUNDLE_FILE = /^[A-Za-z0-9_-]+\.[0-9a-f]{12}\.(js|css)$/;

function filesNamedBy(manifest) {
  const names = new Set();
  if (manifest && typeof manifest === "object") {
    for (const key of ["js", "css"]) if (typeof manifest[key] === "string" && manifest[key]) names.add(manifest[key]);
    const hash = typeof manifest.hash === "string" ? manifest.hash : "";
    if (hash && !manifest.js) names.add(`schrijfassistent.${hash}.js`);
    if (hash && !manifest.css) names.add(`schrijfassistent.${hash}.css`);
  }
  return names;
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function sameContent(a, b) {
  try {
    return fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function copyFileAtomic(src, dst) {
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

function listFiles(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), relPath));
    else if (entry.isFile()) out.push(relPath);
  }
  return out;
}

// Returns { ok, files, pruned, error }: `files` counts the files written, `pruned` the files removed.
function publishAppsDir(sourceDir, targetDir, log = console) {
  if (!fs.existsSync(sourceDir)) return { ok: true, files: 0, pruned: 0, error: "" };
  let files = 0;
  let pruned = 0;
  try {
    const all = listFiles(sourceDir);
    const isManifest = (rel) => path.posix.basename(rel) === "manifest.json";
    const ordered = [...all.filter((rel) => !isManifest(rel)), ...all.filter(isManifest)];
    const manifestDirs = new Set();
    for (const rel of ordered) {
      const src = path.join(sourceDir, ...rel.split("/"));
      const dst = path.join(targetDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (sameContent(src, dst)) {
        if (isManifest(rel)) manifestDirs.add(path.posix.dirname(rel));
        continue;
      }
      if (isManifest(rel)) {
        manifestDirs.add(path.posix.dirname(rel));
        if (fs.existsSync(dst)) copyFileAtomic(dst, path.join(path.dirname(dst), "manifest.prev.json"));
      }
      copyFileAtomic(src, dst);
      files += 1;
    }
    for (const relDir of manifestDirs) {
      const dir = relDir === "." ? targetDir : path.join(targetDir, ...relDir.split("/"));
      const keep = new Set([
        ...filesNamedBy(readJsonIfPresent(path.join(dir, "manifest.json"))),
        ...filesNamedBy(readJsonIfPresent(path.join(dir, "manifest.prev.json"))),
      ]);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !HASHED_BUNDLE_FILE.test(entry.name) || keep.has(entry.name)) continue;
        fs.unlinkSync(path.join(dir, entry.name));
        pruned += 1;
      }
    }
    if (files || pruned) log.log(`[publish] apps/ (${files} file(s) written, ${pruned} pruned) → ${targetDir}`);
    return { ok: true, files, pruned, error: "" };
  } catch (err) {
    log.warn(`[publish] Failed to publish apps/: ${err.message}`);
    return { ok: false, files, pruned, error: err.message };
  }
}

module.exports = { publishAppsDir, filesNamedBy, HASHED_BUNDLE_FILE };
