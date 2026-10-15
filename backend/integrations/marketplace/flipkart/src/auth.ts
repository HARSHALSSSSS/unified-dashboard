import { MarketplaceHttpClient, type HttpTransport } from '@oms/marketplace-core';
import type { FkTokenResponse } from './dto';
import { basicAuth } from './environment';
import { mapFlipkartError } from './errors';

export interface Tokens { accessToken: string; refreshToken?: string; expiresAt: Date; scope?: string }

/** Flipkart OAuth 2.0: client credentials (self access), authorization code and refresh token grants. */
export class FlipkartAuth {
  private readonly http: MarketplaceHttpClient;
  constructor(transport: HttpTransport, baseUrl: string, private readonly id: string, private readonly secret: string, private readonly now: () => number = Date.now) {
    this.http = new MarketplaceHttpClient({ baseUrl, transport, mapError: (res) => mapFlipkartError(res) });
  }

  private async token(query: Record<string, string>): Promise<Tokens> {
    const res = await this.http.request<FkTokenResponse>({ method: 'GET', path: '/oauth-service/oauth/token', query, headers: { authorization: basicAuth(this.id, this.secret) } });
    return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token, expiresAt: new Date(this.now() + res.body.expires_in * 1000), scope: res.body.scope };
  }

  clientCredentials(): Promise<Tokens> { return this.token({ grant_type: 'client_credentials', scope: 'Seller_Api' }); }
  exchangeCode(code: string, redirectUri: string): Promise<Tokens> { return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }); }
  refresh(refreshToken: string): Promise<Tokens> { return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
}
