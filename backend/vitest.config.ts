import { defineConfig } from 'vitest/config';

const project = (name: string) => ({
  test: {
    name,
    include: [`tests/${name}/**/*.test.ts`],
    environment: 'node' as const,
    setupFiles: ['tests/helpers/setup-env.ts'],
    // PGlite (WASM Postgres) boots per test file; several files starting at once on a busy machine need headroom.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

export default defineConfig({
  test: {
    projects: ['unit', 'integration', 'api', 'database', 'contract', 'connector', 'e2e'].map(project),
    coverage: { provider: 'v8', include: ['apps/*/src/**', 'packages/*/src/**', 'modules/*/src/**'] },
  },
});
