# Development

## Prerequisites

Node ≥ 20.11 (22 recommended), pnpm 10 (`corepack enable`), Docker (for Postgres/Redis/MinIO). Docker is **not** needed to run the test suite.

## First run

```bash
pnpm install
cp .env.example .env              # dev defaults work as-is with the compose stack

pnpm infra:up                     # postgres + redis + minio (+ bucket)
pnpm db:migrate                   # as oms_owner
pnpm db:seed                      # permissions + system roles

pnpm dev                          # api + worker + scheduler + webhook-worker, watch mode
# or just the API:  pnpm dev:api
```

| URL | What |
|---|---|
| http://localhost:3000/docs | Swagger UI |
| http://localhost:3000/docs/openapi | OpenAPI JSON |
| http://localhost:3000/health/ready | readiness (postgres, redis) |
| http://localhost:3000/metrics | Prometheus metrics |
| http://localhost:9001 | MinIO console (minioadmin / minioadmin) |

Whole backend in containers instead: `pnpm stack:up` (adds `migrate`, `api`, `worker`, `scheduler`, `webhook-worker`). Add `--profile observability` for Prometheus (:9090) and Jaeger (:16686).

> If port 5432/6379 is taken, set `POSTGRES_PORT` / `REDIS_PORT` and update the URLs in `.env`.

## Commands

| Command | |
|---|---|
| `pnpm dev` / `pnpm dev:api` | run apps with `tsx watch` |
| `pnpm build` | bundle each app (tsup) into `apps/<app>/dist` |
| `pnpm typecheck` | `tsc` for every package + root tests/scripts |
| `pnpm lint` | ESLint |
| `pnpm test` (`:unit :api :database :contract :connector :integration :e2e`) | Vitest projects, see [TESTING](../testing/TESTING.md) |
| `pnpm check:modules` | module graph guard (also in CI) |
| `pnpm openapi:export` | regenerate `docs/api/openapi.json` (commit it) |
| `pnpm db:generate / db:migrate / db:seed` | database workflow, see [DATABASE](../database/DATABASE.md) |
| `pnpm scaffold:modules` | regenerate module packages, registry and `MODULES.md` from the module map |

## Configuration

`@oms/config` validates the environment at startup and lists *every* problem at once. Files load in order `.env.<NODE_ENV>.local` → `.env.<NODE_ENV>` → `.env` (real env vars always win). Groups: application · database · redis · storage · auth/security · observability · workers · platform marketplace credentials · third party. Per-environment guidance:

| | development | test | staging | production |
|---|---|---|---|---|
| Source | `.env` | `TEST_ENV` constants in `@oms/testing` | secret manager → env | secret manager → env |
| Swagger | on | on | on | **off** (opt-in) |
| Logs | pretty, debug | silent | json, info | json, info |
| HSTS / strict CSP | no | no | yes | yes |

## Adding a feature (the module recipe)

1. Find the module in `modules/<name>` (all 28 exist as skeletons with manifests). If a new one is needed: add it to `scripts/scaffold-modules.mjs`, run `pnpm scaffold:modules`, `pnpm install`.
2. Put code in the layers: `domain/` (pure) → `application/` (use-cases, transactions, emit events) → `infrastructure/` (tenant-scoped repositories) → `http/` (Fastify plugin).
3. Export a `ModuleDefinition` (`manifest`, `routes`, `consumers`, `jobs`) from the module's `index.ts`; it is picked up by `@oms/modules-registry` automatically.
4. Routes: declare `config.access` and a full `schema` (summary, tags, response). Boot fails otherwise.
5. Tenant data: `requireScope(req)` → repository with `tenantWhere()` inside `withScope()`. New tables: composite FKs, `enable_tenant_rls()`, vendor-leading index.
6. Side effects to other modules: write an **outbox event** in the same transaction, declare it in the manifest `publishes`/`consumes`.
7. Add tests at the right level (unit → api → database/integration); run `pnpm openapi:export`, `pnpm check:modules`, `pnpm typecheck`, `pnpm test`.

## Conventions

- TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`); no `any` without a justification comment.
- Errors: throw `AppError`/`Errors.*`; never return ad-hoc error bodies.
- IDs: `newId()` (UUIDv7). Time: inject `Clock` in domain code.
- Money: integer minor units. Dates: UTC ISO-8601.
- Packages ship TypeScript sources (`exports: ./src/index.ts`): no build step for libraries, apps bundle them with tsup.
- Commits: conventional commits recommended; PR checklist: tests, OpenAPI diff, migration reviewed, docs updated.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Invalid environment configuration` at boot | Read the listed variables; compare with `.env.example` |
| `/health/ready` 503 | Infra not running (`pnpm infra:up`) or wrong URLs; response lists which check failed |
| Boot error `[route-policy] …` | A route is missing `config.access`/summary/tags/2xx response: fix the route |
| API returns no rows / `row-level security` errors | Query ran outside `withScope()` (fail-closed by design) or connected as a role that is not `oms_app` |
| `check:modules` fails | A module imports/depends on another not declared in `dependsOn` or a cycle was introduced |
| Contract test fails | Run `pnpm openapi:export` and commit the diff (after reviewing it) |

## Stage 2 additions

| Task | How |
|---|---|
| Create the first platform admin | `PLATFORM_ADMIN_EMAIL=you@corp.test PLATFORM_ADMIN_PASSWORD='…' pnpm db:create-admin` (after `db:migrate` + `db:seed`) |
| Run without MinIO | `STORAGE_DRIVER=memory` |
| See e-mailed links (verify / reset / invite) | dev uses the log mailer: with `LOG_PRETTY=true` the link is printed in the API log (never in production) |
| Skip the verified-e-mail rule locally | `EMAIL_VERIFICATION_REQUIRED=false` (the `.env.example` default; **true** is the code default) |
| Sandbox marketplace | create an account with `"marketplace": "mock"`; authorise with `{ "credentials": { "sellerId": "S1", "apiKey": "sandbox_x" } }` |
| Regenerate API docs | `pnpm openapi:export` → `docs/api/openapi.json` + `docs/api/ENDPOINTS.md` (commit both) |
| Walkthrough of the whole journey | [docs/stages/STAGE-2.md](../stages/STAGE-2.md) |

### Module file layout (as implemented)
```
modules/<name>/src/
  manifest.ts   generated from scripts/scaffold-modules.mjs (responsibility, owns, dependsOn, events)
  schemas.ts    zod contracts: request + response (they ARE the OpenAPI)
  service.ts    use-cases on a transaction (Tx); tenant-scoped queries; no HTTP
  routes.ts     Fastify plugin: access policy + schema + 3-5 lines per handler
  index.ts      public surface (other modules import only from here)
```
Helpers you will use in routes (`@oms/module-kit`): `vendorTx(req, (tx, vendorId) => …)`, `scopedTx`, `systemTx` (pre-auth flows only), `requireVendor`, `audit(tx, req, …)`, `emit(tx, req, …)`, `assertEmailVerified`, `strictRateLimit`, `ok / created / paginated`.
Helpers for lists (`@oms/database`): `keyset({ sorts, idColumn, sort, cursor, limit, defaultSort })`, `escapeLike`, `tenantWhere`.

### Writing tests against the real stack
```ts
const t = await buildTestApp({ database: true });      // all modules, PGlite + real migrations + RLS, memory storage, memory mailer, fake queues
const c = clientFor(t);
const admin = await c.registerVendor();                // register -> verify (from captured mail) -> login
const staff = await c.addMember(admin, 'vendor_staff');// invite -> accept -> login
await c.post('/api/v1/products', { … }, staff);
await t.runJobs();                                     // run queued background jobs through the real handlers
```
