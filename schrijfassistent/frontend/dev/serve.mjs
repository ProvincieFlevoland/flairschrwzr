#!/usr/bin/env node
// Tiny static server for the dev harness (dev-only; no dependencies).
//
//   node dev/serve.mjs            # http://localhost:5175/?api=http://localhost:8001
//   PORT=5176 node dev/serve.mjs
//
// Routes, mirroring the paths Open WebUI serves after publishAll():
//   /                                  dev/index.html (the Open WebUI stand-in)
//   /dev/*                             dev/*
//   /static/apps/schrijfassistent/*    dist/*   (manifest.json, schrijfassistent.<hash>.js/.css, logo)
//   /dev/host/custom.css               admin/defaults/custom.css, read on every request (the overlay's own container rules)
//   /dev/host/preflight.css            Tailwind 3 Preflight from node_modules (stands in for Open WebUI's reset; collisions show early)
//   /dev/host/openwebui.css            the file named by OPENWEBUI_APP_CSS (a built Open WebUI app.css), else an empty sheet
// Everything is served with `Cache-Control: no-store`, so a rebuild is picked up on reload.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 5175);
const host = process.env.HOST || '127.0.0.1';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };

const repoRoot = path.resolve(root, '../..');
const HOST_FILES = {
  '/dev/host/custom.css': path.join(repoRoot, 'admin/defaults/custom.css'),
  '/dev/host/preflight.css': path.join(root, 'node_modules/tailwindcss/lib/css/preflight.css'),
  '/dev/host/openwebui.css': process.env.OPENWEBUI_APP_CSS ? path.resolve(process.env.OPENWEBUI_APP_CSS) : null,
};

function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (Object.hasOwn(HOST_FILES, clean)) return HOST_FILES[clean] || '';
  if (clean === '/' || clean === '/index.html') return path.join(root, 'dev/index.html');
  if (clean.startsWith('/dev/')) return path.join(root, 'dev', clean.slice('/dev/'.length));
  const assetBase = '/static/apps/schrijfassistent/';
  if (clean.startsWith(assetBase)) return path.join(root, 'dist', clean.slice(assetBase.length));
  return null;
}

const server = createServer(async (req, res) => {
  const file = resolveFile(req.url || '/');
  if (file === '') { res.writeHead(200, { 'content-type': TYPES['.css'], 'cache-control': 'no-store' }); res.end('/* no host stylesheet configured */\n'); return; }
  const isHostFile = Object.values(HOST_FILES).includes(file);
  const inside = isHostFile || file && [path.join(root, 'dev'), path.join(root, 'dist')].some((d) => path.resolve(file).startsWith(d + path.sep) || path.resolve(file) === d);
  if (!file || !inside) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found: ' + path.relative(root, file));
  }
});

server.listen(port, host, () => {
  console.log(`schrijfassistent dev harness: http://${host}:${port}/?api=http://localhost:8001  (dist/ at /static/apps/schrijfassistent/)`);
});
