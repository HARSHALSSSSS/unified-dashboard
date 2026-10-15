# Security foundation

## Summary matrix

| Area | Implementation | Where |
|---|---|---|
| Password hashing | **argon2id** (m=19 MiB, t=2, p=1 OWASP baseline), constant-time "unknown user" path (`verifyDummy`) | `@oms/auth/password` |
| Access tokens | JWT **HS256**, 15 min, `iss`/`aud`/`exp`/`jti`, **algorithm pinned** (no `none`/confusion); claims: `sub`, `vid`, `utp`, `rol`, `sid` | `@oms/auth/tokens` |
| Refresh tokens | Opaque 256-bit random, stored **sha256-hashed**, **rotated on every use**, grouped by `family_id`; reuse of a rotated token revokes the whole family; 30-day TTL; purge job | `refresh_tokens`, `@oms/auth` |
| Sessions | `sid` = refresh family; logout / "revoke all" = revoke family; password change revokes all families | Identity module (Stage 2) |
| Authorisation | RBAC: permission catalogue `resource:action`; system roles (owner/admin/staff/viewer, platform admin/support); **deny-by-default** per route | `@oms/auth/rbac`, `plugins/access.ts` |
| Tenant isolation | scope from token only + repository filters + **Postgres RLS (fail-closed)** + composite FKs | [MULTI_TENANCY](../architecture/MULTI_TENANCY.md) |
| Rate limiting | Global per-IP (Redis, shared across replicas, fails open) applied **before** authentication so token/credential guessing is throttled; a stricter per-route limiter (`AUTH_RATE_LIMIT_MAX`, via `app.rateLimit()`) is attached to login/refresh by the Identity module in Stage 2 | `plugins/security.ts` |
| CORS | explicit origin allow-list, no credentials | `plugins/security.ts` |
| Input validation | zod on body/query/params/headers; response schemas also filter output | everywhere |
| SQL injection | Drizzle parameterises all values; raw `sql` only with bound params; no string-built SQL in app code | `@oms/database` |
| Secure headers | `@fastify/helmet` (HSTS in prod, nosniff, frameguard, referrer-policy, CORP/COOP); strict CSP (relaxed only when Swagger UI is on) | `plugins/security.ts` |
| Secrets management | Env validated at boot; **no secrets in git**; prod via secret manager → env; `.env*` git-ignored | `@oms/config`, `.env.example` |
| Encryption at rest (app level) | **AES-256-GCM** `SecretBox`: random 96-bit nonce, key id in envelope (rotation: first key encrypts, all keys decrypt), **AAD binds ciphertext to its row/tenant** | `@oms/auth/crypto` |
| Webhook verification | HMAC-SHA256 over the **raw body**, constant-time compare, timestamp tolerance (replay protection); per-connector scheme calls this | `@oms/auth/signature` |
| Audit logging | Append-only `audit_logs` (DB trigger + revoked privileges); records actor, tenant, request id, redacted before/after | `audit_logs`, Audit module |
| Log hygiene | pino redaction of `authorization`, cookies, passwords, tokens, secrets, credentials | `@oms/logging` |
| Error hygiene | 5xx bodies are generic; stack traces only in logs/error tracker | `plugins/errors.ts` |

## Marketplace credentials never reach clients

1. Stored only in `marketplace_authorizations.credentials_ciphertext` (AES-GCM, AAD `marketplace_authorizations:<vendor>:<id>`).
2. **No API response schema contains credential fields** (responses are zod-serialised: unknown fields are dropped). The repository for authorizations never selects ciphertext unless the connector host asks for it.
3. Decrypted only inside worker/connector-host code for the duration of one call, handed to the connector as `ConnectorContext.credentials`; never logged (redaction covers `credentials`, `client_secret`, tokens).
4. Refreshed tokens come back through `onCredentialsRefreshed` and are re-encrypted by the host (lazy key rotation via `SecretBox.needsRotation`).
5. Platform-level OAuth *app* secrets (one set per marketplace) are env/secret-manager values, not DB or code.

## Token flow

```
login      POST /api/v1/auth/login  (rate limited, constant-time failure) → { accessToken(15m), refreshToken }
request    Authorization: Bearer <access>  → verify → permissions from role keys (cached ≤ 60 s) → vendor status (cached ≤ 30 s)
refresh    POST /api/v1/auth/refresh { refreshToken } → hash lookup → mark used → issue new pair (same family)
           token already used/revoked → revoke whole family (theft signal) → 401
logout     revoke family
```
Why HS256 now: single trust domain (only this backend verifies tokens), simplest correct choice. Move to **EdDSA/RS256 with JWKS** when other services (extracted modules, gateways) need to verify tokens without holding the signing secret; `signAccessToken/verifyAccessToken` are the only touchpoints. Permission/vendor-status caches mean role changes and suspensions apply within ≤ 60 s without token revocation lists.

## Admin, vendor and staff access rules

- **Vendor users**: scope = their vendor; permissions = union of their roles' permissions; vendor must be `active`.
- **Platform admin/support**: cross-tenant scope; support is read-only + `platform:impersonate`; acting inside a vendor requires the explicit `X-Act-As-Vendor` header, is logged, and (Stage 2) is written to `audit_logs` with `on_behalf_of_vendor_id`.
- Vendor roles can never contain `platform:*` permissions (tested). Platform endpoints live under `/api/v1/admin/*` and require `platform:*` permissions.
- Last-owner protection, invitation flow and MFA arrive with the Identity module.

## Threat model highlights

| Threat | Mitigation |
|---|---|
| Cross-tenant data access (IDOR/forgotten filter) | 404 for foreign ids; repo filter; RLS fail-closed; composite FKs |
| Credential stuffing / token guessing | argon2id, per-IP limits before auth, lockout columns, constant-time paths |
| Stolen refresh token | Rotation + family revocation + hashing at rest |
| DB dump / backup leak | Marketplace secrets AES-GCM encrypted with keys outside the DB |
| Webhook spoofing/replay | HMAC on raw body, timestamp window, dedupe by event id |
| Mass assignment | zod strips unknown fields; `vendor_id` never bound from input |
| Supply chain | lockfile + `--frozen-lockfile`, pinned versions, Dependabot/audit in CI (add `pnpm audit` gate), minimal runtime image, non-root user |
| Log leakage | Redaction list + no credential objects logged |
| SSRF via marketplace URLs | Connectors only call fixed marketplace hosts from code; no user-supplied URLs fetched server-side |

## Operational checklist (before production)

- [ ] Real secrets in the secret manager; rotate `JWT_ACCESS_SECRET` and add a second `ENCRYPTION_KEYS` entry per rotation policy
- [ ] DB runtime role is `NOBYPASSRLS`, not owner; verify with `SELECT rolbypassrls FROM pg_roles WHERE rolname='oms_app'`
- [ ] `TRUST_PROXY=<hops>` (e.g. 1) behind the load balancer, never `true`; WAF + TLS 1.2+ at the edge
- [ ] `SWAGGER_ENABLED` off (or gated); `/metrics` not publicly routable (or `METRICS_TOKEN` set)
- [ ] Dependency audit + image scan in CI; SBOM generation
- [ ] Backups + PITR verified by a restore drill

## Stage 2: what is now implemented

| Concern | Implementation |
|---|---|
| Registration / login | argon2id; unknown user and wrong password are indistinguishable (same body, dummy verification for equal timing); **5 failures → 15-minute lock** (`423`), all attempts audited |
| Sessions | each login = a refresh-token family = JWT `sid`. Refresh **rotates**; presenting a used/revoked token **revokes the whole family** (theft signal, audited). Logout, logout-all, password change/reset, member disable and vendor suspension end sessions; the access directory checks `sid` on every request (revocation is immediate in-process, ≤15 s across replicas) |
| Password reset | `forgot-password` always `202` (no enumeration); single-use token, 1 h, stored hashed; reset signs out every device and clears the lock |
| E-mail verification | single-use 48 h token; required (`EMAIL_VERIFICATION_REQUIRED`) for **inviting users and connecting marketplaces** |
| Invitations | 256-bit single-use token (hashed), 7 days, role fixed at invite time, e-mail must not belong to an existing account; accepting counts as verifying the address |
| RBAC | Vendor Admin (everything in the vendor), Vendor Staff (catalogue + operations; no users, billing, vendor profile, marketplace connections, product deletion), Vendor Viewer (read-only, no users/audit/billing); Platform Admin; Platform Support (read-only + impersonate). Self role/status change is refused; a vendor always keeps at least one active admin |
| Platform staff | created only by `pnpm db:create-admin` (never via the API); tenant data needs `X-Act-As-Vendor` + `platform:impersonate`; vendor suspension needs `platform:system` (Platform Admin) |
| Marketplace credentials | accepted once on `/authorize`, **validated with the marketplace before storage**, AES-256-GCM encrypted with AAD `marketplace_authorizations:<vendor>:<account>` (a blob moved to another account/tenant cannot be decrypted), lazily re-encrypted when the active key changes, destroyed on disconnect. Account DTOs are built from an allow-list mapper; tests assert no token/secret/ciphertext appears in any response |
| OAuth redirect flow | signed (HMAC) `state` bound to vendor + account, 10-minute expiry, constant-time compare |
| Uploads | allow-listed types, size limits (images 10 MB, documents 25 MB), extension ↔ MIME check, **content sniffing** (magic bytes), file-name sanitising, tenant-prefixed storage keys, `nosniff`, attachment disposition for non-images, max 50 files per product |
| CSV | import capped (5 MB / 20 000 rows) and processed in the worker; export neutralises spreadsheet formula injection (`= + - @`) |
| Rate limiting | global per-IP limiter + a stricter per-route limiter (`AUTH_RATE_LIMIT_MAX`/min) on register, login, refresh, verification, reset, change-password, invitation acceptance |
| Audit | register/login/failed login/lockout/refresh reuse/logout/password events, user and invitation changes, vendor profile/settings/status, category/attribute/product/variant/document/bulk/import/export, marketplace connect/reconnect/disconnect/rotation/auth failure: all in the same transaction as the change |

**Known gaps (tracked):** MFA, API keys, breached-password check, SMTP delivery (log mailer only), and cross-replica instant session revocation (needs Redis pub/sub; today ≤15 s).
