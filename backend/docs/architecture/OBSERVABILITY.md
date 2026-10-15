# Observability

Goal: any request, job or marketplace call can be traced from symptom to cause in minutes, per tenant, without leaking secrets.

## 1. Logs (pino, structured JSON to stdout)

- One JSON object per line; collected by the platform (CloudWatch / Loki / ELK). `LOG_PRETTY=true` only in local development.
- **Ambient context** (AsyncLocalStorage) is injected into *every* line, including from libraries and async continuations: `requestId`, `correlationId`, `vendorId`, `actorId`, and for jobs `jobId`, `queue`.
- **Request id** (`X-Request-Id`): unique per HTTP request; accepted from callers only if it matches `^[A-Za-z0-9._-]{8,128}$` (log-injection safe), otherwise a UUIDv7 is generated. Returned as a header and as `requestId` in every response body.
- **Correlation id** (`X-Correlation-Id`): constant across one business flow. HTTP request → outbox event (`correlation_id`) → queue job envelope → worker logs. Search one id to see the whole flow.
- **Redaction**: `authorization`, cookies, passwords, tokens, secrets, credentials are replaced with `[REDACTED]` (`REDACT_PATHS`).
- Levels: `error` = a bug or an outage needing attention; `warn` = degraded but handled (retries, redis down, cross-tenant platform access); `info` = lifecycle and business milestones; `debug` = development only. 4xx are `info` (client errors are not alerts).

## 2. Metrics (Prometheus)

Scrape `GET /metrics` on the API (`:3000`) and on every worker/scheduler/webhook-worker ops server (`:3100`). Protect with network policy and/or `METRICS_TOKEN`.

| Metric | Type | Labels |
|---|---|---|
| `http_request_duration_seconds` | histogram (RED: rate/errors/duration) | `method`, `route` (template, never raw URL), `status_code` |
| `http_requests_in_flight` | gauge | |
| `jobs_processed_total` | counter | `queue`, `status` |
| `job_duration_seconds` | histogram | `queue` |
| `marketplace_calls_total` | counter | `marketplace`, `operation`, `outcome` |
| `db_pool_connections` | gauge | `state` |
| default Node metrics | event loop lag, GC, memory, CPU | |

Cardinality rule: **never** label by `vendorId`, user, order or raw path. Per-tenant analysis uses logs/traces. Every series carries `service` (api/worker/…).

Starter alerts: `infrastructure/observability/alerts.yml` (5xx > 2 %, p95 > 1 s, job failure > 10 %, marketplace failure > 25 %). Add queue-depth/age alerts from BullMQ counts when Stage 3 jobs exist.

## 3. Health, readiness, liveness

| Endpoint | Meaning | Checks | Status |
|---|---|---|---|
| `GET /health` | Service identity/version | none | 200 |
| `GET /health/live` | **Liveness**: process responsive | **none (by design)**: a Redis/DB outage must not trigger restarts of every pod | 200 |
| `GET /health/ready` | **Readiness**: should receive traffic | PostgreSQL (critical), Redis (critical), object storage (non-critical, only if configured); 2 s timeout each | 200 / **503** with per-check detail |

Workers expose the same probes on `WORKER_HEALTH_PORT`. The API uses a **fail-fast Redis connection** (no offline queue, 250 ms command timeout), so a Redis outage degrades readiness and rate limiting (fails open) instead of hanging requests (verified manually against a stopped Redis).

## 4. Tracing (OpenTelemetry)

- `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (Collector, Jaeger, Tempo, Datadog…). HTTP and `pg` are auto-instrumented; `service.name = <APP_NAME>-<process>`.
- Start tracing before other imports in the entrypoint (done in `@oms/runtime`).
- Trace ↔ log linking: include the active trace id in logs via the pino mixin when a tracing backend is chosen (one-line change in `@oms/logging`); until then `correlationId` is the join key.
- Propagating trace context through BullMQ jobs: add `traceparent` to the job envelope (planned with Stage 3 sync jobs).

## 5. Error tracking

`ErrorTracker` port (`captureException(err, context)`) with a log-based default. Plug Sentry (or similar) by implementing the port once in `@oms/runtime` (`SENTRY_DSN` is already in config). Only **unexpected** errors (bugs, response-schema violations, unhandled rejections) are captured; 4xx and expected domain errors are not.

## 6. Audit logs

`audit_logs` (append-only) is the business/security trail (who did what to which resource, when, from where, request id). It is not a debug log; retention is long and legally driven. See DATABASE.md and SECURITY.md.

## 7. Local observability stack

```bash
docker compose --profile observability up -d      # Prometheus :9090, Jaeger UI :16686
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev
```

## 8. Suggested SLOs (initial)

API availability 99.9 % (readiness-based) · p95 latency < 500 ms for reads, < 1 s for writes · inventory change → marketplace push p95 < 2 min · order ingestion lag p95 < 5 min · webhook ACK p99 < 300 ms.
