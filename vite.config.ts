import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * A LINKED LIBRARY'S REBUILD RELOADS THE PAGE — it is never hot-swapped.
 * Learned in Nodestra (2026-09-27): a hot swap of a file:-linked library left
 * the app holding OLD and NEW copies of it at once, and state was lost. A
 * full reload boots one consistent copy. It waits until the build has
 * finished writing (the build empties dist/ first).
 */
function reloadOnLinkedLibraryBuild(): Plugin {
  const linkedDists = ['easy-folder-management-ui/dist/'];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    name: 'reload-on-linked-library-build',
    apply: 'serve',
    handleHotUpdate({ file, server }) {
      const normalized = file.replaceAll('\\', '/');
      const dist = linkedDists.find((marker) => normalized.includes(marker));
      if (dist === undefined) return undefined;
      const root = normalized.slice(0, normalized.indexOf(dist) + dist.length);
      clearTimeout(timer);
      const reloadWhenBuilt = (attempt: number) => {
        const built = ['index.d.ts', 'styles.css'].some((name) => existsSync(root + name));
        if (built || attempt > 40) {
          server.ws.send({ type: 'full-reload' });
          return;
        }
        timer = setTimeout(() => reloadWhenBuilt(attempt + 1), 250);
      };
      timer = setTimeout(() => reloadWhenBuilt(0), 800);
      return [];
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app from https://theclearsky.github.io/watch-together/.
  // Routes live in the URL hash (`#/room/<code>`), so a deep link never asks
  // Pages for a path it does not have.
  base: '/watch-together/',
  plugins: [react(), tailwindcss(), reloadOnLinkedLibraryBuild()],
  resolve: {
    // LOAD-BEARING: the file:-linked library resolves its own node_modules
    // copies otherwise — a second React crashes hooks.
    dedupe: ['react', 'react-dom', 'zod', '@theclearsky/easy-folder-management-ui'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
