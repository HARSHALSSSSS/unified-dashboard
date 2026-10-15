# Architecture Decision Records

Short, dated, immutable once accepted (supersede, don't edit). Format: Context → Decision → Consequences.

## ADR-0001 Modular monolith, service-ready (accepted)
**Context** Early stage, small team, many domains, uncertain scaling hot-spots. **Decision** One codebase/deployable family with hard module boundaries (packages + declared dependency graph + events + single-writer tables) and four process types sharing one composition root. **Consequences** Fast development and simple operations now; extraction candidates and the mechanics are documented (ARCHITECTURE §11). Risk: boundary erosion, mitigated by `check:modules`, ESLint import rules, and per-module table ownership.

## ADR-0002 Fastify + zod as the HTTP/contract stack (accepted)
**Context** Swagger is mandatory and "no undocumented APIs". **Decision** Schema-first routes: zod → validation, typing, serialisation and OpenAPI from one definition; boot-time route policy. **Consequences** Documentation cannot drift; slightly more ceremony per route (summary/tags/response). NestJS rejected: its decorator-driven structure would not give stronger boundaries than packages + manifests and adds runtime overhead.

## ADR-0003 Drizzle ORM over Prisma/TypeORM (accepted)
**Decision** Drizzle with SQL migrations. **Why** Composite FKs, partial/expression indexes, check constraints and hand-written RLS/trigger migrations are first-class; typed SQL-like queries; no engine binary; plain-SQL migrations are reviewable; works naturally with transaction-scoped `set_config` for RLS. **Trade-off** Fewer batteries (no automatic relation loading magic); mitigated by repositories.

## ADR-0004 PostgreSQL RLS as defence in depth (accepted)
**Decision** `vendor_id` on all tenant rows; RLS fail-closed driven by transaction-local settings; runtime role is non-owner/NOBYPASSRLS; composite FKs. **Consequences** A forgotten filter cannot leak data. Costs: every DB access goes through `withScope` (one extra `set_config` per transaction); ops must keep the role setup correct (tested/checklisted).

## ADR-0005 Transactional outbox + BullMQ (accepted)
**Decision** Events inserted with the state change, relayed to Redis queues, at-least-once, idempotent consumers. **Why** Avoids dual-write inconsistency without introducing Kafka. **Revisit** when sustained event volume or cross-service streaming needs replay/partitioning (then relay to Kafka/NATS behind the same event envelope).

## ADR-0006 HS256 access tokens + rotating opaque refresh tokens (accepted)
**Decision** Short-lived JWT, permissions resolved server-side from role keys (cached), refresh rotation with family revocation. **Revisit** → asymmetric keys + JWKS when another service must verify tokens.

## ADR-0007 Keyset pagination only (accepted)
Stable under writes, constant-time deep pages, forces indexes ending in `id`. Offsets are not offered; "total count" endpoints are opt-in and expensive.

## ADR-0008 Capability-based connector contract (accepted)
Marketplaces are not uniform. Connectors declare capabilities and limits; core checks them; connectors never access the DB. New marketplace = new package + one registry line.

## ADR-0009 Money as integer minor units (accepted)
No floating point anywhere; currency alongside; tax in basis points.

## ADR-0010 Bundle apps with tsup, external third-party deps (accepted)
Workspace packages ship TS sources and are bundled; third-party packages stay external with exact versions emitted to `dist/package.json` (native/fs-reading modules keep working; small reproducible images).

## ADR-0011 Services on a transaction; routes translate HTTP (accepted, Stage 2)
Use-cases take a `Tx` (already scoped to the tenant by `vendorTx`) and return plain data; routes only map HTTP. The same service code runs from routes and background jobs (side effects injected as `Effects`). Cross-module calls pass the same `Tx`, so they join the caller's transaction and tenant scope.

## ADR-0012 Marketplace-specific data lives outside the core model (accepted, Stage 2)
The core product/variant has no Amazon/Flipkart/Myntra/Snapdeal columns. Generic attributes (typed, category-assigned) cover vendor-defined data; marketplace-specific payloads are stored per `(product, marketplace)` in `product_marketplace_data` and validated by the connector at listing time. Readiness checks combine generic rules with connector capabilities.

## ADR-0013 Credentials: validate, then encrypt, then never return (accepted, Stage 2)
`/authorize` verifies credentials with the marketplace before storing; storage is AES-256-GCM bound to vendor+account; reads are only through `loadCredentials` inside `ConnectorHost`; API shapes are allow-list mappers. Rotation is automatic (ahead of expiry, on auth failure, and by a scheduled job) and audited.

## ADR-0014 Sandbox as a first-class connector (accepted, Stage 2)
`mock` implements the full capability set behind the normal connector contract, so every platform feature (lifecycle, retries, rotation, health, readiness) is developed and tested without marketplace approval. It is registered outside production by default and is sandbox-only.

## ADR-0015 Session validity is checked per request (accepted, Stage 2)
Short-lived JWTs alone cannot be revoked. The access hook asks the access directory whether the session (`sid` = refresh family) is still alive (15 s cache, in-process invalidation on logout). Cost: one cached lookup per session; benefit: logout, password reset, member disable and theft detection take effect immediately.
