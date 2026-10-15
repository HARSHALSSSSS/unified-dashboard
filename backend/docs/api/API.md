# API conventions

REST over HTTPS, JSON. Base path `/api/v1`. Live docs: **`/docs`** (Swagger UI) and **`/docs/openapi`** (spec JSON; `/docs/openapi.yaml`). The committed contract is [`openapi.json`](openapi.json).

## 1. Swagger / OpenAPI is mandatory (and automatic)

- The spec is **generated from the route zod schemas**. Writing a route = documenting it. There is no separate spec to maintain.
- **The process refuses to boot** if a route lacks `config.access`, `schema.summary`, `schema.tags`, or a 2xx `schema.response`, if a public route lives outside `/api/v1`, or if it names a permission that is not in the catalogue (`apps/api/src/plugins/route-policy.ts`, tested).
- Standard error responses (400/401/403/429/500 → `ErrorResponse`) and the `bearerAuth` requirement are **added automatically** from the route's `config.access`.
- Tags = module titles (from manifests) + `System` + `Identity & Access`.
- `docs/api/openapi.json` is committed; `tests/contract` fails if it differs from the code, so every API change is visible in code review. Regenerate with `pnpm openapi:export`.
- UI/spec are served in dev/staging; **off in production by default** (`SWAGGER_ENABLED=true` to override, ideally behind the gateway's auth).

### Writing a route (the whole recipe)

```ts
app.withTypeProvider<ZodTypeProvider>().get('/products', {
  config: { access: { permission: 'products:read' } },           // RBAC (required)
  schema: {
    tags: ['Product Catalog'], summary: 'List products',          // docs (required)
    querystring: PaginationQuerySchema.extend({ q: z.string().optional() }),
    response: { 200: paginatedEnvelope(ProductSchema) },          // docs + serialisation (required)
  },
}, async (req) => {
  const scope = requireScope(req);                                // tenant from the token
  const page = await productService.list(scope, req.query);
  return paginated(req, page.items, { limit: req.query.limit, nextCursor: page.nextCursor });
});
```

## 2. Authentication

`Authorization: Bearer <access token>` (JWT, 15 min). Refresh tokens are opaque and rotated. Tenant comes from the token only. Details: [SECURITY](../security/SECURITY.md). `GET /api/v1/me` returns the resolved principal and permissions.

Route access policy (`config.access`): `'public'` · `'authenticated'` · `{ permission: 'resource:action' }` · `'internal'` (hidden: metrics, docs).

## 3. Response format

Success:
```json
{ "success": true, "data": { }, "requestId": "0198…" }
```
List:
```json
{ "success": true, "data": [ ], "meta": { "limit": 25, "nextCursor": "WyIyMDI1…", "hasMore": true }, "requestId": "0198…" }
```
Error (always this shape, for every failure including 404/429/500):
```json
{ "success": false,
  "error": { "code": "VALIDATION_FAILED", "message": "Request validation failed",
             "details": { "location": "body", "issues": [{ "path": "name", "message": "…" }] } },
  "requestId": "0198…" }
```
`requestId` equals the `X-Request-Id` response header and appears in every log line for that request. `X-Correlation-Id` is echoed/generated and follows the flow into async jobs.

## 4. Status codes and error codes

| HTTP | `error.code` | When |
|---|---|---|
| 200 / 201 / 202 / 204 | | OK / created (`Location` header) / accepted for async work / no content |
| 400 | `VALIDATION_FAILED`, `BAD_REQUEST` | Schema violations; malformed JSON/cursor |
| 401 | `UNAUTHENTICATED`, `TOKEN_INVALID`, `TOKEN_EXPIRED` | Missing/invalid/expired token |
| 403 | `FORBIDDEN`, `TENANT_SUSPENDED` | Missing permission (details name it); suspended vendor |
| 404 | `NOT_FOUND` | Unknown route **or** resource not visible to the caller's tenant (never 403, to avoid confirming other tenants' ids) |
| 409 | `CONFLICT`, `VERSION_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS` | State/uniqueness/optimistic-lock conflicts |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same idempotency key, different request |
| 429 | `RATE_LIMITED` | Includes `Retry-After` |
| 500 / 502 / 503 | `INTERNAL`, `UPSTREAM_ERROR`, `SERVICE_UNAVAILABLE` | 5xx messages are generic; internals are only in logs |

Codes are part of the contract: never rename; add new ones in `@oms/shared` (`ErrorCodes`).

## 5. Pagination, filtering, sorting, search

- **Keyset pagination**: `?limit=25&cursor=<opaque>` (limit 1–100, default 25). Response `meta.nextCursor` is `null` on the last page. Chosen over offsets: O(log n) deep pages, stable under concurrent writes.
- **Sorting**: `?sort=-createdAt,name` (leading `-` = desc). Each resource whitelists sortable fields (`sortQuery([...])`); unknown fields → 400.
- **Filtering**: flat `filter[field]=value`, comma list = IN (`filter[status]=active,paused`), ranges `filter[createdAt][gte]=…`. Each resource whitelists filterable fields in its own querystring schema.
- **Search**: `?q=` free text (Postgres trigram/FTS; per-resource documented).
- Field naming in JSON: `camelCase`. Timestamps ISO-8601 UTC. Money as integer minor units + `currency`. Ids are UUID strings.

## 6. Idempotency

POST endpoints that create resources or trigger side effects declare `config: { idempotent: true }` and require `Idempotency-Key` (8–128 chars, client-generated UUID recommended).
- Same key + same request → original response replayed with `Idempotency-Replayed: true`.
- Same key + different request → `422 IDEMPOTENCY_KEY_REUSED`; still running → `409`.
- 5xx responses are not stored (safe to retry). Keys are scoped by vendor + route and kept 24 h.
- Inbound marketplace webhooks use the marketplace event id as idempotency key instead (Webhooks module).

## 7. Versioning and compatibility

- URL major version: `/api/v1`. **Additive** changes (new optional fields, endpoints, enum values clients must tolerate) stay in v1. **Breaking** changes (remove/rename fields, tighten validation, change semantics) ship as `/api/v2` with v1 supported for ≥ 6 months and `Deprecation`/`Sunset` headers.
- Clients must ignore unknown response fields.
- The OpenAPI diff in the PR is the review artefact.

## 8. Other platform behaviours

- **Validation**: zod, at the edge, for body/query/params/headers; unknown fields are stripped, not trusted.
- **Rate limiting**: per IP, global baseline (`RATE_LIMIT_MAX` / window), Redis-backed, fails open if Redis is down; stricter limiter on auth routes.
- **CORS**: explicit allow-list (`CORS_ORIGINS`), no credentials/cookies.
- **Body limit**: 1 MiB (uploads go straight to object storage via pre-signed URLs).
- **System endpoints** (outside `/api/v1`): `GET /health`, `GET /health/live`, `GET /health/ready`; `/metrics` (hidden, optional bearer token).

## 9. Stage 2 additions

**Endpoint catalogue:** [ENDPOINTS.md](ENDPOINTS.md) (generated, 101 operations, grouped by Swagger tag with the permission each needs).

- **Filtering** uses literal bracket query keys, e.g. `GET /products?filter[status]=active&filter[categoryId]=…&sort=-createdAt&limit=25`. Every list documents its own filterable and sortable fields; unknown sort fields are a 400.
- **Pagination cursors are bound to the sort** they were issued for; reusing a cursor with a different `sort` is a 400. Only the first `sort` field is used (keyset pagination needs one total order); ties break on id.
- **Search** (`q`) escapes `%`/`_`: user input is always literal.
- **Partial update** = `PATCH`; only the fields sent change; `null` clears a nullable field; `version` (optional) enables optimistic locking → `409 VERSION_CONFLICT` with `details.currentVersion`.
- **Uniqueness conflicts** are `409 CONFLICT` with `details.field` (`sku`, `barcode`, `productCode`, `email`, `slug`, `code`, `externalAccountId`).
- **Bulk** endpoints answer `200` with a per-item `results[]` (partial success), not an all-or-nothing status.
- **Asynchronous work** returns `202` and a job resource (`/data-jobs/{id}`) to poll.
- **File upload is two steps**: register (`POST /products/{id}/documents`) → send bytes via the returned instruction (`strategy: "api"` → raw body to the API; `"presigned"` → PUT to storage, then `POST /documents/{id}/confirm`).
- **Error codes added:** `ACCOUNT_LOCKED` (423), `INVALID_CREDENTIALS` (401), `EMAIL_NOT_VERIFIED` (403), `CAPABILITY_UNSUPPORTED` (422), `ACCOUNT_NOT_CONNECTED` (409), `PAYLOAD_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415). `UPSTREAM_ERROR` (502) now carries `details.{marketplace,kind,code,action}` so clients can show "reconnect".
- The database being unreachable is reported as `503 SERVICE_UNAVAILABLE`, not 500.
