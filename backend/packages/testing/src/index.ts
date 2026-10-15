import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, DbAccessDirectory, DbIdempotencyStore, InMemoryIdempotencyStore, StaticAccessDirectory } from '@oms/api';
import { parseConfig, type AppConfig } from '@oms/config';
import { createLogger } from '@oms/logging';
import { createMetrics, HealthRegistry, type ErrorTracker } from '@oms/observability';
import { signAccessToken, SYSTEM_ROLES } from '@oms/auth';
import { amazonControl, createConnectorRegistry, flipkartControl, mockControl, myntraControl, snapdealControl } from '@oms/connectors';
import { MemoryMailer, type Container, type ModuleDefinition } from '@oms/module-kit';
import { allModules } from '@oms/modules-registry';
import { MemoryStorage } from '@oms/storage';
import { asc, eq, isNull, schema, seedReferenceData, withSystem, type Database, type Db } from '@oms/database';
import { newId } from '@oms/shared';

export { mockControl, amazonControl, flipkartControl, myntraControl, snapdealControl, MemoryMailer, MemoryStorage };

/** Deterministic test configuration. Secrets here are test-only constants. */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://oms_app:oms_app@localhost:5432/oms_test',
  JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-0123456789',
  ENCRYPTION_KEYS: `test:${Buffer.alloc(32, 7).toString('base64')}`,
  SWAGGER_ENABLED: 'true',
  RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
  STORAGE_DRIVER: 'memory',
  // fast, deterministic retries: no real sleeping in tests
  CONNECTOR_RETRY_BASE_MS: '1',
  CONNECTOR_RETRY_MAX_MS: '2',
  CONNECTOR_RETRY_AFTER_CAP_MS: '2',
  SYNC_BACKOFF_BASE_MS: '0',
  SYNC_BACKOFF_MAX_MS: '0',
};

/** overrides that make NODE_ENV=production pass the production readiness checks (for tests that need a production-mode app) */
export const PROD_SAFE_ENV: Record<string, string> = {
  NODE_ENV: 'production', JWT_ACCESS_SECRET: 'Zk3v9qLw1XrT7mNc4HbY8dFs2PjA6eUo0GiKt5RxVnWyQz1B', ENCRYPTION_KEYS: `k2025:${Buffer.alloc(32, 7).toString('base64')}`, METRICS_TOKEN: 'metrics-token-0123456789',
  CORS_ORIGINS: 'https://app.example.com', DATABASE_URL: 'postgres://oms_app:pw@db.example.com:5432/oms', DATABASE_SSL: 'true', STORAGE_DRIVER: 's3', TRUST_PROXY: '1',
  APP_WEB_URL: 'https://app.example.com', PUBLIC_BASE_URL: 'https://api.example.com', PUBLIC_API_URL: 'https://api.example.com', AUTH_RATE_LIMIT_MAX: '10', EMAIL_VERIFICATION_REQUIRED: 'true',
};

export const testConfig = (overrides: Record<string, string> = {}): AppConfig => parseConfig({ ...TEST_ENV, ...overrides });

export const ROLE_PERMISSIONS: Record<string, string[]> = Object.fromEntries(Object.entries(SYSTEM_ROLES).map(([k, v]) => [k, v.permissions]));

// ------------------------------------------------------------------------------------------------
// in-process Postgres (PGlite) with the REAL migrations, seeded reference data and the non-owner runtime role
// ------------------------------------------------------------------------------------------------
const MIGRATIONS = fileURLToPath(new URL('../../database/migrations', import.meta.url));
let template: Promise<Blob | File | null> | undefined;

async function migrate(pg: PGlite): Promise<void> {
  await pg.exec('CREATE ROLE oms_app NOLOGIN');
  const journal = JSON.parse(readFileSync(resolve(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  for (const { tag } of journal.entries) {
    for (const stmt of readFileSync(resolve(MIGRATIONS, `${tag}.sql`), 'utf8').split('--> statement-breakpoint')) if (stmt.trim()) await pg.exec(stmt);
  }
  await seedReferenceData(drizzle(pg, { schema }) as never);
}

export interface TestDatabase extends Database { pg: PGlite }

/** Fresh database per call; the migrated+seeded image is built once per process and cloned (fast). */
export async function createTestDatabase(): Promise<TestDatabase> {
  template ??= (async () => {
    const base = new PGlite({ extensions: { pg_trgm } });
    await migrate(base);
    try {
      const dump = await base.dumpDataDir('none');
      await base.close();
      return dump;
    } catch {
      await base.close();
      return null;
    }
  })();
  const dump = await template;
  let pg: PGlite;
  if (dump) pg = new PGlite({ extensions: { pg_trgm }, loadDataDir: dump });
  else { pg = new PGlite({ extensions: { pg_trgm } }); await migrate(pg); }
  await pg.waitReady;
  await pg.exec('SET ROLE oms_app'); // the application never runs as the owner: RLS applies exactly as in production
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { pg, db, pool: {} as never, ping: async () => void (await pg.query('select 1')), close: () => pg.close() };
}

// ------------------------------------------------------------------------------------------------
// queues: record jobs; tests run them on demand through the modules' real job handlers
// ------------------------------------------------------------------------------------------------
export interface RecordedJob { queue: string; name: string; envelope: { vendorId: string | null; correlationId: string; idempotencyKey?: string; data: unknown }; opts?: { delay?: number } }

class FakeQueues {
  readonly jobs: RecordedJob[] = [];
  async enqueue(queue: string, name: string, envelope: RecordedJob['envelope'], opts?: { delay?: number }) {
    // BullMQ semantics: a job id may be used once (a duplicate add is a no-op) and may not contain ':'
    if (envelope.idempotencyKey?.includes(':')) throw new Error(`BullMQ job ids cannot contain ':' (got ${envelope.idempotencyKey})`);
    if (envelope.idempotencyKey && this.jobs.some((j) => j.envelope.idempotencyKey === envelope.idempotencyKey)) return { id: envelope.idempotencyKey };
    this.jobs.push({ queue, name, envelope, opts });
    return { id: String(this.jobs.length) };
  }
  queue() { return { add: async () => ({}) }; }
  async close() { /* nothing */ }
}

// ------------------------------------------------------------------------------------------------
// test app
// ------------------------------------------------------------------------------------------------
export interface TestAppOptions {
  config?: Record<string, string>;
  modules?: ModuleDefinition[];
  /** vendorId -> status for the static directory (no-database mode) */
  vendors?: Record<string, 'pending' | 'active' | 'suspended' | 'closed'>;
  healthChecks?: Record<string, () => Promise<void>>;
  /** Use a real (in-process) PostgreSQL with all migrations, real access directory and idempotency store. All modules are loaded unless `modules` is given. */
  database?: boolean;
}

export interface TestApp {
  app: FastifyInstance;
  config: AppConfig;
  container: Container;
  mailer: MemoryMailer;
  storage: MemoryStorage;
  queues: FakeQueues;
  database: TestDatabase | null;
  vendorId: string;
  /** Mint a valid access token (no-database mode, or when you want a token without a login). */
  tokenFor(input: { userId?: string; vendorId?: string | null; roles?: string[]; userType?: 'vendor' | 'platform'; sessionId?: string }): Promise<string>;
  /** Execute recorded background jobs through the real handlers (what apps/worker does). Returns how many ran. */
  runJobs(filter?: (j: RecordedJob) => boolean): Promise<number>;
  /** Relay committed outbox events to the modules' event consumers (what apps/worker's relay + domain-events queue do). Returns how many events were delivered. */
  relayEvents(): Promise<number>;
  /** relay events + run jobs until nothing is left to do (bounded). The whole async pipeline, deterministically. */
  pump(opts?: { maxRounds?: number; filter?: (j: RecordedJob) => boolean }): Promise<{ jobs: number; events: number }>;
  /** jobs recorded but not run yet */
  pendingJobs(filter?: (j: RecordedJob) => boolean): RecordedJob[];
  /** every domain event written so far (optionally one type), oldest first */
  outbox(type?: string): Promise<Array<{ id: string; type: string; vendorId: string | null; aggregateType: string; aggregateId: string; payload: any }>>;
  close(): Promise<void>;
}

/** Full HTTP stack. Without `database`, in-memory ports only (fast); with it, the real data layer on PGlite. */
export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  const config = testConfig(opts.config);
  const logger = createLogger({ level: 'silent', service: 'test' });
  const health = new HealthRegistry();
  for (const [name, fn] of Object.entries(opts.healthChecks ?? {})) health.register(name, fn);
  const vendorId = newId();
  const noopTracker: ErrorTracker = { captureException: () => undefined };
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const queues = new FakeQueues();
  const database = opts.database ? await createTestDatabase() : null;
  const modules = opts.modules ?? (opts.database ? allModules : []);

  const container = {
    config, logger, mailer, storage,
    database: (database ?? {}) as Database,
    queues: queues as never,
    connectors: createConnectorRegistry({ mock: config.mockMarketplaceEnabled }),
  } satisfies Container;

  const app = await buildApp({
    container, logger,
    metrics: createMetrics('test'),
    health,
    errorTracker: noopTracker,
    access: database ? new DbAccessDirectory(database) : new StaticAccessDirectory(ROLE_PERMISSIONS, { [vendorId]: 'active', ...(opts.vendors ?? {}) }),
    idempotency: database ? new DbIdempotencyStore(database) : new InMemoryIdempotencyStore(),
    modules,
  });
  await app.ready();

  const tokenCfg = { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, secret: config.JWT_ACCESS_SECRET, accessTtlSeconds: 900 };
  const handlers = new Map(modules.flatMap((m) => m.jobs ?? []).map((h) => [`${h.queue}/${h.name}`, h]));
  const ran = new Set<RecordedJob>();
  const consumers = modules.flatMap((m) => m.consumers ?? []);

  const self: TestApp = {
    app, config, container, mailer, storage, queues, database, vendorId,
    tokenFor: async ({ userId = newId(), vendorId: vid = vendorId, roles = ['vendor_admin'], userType = 'vendor', sessionId = newId() }) =>
      (await signAccessToken(tokenCfg, { sub: userId, vid: userType === 'platform' ? null : vid, utp: userType, rol: roles, sid: sessionId })).token,
    runJobs: async (filter = () => true) => {
      let n = 0;
      for (const job of [...queues.jobs]) {
        if (ran.has(job) || !filter(job)) continue;
        ran.add(job);
        const h = handlers.get(`${job.queue}/${job.name}`);
        if (!h) throw new Error(`no handler for ${job.queue}/${job.name}`);
        await h.handle(job.envelope as never, container, { id: String(n), attemptsMade: 0 });
        n++;
      }
      return n;
    },
    relayEvents: async () => {
      if (!database) return 0;
      let delivered = 0;
      for (;;) {
        const batch = await withSystem(database.db, (tx) => tx.select().from(schema.outboxEvents).where(isNull(schema.outboxEvents.publishedAt)).orderBy(asc(schema.outboxEvents.occurredAt)).limit(100));
        if (batch.length === 0) return delivered;
        for (const e of batch) {
          await withSystem(database.db, (tx) => tx.update(schema.outboxEvents).set({ publishedAt: new Date() }).where(eq(schema.outboxEvents.id, e.id)));
          const event = { id: e.id, type: e.type, vendorId: e.vendorId, aggregateType: e.aggregateType, aggregateId: e.aggregateId, payload: e.payload, occurredAt: e.occurredAt.toISOString() };
          // production isolates consumers; tests surface the first failure so bugs are not swallowed
          for (const consumer of consumers.filter((x) => x.event === e.type || x.event === '*')) await consumer.handle(event, container);
          delivered++;
        }
      }
    },
    pendingJobs: (filter = () => true) => queues.jobs.filter((j) => !ran.has(j) && filter(j)),
    outbox: async (type) => {
      if (!database) return [];
      const rows = await withSystem(database.db, (tx) => tx.select().from(schema.outboxEvents).where(type ? eq(schema.outboxEvents.type, type) : undefined).orderBy(asc(schema.outboxEvents.occurredAt)));
      return rows.map((r) => ({ id: r.id, type: r.type, vendorId: r.vendorId, aggregateType: r.aggregateType, aggregateId: r.aggregateId, payload: r.payload }));
    },
    pump: async ({ maxRounds = 25, filter } = {}) => {
      let jobs = 0;
      let events = 0;
      for (let round = 0; round < maxRounds; round++) {
        const e = await self.relayEvents();
        const j = await self.runJobs(filter);
        events += e;
        jobs += j;
        if (e === 0 && j === 0) return { jobs, events };
      }
      throw new Error(`pump did not settle after ${maxRounds} rounds (a job or consumer keeps producing work)`);
    },
    close: async () => { await app.close(); await database?.close(); },
  };
  return self;
}

// ------------------------------------------------------------------------------------------------
// HTTP client + scenario helpers (database mode)
// ------------------------------------------------------------------------------------------------
export interface Resp<T = any> { status: number; body: T; headers: LightMyRequestResponse['headers']; raw: LightMyRequestResponse }
export type Actor = { token: string; refreshToken: string; userId: string; vendorId: string | null; email: string; password: string; sessionId: string };

export class Client {
  constructor(private readonly t: TestApp) {}

  async call<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, o: { as?: Actor | string; body?: unknown; raw?: Buffer | string; headers?: Record<string, string>; contentType?: string } = {}): Promise<Resp<T>> {
    const token = typeof o.as === 'string' ? o.as : o.as?.token;
    const res = await this.t.app.inject({
      method, url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.contentType ? { 'content-type': o.contentType } : {}), ...o.headers },
      ...(o.raw !== undefined ? { payload: o.raw } : o.body !== undefined ? { payload: o.body as object } : {}),
    });
    let body: unknown = res.body;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { /* non-JSON (csv, bytes) */ }
    return { status: res.statusCode, body: body as T, headers: res.headers, raw: res };
  }
  get = <T = any>(url: string, as?: Actor | string, headers?: Record<string, string>) => this.call<T>('GET', url, { as, headers });
  post = <T = any>(url: string, body: unknown, as?: Actor | string, headers?: Record<string, string>) => this.call<T>('POST', url, { as, body, headers });
  patch = <T = any>(url: string, body: unknown, as?: Actor | string) => this.call<T>('PATCH', url, { as, body });
  put = <T = any>(url: string, body: unknown, as?: Actor | string) => this.call<T>('PUT', url, { as, body });
  del = <T = any>(url: string, as?: Actor | string) => this.call<T>('DELETE', url, { as });

  async login(email: string, password: string): Promise<Actor> {
    const r = await this.post('/api/v1/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
    const d = r.body.data;
    return { token: d.accessToken, refreshToken: d.refreshToken, userId: d.user.id, vendorId: d.user.vendorId, email, password, sessionId: d.sessionId };
  }

  /** register -> verify e-mail (via the captured mail) -> login */
  async registerVendor(o: { businessName?: string; email?: string; password?: string; fullName?: string; verify?: boolean } = {}): Promise<Actor> {
    const n = newId().slice(-8);
    const email = o.email ?? `admin-${n}@acme.test`;
    const password = o.password ?? 'correct-horse-battery';
    const r = await this.post('/api/v1/auth/register', { businessName: o.businessName ?? `Acme ${n}`, fullName: o.fullName ?? 'Asha Admin', email, password });
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
    if (o.verify !== false) {
      const token = this.t.mailer.last('verify_email', email)!.data.token;
      const v = await this.post('/api/v1/auth/verify-email', { token });
      if (v.status !== 200) throw new Error(`verify failed: ${JSON.stringify(v.body)}`);
    }
    return this.login(email, password);
  }

  /** admin invites -> invitee accepts -> logs in */
  async addMember(admin: Actor, roleKey: 'vendor_admin' | 'vendor_staff' | 'vendor_viewer', email?: string): Promise<Actor> {
    const to = email ?? `${roleKey.replace('vendor_', '')}-${newId().slice(-8)}@acme.test`;
    const inv = await this.post('/api/v1/invitations', { email: to, roleKey }, admin);
    if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
    const token = this.t.mailer.last('invitation', to)!.data.token;
    const password = 'staff-password-123';
    const acc = await this.post('/api/v1/invitations/accept', { token, fullName: 'Team Member', password });
    if (acc.status !== 201) throw new Error(`accept failed: ${acc.status} ${JSON.stringify(acc.body)}`);
    return this.login(to, password);
  }


  /** a product with ONE variant; returns ids. Defaults make it listable (price, MRP, brand, GST, origin). */
  async makeVariant(as: Actor, o: { sku?: string; title?: string; priceMinor?: number; mrpMinor?: number; brand?: string; barcode?: string; categoryId?: string; status?: 'draft' | 'active'; description?: string } = {}) {
    const n = newId().slice(-8).toUpperCase();
    const sku = o.sku ?? `SKU-${n}`;
    const r = await this.post('/api/v1/products', {
      productCode: `P-${sku}`, title: o.title ?? `Test Tee ${sku}`, brand: o.brand ?? 'Acme', description: o.description ?? 'A comfortable cotton tee', countryOfOrigin: 'IN', hsnCode: '6109', gstRateBps: 1200,
      status: o.status ?? 'active', ...(o.categoryId ? { categoryId: o.categoryId } : {}),
      variants: [{ sku, sellingPriceMinor: o.priceMinor ?? 49900, mrpMinor: o.mrpMinor ?? 59900, ...(o.barcode ? { barcode: o.barcode } : {}), optionValues: { color: 'Blue', size: 'M' } }],
    }, as);
    if (r.status !== 201) throw new Error(`makeVariant failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { productId: r.body.data.id as string, variantId: r.body.data.variants[0].id as string, sku };
  }

  async makeWarehouse(as: Actor, o: { code?: string; name?: string; priority?: number } = {}) {
    const code = o.code ?? `WH-${newId().slice(-6).toUpperCase()}`;
    const r = await this.post('/api/v1/warehouses', { code, name: o.name ?? `Warehouse ${code}`, ...(o.priority !== undefined ? { priority: o.priority } : {}) }, as);
    if (r.status !== 201) throw new Error(`makeWarehouse failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data as { id: string; code: string; isDefault: boolean };
  }

  /** puts stock on a shelf (a receive movement) */
  async stock(as: Actor, variantId: string, warehouseId: string, quantity: number) {
    const r = await this.post('/api/v1/inventory/receive', { variantId, warehouseId, quantity, reason: 'test stock' }, as);
    if (r.status !== 200) throw new Error(`stock failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  }

  async available(as: Actor, variantId: string): Promise<number> {
    return (await this.get(`/api/v1/inventory/variants/${variantId}`, as)).body.data.totals.available;
  }

  /** creates a sandbox account on a marketplace and connects it; returns the account */
  async connectAccount(as: Actor, marketplace = 'mock', o: { sellerId?: string; displayName?: string; config?: Record<string, unknown> } = {}) {
    const sellerId = o.sellerId ?? `SELLER${newId().slice(-8).toUpperCase()}`;
    const acc = await this.post('/api/v1/marketplace-accounts', { marketplace, displayName: o.displayName ?? `${marketplace} ${sellerId}`, mode: 'sandbox', ...(o.config ? { config: o.config } : {}) }, as);
    if (acc.status !== 201) throw new Error(`create account failed: ${acc.status} ${JSON.stringify(acc.body)}`);
    const credentials: Record<string, Record<string, string>> = {
      mock: { sellerId, apiKey: 'sandbox_key' },
      amazon_in: { sellerId, refreshToken: `Atzr|sandbox:${sellerId}` },
      flipkart: { appId: `fk-sandbox-${sellerId}`, appSecret: 'secret' },
      myntra: { apiKey: `myn-sandbox-${sellerId}`, apiSecret: 'secret' },
      snapdeal: { sellerId, authToken: `sd-sandbox-${sellerId}` },
    };
    const r = await this.post(`/api/v1/marketplace-accounts/${acc.body.data.id}/authorize`, { credentials: credentials[marketplace] }, as);
    if (r.status !== 200) throw new Error(`authorize failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { ...r.body.data, sellerId: r.body.data.externalAccountId as string } as { id: string; marketplace: string; externalAccountId: string; sellerId: string; status: string };
  }

  /** Inserts a platform admin directly (the only way they exist) and signs in. */
  async platformAdmin(roleKey: 'platform_admin' | 'platform_support' = 'platform_admin'): Promise<Actor> {
    const { createPlatformUser } = await import('@oms/database');
    const { hashPassword } = await import('@oms/auth');
    const email = `${roleKey}-${newId().slice(-8)}@platform.test`;
    const password = 'platform-password-123';
    await this.t.database!.pg.exec('RESET ROLE');
    await createPlatformUser(drizzle(this.t.database!.pg, { schema }) as never, { email, fullName: 'Platform Person', passwordHash: await hashPassword(password), roleKey });
    await this.t.database!.pg.exec('SET ROLE oms_app');
    return this.login(email, password);
  }
}

export const clientFor = (t: TestApp): Client => new Client(t);

/** Smallest valid image bytes for upload tests. */
export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
