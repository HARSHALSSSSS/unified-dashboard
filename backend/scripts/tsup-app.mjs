// Shared tsup configuration for deployable apps.
//
// Workspace packages (@oms/*) ship TypeScript sources and are BUNDLED into one file. Every third-party npm package
// stays EXTERNAL (native addons like argon2 and packages that read files at runtime like bullmq cannot be bundled).
// Because external packages are declared by the workspace packages (not by the app), we walk the @oms dependency
// graph, collect them, and emit `dist/package.json` with EXACT installed versions. The Docker runtime stage just
// runs `npm install --omit=dev` against that file.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const wsIndex = new Map(); // @oms/name -> package dir
let indexed = false;
function indexWorkspace(root) {
  if (indexed) return;
  indexed = true;
  for (const base of ['apps', 'packages', 'modules', 'integrations/marketplace']) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) {
      const pj = join(dir, d, 'package.json');
      if (existsSync(pj)) wsIndex.set(JSON.parse(readFileSync(pj, 'utf8')).name, join(dir, d));
    }
  }
}

function collectExternal(appDir) {
  const external = new Map(); // name -> declaring package dir
  const seen = new Set();
  const walk = (dir) => {
    const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (seen.has(pj.name)) return;
    seen.add(pj.name);
    for (const dep of Object.keys(pj.dependencies ?? {})) {
      if (dep.startsWith('@oms/')) walk(wsIndex.get(dep));
      else if (!external.has(dep)) external.set(dep, dir);
    }
  };
  walk(appDir);
  return external;
}

export function appConfig(appDir) {
  indexWorkspace(resolve(appDir, '../..'));
  const external = collectExternal(appDir);
  const deps = {};
  for (const [name, declaredIn] of external) {
    const req = createRequire(join(declaredIn, 'package.json'));
    let dir = dirname(req.resolve(name));
    // walk up to the package.json whose name matches
    while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name) dir = dirname(dir);
    deps[name] = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  }
  return {
    entry: ['src/main.ts'],
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    clean: true,
    sourcemap: true,
    noExternal: [/^@oms\//],
    external: [...external.keys()].map((n) => new RegExp(`^${n.replace(/[/.]/g, '\\$&')}(/.*)?$`)),
    async onSuccess() {
      const own = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
      writeFileSync(join(appDir, 'dist', 'package.json'), JSON.stringify({ name: own.name, version: own.version, private: true, type: 'module', dependencies: deps }, null, 2) + '\n');
    },
  };
}
