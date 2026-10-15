import { manifest } from './manifest';
import { connectorRoutes } from './routes';
import { refreshExpiringTokensHandler } from './jobs';

export { manifest };
export { connectorRoutes };
export { ConnectorHost, signState, verifyState, type HostOptions } from './host';
export { refreshExpiringTokensHandler, JOB_REFRESH_EXPIRING } from './jobs';

/**
 * Marketplace Connectors (runtime): connector catalogue + capability matrix, the authorization lifecycle
 * (authorize / reconnect / refresh / health / disconnect) and the host that runs connector calls with
 * credential decryption, token rotation, rate limiting, retries and health tracking.
 */
export const marketplaceConnectorsModule = { manifest, routes: connectorRoutes, jobs: [refreshExpiringTokensHandler] };
