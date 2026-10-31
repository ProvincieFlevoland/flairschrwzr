#!/usr/bin/env node
// Open WebUI stand-in that runs the REAL overlay files.
//
//   node hostsim/serve.mjs --port 3071 --upstream http://127.0.0.1:8071 --ow http://127.0.0.1:8072 --data /tmp/hostsim-data
//
// A plain node http server (no dependencies) that serves what a browser meets on the GovChat host, taken from the
// repository itself, so the e2e tests run the unmodified loader.js against the unmodified bundle:
//   /                              a page with Open WebUI's sidebar Search row (the anchor of the launcher), the overlay
//                                  loader.js and custom.css; `?token=<t>` stores localStorage.token like a sign-in,
//                                  `&dark=1` sets the .dark class on <html>
//   /api/v1/auths/                 forwarded to the Open WebUI token stand-in (--ow): the identity of the bearer token
//   /static/loader.js, /static/custom.css, /static/help-content.json   from <repo>/admin/defaults
//   /static/apps.json              the PUBLISHED card list: admin/defaults/apps.json prepared by
//                                  admin/lib/schrijfassistent-card.js (the code server.js runs), written to <data>/published/
//   /static/apps/schrijfassistent/*  the bundle (<repo>/schrijfassistent/frontend/dist)
//   /apps/schrijfassistent/*       forwarded to --upstream with the prefix stripped (the Front Door rule)
//   /api/config/apps               GET the published list; POST stores the editor's document and republishes (like the apps editor)
//   /__hostsim/requests            every request seen since the last reset (method, path, ts)
//   /__hostsim/reset               clears that log
// Differences from the real admin container, on purpose: the republish is immediate (server.js republishes inside the POST as well
// and on an interval) and /static has no cache headers beyond no-store.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : (process.env['HOSTSIM_' + name.toUpperCase().replace(/-/g, '_')] || dflt);
}
const REPO = path.resolve(arg('repo', path.resolve(here, '../../../..')));
const PORT = Number(arg('port', '3071'));
const UPSTREAM = arg('upstream', 'http://127.0.0.1:8071').replace(/\/$/, '');
const OW = arg('ow', 'http://127.0.0.1:8072').replace(/\/$/, '');
const DATA = path.resolve(arg('data', path.join(REPO, '..', 'hostsim-data-' + PORT)));
const DIST = path.resolve(arg('dist', path.join(REPO, 'schrijfassistent/frontend/dist')));
const require = createRequire(import.meta.url);
const { prepareAppsForPublish } = require(path.join(REPO, 'admin/lib/schrijfassistent-card.js'));

const DEFAULTS = path.join(REPO, 'admin/defaults');
const STORED_APPS = path.join(DATA, 'apps.json');
const PUBLISHED = path.join(DATA, 'published');
fs.mkdirSync(PUBLISHED, { recursive: true });

// -- the admin's state -------------------------------------------------------------------------------------------------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function publishApps() {
  const stored = readJson(STORED_APPS, null) || readJson(path.join(DEFAULTS, 'apps.json'), { apps: [] });
  const prepared = prepareAppsForPublish(stored);
  const file = path.join(PUBLISHED, 'apps.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(prepared, null, 2));
  fs.renameSync(tmp, file);
  return prepared;
}
// initDefaults(): the git copy of apps.json is forced on every start
fs.copyFileSync(path.join(DEFAULTS, 'apps.json'), STORED_APPS);
publishApps();
console.log(`[hostsim] repo=${REPO} port=${PORT} upstream=${UPSTREAM} ow=${OW} data=${DATA}`);

// -- helpers -------------------------------------------------------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
const reqLog = [];
function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'cache-control': 'no-store', 'content-length': buf.length, ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'content-type': TYPES['.json'] } : {}), ...headers });
  res.end(buf);
}
function sendFile(res, file, type) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    send(res, 200, fs.readFileSync(file), { 'content-type': type || TYPES[path.extname(file)] || 'application/octet-stream', 'last-modified': st.mtime.toUTCString() });
  } catch { send(res, 404, 'not found'); }
}
function readBody(req, limit = 14 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function forward(req, res, base, pathAndQuery) {
  try {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) headers[k] = v;
    const r = await fetch(base + pathAndQuery, { method: req.method, headers, body, redirect: 'manual' });
    const out = Buffer.from(await r.arrayBuffer());
    const h = {};
    r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) h[k] = v; });
    res.writeHead(r.status, { ...h, 'content-length': out.length });
    res.end(out);
  } catch (e) {
    send(res, 502, { detail: 'hostsim upstream error: ' + e.message });
  }
}

const HOST_PAGE = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><title>Open WebUI stand-in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/static/custom.css"></head>
<body>
<div id="app" style="display:flex;height:100vh;font-family:system-ui,sans-serif">
  <nav id="sidebar" style="width:260px;border-right:1px solid #ccc;padding:8px">
    <div class="px-1 flex justify-center"><button id="sidebar-search-button" class="grow flex items-center rounded-xl px-2 py-1.5" type="button">Zoeken</button></div>
  </nav>
  <main style="flex:1;padding:16px"><h1>Open WebUI stand-in</h1><p>Chat</p></main>
</div>
<script>
  try {
    var p = new URLSearchParams(location.search);
    if (p.get('token')) localStorage.setItem('token', p.get('token'));
    if (p.get('help') !== '1') localStorage.setItem('helpOverlay_dontShow', '1');   // a returning user: no first-visit help modal
    if (p.get('dark') === '1') document.documentElement.classList.add('dark');
  } catch (e) {}
</script>
<script src="/static/loader.js"></script>
</body></html>`;

// -- routes --------------------------------------------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  reqLog.push({ ts: Date.now(), method: req.method, path: p });
  try {
    if (p === '/__hostsim/requests') return send(res, 200, { requests: reqLog });
    if (p === '/__hostsim/reset') { reqLog.length = 0; return send(res, 200, { ok: true }); }

    if (p === '/' || p === '/index.html') return send(res, 200, HOST_PAGE, { 'content-type': TYPES['.html'] });
    if (p === '/favicon.ico') return send(res, 204, '');
    if (p === '/api/v1/auths/' || p === '/api/v1/auths') return forward(req, res, OW, '/api/v1/auths/');

    if (p === '/static/apps.json' || (p === '/api/config/apps' && req.method === 'GET')) return sendFile(res, path.join(PUBLISHED, 'apps.json'));
    if (p === '/static/loader.js') return sendFile(res, path.join(DEFAULTS, 'loader.js'));
    if (p === '/static/custom.css') return sendFile(res, path.join(DEFAULTS, 'custom.css'));
    if (p === '/static/help-content.json') return sendFile(res, path.join(DEFAULTS, 'help-content.json'));
    if (p.startsWith('/static/apps/schrijfassistent/')) {
      const rel = decodeURIComponent(p.slice('/static/apps/schrijfassistent/'.length));
      const file = path.resolve(DIST, rel);
      if (!file.startsWith(DIST + path.sep)) return send(res, 404, 'not found');
      return sendFile(res, file);
    }
    if (p.startsWith('/apps/schrijfassistent/')) return forward(req, res, UPSTREAM, p.slice('/apps/schrijfassistent'.length) + url.search);

    // the admin container's API, as far as the card uses it
    if (p === '/api/config/apps' && req.method === 'POST') {
      let input;
      try { input = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'Ongeldige JSON' }); }
      fs.writeFileSync(STORED_APPS, JSON.stringify(input, null, 2));
      publishApps();
      return send(res, 200, { ok: true, published: true });
    }
    return send(res, 404, 'not found: ' + p);
  } catch (e) {
    return send(res, 500, { detail: String(e && e.message || e) });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`[hostsim] http://localhost:${PORT}/?token=<token>`));
