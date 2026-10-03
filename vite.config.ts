import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  const linkedDists = ['easy-folder-management-ui/dist/', 'easy-tutorial-builder/dist/'];
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

/**
 * THIRD_PARTY_LICENSES.txt: every npm package that ends up in the bundle,
 * with its OWN license file copied byte for byte (never retyped). JASSUB's
 * native parts (libass, FreeType, …) are in public/THIRD_PARTY_NOTICES.txt.
 */
function bundledLicenses(): Plugin {
  const packageRoot = (id: string): string | null => {
    let dir = dirname(id.split('?')[0]);
    for (let depth = 0; depth < 12; depth += 1) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        try {
          const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
          if (json.name && json.version) return dir;
        } catch {
          // keep walking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  };
  return {
    name: 'bundled-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const normalized = id.replaceAll('\\', '/');
          // Anything that is not this app's own source: node_modules, and
          // first-party libraries linked in by path during development.
          if (normalized.includes('/watch-together/src/') || normalized.startsWith('\0')) continue;
          const root = packageRoot(id.replace(/^\0/, ''));
          if (root && !root.replaceAll('\\', '/').endsWith('/watch-together')) roots.add(root);
        }
      }
      const entries = [...roots]
        .map((root) => {
          const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string; version: string; license?: string };
          const file = readdirSync(root).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
          // Packages that ship no license file: a byte copy fetched from the
          // upstream repository lives in licenses/<package>.txt.
          const vendored = join(fileURLToPath(new URL('./licenses', import.meta.url)), `${json.name.replace(/^@/, '').split('/')[0]}.txt`);
          const text = file ? readFileSync(join(root, file), 'utf8') : existsSync(vendored) ? readFileSync(vendored, 'utf8') : null;
          return { ...json, text };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const seen = new Set<string>();
      const parts = [
        'Third-party software bundled into watch-together (generated at build time from each package’s own files).',
        'Native subtitle-rendering components (libass, FreeType, FriBidi, HarfBuzz, …) are listed in THIRD_PARTY_NOTICES.txt.',
        '',
      ];
      for (const entry of entries) {
        const key = `${entry.name}@${entry.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push('='.repeat(78), `${key} — ${entry.license ?? 'see license text'}`, '='.repeat(78), entry.text ?? '(the package ships no license file — its text is in THIRD_PARTY_NOTICES.txt)', '');
      }
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.txt', source: parts.join('\n') });
    },
  };
}

export default defineConfig({
  // GitHub Pages serves the app from https://theclearsky.github.io/watch-together/.
  // Routes live in the URL hash (`#/room/<code>`), so a deep link never asks
  // Pages for a path it does not have.
  base: '/watch-together/',
  plugins: [react(), tailwindcss(), reloadOnLinkedLibraryBuild(), bundledLicenses()],
  // JASSUB's worker uses a dynamic import, which the default iife worker
  // format cannot bundle (the build fails without this).
  worker: { format: 'es' },
  build: {
    // The one big chunk is three.js for the Welcome page's 3D stage (~680 kB,
    // ~200 kB gzip): lazy, fetched only when the Welcome page shows.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        // ONE long-lived vendor chunk: an app update re-downloads only the app.
        // (Several hand-made vendor chunks — react / library / p2p — imported
        // each other in a circle, and the live site crashed on load with
        // "Cannot access 'lt' before initialization" (2026-10-03). A single
        // vendor chunk cannot form a cycle: it never imports app code.)
        // The big lazy libraries stay in their own on-demand chunks.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](three|jassub|abslink|lfa-ponyfill|throughput)[\\/]/.test(id)) return undefined;
          return 'vendor';
        },
      },
    },
  },
  resolve: {
    // LOAD-BEARING: the file:-linked library resolves its own node_modules
    // copies otherwise — a second React crashes hooks.
    dedupe: ['react', 'react-dom', 'zod', '@theclearsky/easy-folder-management-ui'],
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // JASSUB imports `rvfc-polyfill` (GPL-3.0) for a side effect every
      // supported browser already provides natively; an empty stand-in keeps
      // GPL code out of this MIT app (src/subtitles/rvfcNoop.ts).
      'rvfc-polyfill': fileURLToPath(new URL('./src/subtitles/rvfcNoop.ts', import.meta.url)),
    },
  },
});
