# Backups, recovery and migrations

Targets (starting point, tune per contract): **RPO ≤ 5 minutes** (point-in-time recovery), **RTO ≤ 1 hour** for a regional database failure, ≤ 15 minutes for an application or single-AZ failure.

## What must be recoverable

| Data | Where | Why it matters |
|---|---|---|
| PostgreSQL | managed Postgres (Multi-AZ) | the single source of truth: orders, inventory ledger, audit trail, encrypted marketplace credentials |
| Object storage | S3 bucket (product images / documents) | catalogue media |
| Secrets + **encryption keys** | secret manager | `ENCRYPTION_KEYS` decrypt every marketplace credential; losing them = every vendor must reconnect |
| Redis | managed, AOF | queues and rate-limit counters only. **Not** a source of truth: everything durable is in Postgres (outbox, sync jobs, webhook events), and sweepers re-queue what Redis lost |

## Database

* **Continuous backup**: managed PITR (WAL archiving) + daily automated snapshot, retained **35 days** (production) / 7 (staging). Cross-region copy of snapshots daily.
* **Logical backup** weekly (`pg_dump -Fc` of schema + data with the owner role) to a separate account / bucket with object lock (ransomware-safe), retained 12 weeks. It also proves restorability independent of the provider.
* **Restore drill, monthly** (and after every migration that touches > 1 table): restore the latest snapshot into an isolated instance, run `pnpm db:migrate` (must be a no-op), run `GET /inventory/ledger-check` for sample vendors (`inventory_ledger_drift()` must be empty), compare row counts of `orders`, `inventory_movements`, `audit_logs` with the source at the snapshot time. Record the measured RTO.
* **Immutability of history**: `audit_logs`, `inventory_movements`, `order_status_events`, `fulfillment_events`, `shipment_tracking_events`, `return_events`, `price_history`, `rule_executions` are append-only (DB triggers + revoked privileges), so a restore never has to reconcile edited history.

### Recovery scenarios

| Scenario | Action |
|---|---|
| Bad deploy | redeploy the previous image tag (migrations are expand / contract, the old version runs on the new schema) |
| Bad migration | restore is NOT needed for additive migrations; for a destructive mistake: PITR to just before the migration into a new instance, verify, switch `DATABASE_URL` (secret) and roll the apps |
| Accidental data deletion (a vendor) | PITR into a side instance, export that vendor's rows (RLS scope `app.vendor_id`), re-insert into production inside one transaction; audit shows who did what |
| Database failure (AZ) | managed failover (≈ 1–2 min); apps reconnect (pool error handler, no restart needed) |
| Region loss | promote the cross-region replica / restore the cross-region snapshot; point DNS + `DATABASE_URL` at it; Redis is rebuilt empty; workers start; sweepers re-queue stuck jobs / webhook events / outbox rows |
| Redis loss | start an empty Redis; the outbox relay, `sync.sweep` and `webhooks.sweep` re-queue everything that was in flight (idempotent consumers) |
| Lost encryption key | restore the key from the secret manager's version history; keep **two** generations in `ENCRYPTION_KEYS` while rotating |
| Compromised credentials / suspected breach | rotate `JWT_ACCESS_SECRET` (all access tokens die in ≤ 15 min), revoke refresh tokens (`UPDATE refresh_tokens SET revoked_at = now()`), rotate `ENCRYPTION_KEYS` (first entry active; re-encryption happens on read) and ask vendors to reconnect if marketplace tokens may have leaked |

## Object storage

Versioning ON, lifecycle: non-current versions expire after 90 days, incomplete multipart uploads after 7 days. Cross-region replication to a second bucket. Objects are private; access is by short-lived signed URLs. Restore = copy the previous version / replica back (keys are `vendors/<vendorId>/...`, so a single vendor can be restored by prefix).

## Migrations strategy

* Drizzle migrations in `packages/database/migrations` (owner role, `pnpm db:migrate`), applied by the `oms-migrate` Job **before** the application rolls; if it fails the rollout stops.
* **Expand / contract only**: release N adds (nullable column, new table, new index `CONCURRENTLY` where large), release N+1 starts writing/reading it, release N+2 removes the old. Never drop or rename in the same release that stops using it.
* RLS is part of the migration (`enable_tenant_rls`, `attach_updated_at`, append-only triggers); a schema-convention test fails the build if a tenant table lacks it.
* Large backfills run as jobs (batched), not inside a migration.
* Every migration is exercised in CI on a real database (PGlite for unit CI, Postgres 16 in the integration job) from scratch AND on top of the previous release's schema.
