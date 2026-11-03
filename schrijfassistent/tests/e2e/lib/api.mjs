// HTTP side of the e2e tests (Node fetch): scratch notas, configuration restore, auth header.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEV_DIR } from './env.mjs';

export const API_V1 = '/api/v1';
export const STORAGE = API_V1 + '/storage';
export const CONFIG_ID = 'GS-nota v5';

export class Api {
  constructor(env) { this.env = env; }

  /** The admin token of the Open WebUI stand-in: the backend refuses a configuration write from any other role. */
  async authHeaders() {
    return { Authorization: `Bearer ${this.env.adminBearer}` };
  }

  async call(method, p, body) {
    const h = { ...(await this.authHeaders()) };
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(`${this.env.baseUrl}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, ok: r.ok, json, text };
  }
  get(p) { return this.call('GET', p); }
  put(p, b) { return this.call('PUT', p, b); }
  post(p, b) { return this.call('POST', p, b); }
  patch(p, b) { return this.call('PATCH', p, b); }
  delete(p) { return this.call('DELETE', p); }

  async listNotas() { const r = await this.get(`${STORAGE}/notas`); if (!r.ok) throw new Error(`GET notas ${r.status}`); return r.json.notas; }
  async getNota(id) { return (await this.get(`${STORAGE}/notas/${encodeURIComponent(id)}`)).json; }
  async putNota(nota) { const r = await this.put(`${STORAGE}/notas/${encodeURIComponent(nota.id)}`, nota); if (!r.ok) throw new Error(`PUT nota ${r.status}: ${r.text}`); return r.json; }
  async deleteNota(id) { return this.delete(`${STORAGE}/notas/${encodeURIComponent(id)}`); }

  /** Re-uploads the seeded v5 configuration (wipe and rebuild, like the seed step). */
  async restoreConfig() {
    const body = fixture('config/GS-nota-v5.upload.json');
    const r = await this.post(`${STORAGE}/upload-configuration`, body);
    if (!r.ok) throw new Error(`restore config ${r.status}: ${r.text}`);
    return r.json;
  }
}

export function fixture(rel) {
  return JSON.parse(readFileSync(path.join(DEV_DIR, 'fixtures', rel), 'utf8'));
}

/** The v5 chapters (id, titel, instructie) from the seeded upload body. */
export function v5Chapters() {
  const body = fixture('config/GS-nota-v5.upload.json');
  return Object.values(body)[0].mappen.hoofdstukken;
}

/** Nota HTML the way `createNewNota` builds it from the v5 chapters, with optional body HTML per chapter id. */
export function notaHtml(bodies = {}) {
  return v5Chapters().map((g) => {
    const instructie = (g.instructie || '').trim();
    const extra = bodies[g.id] ? `\n${bodies[g.id]}` : '';
    const body = instructie ? `\n<p><i>${instructie}</i></p>` : '';
    return `<h2 class="dynamic-chapter" data-chapter-id="${g.id}">${g.titel}</h2>${body}${extra}\n`;
  }).join('\n');
}

let seq = 0;
/** A scratch nota id that cannot collide with the fixtures (n1760000000001..3) or the UI's `'n' + Date.now()`. */
export function scratchId(tag) { return `ne2e-${tag}-${Date.now()}-${++seq}`; }

export function scratchNota(tag, overrides = {}) {
  return {
    id: scratchId(tag),
    title: `Test ${tag}`,
    titleManuallySet: true,
    status: 'WIP',
    lastModified: new Date().toISOString(),
    configId: CONFIG_ID,
    configName: CONFIG_ID,
    templateVersion: 'v5.0',
    toneOfVoice: 'Zakelijk',
    allowedWords: [],
    authors: ['Test Auteur'],
    reviewers: [],
    content: notaHtml(),
    notes: [],
    shortSummary: '',
    ...overrides,
  };
}

/** A scratch copy of a fixture nota (fixtures/notas/<file>) with its own id; `overrides` win (e.g. blockWorkflow: {} to unlock h2/h3). */
export function fixtureNotaCopy(file, tag, overrides = {}) {
  const fx = fixture(`notas/${file}`);
  return { ...fx, id: scratchId(tag), title: `Test ${tag} (${fx.title})`, lastModified: new Date().toISOString(), ...overrides };
}

/** Blob names POST /upload-configuration creates for a body . */
export function expectedBlobsForUpload(body) {
  const folder = Object.keys(body)[0];
  const cfg = body[folder];
  const names = [`${folder}/metadata.json`];
  for (const [sub, items] of Object.entries(cfg.mappen || {})) {
    if (!Array.isArray(items)) continue;
    items.forEach((item, index) => {
      const id = item && typeof item === 'object' ? item.id : null;
      names.push(id ? `${folder}/${sub}/${id}.json` : `${folder}/${sub}/${index}.json`);
    });
  }
  return names;
}
