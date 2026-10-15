import type { FlipkartAppCredentials } from './environment';

/** Third-party app authorization-code flow: the seller approves the application, Flipkart redirects with `code` + `state`. */
export function buildAuthorizeUrl(app: FlipkartAppCredentials, state: string, redirectUri: string): string {
  const u = new URL('https://api.flipkart.net/oauth-service/oauth/authorize');
  u.searchParams.set('client_id', app.appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'Seller_Api');
  u.searchParams.set('state', state);
  return u.toString();
}
