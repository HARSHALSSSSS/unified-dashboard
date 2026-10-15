import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { schema } from '@oms/database';
import { IdParamSchema, IsoDate, successEnvelope } from '@oms/contracts';
import { audit, ok, systemTx, vendorTx } from '@oms/module-kit';
import { cancelSubscription, changePlan, getInvoice, getSubscription, listInvoices, listPlans, recordPayment, runInvoicing, upsertPlan, usageReport } from './service';

const Limits = z.record(z.string(), z.number().int().min(0).nullable());
const PlanSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), description: z.string().nullable(), priceMinor: z.number().int(), currency: z.string(), interval: z.string(), limits: Limits, overagePerOrderMinor: z.number().int().nullable(), features: z.array(z.string()), active: z.boolean() }).meta({ id: 'Plan' });
const SubscriptionSchema = z.object({ id: z.string(), status: z.enum(schema.SUBSCRIPTION_STATUSES), plan: PlanSchema, trialEndsAt: IsoDate.nullable(), currentPeriodStart: IsoDate, currentPeriodEnd: IsoDate, cancelAtPeriodEnd: z.boolean(), version: z.number().int() }).meta({ id: 'Subscription' });
const InvoiceSchema = z.object({
  id: z.string(), number: z.string(), status: z.enum(schema.INVOICE_STATUSES), periodStart: IsoDate, periodEnd: IsoDate, currency: z.string(), subtotalMinor: z.number().int(), taxMinor: z.number().int(), totalMinor: z.number().int(), dueAt: IsoDate.nullable(), paidAt: IsoDate.nullable(),
  lines: z.array(z.object({ description: z.string(), metric: z.string().nullable(), quantity: z.number().int(), unitMinor: z.number().int(), amountMinor: z.number().int() })),
  payments: z.array(z.object({ id: z.string(), amountMinor: z.number().int(), status: z.enum(schema.PAYMENT_STATUSES), provider: z.string(), providerRef: z.string().nullable(), failureReason: z.string().nullable(), createdAt: IsoDate })), createdAt: IsoDate,
}).meta({ id: 'Invoice' });
const TAGS = ['Billing'];

/** Billing: plans, subscription, usage vs limits, invoices (vendor) and plan / invoice administration (platform staff). */
export const billingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/billing/plans', {
    config: { access: { permission: 'billing:read' } },
    schema: { tags: TAGS, summary: 'Plans on offer', response: { 200: successEnvelope(z.array(PlanSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx) => listPlans(tx))));

  r.get('/billing/subscription', {
    config: { access: { permission: 'billing:read' } },
    schema: { tags: TAGS, summary: 'My subscription', response: { 200: successEnvelope(SubscriptionSchema.nullable()) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getSubscription(tx, vendorId))));

  r.post('/billing/subscription', {
    config: { access: { permission: 'billing:write' } },
    schema: { tags: TAGS, summary: 'Change plan', description: 'A downgrade is refused while you are over the new plan\'s limits (products, marketplace accounts, users).', body: z.object({ planCode: z.string().min(2).max(40) }), response: { 200: successEnvelope(SubscriptionSchema.nullable()) } },
  }, async (req) => ok(req, await vendorTx(req, async (tx, vendorId) => changePlan(tx, vendorId, req.ctx.principal?.actorId ?? null, req.body.planCode))));

  r.post('/billing/subscription/cancel', {
    config: { access: { permission: 'billing:write' } },
    schema: { tags: TAGS, summary: 'Cancel at the end of the current period', response: { 200: successEnvelope(SubscriptionSchema.nullable()) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => cancelSubscription(tx, vendorId, req.ctx.principal?.actorId ?? null))));

  r.get('/billing/usage', {
    config: { access: { permission: 'billing:read' } },
    schema: {
      tags: TAGS, summary: 'Usage against plan limits', description: 'Limits are always reported; they are only enforced when the platform enables `billing.enforce_limits` for your business.',
      response: { 200: successEnvelope(z.object({ plan: z.string().nullable(), periodStart: IsoDate.nullable(), periodEnd: IsoDate.nullable(), metrics: z.array(z.object({ metric: z.string(), used: z.number().int(), limit: z.number().int().nullable(), percent: z.number().int().nullable(), exceeded: z.boolean() })) })) },
    },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => usageReport(tx, vendorId))));

  r.get('/billing/invoices', {
    config: { access: { permission: 'billing:read' } },
    schema: { tags: TAGS, summary: 'My invoices', response: { 200: successEnvelope(z.array(InvoiceSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => listInvoices(tx, vendorId))));

  r.get('/billing/invoices/:id', {
    config: { access: { permission: 'billing:read' } },
    schema: { tags: TAGS, summary: 'One invoice with its lines and payments', params: IdParamSchema, response: { 200: successEnvelope(InvoiceSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => getInvoice(tx, vendorId, req.params.id))));

  // ---------------------------------------------------------------- platform staff
  r.get('/admin/billing/plans', {
    config: { access: { permission: 'platform:vendors' } },
    schema: { tags: TAGS, summary: 'All plans including retired ones (platform staff)', response: { 200: successEnvelope(z.array(PlanSchema)) } },
  }, async (req) => ok(req, await systemTx(req, (tx) => listPlans(tx, true))));

  r.put('/admin/billing/plans/:code', {
    config: { access: { permission: 'platform:system' } },
    schema: {
      tags: TAGS, summary: 'Create or change a plan (platform staff)', params: z.object({ code: z.string().regex(/^[a-z0-9_-]{2,40}$/) }),
      body: z.object({ name: z.string().min(2).max(80), description: z.string().max(300).nullish(), priceMinor: z.number().int().min(0).max(100_000_000), currency: z.string().length(3).default('INR'), limits: Limits, overagePerOrderMinor: z.number().int().min(0).nullish(), features: z.array(z.string().max(40)).max(50).default([]), active: z.boolean().default(true), sortOrder: z.number().int().default(100) }),
      response: { 200: successEnvelope(PlanSchema) },
    },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const p = await upsertPlan(tx, { code: req.params.code, ...req.body });
    await audit(tx, req, { action: 'admin.plan_upsert', resourceType: 'plan', resourceId: p.id, after: { code: p.code, priceMinor: p.priceMinor, limits: p.limits } });
    return p;
  })));

  r.post('/admin/billing/invoices/run', {
    config: { access: { permission: 'platform:system' } },
    schema: { tags: TAGS, summary: 'Invoice every subscription whose period ended (also runs hourly)', description: 'Idempotent: one invoice per vendor and period.', response: { 200: successEnvelope(z.object({ invoiced: z.number().int(), cancelled: z.number().int() })) } },
  }, async (req) => ok(req, await runInvoicing(req.server.container)));

  r.post('/admin/billing/invoices/:id/payments', {
    config: { access: { permission: 'platform:system' } },
    schema: { tags: TAGS, summary: 'Record a payment outcome for an invoice (platform staff / payment provider callback)', description: 'Idempotent per `providerRef`. A failed payment marks the subscription past_due and raises `billing.payment_failed`.', params: IdParamSchema, body: z.object({ status: z.enum(['succeeded', 'failed']), provider: z.string().max(40).default('manual'), providerRef: z.string().max(120).nullish(), failureReason: z.string().max(300).nullish() }), response: { 200: successEnvelope(InvoiceSchema) } },
  }, async (req) => ok(req, await systemTx(req, async (tx) => {
    const inv = await recordPayment(tx, req.params.id, req.body);
    await audit(tx, req, { action: 'admin.invoice_payment', resourceType: 'invoice', resourceId: req.params.id, after: { status: req.body.status, provider: req.body.provider } });
    return inv;
  })));
};
