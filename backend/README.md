# OMS Platform: multi-vendor commerce backend

Independent multi-vendor commerce operating system. Many vendors connect their own marketplace accounts (Amazon India, Flipkart, Myntra, Snapdeal; more later) and manage products, inventory, orders, fulfilment and more from **one source of truth per vendor**.

**Status: Stage 2 done.** Foundation (Stage 1) + the first business domains: vendor registration, auth/sessions, RBAC, staff invitations, catalogue (products, SKUs, attributes, categories, images/documents, bulk + CSV import/export), marketplace accounts with encrypted credentials, the connector framework (capability matrix, token rotation, retries, health) and a full sandbox marketplace. Orders/inventory/listings are next. See [docs/stages/STAGE-2.md](docs/stages/STAGE-2.md).

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm infra:up && pnpm db:migrate && pnpm db:seed     # postgres, redis, minio
pnpm dev                                              # api :3000 + workers
```

Swagger UI → http://localhost:3000/docs · Spec → `/docs/openapi` · Health → `/health/ready`

No Docker? `pnpm test` still runs the whole suite (~230 tests, ~30 s) including the real migrations on an in-process Postgres.

## Layout

```
apps/            api · worker · webhook-worker · scheduler       (deployable processes)
packages/        shared · config · logging · observability · database · auth · contracts ·
                 messaging · storage · marketplace-core · module-kit · runtime · testing
modules/         28 domain modules (@oms/mod-*) + registry       (vendors, catalog, orders, inventory, …)
integrations/    marketplace connectors (amazon-in, flipkart, myntra, snapdeal) + registry
infrastructure/  Dockerfile · postgres bootstrap · observability · k8s base
docs/            architecture · api · database · security · integrations · development · deployment · testing · adr
tests/           unit · integration · api · database · contract · connector · e2e
scripts/         scaffold-modules · check-modules · export-openapi · tsup-app
```

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture/ARCHITECTURE.md) | principles, stack, diagrams, layers, events, scaling, **microservice extraction map** |
| [Domain modules](docs/architecture/MODULES.md) | responsibility, owned data, APIs, dependencies, events for all 28 modules |
| [Multi-tenancy](docs/architecture/MULTI_TENANCY.md) | tenant context, RBAC scopes, RLS, composite FKs |
| [Database](docs/database/DATABASE.md) | conventions, tables, indexes, scaling |
| [API](docs/api/API.md) · [endpoint catalogue](docs/api/ENDPOINTS.md) · [openapi.json](docs/api/openapi.json) | REST conventions, errors, pagination, idempotency, Swagger enforcement |
| [Security](docs/security/SECURITY.md) | auth, encryption, rate limiting, threat model |
| [Observability](docs/architecture/OBSERVABILITY.md) | logs, metrics, health, tracing |
| [Connectors](docs/integrations/CONNECTORS.md) | capability-based marketplace contract |
| [Development](docs/development/DEVELOPMENT.md) · [Testing](docs/testing/TESTING.md) · [Deployment](docs/deployment/DEPLOYMENT.md) | |
| [ADRs](docs/adr/README.md) · [Stage 2 walkthrough](docs/stages/STAGE-2.md) | decisions, trade-offs, what each stage delivered |

## Guarantees enforced by the codebase (not by convention)

- **No undocumented or unprotected route can exist**: the API refuses to boot without `config.access` + Swagger metadata; `docs/api/openapi.json` is contract-tested.
- **Tenant isolation**: tenant from the verified token only → repository filters → Postgres RLS (fail-closed) → composite `(vendor_id, id)` foreign keys.
- **Module boundaries**: acyclic declared dependency graph checked in CI (`pnpm check:modules`).
- **Marketplace credentials** are AES-256-GCM encrypted, AAD-bound, and have no path into any API response or log.
- **Replay-safe async**: transactional outbox, idempotent queues/webhooks/HTTP (`Idempotency-Key`).
