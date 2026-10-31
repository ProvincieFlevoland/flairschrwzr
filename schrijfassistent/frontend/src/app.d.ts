// Ambient declarations of the bundle.
// The file is a module (`export {}`), so globals must sit inside `declare global`.

declare global {
    /** Build info injected by Vite `define` at compile time (vite.config.ts). */
    const __BUILD_HASH__: string;
    const __BUILD_DATE__: string;
    const __BUILD_DEV__: boolean;
    /** Published file names (relative to `asset_base_url`) of the three B1 lexicons, injected by vite.config.ts. */
    const __B1_LEXICON_FILES__: { jargon: string; formal: string; cohesion: string };

    interface Window {
        /** The IIFE export of the bundle (main.js); the one global the bundle creates. */
        SchrijfassistentApp?: { mount: (target: HTMLElement, props?: object) => unknown; unmount: () => Promise<void> };
    }
}

export {};
