/**
 * JASSUB (libass → WASM) and the URLs of its worker, WASM and default font.
 * Only ever reached through a dynamic `import()` from AssLayer, so none of it
 * — not even these URL strings — is in the app's entry chunk.
 *
 * WHY EXPLICIT URLS (JASSUB's README, "custom bundler" section): JASSUB finds
 * its files with `new URL('./…', import.meta.url)`. In `vite build` that
 * works, but in `vite dev` Vite pre-bundles the package into
 * `node_modules/.vite/deps/`, where those relative files do not exist. Vite's
 * own `?worker&url` / `?url` imports resolve correctly in BOTH modes and are
 * emitted under `base` (`/watch-together/assets/…`) in the build, so the
 * GitHub Pages sub-path needs no special handling.
 *
 *  - `?worker&url` bundles JASSUB's worker (it imports `abslink`,
 *    `lfa-ponyfill` and the Emscripten glue) into one worker chunk.
 *  - The two WASM builds: `modern` needs relaxed-SIMD; JASSUB picks.
 *  - `default.woff2` (Liberation Sans) is the fallback font when a script
 *    names a font that is neither embedded nor installed.
 */
import JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import defaultFontUrl from 'jassub/dist/default.woff2?url';

const DEFAULT_FONT = 'liberation sans';

export { DEFAULT_FONT, defaultFontUrl, JASSUB, modernWasmUrl, wasmUrl, workerUrl };
