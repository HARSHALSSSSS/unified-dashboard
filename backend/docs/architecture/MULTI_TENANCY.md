# Multi-tenancy

**Model:** `Vendor (organization) → Users → business data`. The vendor is the tenant. Every tenant-owned row carries `vendor_id`.

## Principals and scopes

| Principal | `userType` | Token `vid` | Effective scope | Access |
|---|---|---|---|---|
| Vendor owner/admin/staff/viewer | `vendor` | their vendor | `vendor(vendorId)` | Only their own vendor's data, limited by role permissions |
| Platform admin / support | `platform` | null | `platform` (cross-tenant) | Cross-tenant read/write per permission; **every cross-tenant access is logged** (`platform.cross_tenant_access`) and audited once the Audit module lands |
| Platform staff acting inside a vendor | `platform` + header `X-Act-As-Vendor` + `platform:impersonate` | null | `vendor(that vendor)` | Behaves exactly like a vendor user of that tenant (support access) |
| Workers / scheduler | system | n/a | `system` | Internal only; never derivable from HTTP input |
| API keys (future) | `api_key` | their vendor | `vendor` | Same rules as vendor users |

`resolveScope(principal)` (`@oms/shared`) is the only function that turns a principal into a scope. A vendor user can never become platform scope, and `actingAsVendorId` is ignored for non-platform users (unit tested).

## Tenant context flow

```
Authorization: Bearer <JWT>
   │  accessPlugin (onRequest, every request, deny-by-default)
   ├─ verify signature/iss/aud/exp, pinned alg
   ├─ resolve permissions from role keys (cached directory)
   ├─ vendor users: vendor status must be ACTIVE (suspension is immediate)
   ├─ platform + X-Act-As-Vendor: require platform:impersonate, vendor must exist
   ├─ request.ctx = { principal, scope }          <- the ONLY source of tenant id
   └─ route.config.access: public | authenticated | { permission }  (RBAC check)
        │
        ▼  service layer:  scope = requireScope(req)
        ▼  repository:     tenantWhere(table, scope, ...)  / requireVendorId(scope) for INSERT
        ▼  database:       withScope(db, scope, tx => ...)
                              └─ SET LOCAL app.scope / app.vendor_id  → Postgres RLS policies
```

Tenant ids in request bodies, query strings, path params and custom headers are **never trusted** (there is a test sending `?vendorId=` and `X-Vendor-Id` attempting to hijack scope).

## Three independent enforcement layers

1. **Service/scope layer.** Handlers obtain the scope from `req.ctx` only. Cross-tenant operations require platform permissions.
2. **Repository layer.** `tenantWhere()` adds `vendor_id = $scope` for vendor scope; `requireVendorId()` forces the INSERT value from the trusted scope. Soft-delete filters via `notDeleted()`.
3. **PostgreSQL RLS (defence in depth).** Every table with `vendor_id` has `ENABLE` + `FORCE ROW LEVEL SECURITY` and policy:
   `USING/WITH CHECK (vendor_id = app_vendor_id() OR app_scope() IN ('platform','system'))`.
   - **Fails closed:** no scope set (a forgotten `withScope`) → zero rows visible, writes rejected.
   - `set_config(..., true)` is **transaction-local**, so pooled connections can never leak one request's tenant into the next.
   - The runtime DB role is **not the owner and not superuser** (`oms_app`), otherwise RLS would be bypassed. Migrations use a separate owner role.
   - Verified against real migrations in `tests/database/migrations-rls.test.ts`: isolation, fail-closed, WITH CHECK on cross-tenant writes, silent 0-row update/delete, platform/system cross-tenant, system roles readable-not-writable.

## Schema-level tenant integrity

Child tables reference parents with **composite** foreign keys `(vendor_id, parent_id) → parent(vendor_id, id)` (parents expose `UNIQUE (vendor_id, id)`). A listing for vendor A therefore cannot point at vendor B's variant, even through a bug or manual SQL; the database rejects it (tested).

Other tenant-safe conventions: SKUs/product codes/warehouse codes are unique **per vendor**; storage keys are prefixed `vendors/<vendorId>/` and `assertKeyBelongsToVendor()` guards signing; queue job envelopes carry `vendorId` so every background job re-enters the correct scope; idempotency keys are scoped by `(vendor, route, key)`.

## Rules for module authors

- Always call `requireScope(req)`; never accept `vendorId` from clients for tenant routes.
- Tenant data access goes through `withScope`/`withVendor`; never use the bare `db` for tenant tables.
- Every new tenant table: `vendor_id` first column after `id`, `UNIQUE(vendor_id, id)` if it is referenced, composite FKs for children, an index **starting with** `vendor_id`. `tests/database/schema-conventions.test.ts` enforces these, and the RLS migration loop picks up any table with a `vendor_id` column automatically (re-run the policy loop for tables added later, see DATABASE.md).
- Workers rebuild scope from `envelope.vendorId`; platform-wide jobs use `system` scope explicitly.
