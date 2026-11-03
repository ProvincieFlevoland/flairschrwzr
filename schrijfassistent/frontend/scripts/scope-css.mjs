#!/usr/bin/env node
// One-time scoping of the app's CSS under `.sa-root`. Run once from
// schrijfassistent/frontend after convert-css-modules.mjs; the output is committed, the script
// stays as the record of the rules. Idempotent: a second run changes nothing.
//
//   node scripts/scope-css.mjs            # rewrites in place
//   node scripts/scope-css.mjs --dry-run  # prints the summary only
//
// Rules applied
//   src/styles/app.css
//     * `@tailwind` directives removed (Tailwind is not part of the bundle); the reset rules the
//       app relied on live in src/styles/reset.css, scoped under .sa-root.
//     * `:root { --x: ... }`      -> `.sa-root { --sa-x: ... }`
//     * `* { ... }`               -> `.sa-root, .sa-root * { ... }`
//     * `body { ... }`            -> `.sa-root { ... }` with `height: 100%` (fixed container) and the
//                                    host font (`font-family: inherit`, Inter removed)
//     * `#root { ... }`           -> removed
//     * `::highlight(ai-suggestions)` -> `::highlight(sa-ai-suggestions)` (global by nature)
//     * `@keyframes name`         -> `@keyframes sa-name`, animation references rewritten
//     * every other selector      -> prefixed `.sa-root ` (a selector that already starts with
//                                    `.sa-root` or `.dark .sa-root` is left alone)
//     * generic class names (.btn, .tab, .form-input, .flex-1, .divider, .card-*, .badge-*
//       and their siblings) -> `.sa-<name>` in the selectors
//   src/lib/**/*.css (the converted CSS modules)
//     * every selector prefixed `.sa-root `; keyframes already carry the module prefix
//   every .css and .svelte file
//     * `var(--x)` -> `var(--sa-x)` and `--x:` -> `--sa-x:` for every custom property the app
//       declares or uses (app.css :root set plus the inline ones such as --chip-color)
//   every .svelte file
//     * generic class names inside `class="..."` attributes (static tokens and quoted strings in
//       the attribute's expressions) -> `sa-<name>`
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dryRun = process.argv.includes('--dry-run');
const ROOT_CLASS = '.sa-root';

/** Generic global class names renamed `sa-<name>` in app.css and in component class attributes. */
export const GENERIC_CLASSES = new Set([
  'btn', 'btn-primary', 'btn-secondary', 'btn-danger', 'btn-success', 'btn-icon', 'btn-sm',
  'tab', 'tabs',
  'form-input', 'form-group',
  'flex-1', 'flex-2',
  'divider',
  'card-header', 'card-content', 'card-actions', 'card-category',
  'badge-draft', 'badge-review', 'badge-success',
]);

function walk(dir, exts, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- custom properties
export function collectCustomProperties(files) {
  const names = new Set();
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/var\(\s*--([a-zA-Z][\w-]*)/g)) names.add(m[1]);
    for (const m of s.matchAll(/(?<![\w-])--([a-zA-Z][\w-]*)\s*:/g)) names.add(m[1]);
  }
  for (const n of [...names]) if (n.startsWith('sa-')) names.delete(n);
  return names;
}

export function renameCustomProperties(text, names) {
  if (!names.size) return text;
  const alt = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const useRe = new RegExp(`var\\(\\s*--(${alt})(?![\\w-])`, 'g');
  const defRe = new RegExp(`(?<![\\w-])--(${alt})(\\s*:)`, 'g');
  return text.replace(useRe, (_, n) => `var(--sa-${n}`).replace(defRe, (_, n, colon) => `--sa-${n}${colon}`);
}

// ---------------------------------------------------------------- selectors
function isScoped(selector) {
  const s = selector.trim();
  return s === ROOT_CLASS || s.startsWith(ROOT_CLASS + ' ') || s.startsWith(ROOT_CLASS + '.') || s.startsWith(ROOT_CLASS + ':') || s.startsWith(ROOT_CLASS + ',')
    || /^\.dark\s+\.sa-root(\s|\.|:|$)/.test(s) || /^html\.dark\s+\.sa-root(\s|\.|:|$)/.test(s);
}

function renameGenericInSelector(selector) {
  return selector.replace(/\.([a-zA-Z_-][\w-]*)/g, (m, name) => (GENERIC_CLASSES.has(name) ? `.sa-${name}` : m));
}

function scopeSelector(selector) {
  const s = selector.trim();
  if (isScoped(s)) return s;
  if (s.startsWith('::highlight(')) return s;
  return `${ROOT_CLASS} ${s}`;
}

function inKeyframes(rule) {
  return rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name);
}

// ---------------------------------------------------------------- app.css
export function scopeAppCss(cssText) {
  const ast = postcss.parse(cssText);
  const notes = [];
  // 1. @tailwind directives
  ast.walkAtRules('tailwind', (at) => { at.remove(); notes.push('@tailwind removed'); });
  // 2. keyframes
  const keyframeNames = new Set();
  ast.walkAtRules('keyframes', (at) => {
    const name = at.params.trim();
    if (name.startsWith('sa-')) return;
    keyframeNames.add(name);
    at.params = `sa-${name}`;
  });
  if (keyframeNames.size) {
    ast.walkDecls(/^animation(-name)?$/, (decl) => {
      decl.value = decl.value.replace(/[A-Za-z_][\w-]*/g, (w) => (keyframeNames.has(w) ? `sa-${w}` : w));
    });
  }
  // 3. rules
  ast.walkRules((rule) => {
    if (inKeyframes(rule)) return;
    const sel = rule.selector.trim();
    if (sel === ':root') { rule.selector = ROOT_CLASS; notes.push(':root -> .sa-root'); return; }
    if (sel === '*') { rule.selector = `${ROOT_CLASS}, ${ROOT_CLASS} *`; notes.push('* scoped'); return; }
    if (sel === 'body') {
      rule.selector = ROOT_CLASS;
      rule.walkDecls('height', (d) => { if (d.value === '100vh') d.value = '100%'; });
      rule.walkDecls('font-family', (d) => { d.value = 'inherit'; });
      notes.push('body -> .sa-root (height 100%, host font)');
      return;
    }
    if (sel === '#root') { rule.remove(); notes.push('#root removed'); return; }
    if (sel.startsWith('::highlight(')) {
      rule.selector = sel.replace('::highlight(ai-suggestions)', '::highlight(sa-ai-suggestions)');
      return;
    }
    rule.selector = rule.selectors.map((s) => scopeSelector(renameGenericInSelector(s))).join(',\n');
  });
  return { css: ast.toString(), notes };
}

// ---------------------------------------------------------------- component css
export function scopeComponentCss(cssText) {
  const ast = postcss.parse(cssText);
  ast.walkRules((rule) => {
    if (inKeyframes(rule)) return;
    rule.selector = rule.selectors.map((s) => scopeSelector(s)).join(',\n');
  });
  return ast.toString();
}

// ---------------------------------------------------------------- svelte class attributes
export function renameGenericClassesInSvelte(src) {
  const token = (t) => (GENERIC_CLASSES.has(t) ? `sa-${t}` : t);
  const renameStatic = (text) => text.split(/(\s+)/).map((part) => (/^\s+$/.test(part) ? part : token(part))).join('');
  const renameQuoted = (expr) => expr.replace(/(['"`])([^'"`]*)\1/g, (m, q, inner) => q + inner.split(/(\s+)/).map((p) => (/^\s+$/.test(p) ? p : token(p))).join('') + q);
  // class="...": static text outside { } and quoted strings inside { }
  let out = src.replace(/\bclass="([^"]*)"/g, (m, value) => {
    let res = '';
    let i = 0;
    while (i < value.length) {
      const open = value.indexOf('{', i);
      if (open === -1) { res += renameStatic(value.slice(i)); break; }
      res += renameStatic(value.slice(i, open));
      let depth = 0; let j = open;
      for (; j < value.length; j++) { if (value[j] === '{') depth++; else if (value[j] === '}') { depth--; if (depth === 0) break; } }
      res += renameQuoted(value.slice(open, j + 1));
      i = j + 1;
    }
    return `class="${res}"`;
  });
  // class={'a b'} / class={cond ? 'a' : 'b'}
  out = out.replace(/\bclass=\{([^}]*)\}/g, (m, expr) => `class={${renameQuoted(expr)}}`);
  return out;
}

// ---------------------------------------------------------------- main
function main() {
  const cssFiles = walk(path.join(root, 'src'), ['.css']);
  const svelteFiles = walk(path.join(root, 'src'), ['.svelte']);
  const names = collectCustomProperties([...cssFiles, ...svelteFiles]);
  console.log(`custom properties to rename (${names.size}): ${[...names].sort().join(' ')}`);
  const appCss = path.join(root, 'src/styles/app.css');
  const changed = [];

  for (const f of cssFiles) {
    const before = readFileSync(f, 'utf8');
    let after;
    if (f === appCss) {
      const r = scopeAppCss(before);
      after = r.css;
      if (r.notes.length) console.log(`app.css: ${[...new Set(r.notes)].join('; ')}`);
    } else {
      after = scopeComponentCss(before);
    }
    after = renameCustomProperties(after, names);
    if (after !== before) { changed.push(path.relative(root, f)); if (!dryRun) writeFileSync(f, after); }
  }
  for (const f of svelteFiles) {
    const before = readFileSync(f, 'utf8');
    let after = renameCustomProperties(before, names);
    after = renameGenericClassesInSvelte(after);
    if (after !== before) { changed.push(path.relative(root, f)); if (!dryRun) writeFileSync(f, after); }
  }
  // reset.css is imported by app.css; make sure the import line exists once
  if (existsSync(appCss)) {
    const s = readFileSync(appCss, 'utf8');
    if (!/@import\s+['"]\.\/reset\.css['"]/.test(s)) {
      if (!dryRun) writeFileSync(appCss, `@import './reset.css';\n${s}`);
      changed.push('src/styles/app.css (reset import)');
    }
  }
  console.log(`${dryRun ? 'would change' : 'changed'} ${changed.length} file(s):\n  ${changed.join('\n  ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
