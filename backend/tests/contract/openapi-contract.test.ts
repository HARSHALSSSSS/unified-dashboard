import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allModules } from '@oms/modules-registry';
import { buildTestApp } from '@oms/testing';

/**
 * API contract: the OpenAPI document generated from code must equal the committed docs/api/openapi.json.
 * Any route/schema change therefore shows up as a diff in code review, and CI fails until `pnpm openapi:export`
 * is run. Breaking-change policy: see docs/api/API.md.
 */
const committed = resolve(__dirname, '../../docs/api/openapi.json');

describe('openapi contract', () => {
  it('committed spec matches the running code', async () => {
    expect(existsSync(committed), 'run `pnpm openapi:export` and commit docs/api/openapi.json').toBe(true);
    const t = await buildTestApp({ modules: allModules });
    const generated = JSON.parse(JSON.stringify(t.app.swagger()));
    await t.close();
    expect(generated).toEqual(JSON.parse(readFileSync(committed, 'utf8')));
  });

  it('every module declares only /api/v1 prefixes and unique names', () => {
    const names = new Set<string>();
    for (const { manifest } of allModules) {
      expect(names.has(manifest.name)).toBe(false);
      names.add(manifest.name);
      for (const p of manifest.api) expect(p.startsWith('/api/v1/')).toBe(true);
    }
  });
});
