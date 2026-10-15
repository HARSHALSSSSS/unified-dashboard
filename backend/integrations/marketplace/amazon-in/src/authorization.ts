import { AMAZON_HOSTS, type AmazonAppCredentials } from './environment';

/**
 * Seller authorization (OAuth consent) for a public/private SP-API application.
 * The seller is sent to Seller Central; Amazon redirects back to the redirect URI registered on the application with
 * `spapi_oauth_code` and `selling_partner_id`. The platform exchanges the code for a refresh token (auth.ts).
 * `version=beta` is required while the application is in draft state.
 */
export function buildConsentUrl(app: AmazonAppCredentials, state: string, draft = true): string {
  const u = new URL('/apps/authorize/consent', AMAZON_HOSTS.sellerCentral);
  u.searchParams.set('application_id', app.applicationId ?? app.clientId);
  u.searchParams.set('state', state);
  if (draft) u.searchParams.set('version', 'beta');
  return u.toString();
}
