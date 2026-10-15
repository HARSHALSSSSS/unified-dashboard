import { MarketplaceHttpClient, type HttpTransport } from '@oms/marketplace-core';
import type { LwaTokenResponse } from './dto';
import { mapAmazonError } from './errors';
import type { AmazonAppCredentials } from './environment';

export interface Tokens { accessToken: string; refreshToken?: string; expiresAt: Date }

/** Login with Amazon (LWA): authorization code / refresh token -> short-lived access token. */
export class LwaAuth {
  private readonly http: MarketplaceHttpClient;
  constructor(transport: HttpTransport, lwaBaseUrl: string, private readonly app: AmazonAppCredentials, private readonly now: () => number = Date.now) {
    this.http = new MarketplaceHttpClient({ baseUrl: lwaBaseUrl, transport, mapError: (res) => mapAmazonError(res) });
  }

  private async token(form: Record<string, string>): Promise<Tokens> {
    const res = await this.http.request<LwaTokenResponse>({
      method: 'POST', path: '/auth/o2/token',
      form: { ...form, client_id: this.app.clientId, client_secret: this.app.clientSecret },
    });
    return { accessToken: res.body.access_token, refreshToken: res.body.refresh_token, expiresAt: new Date(this.now() + res.body.expires_in * 1000) };
  }

  exchangeCode(code: string, redirectUri?: string): Promise<Tokens> {
    return this.token({ grant_type: 'authorization_code', code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) });
  }

  refresh(refreshToken: string): Promise<Tokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }
}
