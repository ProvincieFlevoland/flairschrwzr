// Plain Svelte 5 (no SvelteKit) for the library build; legacy mode, no runes.
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/vite-plugin-svelte').SvelteConfig} */
const config = {
    preprocess: vitePreprocess(),
    compilerOptions: { runes: false }
};

export default config;
