# Stage 3 - multi-marketplace engine

## Honesty first
All four marketplace connectors (Amazon India, Flipkart, Myntra, Snapdeal) run against **in-process simulators** (or an official sandbox URL via `config.sandbox.target = "vendor-sandbox"`). Amazon and Flipkart follow the public API docs; Myntra and Snapdeal are **provisional** (no public contract). Every connector declares `readiness.live = false` and the connector host **refuses live accounts**. Nothing here has touched a real marketplace.

## Flow
Master product -> select marketplace -> category mapping -> attribute mapping -> validate -> preview -> merchant approval (bound to a content hash) -> publish (async job) -> status tracking (poll / webhook).

Sync engine: API/event/schedule -> `sync_jobs` row (idempotent) -> queue -> worker -> connector host -> marketplace -> normalise -> DB -> `sync_logs`. Retries with exponential backoff (`retrying`), `dead_lettered` after `SYNC_MAX_ATTEMPTS`, manual retry, progress + per-item failure details, crash-recovery sweeper.

Inventory: every change = one append-only ledger movement (`inventory_movements`); `GET /inventory/ledger-check` proves stock == ledger. Orders reserve stock on import; dispatch commits it; cancel releases it; short stock is reserved partially and flagged (never oversold) and completed automatically when stock arrives.

Channel sync: `sellable = clamp(floor(available x allocation%) - buffer, 0, max)` per marketplace account/listing. Stock events mark listings dirty, one coalesced job per account pushes only what changed and records each push (`channel_stock_updates`).

Orders: unique per (vendor, marketplace, marketplace order id); normalised statuses new..returned with the marketplace word kept; timeline; outbound status sync (requested/sent/successful/failed/retrying/skipped).

Webhooks: raw-body HMAC verification with a per-account secret (shown once), idempotent persistence, ack-then-process, retry, dead-letter, replay. Marketplaces without push (Myntra, Snapdeal) are polled.

## Tests
`pnpm test` - includes connector conformance (4 connectors), webhook, sync-engine, inventory, listing, order, connection tests and the end-to-end flow across mock + 4 simulators (`tests/e2e/stage3-flow.test.ts`).
