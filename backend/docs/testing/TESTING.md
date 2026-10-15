# Testing

Vitest, one project per level, all under `/tests`. Run everything: `pnpm test` (≈ 10 s, no Docker, no network).

| Project | Folder | What it proves | Needs |
|---|---|---|---|
| **unit** | `tests/unit` | Pure logic: errors, ids, pagination, scope resolution, passwords, JWT (expiry, alg=none, wrong aud), AES-GCM envelope (AAD binding, tamper, rotation), HMAC webhooks (replay), RBAC catalogue, config validation | nothing |
| **api** | `tests/api` | The real Fastify stack via `inject()` with in-memory ports: health/ready/live, ids, error envelope, RBAC 401/403, suspended tenant, tenant-from-token, impersonation rules, pagination, idempotency, CORS/headers, rate limiting, metrics, OpenAPI content, **route-policy boot enforcement** | nothing |
| **database** | `tests/database` | Applies the **real SQL migrations** to an in-process Postgres (PGlite): RLS isolation + fail-closed, cross-tenant write rejection, composite-FK protection, per-vendor uniqueness, order-ingestion idempotency, append-only audit log, triggers, `enable_tenant_rls()`; schema conventions (naming, timestamps, vendor-leading indexes, money columns) | nothing |
| **contract** | `tests/contract` | Generated OpenAPI == committed `docs/api/openapi.json`; module API prefixes | nothing |
| **connector** | `tests/connector` | Conformance suite run against **every** registered connector: complete capability matrix, promised operations implemented (for beta/ga), registry rules | nothing |
| **integration** | `tests/integration` | Components against real infra (Redis queues: dedupe by idempotency key, envelope; later outbox relay, repositories on real Postgres) | `TEST_REDIS_URL`, `TEST_DATABASE_URL` (auto-skip when unset; CI provides them) |
| **e2e** | `tests/e2e` | Black-box smoke of a running stack: live/ready/docs/401 | `E2E_BASE_URL` (auto-skip) |

## Conventions

- File naming `*.test.ts`; one `describe` per behaviour area; test names state the guarantee ("rejects the same key with a different payload").
- **Hermetic by default**: `tests/helpers/setup-env.ts` injects test-only config; no test reads real `.env` or secrets.
- API tests use `buildTestApp({ modules, vendors, healthChecks })` and `tokenFor({ roles, userType })` from `@oms/testing`; no mocking of Fastify internals.
- Test the **contract**, not the implementation: assert status + error `code` + envelope, not stack traces.
- Every module PR adds: unit tests for domain logic, API tests for each route (happy path, validation, RBAC, **cross-tenant 404**), database/integration tests for repositories and migrations.
- Every new tenant table is covered automatically by the convention tests; add targeted RLS assertions only for special policies.
- Connectors: recorded HTTP fixtures per operation (no live marketplace calls in CI); sandbox/live checks are a separate manual/nightly job.
- Time and randomness are injected (`Clock`, ids) so tests are deterministic. Do not use `sleep` for synchronisation unless unavoidable.
- Coverage (`vitest --coverage`) is tracked; thresholds are introduced once real domain code exists.

## CI

`verify` job: typecheck · lint · `check:modules` · `pnpm test` · OpenAPI export diff · build. `integration` job: Postgres + Redis services, `pnpm test:integration`. `docker` job: builds all four images.

## Stage 2 suites (≈ 230 tests, ~30 s, no Docker)

| File | Proves |
|---|---|
| `tests/api/flow.test.ts` | the full onboarding journey end to end |
| `tests/api/identity.test.ts` | register/login/lockout/rate-limit, refresh rotation + reuse detection, logout/sessions, e-mail verification, password reset/change, profile |
| `tests/api/tenancy-rbac.test.ts` | **tenant isolation** (reads, lists, writes, references, per-vendor uniqueness, smuggled tenant ids, direct DB with no scope = zero rows), **RBAC** matrix (admin/staff/viewer), role changes, last-admin rule, platform admin/support, suspension, **marketplace-account ownership**, **vendor ownership** |
| `tests/api/catalog.test.ts` | product CRUD, partial updates, optimistic locking, **SKU/barcode/code uniqueness**, price rules, search/filter/sort/**pagination walk**, bulk (savepoint isolation), categories tree, typed attributes, readiness, marketplace-specific data, **CSV import/export jobs** |
| `tests/api/documents.test.ts` | upload flow, sniffing, MIME/extension/size rules, primary image, tenant prefix, path traversal, RBAC |
| `tests/api/marketplace.test.ts` | capability matrix, authorization (code+state / credentials), encryption at rest, **rotation, expiry, proactive refresh, retries, 429, auth failure → reconnect**, health, disconnect, pause, scheduled token maintenance |
| `tests/connector/mock-connector.test.ts` | the sandbox through the bare `MarketplaceConnector` interface: auth, products, listings, inventory, orders, returns, shipments, webhooks, scripted failures + `withRetry` |
| `tests/connector/connectors.test.ts` | conformance for every registered connector (planned vs beta) |
| `tests/unit/marketplace-core.test.ts` | capability helpers, error taxonomy, OAuth state, CSV |

API tests use `buildTestApp({ database: true })`: real migrations on PGlite with the app connected as the **non-owner role**, so row-level security is active in every test. Mock-marketplace state is process-global: call `mockControl.reset()` in `beforeEach`.
Vitest timeouts are generous (60 s test / 120 s hook) because several PGlite instances can boot at once.
