import { FetchTransport, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';

export const FLIPKART_HOSTS = { live: 'https://api.flipkart.net', sandbox: 'https://sandbox-api.flipkart.net' } as const;

/** platform-level Flipkart application (AUTHORIZATION CODE flow for third-party apps) */
export interface FlipkartAppCredentials { appId: string; appSecret: string }

export type SandboxTarget = 'simulator' | 'vendor-sandbox';
export const sandboxTarget = (config?: Record<string, unknown>): SandboxTarget =>
  (config?.sandbox as { target?: SandboxTarget } | undefined)?.target === 'vendor-sandbox' ? 'vendor-sandbox' : 'simulator';

export interface Target { transport: HttpTransport; baseUrl: string; simulated: boolean }

export function selectTarget(opts: { mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }, simulator: HttpTransport): Target {
  const mode = opts.mode ?? 'sandbox';
  if (mode === 'sandbox' && sandboxTarget(opts.config) === 'simulator') return { transport: simulator, baseUrl: FLIPKART_HOSTS.live, simulated: true };
  return { transport: new FetchTransport(), baseUrl: mode === 'live' ? FLIPKART_HOSTS.live : FLIPKART_HOSTS.sandbox, simulated: false };
}
export const targetOf = (ctx: ConnectorContext, simulator: HttpTransport): Target => selectTarget({ mode: ctx.mode, config: ctx.config }, simulator);

/** Flipkart expects HTTP Basic auth (appId:appSecret) on the token endpoint. */
export const basicAuth = (id: string, secret: string): string => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
