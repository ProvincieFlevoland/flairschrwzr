#!/usr/bin/env node
// One-time conversion of the CSS Modules (`X.module.css` + `import styles from './X.module.css'`)
// to plain CSS files. Run once from
// schrijfassistent/frontend; the output is committed, the script stays as the record of the rule.
//
//   node scripts/convert-css-modules.mjs            # converts in place
//   node scripts/convert-css-modules.mjs --dry-run  # prints what would change
//
// Rules
//   * `src/lib/**/X.module.css` becomes `X.css` next to it. Every local class `.name` becomes
//     `.sa-<module>-name` where <module> is the kebab-case component name (`SuggestionModal` ->
//     `sa-suggestion-modal-popup`). CSS Modules gave every module its own hashed namespace; the
//     per-module prefix keeps that isolation, because 15 module class names collide with app.css
//     names (`.btn`, `.editor-cell`, `.cell-content`, `.form-input`, ...) and 11 collide between
//     modules (`.modal-backdrop`, `.btn-close`, `.active`, ...).
//   * Classes inside `:global(...)` are unwrapped and left unchanged (runtime-generated spans).
//   * The names stored in nota HTML or parsed by code stay unchanged everywhere (KEEP list).
//   * `@keyframes name` becomes `sa-<module>-name`; `animation` / `animation-name` declarations
//     that reference it are rewritten.
//   * In the component: `import styles from './X.module.css'` -> `import './X.css'`;
//     `styles['name']` and `styles.name` -> the literal `'sa-<module>-name'`;
//     styles[`name-${expr}`] -> `sa-<module>-name-${expr}`.
//   The scoping under `.sa-root` and the `--sa-` variable rename are done by scope-css.mjs.
import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dryRun = process.argv.includes('--dry-run');

/** Class names that stay as they are: stored in nota HTML, generated at runtime or parsed by code. */
export const KEEP = new Set([
  'cell-content', 'cell-content-wrapper', 'editor-cell', 'suggestion-highlight', 'dynamic-chapter', 'reviewer-highlight',
  'non-b1-word', 'hovered-from-sidebar', 'suggestion-highlight-active', 'has-structuur-highlight',
]);
export const KEEP_PREFIXES = ['source-'];
export function keepName(name) {
  return KEEP.has(name) || KEEP_PREFIXES.some((p) => name.startsWith(p));
}

export function kebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.module.css')) out.push(p);
  }
  return out;
}

/**
 * First pass: unwrap `:global(...)` and tag the classes that were inside it with a marker, so the
 * second pass (finishSelector) leaves them unprefixed.
 */
function markGlobals(selector) {
  const parsed = selectorParser().astSync(selector);
  parsed.walk((node) => {
    if (node.type === 'pseudo' && node.value === ':global') {
      const inner = node.nodes[0];
      const parent = node.parent;
      const children = inner ? [...inner.nodes] : [];
      for (const c of children) {
        c.remove();
        if (c.type === 'class') c.value = '__GLOBAL__' + c.value;
        parent.insertBefore(node, c);
      }
      node.remove();
    }
  });
  return parsed.toString();
}

/** Final pass: classes marked __GLOBAL__ lose the marker and are never prefixed. */
function finishSelector(selector, prefix) {
  const processor = selectorParser((selectors) => {
    selectors.walkClasses((cls) => {
      if (cls.value.startsWith('__GLOBAL__')) { cls.value = cls.value.slice('__GLOBAL__'.length); return; }
      if (keepName(cls.value)) return;
      cls.value = prefix + cls.value;
    });
  });
  return processor.processSync(selector);
}

export function convertCss(cssText, prefix) {
  const ast = postcss.parse(cssText);
  const keyframeNames = new Set();
  ast.walkAtRules('keyframes', (at) => { keyframeNames.add(at.params.trim()); at.params = prefix + at.params.trim(); });
  ast.walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    rule.selector = rule.selectors.map((s) => finishSelector(markGlobals(s), prefix)).join(', ');
  });
  if (keyframeNames.size) {
    ast.walkDecls(/^animation(-name)?$/, (decl) => {
      decl.value = decl.value.replace(/[A-Za-z_][\w-]*/g, (word) => (keyframeNames.has(word) ? prefix + word : word));
    });
  }
  return ast.toString();
}

export function convertComponent(src, moduleBase, prefix) {
  const importRe = new RegExp(`import\\s+styles\\s+from\\s+(['"])\\.\\/${moduleBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.module\\.css\\1;?`);
  if (!importRe.test(src)) return null;
  let out = src.replace(importRe, `import './${moduleBase}.css';`);
  const lit = (name) => `'${keepName(name) ? name : prefix + name}'`;
  out = out.replace(/styles\[\s*'([A-Za-z0-9_-]+)'\s*\]/g, (_, n) => lit(n));
  out = out.replace(/styles\[\s*"([A-Za-z0-9_-]+)"\s*\]/g, (_, n) => lit(n));
  out = out.replace(/styles\[\s*`([^`]*)`\s*\]/g, (_, tpl) => '`' + prefix + tpl + '`');
  out = out.replace(/\bstyles\.([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => lit(n));
  if (/\bstyles\b/.test(out.replace(/span-styles|styles of/g, ''))) {
    const left = out.match(/.*\bstyles\b.*/g);
    console.warn(`  ! ${moduleBase}: unconverted "styles" reference(s):\n    ${left.join('\n    ')}`);
  }
  return out;
}

function main() {
  const files = walk(path.join(root, 'src/lib'));
  if (!files.length) { console.log('no .module.css files found (already converted)'); return; }
  for (const file of files) {
    const dir = path.dirname(file);
    const moduleBase = path.basename(file, '.module.css');
    const prefix = `sa-${kebab(moduleBase)}-`;
    const cssOut = convertCss(readFileSync(file, 'utf8'), prefix);
    const cssTarget = path.join(dir, `${moduleBase}.css`);
    const svelteFile = path.join(dir, `${moduleBase}.svelte`);
    let svelteOut = null;
    try { svelteOut = convertComponent(readFileSync(svelteFile, 'utf8'), moduleBase, prefix); } catch { /* no component */ }
    console.log(`${path.relative(root, file)} -> ${path.relative(root, cssTarget)} (prefix ${prefix})${svelteOut ? ` + ${path.basename(svelteFile)}` : ''}`);
    if (dryRun) continue;
    writeFileSync(cssTarget, cssOut);
    unlinkSync(file);
    if (svelteOut) writeFileSync(svelteFile, svelteOut);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
