import { describe, expect, it } from 'vitest';

/**
 * Black-box smoke test against a RUNNING stack (local compose, staging, or a preview environment).
 *   E2E_BASE_URL=http://localhost:3000 pnpm test:e2e
 * Skipped when E2E_BASE_URL is unset. Business-flow journeys are added per stage.
 */
const base = process.env.E2E_BASE_URL;

describe.skipIf(!base)('smoke', () => {
  it('is alive, ready and documented', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status, await ready.clone().text()).toBe(200);
    const spec = (await (await fetch(`${base}/docs/openapi`)).json()) as { openapi: string };
    expect(spec.openapi).toMatch(/^3\./);
  });
  it('rejects unauthenticated access to the API', async () => {
    const res = await fetch(`${base}/api/v1/me`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });
});
