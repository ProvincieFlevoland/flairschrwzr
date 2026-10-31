#!/usr/bin/env node
// Build-time check of the styling rule: every selector in the emitted bundle CSS
// starts inside `.sa-root` (or its dark twin `.dark .sa-root`). Allowed exceptions: the
// `::highlight(sa-ai-suggestions)` rule (global by nature), `@keyframes sa-*` (names are prefixed) and
// `@font-face` for the Phosphor icon font: the `font-family` name must be `sa-` prefixed or start with
// `Phosphor`, and every `src` url must be a same-origin relative path (no scheme, no leading `/`, no `..`,
// no `data:`: library mode inlines fonts imported from src/ as data URIs, so the files must come from static/fonts/), so the font files are served next to the bundle.
//
//   node scripts/check-css-scope.mjs            # checks dist/schrijfassistent.*.css (after vite build)
//   node scripts/check-css-scope.mjs file.css   # checks one file
// Exit code 1 with the offending selectors listed when the rule is broken.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SCOPE_RE = /^(\.dark\s+|html\.dark\s+)?\.sa-root(?![\w-])/;
const HIGHLIGHT_RE = /^::highlight\(sa-ai-suggestions\)$/;
const FONT_FAMILY_RE = /^(sa-|Phosphor)/;

/** Problems of one `@font-face` rule: an empty array when it is allowed. */
function fontFaceProblems(at) {
  const problems = [];
  let family = '';
  const urls = [];
  at.walkDecls((d) => {
    if (d.prop === 'font-family') family = d.value.trim().replace(/^['"]|['"]$/g, '');
    if (d.prop === 'src') for (const m of d.value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) urls.push(m[2].trim());
  });
  if (!FONT_FAMILY_RE.test(family)) problems.push(`font-family "${family}" must start with sa- or Phosphor`);
  if (!urls.length) problems.push('no src url');
  for (const u of urls) {
    const bare = u.replace(/[?#].*$/, '');
    if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('/') || u.startsWith('//') || bare.split('/').includes('..')) {
      problems.push(`src url "${u.slice(0, 60)}" is not a same-origin relative path`);
    }
  }
  return problems;
}

export function checkCss(cssText) {
  const ast = postcss.parse(cssText);
  const violations = [];
  ast.walkAtRules('keyframes', (at) => {
    if (!/^sa-/.test(at.params.trim())) violations.push({ kind: 'keyframes', selector: `@keyframes ${at.params}`, line: at.source?.start?.line });
  });
  ast.walkAtRules((at) => {
    if (['keyframes', 'media', 'supports', 'layer', 'charset'].includes(at.name)) return;
    if (!['font-face', 'import', 'container'].includes(at.name)) {
      // @property, @page, @counter-style, @namespace and the like are document-global and cannot be scoped under .sa-root
      violations.push({ kind: 'at-rule', selector: `@${at.name} ${at.params}`, line: at.source?.start?.line });
      return;
    }
    if (at.name === 'import') violations.push({ kind: 'at-rule', selector: `@${at.name} ${at.params}`, line: at.source?.start?.line });
    if (at.name === 'font-face') {
      for (const p of fontFaceProblems(at)) violations.push({ kind: 'font-face', selector: `@font-face: ${p}`, line: at.source?.start?.line });
    }
  });
  ast.walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    for (const sel of rule.selectors) {
      const s = sel.trim();
      // `.sa-root + .x` and `.sa-root ~ .x` reach siblings OUTSIDE the container
      // (any compound that holds `.sa-root` followed by a sibling combinator, `.sa-root:hover + .x`,
      // `.sa-root.open ~ .x`, and a `:has()` with a sibling combinator inside, `.sa-root:has(+ .x)`, reach outside too)
      if (SCOPE_RE.test(s) && !SIBLING_ESCAPE_RE.test(s) && !HAS_SIBLING_RE.test(s)) continue;
      if (HIGHLIGHT_RE.test(s)) continue;
      violations.push({ kind: 'selector', selector: s, line: rule.source?.start?.line });
    }
  });
  return violations;
}

const SIBLING_ESCAPE_RE = /\.sa-root[^\s>+~]*\s*[+~]/;
const HAS_SIBLING_RE = /:has\([^)]*[+~]/;

function main() {
  let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) {
    const dist = path.join(root, 'dist');
    files = readdirSync(dist).filter((f) => /^schrijfassistent\..*\.css$/.test(f)).map((f) => path.join(dist, f));
  }
  if (!files.length) { console.error('check-css-scope: no CSS file found (run vite build first)'); process.exit(2); }
  let total = 0;
  for (const f of files) {
    const v = checkCss(readFileSync(f, 'utf8'));
    total += v.length;
    console.log(`${path.relative(root, f)}: ${v.length ? `${v.length} selector(s) outside .sa-root` : 'all selectors scoped under .sa-root'}`);
    for (const x of v.slice(0, 50)) console.log(`  line ${x.line}: ${x.selector}`);
    if (v.length > 50) console.log(`  ... ${v.length - 50} more`);
  }
  process.exit(total ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
