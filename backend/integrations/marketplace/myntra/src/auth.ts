import { MarketplaceHttpClient, type HttpTransport } from '@oms/marketplace-core';
import type { MynLoginResponse } from './dto';
import { mapMyntraError } from './errors';

export interface Session { accessToken: string; expiresAt: Date }

/** Partner API-key login: exchange { apiKey, apiSecret } for a short-lived session token (PROVISIONAL scheme). */
export class MyntraAuth {
  private readonly http: MarketplaceHttpClient;
  constructor(transport: HttpTransport, baseUrl: string, private readonly now: () => number = Date.now) {
    this.http = new MarketplaceHttpClient({ baseUrl, transport, mapError: (res) => mapMyntraError(res) });
  }
  async login(apiKey: string, apiSecret: string): Promise<Session> {
    const res = await this.http.post<MynLoginResponse>('/partner/v1/auth/login', { apiKey, apiSecret });
    return { accessToken: res.body.token, expiresAt: new Date(this.now() + res.body.expiresIn * 1000) };
  }
}
