# Marketplace connectors

Marketplaces differ in auth, rate limits, push vs poll, catalogue rules and shipping models. The core system therefore **never assumes a feature**: it consults the connector's declared capabilities and degrades or skips.

## Where things live

```
packages/marketplace-core/            the contract: MarketplaceConnector, ConnectorCapabilities, ConnectorContext, normalised models, ConnectorRegistry
integrations/marketplace/<name>/      one package per marketplace (amazon-in, flipkart, myntra, snapdeal)
integrations/marketplace/registry/    createConnectorRegistry(): the ONLY file that knows every connector
modules/marketplace-accounts/         vendor's connection + encrypted credential custody (DB)
modules/marketplace-connectors/       runtime hosting: rate limiting, retries, metrics, credential injection
modules/{sync,listings,orders,inventory,webhooks}   orchestration; call connectors only through the registry
```

## Responsibilities

| Connector (adapter) | Host / core |
|---|---|
| Speak the marketplace API (auth handshake, calls, pagination) | Load + decrypt credentials, build `ConnectorContext` |
| Normalise responses to core models (`NormalizedOrder`, …) | Persist everything; own all business rules and DB access |
| Translate marketplace errors into typed errors | Rate limit per account (`capabilities.limits`), batching, retries/backoff, circuit breaking |
| Declare **capabilities** and **limits** | Persist refreshed tokens passed back via `onCredentialsRefreshed` |
| Verify + parse its own webhooks | Webhook endpoint, dedupe, enqueue, idempotent apply |

Connectors **never** touch the database, never read env for vendor secrets, never log credentials.

## Capability model

`ConnectorCapabilities` = `auth {type, refreshable}` · `orders {fetch, webhook, acknowledge, cancel, maxLookbackDays}` · `inventory {push, pull, batch}` · `pricing {push, pull}` · `listings {create, update, deactivate, fetch, requiresCategoryMapping}` · `shipping {generateLabel, marketplaceManagedLogistics, manifest}` · `returns {fetch, webhook}` · `limits {requestsPerSecond, burst, maxBatchSize}`.

Examples of how core uses them: schedule order polling only for connectors with `orders.fetch` and *no* `orders.webhook`; skip label generation when `marketplaceManagedLogistics`; require category mapping before listing creation when `requiresCategoryMapping`; size inventory batches from `limits.maxBatchSize`.

`implementation: 'planned' | 'beta' | 'ga'`: Stage 1 connectors are **planned** (contract + capability declaration, no network code). Core refuses to schedule work for `planned` connectors; the conformance suite (`tests/connector`) enforces that `beta/ga` connectors implement every operation their capabilities promise. Myntra/Snapdeal capability values are provisional and must be confirmed against partner API contracts before Stage 3.

## Adding a marketplace (e.g. Ajio)

1. `integrations/marketplace/ajio/` (copy an existing package); implement `MarketplaceConnector`; declare capabilities.
2. Add `'ajio'` to `MARKETPLACES` (marketplace-core) and to the `marketplace_accounts_marketplace_chk` check via a migration.
3. Register it in `integrations/marketplace/registry/src/index.ts`.
4. Add recorded-fixture tests; the conformance suite picks it up automatically.

**No change to orders, inventory, listings, sync or any other core module.**

## Credentials and authorization lifecycle

`pending_authorization → active → (expiring → expired | revoked | error)`. OAuth state is signed and short-lived; the callback exchanges the code via `exchangeAuthorizationCode`, the host encrypts and stores credentials, emits `marketplace_account.connected`. A scheduled job refreshes tokens ahead of `access_token_expires_at` (partial index exists) and emits `marketplace_account.authorization_expired` (→ notification) when refresh fails. Details of encryption: SECURITY.md.

## Reliability rules (apply in Stage 3)

- Every outbound call: timeout, bounded retries with jitter on 429/5xx, honour `Retry-After`, never retry non-idempotent calls without an idempotency key.
- Rate limiting is **per marketplace account** (token bucket in Redis), not global.
- Ingestion is idempotent by `(marketplace_account_id, external_order_id)`; pushes skip no-ops via `marketplace_listings.sync_hash`.
- `marketplace_calls_total{marketplace,operation,outcome}` and per-account error state drive alerts.

## Stage 2: framework, host and sandbox

### The contract (`@oms/marketplace-core`)
Capability groups: `auth` · `account` · `catalog` · `listings` · `inventory` · `pricing` · `orders` · `returns` · `shipping` · `limits`. Operations (all optional, gated by capability): `authenticate`, `buildAuthorizationUrl`, `exchangeAuthorizationCode`, `refreshCredentials`, `verifyConnection`, `getAccount`, `importProducts`, `createListing`, `updateListing`, `pushInventory`, `pushPrices`, `fetchOrders`, `updateOrderStatus`, `cancelOrder`, `fetchReturns`, `createShipment`, `verifyWebhook`, `parseWebhook`.
Helpers: `hasCapability`, `requireCapability` (typed 422), `enabledCapabilities`, `ConnectorError` (`auth | rate_limited | transient | permanent | unsupported`), `withRetry` (exponential backoff, full jitter, honours Retry-After, only retryable errors).
Exposed by the API: `GET /marketplaces` (matrix for every connector), `GET /marketplace-accounts/{id}/capabilities`.

### The host (`ConnectorHost`, `modules/marketplace-connectors`)
`host.run(vendorId, accountId, fn)` is the only path to a marketplace:

1. loads the account and decrypts credentials in a **short** transaction; refuses paused / unconnected accounts (`ACCOUNT_NOT_CONNECTED`) and `planned` connectors (`CAPABILITY_UNSUPPORTED`)
2. refreshes tokens **ahead of expiry** (< 2 min left) and **once on an `auth` failure**, persisting the rotation re-encrypted (`rotationCount++`, audit entry)
3. per-account **token bucket** from `capabilities.limits`; bounded retries for transient/429
4. records `lastSuccessAt` / `lastFailureAt` / `connectionStatus`; an unrecoverable auth failure marks the authorization `expired`, the account `error`, emits `marketplace_account.authorization_expired` and demands a reconnect
5. maps failures to API errors without leaking upstream internals

Scheduled maintenance: `marketplace.refresh-expiring-tokens` (every 5 min, `maintenance` queue) rotates tokens expiring within 15 minutes.

### Lifecycle endpoints
`authorization-url` → `authorize` (code+state, or credentials) → `health-check` → `refresh` → `reconnect` → `disconnect`; plus capability-gated reads `remote-account`, `remote-products`. Connecting **validates with the marketplace before anything is stored**.

### Sandbox (`mock`, `integrations/marketplace/mock`)
Always sandbox-mode; enabled outside production (`MOCK_MARKETPLACE_ENABLED` to override). Authorise with code `sandbox-code[:sellerId[:ttlSeconds]]` or `{ sellerId, apiKey: "sandbox_…" }`. Seeds 25 products, 5 orders and 1 return per seller. Script failures from tests/dev:

```ts
import { mockControl } from '@oms/connectors';
mockControl.setBehavior('SELLER-1', { failNext: 2, failKind: 'transient' });   // next 2 calls fail, then recover
mockControl.setBehavior('SELLER-1', { rateLimitNext: 1, retryAfterMs: 500 });  // 429 + Retry-After
mockControl.expireAllAccessTokens();                                           // marketplace rejects stored tokens -> host refreshes
```
The conformance suite treats it as a `beta` connector: it must implement every operation its capabilities promise.

### Writing the real connectors (Stage 3+)
Replace a stub's `implementation: 'planned'` with `'beta'`, implement the declared operations against recorded fixtures, keep marketplace-specific shapes inside the package, and the host, lifecycle endpoints and token maintenance above work unchanged.
