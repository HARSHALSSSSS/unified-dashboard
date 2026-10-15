# Stage 2: first real business domains

**Goal:** a vendor can *register → create a business → log in → add staff → create products → manage SKUs → upload images → see the product → connect a marketplace account in sandbox mode*, on top of the Stage 1 foundation, without restructuring it.

Everything below is covered by automated tests that run the real HTTP stack, the real SQL migrations and Postgres row-level security (`pnpm test`, ~230 tests, no Docker needed). The journey itself is `tests/api/flow.test.ts`.

## What was built

| Area | Module(s) | Highlights |
|---|---|---|
| Identity | `identity` | register, login, refresh **rotation with reuse detection**, logout / logout-all, sessions (list/revoke), e-mail verification, forgot/reset password, change password, profile, role catalogue. argon2id, account lockout, constant-time failures, per-route rate limits, immediate session revocation. |
| Vendor / organization | `vendors` | business profile (GSTIN, PAN, address, timezone, currency), validated business settings, status lifecycle with platform-admin suspension that takes effect on the next request |
| Users & RBAC | `users` | members, role change, disable/remove (ends their sessions), **last-admin protection**, no self-escalation, invitations (7-day single-use link, resend, revoke, accept). Roles: **Vendor Admin, Vendor Staff, Vendor Viewer** (+ **Platform Admin / Support**) |
| Catalog | `catalog` | products + variants/SKU, barcode, brand, HSN/GST, weight, dimensions, tags, status; create / partial update / archive / delete; optimistic locking; search, filters, sort, keyset pagination; **bulk** create/status/delete with per-item results; **CSV import/export** as asynchronous jobs; marketplace readiness checks |
| Categories & attributes | `categories`, `attributes` | category tree (materialised path, safe move/rename), generic typed attributes (text/number/boolean/date/enum) + values + per-category assignment + typed product/variant values. **No marketplace field is in the core model**: marketplace-specific data lives in `product_marketplace_data` |
| Files | `documents` + `@oms/storage` | product images, product documents, listing documents; `ObjectStorage` port with S3/MinIO and in-memory providers; presigned **or** API upload, content sniffing, size/type limits, primary image rules, tenant-prefixed keys |
| Marketplace accounts | `marketplace-accounts` | many accounts per vendor and many vendors per marketplace; encrypted credential custody; token **metadata only** in API responses |
| Connector framework | `@oms/marketplace-core`, `marketplace-connectors` | capability matrix, `ConnectorError` taxonomy, `withRetry`, `ConnectorHost` (decrypt, proactive + reactive token rotation, rate limiting, bounded retries, health tracking), authorize / reconnect / refresh / health-check / disconnect, scheduled token maintenance |
| Sandbox | `integrations/marketplace/mock` | full in-memory marketplace: authorization (code or API key), products, listings, inventory/price push, orders, returns, shipments, webhooks, scriptable failures/429s/expiry |
| Audit | `audit` | every mutation above writes an append-only audit record in the same transaction; read API with keyset pagination |

101 documented operations in 16 Swagger sections: see [ENDPOINTS.md](../api/ENDPOINTS.md).

## Try it locally

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed      # postgres, redis, minio, schema, roles/permissions
pnpm dev:api                                           # http://localhost:3000/docs
```

With `LOG_PRETTY=true` the dev mailer prints every e-mail link (verification, reset, invitation) in the API log.
No S3? set `STORAGE_DRIVER=memory` to run without MinIO.

```bash
B=http://localhost:3000/api/v1
# 1. register (creates the business + its first admin)
curl -s $B/auth/register -H 'content-type: application/json' -d '{
  "businessName":"Acme Apparel","fullName":"Asha Rao","email":"asha@acme.test","password":"correct-horse-battery"}'
# 2. log in
TOKEN=$(curl -s $B/auth/login -H 'content-type: application/json' -d '{"email":"asha@acme.test","password":"correct-horse-battery"}' | jq -r .data.accessToken)
# 3. (optional, needed to invite/connect when EMAIL_VERIFICATION_REQUIRED=true) open the verification link from the API log, or:
#    curl -s $B/auth/verify-email -H 'content-type: application/json' -d '{"token":"<token from the mail>"}'
# 4. add staff (they receive a link; POST /invitations/accept {token, fullName, password})
curl -s $B/invitations -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"email":"priya@acme.test","roleKey":"vendor_staff"}'
# 5. product with SKUs
PID=$(curl -s $B/products -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "productCode":"ACME-TEE","title":"Acme Classic Tee","brand":"Acme","hsnCode":"6109","gstRateBps":500,
  "variants":[{"sku":"ACME-TEE-BLK-M","mrpMinor":79900,"sellingPriceMinor":59900,"optionValues":{"color":"Black","size":"M"}}]}' | jq -r .data.id)
# 6. image: register, then send the bytes
DOC=$(curl -s $B/products/$PID/documents -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"fileName":"front.jpg","mimeType":"image/jpeg","sizeBytes":12345}')
curl -s -X POST "http://localhost:3000$(echo $DOC | jq -r .data.upload.url)" -H "authorization: Bearer $TOKEN" -H 'content-type: image/jpeg' --data-binary @front.jpg
# 7. see it
curl -s "$B/products?q=classic" -H "authorization: Bearer $TOKEN" | jq
curl -s $B/products/$PID/readiness -H "authorization: Bearer $TOKEN" | jq .data
# 8. sandbox marketplace connection
AID=$(curl -s $B/marketplace-accounts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"marketplace":"mock","displayName":"Acme sandbox"}' | jq -r .data.id)
curl -s $B/marketplace-accounts/$AID/authorize -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"credentials":{"sellerId":"ACME-SANDBOX","apiKey":"sandbox_key"}}' | jq .data
curl -s "$B/marketplace-accounts/$AID/remote-products?limit=5" -H "authorization: Bearer $TOKEN" | jq '.data.items[].externalSku'
```

Platform staff are never created through the API: `PLATFORM_ADMIN_EMAIL=… PLATFORM_ADMIN_PASSWORD=… pnpm db:create-admin`.

## Design decisions worth knowing

1. **Services run on a transaction, routes only translate HTTP.** Every module has `schemas.ts` (zod = validation + serialisation + OpenAPI), `service.ts` (use-cases on a `Tx`), `routes.ts`. The same catalog service code runs from HTTP and from the import job (side effects are injected as `Effects`).
2. **Tenant comes from the token, enforced three times.** `vendorTx(req, …)` is the only way routes touch tenant data: it opens a transaction with the RLS session variables, so a forgotten `WHERE` returns nothing instead of another vendor's rows. Foreign ids are **404** (never 403).
3. **Short transactions around slow calls.** `ConnectorHost` never holds a database transaction across a marketplace HTTP call.
4. **Partial updates cannot clobber.** PATCH schemas are derived from default-free base schemas; zod defaults only apply on create (a regression test guards it).
5. **Rejections that must persist are returned, not thrown** (e.g. a rejected upload is recorded as `rejected`), because a thrown error rolls the transaction back.
6. **Marketplaces are not assumed uniform.** Capabilities gate every call (`requireCapability`), `planned` connectors refuse to run with a clear 422, and the mock exercises every code path (rotation, expiry, 429, transient and permanent failures).
7. **No secret leaves the backend.** Responses are built from an allow-list mapper; ciphertext is AES-256-GCM bound to `vendor:account`; tests assert that no token/secret appears in any account response and that stored values are ciphertext.

## Bugs the tests caught (kept as regression tests)

- subquery columns rendering as the wrong table (`variantCount` was always 0; role filter matched the wrong `id`)
- a thrown rejection rolling back the `rejected` status of a bad upload
- the per-route rate limiter silently not counting (the plugin runs one handler-style limiter per request)
- import statistics counting rows of rolled-back groups
- upstream marketplace errors hidden by the generic 5xx masking

## Not in Stage 2 (by design)

Orders, inventory, listings, pricing, webhooks processing, shipping, returns, billing, notifications delivery, SMTP/SES mailer (a log mailer + port exist), MFA, API keys, real marketplace calls. Seams for all of them are in place (events, queues, connector contract, tenant-safe tables).
