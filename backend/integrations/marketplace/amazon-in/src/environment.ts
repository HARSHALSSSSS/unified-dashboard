import { FetchTransport, type ConnectorContext, type HttpTransport } from '@oms/marketplace-core';

/** SP-API endpoints. Amazon.in belongs to the EU region. */
export const AMAZON_HOSTS = {
  live: 'https://sellingpartnerapi-eu.amazon.com',
  sandbox: 'https://sandbox.sellingpartnerapi-eu.amazon.com',
  lwa: 'https://api.amazon.com',
  sellerCentral: 'https://sellercentral.amazon.in',
} as const;

export const INDIA_MARKETPLACE_ID = 'A21TJRUUN4KGV';

export interface AmazonAppCredentials { clientId: string; clientSecret: string; /** SP-API application id (amzn1.sp.solution...) used for the consent URL */ applicationId?: string }

/** sandbox accounts talk to the in-process simulator by default, or to Amazon's official sandbox when configured. */
export type SandboxTarget = 'simulator' | 'vendor-sandbox';
export const sandboxTarget = (config?: Record<string, unknown>): SandboxTarget =>
  (config?.sandbox as { target?: SandboxTarget } | undefined)?.target === 'vendor-sandbox' ? 'vendor-sandbox' : 'simulator';

export interface Target { transport: HttpTransport; baseUrl: string; lwaBaseUrl: string; simulated: boolean }

export function selectTarget(opts: { mode?: 'live' | 'sandbox'; config?: Record<string, unknown> }, simulator: HttpTransport): Target {
  const mode = opts.mode ?? 'sandbox';
  if (mode === 'sandbox' && sandboxTarget(opts.config) === 'simulator') {
    return { transport: simulator, baseUrl: AMAZON_HOSTS.live, lwaBaseUrl: AMAZON_HOSTS.lwa, simulated: true };
  }
  return { transport: new FetchTransport(), baseUrl: mode === 'live' ? AMAZON_HOSTS.live : AMAZON_HOSTS.sandbox, lwaBaseUrl: AMAZON_HOSTS.lwa, simulated: false };
}

export const targetOf = (ctx: ConnectorContext, simulator: HttpTransport): Target => selectTarget({ mode: ctx.mode, config: ctx.config }, simulator);
export const marketplaceIdOf = (config?: Record<string, unknown>): string => (typeof config?.marketplaceId === 'string' ? config.marketplaceId : INDIA_MARKETPLACE_ID);
