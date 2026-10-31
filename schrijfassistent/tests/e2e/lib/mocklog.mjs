// Reader for the AI mock's call log (AI_MOCK_LOG, one JSON line per agent call with ts/assignment/chapter/variant/user_input):
// the server-side order of the agent calls. When the backend runs elsewhere (Docker) and the file is not readable here,
// callers fall back to the browser's request order; `available` says which.
import { existsSync, readFileSync, statSync } from 'node:fs';

export class MockLog {
  constructor(file) { this.file = file; this.available = !!file && existsSync(file); }
  /** Byte offset to read from later (so a scenario sees only its own calls). */
  mark() { return this.available ? statSync(this.file).size : 0; }
  since(offset) {
    if (!this.available) return [];
    const buf = readFileSync(this.file);
    return buf.subarray(offset).toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}
