// Vite library build of the Schrijfassistent bundle .
//
//   SOFTWARE_VERSION_TAG=1.2.0 node node_modules/vite/bin/vite.js build
//
// Output (dist/): schrijfassistent.<hash>.js (IIFE, global `SchrijfassistentApp`), schrijfassistent.<hash>.css
// (one file, cssCodeSplit false) and manifest.json `{ hash, js, css, version, builtAt }` for loader.js
// (which reads `hash` and the optional `js`/`css` names). The hash is the content hash Rollup computes for
// the JS chunk; the CSS file reuses it so one manifest entry names both files.
import { defineConfig, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build info (`__BUILD_HASH__`): the pipeline passes SOFTWARE_VERSION_TAG; local builds say "dev".
const versionTag = (process.env.SOFTWARE_VERSION_TAG || '').trim() || 'dev';
const buildDate = (process.env.SOFTWARE_BUILD_DATE || '').trim() || new Date().toISOString().split('T')[0]; // YYYY-MM-DD

const BUNDLE_NAME = 'schrijfassistent';

/**
 * Names both output files `schrijfassistent.<hash>.js/.css` with one content hash over the JS and the CSS
 * (a CSS-only change must also yield a new name) and writes manifest.json next to them.
 */
function bundleManifestPlugin(): Plugin {
  return {
    name: 'schrijfassistent-manifest',
    apply: 'build',
    enforce: 'post', // after vite:css-post has emitted the single CSS asset
    generateBundle(options, bundle) {
      const js = Object.values(bundle).find((f) => f.type === 'chunk' && f.isEntry);
      if (!js || js.type !== 'chunk') throw new Error('entry chunk not found');
      const css = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.css'));
      if (!css || css.type !== 'asset') throw new Error('css asset not found (cssCodeSplit must be false)');
      const cssSource = typeof css.source === 'string' ? css.source : Buffer.from(css.source).toString('utf8');
      const hash = createHash('sha256').update(js.code).update(cssSource).digest('hex').slice(0, 12);
      const rename = (file: { fileName: string }, oldKey: string, target: string) => {
        delete bundle[oldKey];
        file.fileName = target;
        bundle[target] = file as (typeof bundle)[string];
      };
      rename(js, js.fileName, `${BUNDLE_NAME}.${hash}.js`);
      rename(css, css.fileName, `${BUNDLE_NAME}.${hash}.css`);
      const manifest = {
        hash,
        js: js.fileName,
        css: css.fileName,
        version: versionTag,
        builtAt: new Date().toISOString(),
      };
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) + '\n' });
    },
  };
}

// the three B1 lexicons (about 273 kB) are not bundled; they are emitted as `lexicons/b1-lexicon-<kind>.<hash>.json` (content hash
// in the name, so a cached copy is never stale) and fetched by `src/lib/utils/b1LexiconLoader.js` on the first use of the Direct Duidelijk tab.
const LEXICON_KINDS = ['jargon', 'formal', 'cohesion'] as const;
const lexiconSources = Object.fromEntries(
  LEXICON_KINDS.map((kind) => {
    const source = readFileSync(path.resolve(__dirname, `src/lib/data/b1-lexicon-${kind}.json`));
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    return [kind, { source, fileName: `lexicons/b1-lexicon-${kind}.${hash}.json` }];
  }),
) as Record<(typeof LEXICON_KINDS)[number], { source: Buffer; fileName: string }>;

function lexiconAssetsPlugin(): Plugin {
  return {
    name: 'schrijfassistent-lexicons',
    apply: 'build',
    generateBundle() {
      for (const kind of LEXICON_KINDS) {
        this.emitFile({ type: 'asset', fileName: lexiconSources[kind].fileName, source: lexiconSources[kind].source });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    svelte({
      // Svelte 5 in legacy mode as the code is written today; no runes migration.
      compilerOptions: { runes: false },
      emitCss: true,
    }),
    bundleManifestPlugin(),
    lexiconAssetsPlugin(),
  ],
  resolve: {
    alias: { $lib: path.resolve(__dirname, 'src/lib') },
  },
  define: {
    __BUILD_HASH__: JSON.stringify(versionTag),
    __BUILD_DATE__: JSON.stringify(buildDate),
    __BUILD_DEV__: JSON.stringify(mode !== 'production'),
    __B1_LEXICON_FILES__: JSON.stringify(Object.fromEntries(LEXICON_KINDS.map((k) => [k, lexiconSources[k].fileName]))),
  },
  // static/logo_flevoland.png is copied into dist/, so the Dockerfile copies one directory.
  publicDir: 'static',
  // Relative URLs for the files of `static/` that the bundle CSS names (the Phosphor font files:
  // `url(/fonts/x.woff2)` in a CSS file is emitted as `url(./fonts/x.woff2)`, so the CSS and `dist/fonts/` are
  // served together from {asset_base_url}/ whatever that path is. Fonts must come from `static/` and not be
  // imported from `src/`: in library mode Vite inlines every imported asset as a data URI whatever
  // `assetsInlineLimit` says (checked with a test font), and data-URI fonts are not allowed; check-css-scope.mjs
  // fails the build on one.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2020',
    lib: {
      entry: path.resolve(__dirname, 'src/main.js'),
      name: 'SchrijfassistentApp',
      formats: ['iife'],
      fileName: () => `${BUNDLE_NAME}.[hash].js`,
    },
    rollupOptions: {
      output: {
        entryFileNames: `${BUNDLE_NAME}.[hash].js`,
        assetFileNames: `${BUNDLE_NAME}.[hash][extname]`,
        inlineDynamicImports: true,
      },
    },
  },
}));
