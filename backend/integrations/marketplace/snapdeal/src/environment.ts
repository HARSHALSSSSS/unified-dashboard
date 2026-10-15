import { FetchTransport, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';

/** Snapdeal does not publish endpoints. PLACEHOLDERS: set the real seller-API hosts from your Snapdeal onboarding contract. */
export const SNAPDEAL_HOSTS = { live: 'https://seller-api.snapdeal.example', sandbox: 'https://seller-sandbox.snapdeal.example' } as const;

export type SandboxTarget = 'simulator' | 'vendor-sandbox';
export const sandboxTarget = (config?: Record<string, unknown>): SandboxTarget =>
  (config?.sandbox as { target?: SandboxTarget } | undefined)?.target === 'vendor-sandbox' ? 'vendor-sandbox' : 'simulator';

export interface Target { transport: HttpTransport; baseUrl: string; simulated: boolean }

export function selectTarget(opts: { mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }, simulator: HttpTransport): Target {
  const mode = opts.mode ?? 'sandbox';
  if (mode === 'sandbox' && sandboxTarget(opts.config) === 'simulator') return { transport: simulator, baseUrl: SNAPDEAL_HOSTS.live, simulated: true };
  const override = opts.config?.baseUrl as string | undefined;
  return { transport: new FetchTransport(), baseUrl: override ?? (mode === 'live' ? SNAPDEAL_HOSTS.live : SNAPDEAL_HOSTS.sandbox), simulated: false };
}
export const targetOf = (ctx: ConnectorContext, simulator: HttpTransport): Target => selectTarget({ mode: ctx.mode, config: ctx.config }, simulator);
