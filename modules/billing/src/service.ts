import { and, desc, eq, inArray, isFeatureEnabled, schema, sql, writeAudit, writeOutboxEvent, withSystem, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import type { Container } from '@oms/module-kit';

const P = schema.plans;
const S = schema.subscriptions;
const U = schema.usageRecords;
const I = schema.invoices;
type Metric = (typeof schema.USAGE_METRICS)[number];
export type PlanRow = typeof P.$inferSelect;
export type SubscriptionRow = typeof S.$inferSelect;

export const toPlanDto = (p: PlanRow) => ({ id: p.id, code: p.code, name: p.name, description: p.description, priceMinor: p.priceMinor, currency: p.currency, interval: p.interval, limits: p.limits, overagePerOrderMinor: p.overagePerOrderMinor, features: p.features, active: p.active });
const monthStart = (d = new Date()): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
const addMonth = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()));

export async function listPlans(tx: Tx, includeInactive = false) {
  return (await tx.select().from(P).where(includeInactive ? undefined : eq(P.active, true)).orderBy(P.sortOrder, P.code)).map(toPlanDto);
}
export async function planByCode(tx: Tx, code: string): Promise<PlanRow> {
  const [p] = await tx.select().from(P).where(eq(P.code, code));
  if (!p) throw Errors.notFound('Plan', code);
  return p;
}

export async function getSubscription(tx: Tx, vendorId: string) {
  const [s] = await tx.select().from(S).where(eq(S.vendorId, vendorId));
  if (!s) return null;
  const [plan] = await tx.select().from(P).where(eq(P.id, s.planId));
  return { id: s.id, status: s.status as (typeof schema.SUBSCRIPTION_STATUSES)[number], plan: toPlanDto(plan!), trialEndsAt: s.trialEndsAt ? s.trialEndsAt.toISOString() : null, currentPeriodStart: s.currentPeriodStart.toISOString(), currentPeriodEnd: s.currentPeriodEnd.toISOString(), cancelAtPeriodEnd: s.cancelAtPeriodEnd, version: s.version };
}

/** every new vendor starts on the free plan (event consumer; idempotent) */
export async function ensureSubscription(tx: Tx, vendorId: string): Promise<void> {
  const [exists] = await tx.select({ id: S.id }).from(S).where(eq(S.vendorId, vendorId));
  if (exists) return;
  const [free] = await tx.select().from(P).where(eq(P.code, 'free'));
  if (!free) return; // no plans seeded: nothing to subscribe to
  const now = new Date();
  await tx.insert(S).values({ vendorId, planId: free.id, status: 'active', currentPeriodStart: now, currentPeriodEnd: addMonth(now) }).onConflictDoNothing();
}

// ------------------------------------------------------------------------------------------------
// usage + limits (reads the commerce tables; the commerce engine never calls billing for its own logic)
// ------------------------------------------------------------------------------------------------
export async function recordUsage(tx: Tx, vendorId: string, metric: Metric, quantity = 1, at = new Date()): Promise<void> {
  await tx.insert(U).values({ vendorId, metric, periodStart: monthStart(at), quantity }).onConflictDoUpdate({ target: [U.vendorId, U.metric, U.periodStart], set: { quantity: sql`${U.quantity} + ${quantity}` } });
}

async function currentUsage(tx: Tx, vendorId: string, metric: Metric): Promise<number> {
  switch (metric) {
    case 'orders': return (await tx.select({ q: U.quantity }).from(U).where(and(eq(U.vendorId, vendorId), eq(U.metric, 'orders'), eq(U.periodStart, monthStart()))))[0]?.q ?? 0;
    case 'products': return (await tx.execute<{ n: number }>(sql`select count(*)::int n from products where vendor_id = ${vendorId} and deleted_at is null`)).rows[0]?.n ?? 0;
    case 'marketplace_accounts': return (await tx.execute<{ n: number }>(sql`select count(*)::int n from marketplace_accounts where vendor_id = ${vendorId} and status <> 'revoked'`)).rows[0]?.n ?? 0;
    case 'users': return (await tx.execute<{ n: number }>(sql`select count(*)::int n from users where vendor_id = ${vendorId} and deleted_at is null and status <> 'disabled'`)).rows[0]?.n ?? 0;
    default: return (await tx.select({ q: U.quantity }).from(U).where(and(eq(U.vendorId, vendorId), eq(U.metric, metric), eq(U.periodStart, monthStart()))))[0]?.q ?? 0;
  }
}

export async function usageReport(tx: Tx, vendorId: string) {
  const sub = await getSubscription(tx, vendorId);
  const limits = sub?.plan.limits ?? {};
  const out = [];
  for (const metric of schema.USAGE_METRICS) {
    const used = await currentUsage(tx, vendorId, metric);
    const limit = limits[metric] ?? null;
    out.push({ metric, used, limit, percent: limit ? Math.round((used / limit) * 100) : null, exceeded: limit !== null && used > limit });
  }
  return { plan: sub?.plan.code ?? null, periodStart: sub?.currentPeriodStart ?? null, periodEnd: sub?.currentPeriodEnd ?? null, metrics: out };
}

/**
 * Called by modules BEFORE they create something a plan limits (marketplace account, product...). Reports always; REJECTS only when the
 * platform switched `billing.enforce_limits` on for this vendor (default off: limits are visible before they bite).
 */
export async function enforceLimit(tx: Tx, vendorId: string, metric: Metric, adding = 1): Promise<void> {
  if (!(await isFeatureEnabled(tx, 'billing.enforce_limits', vendorId, false))) return;
  const sub = await getSubscription(tx, vendorId);
  const limit = sub?.plan.limits[metric] ?? null;
  if (limit === null || limit === undefined) return;
  const used = await currentUsage(tx, vendorId, metric);
  if (used + adding > limit) throw new AppError('FORBIDDEN', `Your ${sub!.plan.name} plan allows ${limit} ${metric.replace('_', ' ')}; upgrade to add more`, { details: { rule: 'plan_limit', metric, limit, used } });
}

// ------------------------------------------------------------------------------------------------
// plan changes
// ------------------------------------------------------------------------------------------------
export async function changePlan(tx: Tx, vendorId: string, actorId: string | null, planCode: string) {
  const plan = await planByCode(tx, planCode);
  if (!plan.active) throw new AppError('BAD_REQUEST', 'This plan is no longer offered', { details: { plan: planCode } });
  // a downgrade must fit: refuse while the vendor is over the new plan's limits
  for (const metric of ['products', 'marketplace_accounts', 'users'] as const) {
    const limit = plan.limits[metric];
    if (limit !== null && limit !== undefined) {
      const used = await currentUsage(tx, vendorId, metric);
      if (used > limit) throw new AppError('CONFLICT', `You currently have ${used} ${metric.replace('_', ' ')}; the ${plan.name} plan allows ${limit}`, { details: { rule: 'over_plan_limit', metric, limit, used } });
    }
  }
  const [cur] = await tx.select().from(S).where(eq(S.vendorId, vendorId));
  const now = new Date();
  let sub: SubscriptionRow;
  if (cur) {
    sub = (await tx.update(S).set({ planId: plan.id, status: 'active', cancelAtPeriodEnd: false, cancelledAt: null, version: sql`${S.version} + 1` }).where(eq(S.id, cur.id)).returning())[0]!;
  } else {
    sub = (await tx.insert(S).values({ vendorId, planId: plan.id, status: 'active', currentPeriodStart: now, currentPeriodEnd: addMonth(now) }).returning())[0]!;
  }
  await writeAudit(tx, { vendorId, actorType: 'user', actorId, action: 'billing.plan_changed', resourceType: 'subscription', resourceId: sub!.id, before: { planId: cur?.planId ?? null }, after: { plan: plan.code } });
  await writeOutboxEvent(tx, { type: 'billing.subscription_changed', vendorId, aggregateType: 'subscription', aggregateId: sub!.id, payload: { plan: plan.code, status: sub!.status } });
  return getSubscription(tx, vendorId);
}

export async function cancelSubscription(tx: Tx, vendorId: string, actorId: string | null) {
  const [cur] = await tx.select().from(S).where(eq(S.vendorId, vendorId));
  if (!cur) throw Errors.notFound('Subscription');
  await tx.update(S).set({ cancelAtPeriodEnd: true, version: sql`${S.version} + 1` }).where(eq(S.id, cur.id));
  await writeAudit(tx, { vendorId, actorType: 'user', actorId, action: 'billing.cancel_requested', resourceType: 'subscription', resourceId: cur.id });
  return getSubscription(tx, vendorId);
}

// ------------------------------------------------------------------------------------------------
// invoices
// ------------------------------------------------------------------------------------------------
export const toInvoiceDto = (i: typeof I.$inferSelect, lines: Array<typeof schema.invoiceLines.$inferSelect> = [], pays: Array<typeof schema.payments.$inferSelect> = []) => ({
  id: i.id, number: i.number, status: i.status as (typeof schema.INVOICE_STATUSES)[number], periodStart: i.periodStart.toISOString(), periodEnd: i.periodEnd.toISOString(), currency: i.currency,
  subtotalMinor: i.subtotalMinor, taxMinor: i.taxMinor, totalMinor: i.totalMinor, dueAt: i.dueAt ? i.dueAt.toISOString() : null, paidAt: i.paidAt ? i.paidAt.toISOString() : null,
  lines: lines.map((l) => ({ description: l.description, metric: l.metric, quantity: l.quantity, unitMinor: l.unitMinor, amountMinor: l.amountMinor })),
  payments: pays.map((p) => ({ id: p.id, amountMinor: p.amountMinor, status: p.status as (typeof schema.PAYMENT_STATUSES)[number], provider: p.provider, providerRef: p.providerRef, failureReason: p.failureReason, createdAt: p.createdAt.toISOString() })),
  createdAt: i.createdAt.toISOString(),
});
export async function listInvoices(tx: Tx, vendorId: string) {
  return (await tx.select().from(I).where(eq(I.vendorId, vendorId)).orderBy(desc(I.periodStart)).limit(100)).map((i) => toInvoiceDto(i));
}
export async function getInvoice(tx: Tx, vendorId: string, id: string) {
  const [i] = await tx.select().from(I).where(and(eq(I.id, id), eq(I.vendorId, vendorId)));
  if (!i) throw Errors.notFound('Invoice', id);
  const lines = await tx.select().from(schema.invoiceLines).where(and(eq(schema.invoiceLines.vendorId, vendorId), eq(schema.invoiceLines.invoiceId, id)));
  const pays = await tx.select().from(schema.payments).where(and(eq(schema.payments.vendorId, vendorId), eq(schema.payments.invoiceId, id))).orderBy(schema.payments.createdAt);
  return toInvoiceDto(i, lines, pays);
}

/**
 * Invoice every subscription whose period ended: base price + overage orders above the plan. One invoice per (vendor, period)
 * (unique), so the run can be repeated. Free invoices are paid at once. Cancel-at-period-end subscriptions end here.
 */
export async function runInvoicing(c: Container, now = new Date()): Promise<{ invoiced: number; cancelled: number }> {
  const due = await withSystem(c.database.db, (tx) => tx.select().from(S).where(sql`${S.currentPeriodEnd} <= ${now} AND ${S.status} IN ('active','trialing','past_due')`).limit(500));
  let invoiced = 0;
  let cancelled = 0;
  for (const s of due) {
    await withSystem(c.database.db, async (tx) => {
      const [plan] = await tx.select().from(P).where(eq(P.id, s.planId));
      if (!plan) return;
      const [exists] = await tx.select({ id: I.id }).from(I).where(and(eq(I.vendorId, s.vendorId), eq(I.periodStart, s.currentPeriodStart)));
      if (!exists) {
        const orders = (await tx.select({ q: U.quantity }).from(U).where(and(eq(U.vendorId, s.vendorId), eq(U.metric, 'orders'), eq(U.periodStart, monthStart(s.currentPeriodStart)))))[0]?.q ?? 0;
        const included = plan.limits.orders ?? null;
        const over = included !== null && included !== undefined && plan.overagePerOrderMinor ? Math.max(0, orders - included) : 0;
        const lines = [{ description: `${plan.name} plan (${plan.interval})`, metric: null as string | null, quantity: 1, unitMinor: plan.priceMinor, amountMinor: plan.priceMinor }];
        if (over > 0) lines.push({ description: `Orders above ${included} included`, metric: 'orders', quantity: over, unitMinor: plan.overagePerOrderMinor!, amountMinor: over * plan.overagePerOrderMinor! });
        const subtotal = lines.reduce((n, l) => n + l.amountMinor, 0);
        const tax = Math.round(subtotal * 0.18); // GST on SaaS (India); a tax engine replaces this later
        const number = `INV-${s.currentPeriodStart.toISOString().slice(0, 7).replace('-', '')}-${s.vendorId.slice(0, 8).toUpperCase()}`;
        const free = subtotal + tax === 0;
        const [inv] = await tx.insert(I).values({ vendorId: s.vendorId, number, periodStart: s.currentPeriodStart, periodEnd: s.currentPeriodEnd, status: free ? 'paid' : 'open', currency: plan.currency, subtotalMinor: subtotal, taxMinor: tax, totalMinor: subtotal + tax, dueAt: new Date(now.getTime() + 14 * 86_400_000), paidAt: free ? now : null }).returning();
        await tx.insert(schema.invoiceLines).values(lines.map((l) => ({ vendorId: s.vendorId, invoiceId: inv!.id, ...l })));
        await writeOutboxEvent(tx, { type: 'billing.invoice_created', vendorId: s.vendorId, aggregateType: 'invoice', aggregateId: inv!.id, payload: { number, totalMinor: inv!.totalMinor, status: inv!.status } });
        invoiced++;
      }
      if (s.cancelAtPeriodEnd) {
        await tx.update(S).set({ status: 'cancelled', cancelledAt: now, version: sql`${S.version} + 1` }).where(eq(S.id, s.id));
        await writeOutboxEvent(tx, { type: 'billing.subscription_changed', vendorId: s.vendorId, aggregateType: 'subscription', aggregateId: s.id, payload: { plan: plan.code, status: 'cancelled' } });
        cancelled++;
      } else {
        await tx.update(S).set({ currentPeriodStart: s.currentPeriodEnd, currentPeriodEnd: addMonth(s.currentPeriodEnd), version: sql`${S.version} + 1` }).where(eq(S.id, s.id));
      }
    });
  }
  return { invoiced, cancelled };
}

/** A payment outcome (manual today; a payment provider's webhook calls the same function). Idempotent per providerRef. */
export async function recordPayment(tx: Tx, invoiceId: string, input: { status: 'succeeded' | 'failed'; provider?: string; providerRef?: string | null; failureReason?: string | null }) {
  const [inv] = await tx.select().from(I).where(eq(I.id, invoiceId));
  if (!inv) throw Errors.notFound('Invoice', invoiceId);
  if (inv.status === 'paid' || inv.status === 'void') throw new AppError('INVALID_STATE', `This invoice is ${inv.status}`, { details: { status: inv.status } });
  if (input.providerRef) {
    const [dup] = await tx.select({ id: schema.payments.id }).from(schema.payments).where(and(eq(schema.payments.invoiceId, invoiceId), eq(schema.payments.providerRef, input.providerRef)));
    if (dup) return getInvoice(tx, inv.vendorId, invoiceId);
  }
  await tx.insert(schema.payments).values({ vendorId: inv.vendorId, invoiceId, amountMinor: Math.max(1, inv.totalMinor), status: input.status, provider: input.provider ?? 'manual', providerRef: input.providerRef ?? null, failureReason: input.failureReason ?? null });
  if (input.status === 'succeeded') {
    await tx.update(I).set({ status: 'paid', paidAt: new Date() }).where(eq(I.id, invoiceId));
    await tx.update(S).set({ status: 'active' }).where(and(eq(S.vendorId, inv.vendorId), inArray(S.status, ['past_due'])));
  } else {
    await tx.update(S).set({ status: 'past_due' }).where(and(eq(S.vendorId, inv.vendorId), inArray(S.status, ['active', 'trialing'])));
    await writeOutboxEvent(tx, { type: 'billing.payment_failed', vendorId: inv.vendorId, aggregateType: 'invoice', aggregateId: invoiceId, payload: { number: inv.number, reason: input.failureReason ?? null } });
  }
  await writeAudit(tx, { vendorId: inv.vendorId, actorType: 'system', actorId: null, action: `billing.payment_${input.status}`, resourceType: 'invoice', resourceId: invoiceId, metadata: { provider: input.provider ?? 'manual' } });
  return getInvoice(tx, inv.vendorId, invoiceId);
}

export async function upsertPlan(tx: Tx, input: { code: string; name: string; description?: string | null; priceMinor: number; currency?: string; limits: Record<string, number | null>; overagePerOrderMinor?: number | null; features?: string[]; active?: boolean; sortOrder?: number }) {
  const values = { code: input.code, name: input.name, description: input.description ?? null, priceMinor: input.priceMinor, currency: input.currency ?? 'INR', limits: input.limits, overagePerOrderMinor: input.overagePerOrderMinor ?? null, features: input.features ?? [], active: input.active ?? true, sortOrder: input.sortOrder ?? 100 };
  const [row] = await tx.insert(P).values(values).onConflictDoUpdate({ target: P.code, set: values }).returning();
  return toPlanDto(row!);
}
