# Connector guide

A connector = package under `integrations/marketplace/<name>` with: client (HTTP), auth/authorization, mappers (marketplace DTO <-> normalised models), error mapper (`ConnectorError` kinds: auth, rate_limited, transient, permanent), capabilities, polling plan, webhook handler (if pushed), simulator, adapter, tests. Core never sees marketplace DTOs. Register it in `integrations/marketplace/registry`.

## Live-readiness checklist (all required before setting `readiness.live = true`)
1. Real seller/app credentials and the marketplace's official sandbox or a test seller account.
2. Replace every PROVISIONAL endpoint/field (Myntra, Snapdeal, Flipkart listings) with the confirmed contract; update `dto.ts`, `client.ts`, `mappers.ts`.
3. Run the conformance suite against the real sandbox (`config.sandbox.target = "vendor-sandbox"`).
4. Verify rate limits, pagination, status vocabularies, webhook signing, token expiry/refresh.
5. Then flip `live` to true in `capabilities.ts` and note the verification date in `readiness.notes`.
