import { manifest } from './manifest';
import { accountRoutes, AccountSchema } from './routes';

export { manifest };
export { accountRoutes, AccountSchema };
export {
  toAccountDto, getAccount, getAccountRow, getAuthorizationRow, saveAuthorization, loadCredentials, recordSuccess, recordFailure, clearAuthorization,
  markAuthorizationExpiring, saveWebhookSecret, readWebhookSecret, type AccountRow, type AuthorizationRow, type SaveAuthorizationInput,
} from './service';

/**
 * Marketplace Accounts: a vendor's seller accounts per marketplace and the custody of their credentials
 * (AES-256-GCM, AAD-bound). Credentials are readable only through `loadCredentials`, used by the connector host.
 */
export const marketplaceAccountsModule = { manifest, routes: accountRoutes };
