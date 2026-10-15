# Stage 4: the operational layer (what happens after an order is received)

Stage 3 gets an order *into* the system and keeps stock honest. Stage 4 is everything that happens next: choose a warehouse,
pick, pack, ship, deliver, handle what goes wrong, take returns back and price / notify / audit / report on all of it.
It is built **on top of** the existing marketplace, inventory, order and connector architecture; nothing there was rewritten.

```
Marketplace Order -> Central Order -> Reserve Inventory -> Warehouse Selection -> Pick -> Pack -> Ship -> Dispatch -> Delivery
Delivered -> Return -> Receive -> Inspect -> Restock / Disposition -> Inventory Update
```
`tests/e2e/stage4-flow.test.ts` runs exactly this (plus cancellation, short pick, split, NDR/RTO) through the public API, and
asserts `GET /inventory/ledger-check` is healthy at the end of every scenario.

## Modules (new / extended)

| Module | Owns | What it does |
|---|---|---|
| `warehouses` (ext.) | locations, bins, members | Zones, bins with barcodes, warehouse staff with **roles + capabilities** (`read pick pack receive dispatch adjust manage`). A user with no membership is unrestricted (RBAC decides); once assigned they only act in *their* warehouses with *their* capabilities. |
| `inventory` (ext.) | bin_stock, inbound_* | Inbound shipments (good + damaged receiving, partial, close), bin stock (put-away / move / capacity; a **location-only** sub-ledger: `sum(bins) <= on_hand`), outbound issue, `moveReservation` (routing), `releaseReservedUnits` (short pick), return buckets. |
| `rules` | business_rules | Controlled, data-driven rule engine. Whitelisted fields / operators / actions per rule type (`pricing stock marketplace fulfillment notification`); no scripts. Rules have priority, exclusivity, active windows; `POST /rules/evaluate` is a dry run. |
| `fulfillment` | fulfillments, pick_*, packages, exceptions | Routing + the fulfillment state machine + picking + packing + exceptions. |
| `shipping` | providers, shipments, manifests, tracking, ndr | Provider-neutral shipping, labels, manifests, dispatch, tracking, NDR / RTO. |
| `returns` | return_orders, return_items | Return requests, pickup, receive, inspect, disposition, refund tracking, RTO returns. |
| `orders` (ext.) | order_cancellations | Cancellation requests (customer / seller / marketplace / system), reasons, decision, timeline; downstream work is cancelled by events. |
| `pricing` | marketplace_prices, price_history | Base price + per-account prices, scheduled sales, rule-driven prices, bulk update with dry run, history. |
| `notifications` | notifications, deliveries, preferences, devices | In-app inbox, e-mail, push-ready. |
| `reports` | – | Read-only aggregates (sales, orders, inventory, products, marketplaces, returns, fulfillment). |
| `audit` (ext.) | audit_logs | Filters by action prefix / source / actor type / request id / date + entity history. |

Module boundaries are enforced (`pnpm check:modules`: acyclic graph, public entry points only, consumed events must be published).
Cross-module reactions are **events**: `order.cancelled` is consumed by fulfillment *and* shipping; `shipment.rto_delivered` by returns;
`variant.price_changed` by pricing; domain events feed notifications. No module reaches into another's tables for writes.

## Fulfillment

**One fulfillment per (order, warehouse)** (an order that ships from two warehouses has two). The order status is *derived* from its
fulfillments (the slowest live part), never set by hand once fulfilment has started: `deriveOrderStatus` (pure, unit-tested).

```
confirmed -> picking -> picked -> packing -> packed -> ready_to_ship -> shipped -> in_transit -> delivered
exceptions: on_hold (any pre-ship step; resume returns to where it was) | cancelled (pre-ship)
            delivery_failed (NDR) -> in_transit (re-attempt) | rto_in_transit -> rto_received
```
Skipping a step is refused (`INVALID_STATE`, 409). Each change writes a timeline row, an audit record and an event in the same transaction.

### Routing (`POST /orders/{id}/fulfillment`, preview with `GET .../routing-preview`)
1. **Rules** (`fulfillment` type) may name warehouses, a strategy (`priority nearest single_warehouse balanced`), `allowSplit`, and a priority.
   An explicit request body beats the rules. No warehouse is hardcoded anywhere.
2. `planRouting` (pure): candidates = allowed active warehouses, ranked by preference → strategy → default warehouse → priority → code.
   The first that can fulfil the **whole** order wins; otherwise split (if allowed) or the best partial warehouse takes what it has and the
   rest is reported as `unallocated` (never oversold).
3. The stock **reservation follows the decision** (`moveReservation`: release at A + reserve at B, both through the ledger, atomically).
4. The result stores *why* (`routing.reasons`, `ruleIds`, ranked `candidates`).

### Picking
`POST /pick-lists` (one warehouse, one or many fulfillments) builds tasks from the bins holding the stock (walking order, unbinned last).
`scan` verifies the barcode/SKU (wrong item → 400 `wrong_item`; wrong bin → 400 `wrong_bin`). `pick` needs a scan (or an audited `override`),
supports partial picks, and takes the units out of the bin. `short` = the rest could not be found: the units leave the books (reasoned stock
adjustment), their reservation is released, the order line is flagged `short_pick`, a `pick_short` exception opens (nothing at all picked →
the fulfillment is cancelled). `flag` raises `wrong_item` / `damaged`. A short-picked unit is **never silently re-reserved** by backorder allocation.

### Packing
`POST /fulfillments/{id}/packages` (several parcels per fulfillment), barcode-verified items, weight + dimensions + box type; closing needs
a weight and every item scanned (or an audited `override`). Cancelling a package returns its units to "packable".

## Shipping (provider abstraction)
`ShippingProvider` interface: `createShipment / cancelShipment / track / requestReattempt / initiateRto` + capabilities. Shipped providers:
`manual` (self-ship; staff or an integration push tracking) and `sandbox` (courier simulator, like the marketplace simulators).
**A real courier = one adapter implementing the interface + `registerProvider()`**; no core code changes. Provider calls are made *outside*
database transactions (and a booking is cancelled if saving fails afterwards).

Shipment: `created → label_ready → manifested → dispatched → in_transit → out_for_delivery → delivered`, branches `delivery_failed`,
`rto_initiated → rto_in_transit → rto_delivered`, `cancelled`. **All** tracking sources (courier webhook, polling job, staff, simulator)
go through one `applyTracking`: events are stored once (dedupe by provider event id) and change the shipment **only if the state machine
allows it**, so late / repeated / out-of-order messages are harmless. Effects: fulfillment + order follow; dispatch consumes the reservation
and tells the marketplace with the AWB; a failed delivery opens an **NDR case** (`reattempt / rto / update_address / contact_customer`);
after `maxAttempts` (default 3, per provider config) the parcel goes RTO automatically; RTO delivery opens an RTO **return order** that is
received into the warehouse's `returned` bucket (one per shipment).

## Returns & inventory
`requested → approved → pickup_scheduled → picked_up → in_transit → received → inspecting → completed` (+ `rejected`, `cancelled`).
Quantities are bounded by what was sold and not already being returned; refund due is computed from what the customer paid; idempotent per
`marketplaceReturnId`. **Receive** puts units into the warehouse's `returned` bucket (not sellable). **Inspect** decides per unit:

| disposition | stock effect (always via the inventory ledger) |
|---|---|
| `restock` (condition must be `sellable`) | `returned → on_hand` (optionally into a bin) |
| `damaged` | `returned → damaged` |
| `dispose` / `return_to_vendor` | leaves the books |
| `quarantine` | stays in `returned`; not a final decision |

`complete` needs every received unit decided (units that never arrived need `acceptShort`); when the whole order is back the order becomes `returned`.
Refund status is tracked (`pending / processed / failed`); the money itself moves in the marketplace / payment system.

## Cancellation
`POST /orders/{id}/cancellation-requests` (initiator + machine-readable reason) → `accept` / `reject`. Accept cancels the order and releases
stock through the normal order transition; the `order.cancelled` event then cancels fulfillments (open pick tasks cancelled, picked units
back to their bin, packages voided) and shipments (booking cancelled at the provider).

## Pricing
Base price lives on the variant; **marketplace prices are per account** (`marketplace_prices`): price, MRP, sale price + window. The price
must not exceed the MRP and a sale must not exceed the regular price. A scheduler job starts / ends sales exactly once (`applied_price_minor`).
The effective price is written to the listing and a price-sync job is queued **only if the connector can take prices** (`pricing.push`); otherwise
the response says `connector_cannot_push_prices` (no faking). Bulk update (`set / percent / amount`) has a dry run and one `batchId`.
Rule-driven prices: base → markups/discounts/fixed → margin floor → rounding → MRP cap, with the steps returned. History is append-only
(`base mrp marketplace sale`, source, rule, batch, who).

## Notifications
Order alerts, low stock, failed / dead-lettered syncs, listing rejections, returns received, expired / disconnected marketplaces, warehouse
exceptions, NDR / RTO, webhook dead letters. Per user and type: channels `in_app / email / push` (defaults by severity), `notification` rules can
mute / force channels / escalate, alert storms collapse into one unread notification (`dedupeKey`). Push is **ready, not faked**: devices register;
without a push provider the delivery is recorded as `skipped` (`registerPushProvider` plugs one in).

## Audit
Every state change writes who / what / when / vendor / entity / previous + new value / source / request id (append-only, DB-enforced).
`GET /audit-logs` filters; `GET /audit-logs/entities/{type}/{id}` is the history of one entity.

## Reports
`/reports/{sales,orders,inventory,products,marketplaces,returns,fulfillment}`: window (`from`, `to`, max 366 days), tenant-scoped, money in
minor units. Plain SQL over operational tables today; a read model can sit behind the same contracts later.

## Tests
`tests/unit/stage4-domain.test.ts` (state machines, routing planner, shipping, returns, pricing maths, rules, notification catalogue),
`tests/api/stage4-operations.test.ts` (warehouse layout / inbound / bins / warehouse permissions, routing rules, state-machine refusals,
returns validations, pricing, notifications, audit, reports, **tenant isolation + RBAC**), `tests/e2e/stage4-flow.test.ts` (the full flow and
exception paths). Migrations `0006` / `0007` are covered by the existing migration / RLS / schema-convention tests.

## Honest limits
* Courier integrations: `manual` + `sandbox` only. A real courier needs its adapter and credentials (same interface).
* Marketplace-originated returns are created through the API (`source: marketplace`, idempotent per marketplace return id); polling
  marketplaces for returns is not built (the `returns` sync type is reserved).
* Push notifications: device registry + delivery bookkeeping only until a provider is configured.
* `stock` and `marketplace` rule types are evaluable (`/rules/evaluate`) but not yet enforced automatically by inventory / listings.

## Security hardening pass (review follow-up)
* Production/staging refuse unsafe config (dev secrets, open CORS, http URLs, no METRICS_TOKEN, owner DB role, TRUST_PROXY=true...).
* Impersonation (X-Act-As-Vendor) is read-only; role change ends the user's sessions; login lock counter is atomic and a locked account answers like a wrong password.
* TRUST_PROXY is a hop count / CIDR list; Idempotency-Key honoured on every authenticated mutating route and bound to the caller.
* Webhooks: non-throwing constant-time compare, unknown endpoint == bad signature (401), stuck events recovered; Retry-After capped; 403 no longer disables an account.
* DB: per-tenant AWB/device-token uniqueness, RLS on user_tokens, permission tables read-only for the app role, pool/lock timeouts, error logs scrubbed of bound values.
* Concurrency: row locks on orders/fulfillments/shipments/returns/transfers/inbound, atomic bin updates, capacity on moves, short pick shrinks bins, no double receive.
* Authorization: warehouses:admin, shipping:configure, returns:refund (admin-only); warehouse checks on shipment/NDR/resume; manual order status cannot bypass fulfillment; manual tracking cannot dispatch.
* Known remaining: webhook timestamp replay protection, SMTP mailer for production, Redis producer fail-fast, retention jobs for PII, DB-level processed-events table for consumers.
