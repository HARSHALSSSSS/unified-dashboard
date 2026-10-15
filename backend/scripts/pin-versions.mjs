#!/usr/bin/env node
// Replaces "latest" ranges with ^<installed version>. Run once after first install.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
const dirs = ['.', ...['apps', 'packages', 'modules', 'integrations/marketplace'].flatMap((d) => existsSync(d) ? readdirSync(d).map((x) => join(d, x)) : [])];
for (const d of dirs) {
  const pj = join(d, 'package.json'); if (!existsSync(pj)) continue;
  const j = JSON.parse(readFileSync(pj, 'utf8')); let changed = false;
  for (const k of ['dependencies', 'devDependencies']) for (const [n, v] of Object.entries(j[k] ?? {})) {
    if (v !== 'latest') continue;
    const cand = [join(d, 'node_modules', n, 'package.json'), join(root, 'node_modules', n, 'package.json')].find(existsSync);
    if (!cand) { console.warn('not found', n); continue; }
    j[k][n] = '^' + JSON.parse(readFileSync(cand, 'utf8')).version; changed = true;
  }
  if (changed) writeFileSync(pj, JSON.stringify(j, null, 2) + '\n');
}
