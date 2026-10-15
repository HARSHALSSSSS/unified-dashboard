import { FetchTransport, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';

/** Myntra does not publish endpoints. These are PLACEHOLDERS: set the real partner hosts from your Myntra onboarding contract. */
export const MYNTRA_HOSTS = { live: 'https://partner-api.myntra.example', sandbox: 'https://partner-sandbox.myntra.example' } as const;

export type SandboxTarget = 'simulator' | 'vendor-sandbox';
export const sandboxTarget = (config?: Record<string, unknown>): SandboxTarget =>
  (config?.sandbox as { target?: SandboxTarget } | undefined)?.target === 'vendor-sandbox' ? 'vendor-sandbox' : 'simulator';

export interface Target { transport: HttpTransport; baseUrl: string; simulated: boolean }

export function selectTarget(opts: { mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }, simulator: HttpTransport): Target {
  const mode = opts.mode ?? 'sandbox';
  if (mode === 'sandbox' && sandboxTarget(opts.config) === 'simulator') return { transport: simulator, baseUrl: MYNTRA_HOSTS.live, simulated: true };
  const override = (opts.config?.baseUrl as string | undefined) ?? undefined;
  return { transport: new FetchTransport(), baseUrl: override ?? (mode === 'live' ? MYNTRA_HOSTS.live : MYNTRA_HOSTS.sandbox), simulated: false };
}
export const targetOf = (ctx: ConnectorContext, simulator: HttpTransport): Target => selectTarget({ mode: ctx.mode, config: ctx.config }, simulator);
