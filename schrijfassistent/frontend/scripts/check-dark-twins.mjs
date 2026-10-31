#!/usr/bin/env node
// Mechanical check of the dark twin rule (a `.dark .sa-root` twin for every colour rule).
//
//   node scripts/check-dark-twins.mjs            # checks dist/schrijfassistent.*.css (after vite build)
//   node scripts/check-dark-twins.mjs file.css   # checks one file
//   node scripts/check-dark-twins.mjs --coverage # also lists the light rules with a hard-coded colour and no twin
//
// Two findings:
//  1. TIE (fails the build): a dark twin whose specificity is not higher than the light rule it should beat, or
//     that comes before an equally specific light rule. Svelte scoped styles add a `.svelte-<hash>` class to the
//     light rule that the twin does not carry; that is how the nota-list hover twin lost.
//  2. COVERAGE (fails the build): light rules that declare a literal colour (hex,
//     rgb, hsl) outside a `var(--sa-...)` and have no twin. A rule that reads its colour from a custom property that
//     dark.css redefines needs no twin.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const COLOUR_PROPS = /^(color|background|background-color|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|box-shadow|fill|stroke|text-decoration-color|caret-color)$/;
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;
const HASH_CLASS = /\.svelte-[a-z0-9]+/g;

/** [ids, classes+attributes+pseudo-classes, elements+pseudo-elements] of one selector (no nested :is handling needed here). */
export function specificity(sel) {
  const spec = [0, 0, 0];
  selectorParser((root) => {
    root.walk((n) => {
      if (n.type === 'id') spec[0] += 1;
      else if (n.type === 'class' || n.type === 'attribute') spec[1] += 1;
      else if (n.type === 'pseudo') (n.value.startsWith('::') || /^:(before|after|first-line|first-letter)$/.test(n.value) ? (spec[2] += 1) : (spec[1] += 1));
      else if (n.type === 'tag') spec[2] += 1;
    });
  }).processSync(sel);
  return spec;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const isDark = (s) => /^(\.dark|html\.dark)\s/.test(s);
const stripDark = (s) => s.replace(/^(html)?\.dark\s+/, '');
const normalise = (s) => s.replace(HASH_CLASS, '').replace(/\s+/g, ' ').trim();

export function checkDarkTwins(cssText) {
  const ast = postcss.parse(cssText);
  /** @type {{ sel: string, norm: string, spec: number[], order: number, colour: boolean, dark: boolean, line?: number }[]} */
  const rules = [];
  let order = 0;
  ast.walkRules((rule) => {
    if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    let colour = false;
    rule.walkDecls((d) => { if (COLOUR_PROPS.test(d.prop) && LITERAL_COLOUR.test(d.value) && !/var\(--sa-/.test(d.value)) colour = true; });
    for (const raw of rule.selectors) {
      const sel = raw.trim();
      rules.push({ sel, norm: normalise(isDark(sel) ? stripDark(sel) : sel), spec: specificity(sel), order: order++, colour, dark: isDark(sel), line: rule.source?.start?.line });
    }
  });
  const ties = [];
  for (const twin of rules.filter((r) => r.dark)) {
    // the light rules the twin is meant to beat: same selector once the Svelte hash class is ignored
    for (const light of rules.filter((r) => !r.dark && r.norm === twin.norm)) {
      const c = cmp(twin.spec, light.spec);
      if (c < 0 || (c === 0 && light.order > twin.order)) {
        ties.push({ twin: twin.sel, light: light.sel, twinLine: twin.line, lightLine: light.line, twinSpec: twin.spec.join(','), lightSpec: light.spec.join(',') });
      }
    }
  }
  const twinned = new Set(rules.filter((r) => r.dark).map((r) => r.norm));
  const uncovered = rules.filter((r) => !r.dark && r.colour && !twinned.has(r.norm)).map((r) => ({ selector: r.sel, line: r.line }));
  return { ties, uncovered, rules: rules.length, twins: rules.filter((r) => r.dark).length };
}

function main() {
  const args = process.argv.slice(2);
  const coverage = args.includes('--coverage');
  let files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    const dist = path.join(root, 'dist');
    files = readdirSync(dist).filter((f) => /^schrijfassistent\..*\.css$/.test(f)).map((f) => path.join(dist, f));
  }
  if (!files.length) { console.error('check-dark-twins: no CSS file found (run vite build first)'); process.exit(2); }
  let failed = 0;
  for (const f of files) {
    const r = checkDarkTwins(readFileSync(f, 'utf8'));
    failed += r.ties.length + r.uncovered.length;
    console.log(`${path.relative(root, f)}: ${r.twins} dark twin selector(s), ${r.ties.length} specificity tie(s), ${r.uncovered.length} light colour rule(s) without twin (done-gate: both must be 0)`);
    for (const t of r.ties) console.log(`  TIE  ${t.twin} (${t.twinSpec}, line ${t.twinLine}) does not beat ${t.light} (${t.lightSpec}, line ${t.lightLine})`);
    if (coverage || r.uncovered.length) for (const u of r.uncovered) console.log(`  no twin  line ${u.line}: ${u.selector}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
