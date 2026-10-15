/**
 * Architecture guard (run in CI): verifies the declared module graph.
 *  1. every module's `dependsOn` is acyclic
 *  2. manifest.dependsOn == the @oms/mod-* dependencies in its package.json (no hidden coupling)
 *  3. every consumed event is published by some module (no dead subscriptions)
 *  4. modules only import other modules through their package entry point
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { allModules } from '@oms/modules-registry';

const root = resolve(import.meta.dirname, '..');
const mods = new Map(allModules.map((m) => [m.manifest.name, m.manifest]));
const errors: string[] = [];

// 1. cycles
const state = new Map<string, 0 | 1 | 2>();
const visit = (n: string, path: string[]) => {
  if (state.get(n) === 2) return;
  if (state.get(n) === 1) { errors.push(`dependency cycle: ${[...path, n].join(' -> ')}`); return; }
  state.set(n, 1);
  for (const d of mods.get(n)?.dependsOn ?? []) {
    if (!mods.has(d)) errors.push(`${n} depends on unknown module "${d}"`);
    else visit(d, [...path, n]);
  }
  state.set(n, 2);
};
for (const n of mods.keys()) visit(n, []);

// 2. package.json parity
for (const [name, m] of mods) {
  const pkg = JSON.parse(readFileSync(join(root, 'modules', name, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const declared = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@oms/mod-')).map((d) => d.replace('@oms/mod-', '')).sort();
  const manifest = [...m.dependsOn].sort();
  if (declared.join() !== manifest.join()) errors.push(`${name}: manifest.dependsOn [${manifest}] != package.json [${declared}]`);
}

// 3. events
const published = new Set([...mods.values()].flatMap((m) => m.publishes));
const SYSTEM_EVENTS = new Set(['*']);
for (const m of mods.values()) for (const e of m.consumes) {
  if (!published.has(e) && !SYSTEM_EVENTS.has(e)) errors.push(`${m.name} consumes "${e}" which no module publishes`);
}

// 4. deep imports
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
});
for (const name of mods.keys()) {
  const src = join(root, 'modules', name, 'src');
  if (!existsSync(src)) continue;
  for (const file of walk(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"](@oms\/mod-[a-z-]+)\/[^'"]+['"]/g)) errors.push(`${file}: deep import of ${m[1]} (use the package entry point)`);
    for (const m of text.matchAll(/from\s+['"]@oms\/mod-([a-z-]+)['"]/g)) {
      const dep = m[1]!;
      if (dep !== name && !mods.get(name)!.dependsOn.includes(dep)) errors.push(`${file}: imports ${dep} but it is not in dependsOn`);
    }
  }
}

if (errors.length) {
  console.error(`Module graph violations:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`module graph OK: ${mods.size} modules, ${[...mods.values()].reduce((n, m) => n + m.dependsOn.length, 0)} dependency edges, acyclic`);
