// Fails the build when the production bundles import each other in a circle.
//
// 2026-10-03: hand-made vendor chunks (react / library / p2p) imported each
// other circularly; the dev server (no bundling) and every test were fine, but
// the deployed site crashed on load with "Cannot access 'lt' before
// initialization". This walks the STATIC imports between the emitted chunks
// (dynamic import() is lazy and cannot cause that) and reports any cycle.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional argument: another build's assets folder (default dist/assets).
const assets = process.argv[2] ?? fileURLToPath(new URL('../dist/assets/', import.meta.url));
const files = readdirSync(assets).filter((name) => name.endsWith('.js'));
const graph = new Map();
for (const name of files) {
  const code = readFileSync(join(assets, name), 'utf8');
  const deps = new Set();
  // `import … from"./x.js"` and bare `import"./x.js"` — not `import("./x.js")`.
  for (const match of code.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) deps.add(match[1]);
  graph.set(name, [...deps].filter((dep) => dep !== name));
}

const cycles = [];
const state = new Map(); // 1 = on the stack, 2 = done
const stack = [];
const visit = (node) => {
  state.set(node, 1);
  stack.push(node);
  for (const dep of graph.get(node) ?? []) {
    if (state.get(dep) === 1) cycles.push([...stack.slice(stack.indexOf(dep)), dep].join(' → '));
    else if (!state.has(dep)) visit(dep);
  }
  stack.pop();
  state.set(node, 2);
};
for (const node of graph.keys()) if (!state.has(node)) visit(node);

if (cycles.length > 0) {
  console.error(`[check-chunks] FAIL: circular imports between bundles (the site would crash on load):\n  ${cycles.join('\n  ')}`);
  process.exit(1);
}
console.log(`[check-chunks] PASS: ${files.length} chunks, no circular static imports`);
