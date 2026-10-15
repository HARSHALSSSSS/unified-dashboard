import { and, desc, eq, inArray, keyset, schema, sql, withVendor, type Tx } from '@oms/database';
import { AppError, Errors } from '@oms/shared';
import { nextCounter } from '@oms/mod-inventory';
import { Work, attachPackages, getFulfillment, itemsOf, markPackagesShipped, moveFulfillment, packagesForShipment } from '@oms/mod-fulfillment';
import { getOrderRow } from '@oms/mod-orders';
import { getWarehouseRow } from '@oms/mod-warehouses';
import { effects, type Container, type OpCtx } from '@oms/module-kit';
import { DEFAULT_MAX_ATTEMPTS, IN_FLIGHT, PRE_DISPATCH, canMove, fulfillmentStatusFor, type ShipmentStatus, type TrackingStatus } from './domain';
import { getProvider, listProviders, type ShipmentRequest, type TrackingUpdate } from './providers';

const S = schema.shipments;
const SP = schema.vendorShippingProviders;
const M = schema.manifests;
const TE = schema.shipmentTrackingEvents;
const N = schema.ndrCases;
export type ShipmentRow = typeof S.$inferSelect;
export type ManifestRow = typeof M.$inferSelect;
export type NdrRow = typeof N.$inferSelect;

// ------------------------------------------------------------------------------------------------
// DTOs
// ------------------------------------------------------------------------------------------------
export const toShipmentDto = (s: ShipmentRow) => ({
  id: s.id, number: s.number, fulfillmentId: s.fulfillmentId, orderId: s.orderId, warehouseId: s.warehouseId, providerCode: s.providerCode, service: s.service, carrier: s.carrier, awb: s.awb, trackingUrl: s.trackingUrl,
  hasLabel: Boolean((s.providerData as { label?: unknown }).label), status: s.status as ShipmentStatus, costMinor: s.costMinor, codAmountMinor: s.codAmountMinor, weightGrams: s.weightGrams, manifestId: s.manifestId,
  attempts: s.attempts, isRto: s.isRto, estimatedDeliveryAt: s.estimatedDeliveryAt ? s.estimatedDeliveryAt.toISOString() : null, dispatchedAt: s.dispatchedAt ? s.dispatchedAt.toISOString() : null,
  deliveredAt: s.deliveredAt ? s.deliveredAt.toISOString() : null, rtoDeliveredAt: s.rtoDeliveredAt ? s.rtoDeliveredAt.toISOString() : null, cancelledAt: s.cancelledAt ? s.cancelledAt.toISOString() : null,
  lastTrackedAt: s.lastTrackedAt ? s.lastTrackedAt.toISOString() : null, version: s.version, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
});
export const toManifestDto = (m: ManifestRow, shipments: ShipmentRow[] = []) => ({
  id: m.id, number: m.number, warehouseId: m.warehouseId, providerCode: m.providerCode, status: m.status as (typeof schema.MANIFEST_STATUSES)[number], closedAt: m.closedAt ? m.closedAt.toISOString() : null,
  dispatchedAt: m.dispatchedAt ? m.dispatchedAt.toISOString() : null, shipmentCount: shipments.length, shipments: shipments.map((s) => ({ id: s.id, number: s.number, awb: s.awb, orderId: s.orderId, weightGrams: s.weightGrams, status: s.status as ShipmentStatus })),
  version: m.version, createdAt: m.createdAt.toISOString(),
});
export const toNdrDto = (n: NdrRow) => ({
  id: n.id, shipmentId: n.shipmentId, orderId: n.orderId, attemptNo: n.attemptNo, reasonCode: n.reasonCode, reasonText: n.reasonText, status: n.status as (typeof schema.NDR_STATUSES)[number], action: n.action as (typeof schema.NDR_ACTIONS)[number] | null,
  actionBy: n.actionBy, nextAttemptAt: n.nextAttemptAt ? n.nextAttemptAt.toISOString() : null, resolvedAt: n.resolvedAt ? n.resolvedAt.toISOString() : null, createdAt: n.createdAt.toISOString(),
});

// ------------------------------------------------------------------------------------------------
// vendor providers
// ------------------------------------------------------------------------------------------------
/** simulators are refused unless the deployment opted in (SANDBOX_COURIER_ENABLED) */
export function assertProviderAllowed(c: Container, code: string): void {
  if (getProvider(code).simulator && !c.config.sandboxCourierEnabled) throw new AppError('BAD_REQUEST', 'The sandbox courier is not available in this environment', { details: { providerCode: code } });
}
export const providerCatalog = (c: Container) => listProviders().filter((p) => !p.simulator || c.config.sandboxCourierEnabled).map((p) => ({ code: p.code, name: p.name, description: p.description, capabilities: p.capabilities, configFields: p.configFields }));
/** only the settings the provider DECLARES (configFields) are returned: nothing free-form can leak through this DTO */
const visibleConfig = (code: string, config: Record<string, unknown>): Record<string, unknown> => {
  let keys: string[] = [];
  try { keys = getProvider(code).configFields.map((f) => f.key); } catch { /* unknown provider: expose nothing */ }
  return Object.fromEntries(Object.entries(config).filter(([k]) => keys.includes(k)));
};
/** a tracking link template is rendered into UI / e-mail: https only, and it must carry the AWB */
function validateConfig(config: Record<string, unknown>): void {
  const tpl = config.trackingUrlTemplate;
  if (tpl === undefined) return;
  if (typeof tpl !== 'string' || !/^https:\/\//i.test(tpl) || !tpl.includes('{awb}')) throw new AppError('BAD_REQUEST', 'trackingUrlTemplate must be an https URL containing {awb}', { details: { rule: 'tracking_url_template' } });
}
export const toVendorProviderDto = (p: typeof SP.$inferSelect) => ({ id: p.id, providerCode: p.providerCode, label: p.label, status: p.status as 'active' | 'disabled', isDefault: p.isDefault, config: visibleConfig(p.providerCode, p.config), version: p.version, createdAt: p.createdAt.toISOString() });

export async function listVendorProviders(tx: Tx, vendorId: string) {
  return (await tx.select().from(SP).where(eq(SP.vendorId, vendorId)).orderBy(SP.createdAt)).map(toVendorProviderDto);
}
export async function enableProvider(tx: Tx, ctx: OpCtx, input: { providerCode: string; label?: string; config?: Record<string, unknown>; isDefault?: boolean }) {
  const p = getProvider(input.providerCode);
  assertProviderAllowed(ctx.c, p.code);
  validateConfig(input.config ?? {});
  const [dup] = await tx.select({ id: SP.id }).from(SP).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.providerCode, p.code)));
  if (dup) throw new AppError('CONFLICT', 'This provider is already enabled', { details: { providerId: dup.id } });
  const [any] = await tx.select({ id: SP.id }).from(SP).where(eq(SP.vendorId, ctx.vendorId)).limit(1);
  const makeDefault = input.isDefault ?? !any;
  if (makeDefault) await tx.update(SP).set({ isDefault: false }).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.isDefault, true)));
  const [row] = await tx.insert(SP).values({ vendorId: ctx.vendorId, providerCode: p.code, label: input.label ?? p.name, config: input.config ?? {}, isDefault: makeDefault }).returning();
  await effects(tx, ctx).audit({ action: 'shipping.provider_enabled', resourceType: 'shipping_provider', resourceId: row!.id, after: { providerCode: p.code, isDefault: makeDefault } });
  return toVendorProviderDto(row!);
}
export async function updateProvider(tx: Tx, ctx: OpCtx, id: string, patch: { label?: string; config?: Record<string, unknown>; status?: 'active' | 'disabled'; isDefault?: boolean }) {
  const [before] = await tx.select().from(SP).where(and(eq(SP.id, id), eq(SP.vendorId, ctx.vendorId)));
  if (!before) throw Errors.notFound('Shipping provider', id);
  if (patch.config) validateConfig(patch.config);
  const status = patch.status ?? before.status;
  if (patch.isDefault) {
    if (status === 'disabled') throw new AppError('CONFLICT', 'A disabled provider cannot be the default');
    await tx.update(SP).set({ isDefault: false }).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.isDefault, true)));
  }
  const [after] = await tx.update(SP).set({ label: patch.label ?? before.label, config: patch.config ?? before.config, status, isDefault: status === 'disabled' ? false : (patch.isDefault ?? before.isDefault), version: sql`${SP.version} + 1` }).where(eq(SP.id, id)).returning();
  await effects(tx, ctx).audit({ action: 'shipping.provider_updated', resourceType: 'shipping_provider', resourceId: id, before: { status: before.status, isDefault: before.isDefault }, after: { status: after!.status, isDefault: after!.isDefault, configKeysChanged: patch.config ? Object.keys(patch.config) : [] } }); // never the values: config may hold courier credentials
  return toVendorProviderDto(after!);
}

async function resolveProvider(tx: Tx, vendorId: string, code?: string): Promise<{ code: string; config: Record<string, unknown> }> {
  const rows = await tx.select().from(SP).where(and(eq(SP.vendorId, vendorId), eq(SP.status, 'active')));
  const row = code ? rows.find((r) => r.providerCode === code) : (rows.find((r) => r.isDefault) ?? rows[0]);
  if (code && !row) {
    if (code === 'manual') return { code, config: {} }; // manual hand-over always works, even before any provider is set up
    throw new AppError('BAD_REQUEST', `Shipping provider "${code}" is not enabled for this vendor`, { details: { enabled: rows.map((r) => r.providerCode) } });
  }
  return row ? { code: row.providerCode, config: row.config } : { code: 'manual', config: {} };
}

// ------------------------------------------------------------------------------------------------
// reads
// ------------------------------------------------------------------------------------------------
export async function getShipment(tx: Tx, vendorId: string, id: string, lock = false): Promise<ShipmentRow> {
  const q = tx.select().from(S).where(and(eq(S.id, id), eq(S.vendorId, vendorId)));
  const [s] = await (lock ? q.for('update') : q);
  if (!s) throw Errors.notFound('Shipment', id);
  return s;
}
export async function listShipments(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; warehouseId?: string; orderId?: string; providerCode?: string; awb?: string; allowedWarehouses?: string[] | null }) {
  const ks = keyset<ShipmentRow>({ sorts: { createdAt: { column: S.createdAt, kind: 'timestamp' } }, idColumn: S.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(S).where(and(eq(S.vendorId, vendorId), q.status ? eq(S.status, q.status) : undefined, q.warehouseId ? eq(S.warehouseId, q.warehouseId) : undefined, q.orderId ? eq(S.orderId, q.orderId) : undefined,
    q.providerCode ? eq(S.providerCode, q.providerCode) : undefined, q.awb ? eq(S.awb, q.awb) : undefined, q.allowedWarehouses ? (q.allowedWarehouses.length ? inArray(S.warehouseId, q.allowedWarehouses) : sql`false`) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}
export async function trackingEvents(tx: Tx, vendorId: string, shipmentId: string) {
  await getShipment(tx, vendorId, shipmentId);
  return (await tx.select().from(TE).where(and(eq(TE.vendorId, vendorId), eq(TE.shipmentId, shipmentId))).orderBy(TE.occurredAt, TE.id))
    .map((e) => ({ id: e.id, status: e.status as ShipmentStatus, rawStatus: e.rawStatus, location: e.location, note: e.note, source: e.source, occurredAt: e.occurredAt.toISOString() }));
}
export async function getLabel(tx: Tx, vendorId: string, id: string) {
  const s = await getShipment(tx, vendorId, id);
  const label = (s.providerData as { label?: { format: 'text' | 'pdf_base64'; content: string } }).label;
  if (!label) throw new AppError('NOT_FOUND', 'This shipment has no label', { details: { resource: 'label', id } });
  return { shipmentId: s.id, awb: s.awb, format: label.format, content: label.content };
}

// ------------------------------------------------------------------------------------------------
// create (3 phases: validate -> provider call OUTSIDE any transaction -> persist)
// ------------------------------------------------------------------------------------------------
export interface CreateShipmentInput { fulfillmentId: string; providerCode?: string; service?: string | null; manual?: { awb?: string; carrier?: string; trackingUrl?: string } }

export async function createShipment(ctx: OpCtx, input: CreateShipmentInput): Promise<ShipmentRow> {
  const db = ctx.c.database.db;
  const prep = await withVendor(db, ctx.vendorId, async (tx) => {
    const f = await getFulfillment(tx, ctx.vendorId, input.fulfillmentId);
    if (f.status !== 'packed') throw new AppError('INVALID_STATE', `A shipment needs a packed fulfillment (this one is ${f.status})`, { details: { status: f.status } });
    const [live] = await tx.select({ id: S.id }).from(S).where(and(eq(S.vendorId, ctx.vendorId), eq(S.fulfillmentId, f.id), sql`${S.status} <> 'cancelled'`));
    if (live) throw new AppError('CONFLICT', 'This fulfillment already has a shipment', { details: { shipmentId: live.id } });
    const pkgs = await packagesForShipment(tx, ctx.vendorId, f.id);
    if (pkgs.length === 0) throw new AppError('CONFLICT', 'There is no closed package to ship', { details: { rule: 'no_packages' } });
    const order = await getOrderRow(tx, ctx.vendorId, f.orderId);
    const wh = await getWarehouseRow(tx, ctx.vendorId, f.warehouseId);
    const provider = await resolveProvider(tx, ctx.vendorId, input.providerCode);
    const number = `SHP-${String(await nextCounter(tx, ctx.vendorId, 'shipment')).padStart(6, '0')}`;
    const ship = order.shippingAddress as Record<string, unknown>;
    const buyer = order.buyer as Record<string, unknown>;
    const req: ShipmentRequest = {
      shipmentNumber: number, orderNumber: order.orderNumber, warehouse: { code: wh.code, name: wh.name, address: wh.address },
      destination: { ...ship, name: ship.name ?? buyer.name, phone: ship.phone ?? buyer.phone },
      packages: pkgs.map((p) => ({ barcode: p.barcode, weightGrams: p.weightGrams, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm })),
      codAmountMinor: order.paymentMethod === 'cod' ? (order.codAmountMinor ?? order.totalMinor) : null, currency: order.currency.trim(), service: input.service ?? null, manual: input.manual,
    };
    return { f, order, number, provider, req, weight: pkgs.reduce((n, p) => n + (p.weightGrams ?? 0), 0) };
  });

  assertProviderAllowed(ctx.c, prep.provider.code);
  const adapter = getProvider(prep.provider.code);
  const made = await adapter.createShipment(prep.req, prep.provider.config);

  const w = new Work();
  try {
    const created = await withVendor(db, ctx.vendorId, async (tx) => {
      const f = await getFulfillment(tx, ctx.vendorId, input.fulfillmentId);
      if (f.status !== 'packed') throw new AppError('INVALID_STATE', `The fulfillment changed while the label was being created (${f.status})`, { details: { status: f.status } });
      const [dupAwb] = await tx.select({ id: S.id }).from(S).where(and(eq(S.providerCode, prep.provider.code), eq(S.awb, made.awb)));
      if (dupAwb) throw new AppError('CONFLICT', 'This AWB is already used by another shipment', { details: { awb: made.awb } });
      const [row] = await tx.insert(S).values({
        vendorId: ctx.vendorId, number: prep.number, fulfillmentId: f.id, orderId: f.orderId, warehouseId: f.warehouseId, providerCode: prep.provider.code, service: input.service ?? null, carrier: made.carrier, awb: made.awb, trackingUrl: made.trackingUrl,
        status: 'label_ready', costMinor: made.costMinor, codAmountMinor: prep.req.codAmountMinor, weightGrams: prep.weight || null, estimatedDeliveryAt: made.estimatedDeliveryAt, providerData: { ...made.providerData, label: made.label },
      }).returning();
      await attachPackages(tx, ctx.vendorId, f.id, row!.id);
      await tx.insert(TE).values({ vendorId: ctx.vendorId, shipmentId: row!.id, status: 'label_ready', providerEventId: 'label-created', source: 'system', occurredAt: new Date(), note: 'label created' });
      await moveFulfillment(tx, ctx, w, f.id, 'ready_to_ship', { note: `shipment ${prep.number}` });
      const fx = effects(tx, ctx);
      await fx.event({ type: 'shipment.created', aggregateType: 'shipment', aggregateId: row!.id, payload: { number: prep.number, orderId: f.orderId, orderNumber: prep.order.orderNumber, awb: made.awb, providerCode: prep.provider.code } });
      await fx.audit({ action: 'shipment.created', resourceType: 'shipment', resourceId: row!.id, after: { number: prep.number, awb: made.awb, providerCode: prep.provider.code, fulfillmentId: f.id } });
      return row!;
    });
    await w.flush(ctx.c); // marketplace pushes only once the data is committed
    return created;
  } catch (e) {
    await adapter.cancelShipment(made.awb, prep.provider.config).catch(() => undefined); // do not leave an orphan booking at the courier
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------
// cancel (before dispatch)
// ------------------------------------------------------------------------------------------------
export async function cancelShipment(ctx: OpCtx, id: string, reason?: string | null): Promise<ShipmentRow> {
  const db = ctx.c.database.db;
  const s0 = await withVendor(db, ctx.vendorId, (tx) => getShipment(tx, ctx.vendorId, id));
  if (!(PRE_DISPATCH as readonly string[]).includes(s0.status)) throw new AppError('INVALID_STATE', `A ${s0.status} shipment can no longer be cancelled`, { details: { status: s0.status } });
  const cfg = await withVendor(db, ctx.vendorId, async (tx) => (await resolveProvider(tx, ctx.vendorId, s0.providerCode).catch(() => ({ code: s0.providerCode, config: {} as Record<string, unknown> }))).config);
  if (s0.awb) await getProvider(s0.providerCode).cancelShipment(s0.awb, cfg);
  const w = new Work();
  const cancelled = await withVendor(db, ctx.vendorId, async (tx) => {
    const s = await getShipment(tx, ctx.vendorId, id, true);
    if (!(PRE_DISPATCH as readonly string[]).includes(s.status)) throw new AppError('INVALID_STATE', `A ${s.status} shipment can no longer be cancelled`, { details: { status: s.status } });
    const [after] = await tx.update(S).set({ status: 'cancelled', cancelledAt: new Date(), manifestId: null, version: sql`${S.version} + 1` }).where(eq(S.id, id)).returning();
    await tx.update(schema.packages).set({ shipmentId: null }).where(and(eq(schema.packages.vendorId, ctx.vendorId), eq(schema.packages.shipmentId, id), eq(schema.packages.status, 'packed')));
    const f = await getFulfillment(tx, ctx.vendorId, s.fulfillmentId);
    if (f.status === 'ready_to_ship') await moveFulfillment(tx, ctx, w, f.id, 'packed', { note: `shipment ${s.number} cancelled` });
    await tx.insert(TE).values({ vendorId: ctx.vendorId, shipmentId: id, status: 'cancelled', providerEventId: 'cancelled', source: 'system', occurredAt: new Date(), note: reason ?? null });
    await effects(tx, ctx).audit({ action: 'shipment.cancelled', resourceType: 'shipment', resourceId: id, before: { status: s.status }, after: { status: 'cancelled', reason: reason ?? null } });
    return after!;
  });
  await w.flush(ctx.c);
  return cancelled;
}

// ------------------------------------------------------------------------------------------------
// dispatch
// ------------------------------------------------------------------------------------------------
/**
 * The parcel leaves the warehouse. `packageBarcodes` (what the dispatcher scanned at the dock) must cover every package of the
 * shipment when given. The fulfillment becomes `shipped`, so the ORDER becomes `dispatched` with the AWB (and the marketplace is told).
 */
export async function dispatchShipment(tx: Tx, ctx: OpCtx, w: Work, id: string, input: { packageBarcodes?: string[] } = {}): Promise<ShipmentRow> {
  const s = await getShipment(tx, ctx.vendorId, id, true);
  if ((await getOrderRow(tx, ctx.vendorId, s.orderId)).status === 'cancelled') throw new AppError('INVALID_STATE', 'The order was cancelled: this parcel must not leave the warehouse', { details: { rule: 'order_cancelled' } });
  if (s.status !== 'label_ready' && s.status !== 'manifested') throw new AppError('INVALID_STATE', `A ${s.status} shipment cannot be dispatched`, { details: { status: s.status } });
  const pkgs = await tx.select().from(schema.packages).where(and(eq(schema.packages.vendorId, ctx.vendorId), eq(schema.packages.shipmentId, id)));
  if (input.packageBarcodes) {
    const scanned = new Set(input.packageBarcodes.map((b) => b.trim().toUpperCase()));
    const missing = pkgs.filter((p) => !scanned.has(p.barcode.toUpperCase()));
    if (missing.length) throw new AppError('CONFLICT', 'Not every package of the shipment was scanned', { details: { rule: 'packages_not_scanned', missing: missing.map((p) => p.barcode) } });
  }
  const now = new Date();
  const [after] = await tx.update(S).set({ status: 'dispatched', dispatchedAt: now, version: sql`${S.version} + 1` }).where(eq(S.id, id)).returning();
  await markPackagesShipped(tx, ctx.vendorId, id);
  await tx.insert(TE).values({ vendorId: ctx.vendorId, shipmentId: id, status: 'dispatched', providerEventId: 'dispatched', source: 'system', occurredAt: now, note: 'handed over' });
  await moveFulfillment(tx, ctx, w, s.fulfillmentId, 'shipped', { note: `shipment ${s.number}`, tracking: { number: s.awb ?? undefined, carrier: s.carrier ?? undefined } });
  const fx = effects(tx, ctx);
  await fx.event({ type: 'shipment.dispatched', aggregateType: 'shipment', aggregateId: id, payload: { number: s.number, orderId: s.orderId, awb: s.awb, carrier: s.carrier } });
  await fx.audit({ action: 'shipment.dispatched', resourceType: 'shipment', resourceId: id, before: { status: s.status }, after: { status: 'dispatched', awb: s.awb } });
  return after!;
}

// ------------------------------------------------------------------------------------------------
// tracking (any source: courier webhook, polling, staff, simulator) -> one place that applies it
// ------------------------------------------------------------------------------------------------
export interface FollowUp { kind: 'rto'; awb: string; providerCode: string; note: string }
export interface TrackingResult { shipment: ShipmentRow; applied: number; recorded: number; duplicates: number; followUps: FollowUp[] }

const EVENT_FOR: Partial<Record<ShipmentStatus, string>> = { in_transit: 'shipment.in_transit', delivered: 'shipment.delivered', delivery_failed: 'shipment.failed', rto_initiated: 'shipment.rto_started', rto_delivered: 'shipment.rto_delivered' };

/**
 * Apply tracking updates in time order. Every update is stored once (deduplicated by provider event id). It CHANGES the shipment
 * only when the state machine allows the move, so late / repeated / out-of-order courier messages are harmless. Effects: the
 * fulfillment (and through it the order) follows; a failed delivery opens an NDR case and, after `maxAttempts`, an RTO.
 */
export async function applyTracking(tx: Tx, ctx: OpCtx, w: Work, shipmentId: string, updates: TrackingUpdate[], source: 'provider' | 'manual' | 'simulator' | 'system' = 'provider'): Promise<TrackingResult> {
  let s: ShipmentRow = await getShipment(tx, ctx.vendorId, shipmentId, true); // serialise courier messages for one shipment
  const out: TrackingResult = { shipment: s, applied: 0, recorded: 0, duplicates: 0, followUps: [] };
  const fx = effects(tx, ctx);
  for (const u of [...updates].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const ins = await tx.insert(TE).values({ vendorId: ctx.vendorId, shipmentId, status: u.status, rawStatus: u.rawStatus ?? null, location: u.location ?? null, note: u.note ?? null, providerEventId: u.eventId, source, occurredAt: u.occurredAt }).onConflictDoNothing().returning({ id: TE.id });
    if (ins.length === 0) { out.duplicates++; continue; }
    out.recorded++;
    const from = s.status as ShipmentStatus;
    const to = u.status as ShipmentStatus;
    // "handed over" is OUR event (dispatch consumes stock, tells the marketplace, scans packages): a courier / staff message can never make it
    if (to === 'dispatched' && source !== 'system') continue;
    if (!canMove(from, to)) continue;
    const patch: Partial<typeof S.$inferInsert> = { status: to, lastTrackedAt: new Date(), version: sql`${S.version} + 1` as never };
    if (to === 'delivered') patch.deliveredAt = u.occurredAt;
    if (to === 'rto_delivered') { patch.rtoDeliveredAt = u.occurredAt; patch.isRto = true; }
    if (to === 'rto_initiated' || to === 'rto_in_transit') patch.isRto = true;
    if (to === 'delivery_failed') patch.attempts = s.attempts + 1;
    s = (await tx.update(S).set(patch).where(eq(S.id, shipmentId)).returning())[0]!;
    out.applied++;
    const fStatus = fulfillmentStatusFor(to);
    if (fStatus && fStatus !== 'shipped') await moveFulfillment(tx, ctx, w, s!.fulfillmentId, fStatus, { note: `shipment ${s!.number}: ${to}`, metadata: { location: u.location ?? null } }).catch((e) => { if ((e as { code?: string }).code !== 'INVALID_STATE') throw e; });
    const rtoItems = to === 'rto_delivered' ? (await itemsOf(tx, ctx.vendorId, s.fulfillmentId)).filter((i) => i.pickedQuantity > 0).map((i) => ({ orderItemId: i.orderItemId, quantity: i.pickedQuantity })) : undefined;
    if (EVENT_FOR[to]) await fx.event({ type: EVENT_FOR[to]!, aggregateType: 'shipment', aggregateId: shipmentId, payload: { number: s.number, orderId: s.orderId, warehouseId: s.warehouseId, awb: s.awb, status: to, attempts: s.attempts, ...(rtoItems ? { items: rtoItems } : {}) } });
    await fx.audit({ action: `shipment.${to}`, resourceType: 'shipment', resourceId: shipmentId, before: { status: from }, after: { status: to }, metadata: { source, location: u.location ?? null } });

    if (to === 'delivery_failed') {
      const [ndr] = await tx.insert(N).values({ vendorId: ctx.vendorId, shipmentId, orderId: s!.orderId, attemptNo: s!.attempts, reasonCode: u.rawStatus ?? 'delivery_failed', reasonText: u.note ?? null }).onConflictDoNothing().returning();
      if (ndr) await fx.event({ type: 'shipment.ndr_raised', aggregateType: 'shipment', aggregateId: shipmentId, payload: { number: s!.number, orderId: s!.orderId, awb: s!.awb, ndrId: ndr.id, attemptNo: ndr.attemptNo, reason: ndr.reasonCode } });
      const max = Number((await tx.select({ c: SP.config }).from(SP).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.providerCode, s!.providerCode))))[0]?.c.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
      if (s!.attempts >= max && s!.awb) {
        // out of attempts: send it back
        await tx.update(N).set({ status: 'rto', action: 'rto', actionBy: 'system', resolvedAt: new Date() }).where(and(eq(N.shipmentId, shipmentId), eq(N.attemptNo, s!.attempts)));
        const r = await applyTracking(tx, ctx, w, shipmentId, [{ eventId: `auto-rto-${s!.attempts}`, status: 'rto_initiated', rawStatus: 'max_attempts', note: `${s!.attempts} failed attempts`, occurredAt: new Date(u.occurredAt.getTime() + 1) }], 'system');
        s = r.shipment;
        out.followUps.push({ kind: 'rto', awb: s.awb!, providerCode: s.providerCode, note: 'maximum delivery attempts reached' }, ...r.followUps);
      }
    }
    if (from === 'delivery_failed' && (to === 'in_transit' || to === 'out_for_delivery' || to === 'delivered')) {
      await tx.update(N).set({ status: 'resolved', resolvedAt: new Date() }).where(and(eq(N.vendorId, ctx.vendorId), eq(N.shipmentId, shipmentId), inArray(N.status, ['open', 'action_requested'])));
    }
  }
  out.shipment = s!;
  return out;
}

/** carry out the provider-side follow-ups of a tracking result (after the transaction committed) */
export async function runFollowUps(ctx: OpCtx, followUps: FollowUp[]): Promise<void> {
  for (const f of followUps) {
    try {
      const cfg = await withVendor(ctx.c.database.db, ctx.vendorId, async (tx) => (await tx.select({ c: SP.config }).from(SP).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.providerCode, f.providerCode))))[0]?.c ?? {});
      await getProvider(f.providerCode).initiateRto?.(f.awb, cfg, { note: f.note });
    } catch (e) { ctx.c.logger.warn({ awb: f.awb, err: (e as Error).message }, 'provider RTO request failed (the shipment is already marked RTO here)'); }
  }
}

/** Ingest tracking updates for a shipment in its own transaction and run the follow-ups. */
export async function ingestTracking(ctx: OpCtx, shipmentId: string, updates: TrackingUpdate[], source: 'provider' | 'manual' | 'simulator' | 'system' = 'provider'): Promise<TrackingResult> {
  const w = new Work();
  const res = await withVendor(ctx.c.database.db, ctx.vendorId, (tx) => applyTracking(tx, ctx, w, shipmentId, updates, source));
  await w.flush(ctx.c);
  await runFollowUps(ctx, res.followUps);
  return res;
}

/** Ask the provider for the latest tracking and apply it (providers that cannot be polled return nothing). */
export async function refreshTracking(ctx: OpCtx, shipmentId: string): Promise<TrackingResult> {
  const db = ctx.c.database.db;
  const s = await withVendor(db, ctx.vendorId, (tx) => getShipment(tx, ctx.vendorId, shipmentId));
  if (!s.awb || !(IN_FLIGHT as readonly string[]).includes(s.status)) throw new AppError('INVALID_STATE', `A ${s.status} shipment is not being tracked`, { details: { status: s.status } });
  const cfg = await withVendor(db, ctx.vendorId, async (tx) => (await tx.select({ c: SP.config }).from(SP).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.providerCode, s.providerCode))))[0]?.c ?? {});
  const updates = await getProvider(s.providerCode).track(s.awb, cfg, s.lastTrackedAt ?? undefined);
  if (updates.length === 0) {
    const shipment = await withVendor(db, ctx.vendorId, async (tx) => (await tx.update(S).set({ lastTrackedAt: new Date() }).where(eq(S.id, shipmentId)).returning())[0]!);
    return { shipment, applied: 0, recorded: 0, duplicates: 0, followUps: [] };
  }
  return ingestTracking(ctx, shipmentId, updates, 'provider');
}

/** Simulator only: push a courier event through the SAME path real tracking uses. */
export async function simulateTracking(ctx: OpCtx, shipmentId: string, input: { status: TrackingStatus; note?: string | null; location?: string | null; reason?: string | null }): Promise<TrackingResult> {
  const s = await withVendor(ctx.c.database.db, ctx.vendorId, (tx) => getShipment(tx, ctx.vendorId, shipmentId));
  assertProviderAllowed(ctx.c, s.providerCode);
  if (s.providerCode !== 'sandbox') throw new AppError('BAD_REQUEST', 'Tracking can only be simulated for sandbox-courier shipments', { details: { providerCode: s.providerCode } });
  const n = await withVendor(ctx.c.database.db, ctx.vendorId, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(TE).where(eq(TE.shipmentId, shipmentId)))[0]!.n);
  return ingestTracking(ctx, shipmentId, [{ eventId: `sim-${n + 1}`, status: input.status, rawStatus: input.reason ?? input.status, note: input.note ?? null, location: input.location ?? 'Simulated hub', occurredAt: new Date() }], 'simulator');
}

// ------------------------------------------------------------------------------------------------
// NDR
// ------------------------------------------------------------------------------------------------
export async function listNdr(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; shipmentId?: string }) {
  const ks = keyset<NdrRow>({ sorts: { createdAt: { column: N.createdAt, kind: 'timestamp' } }, idColumn: N.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(N).where(and(eq(N.vendorId, vendorId), q.status ? eq(N.status, q.status) : undefined, q.shipmentId ? eq(N.shipmentId, q.shipmentId) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}
export async function getNdr(tx: Tx, vendorId: string, id: string): Promise<NdrRow> {
  const [n] = await tx.select().from(N).where(and(eq(N.id, id), eq(N.vendorId, vendorId)));
  if (!n) throw Errors.notFound('NDR case', id);
  return n;
}

/**
 * Decide what to do about a failed delivery: `reattempt` (the courier tries again, optionally on a date), `rto` (send it back),
 * `update_address` / `contact_customer` (recorded as the action taken; the case stays open until the next courier update).
 */
export async function actOnNdr(ctx: OpCtx, id: string, input: { action: (typeof schema.NDR_ACTIONS)[number]; nextAttemptAt?: Date | null; note?: string | null }): Promise<{ ndr: NdrRow; shipment: ShipmentRow }> {
  const db = ctx.c.database.db;
  const n = await withVendor(db, ctx.vendorId, (tx) => getNdr(tx, ctx.vendorId, id));
  if (!['open', 'action_requested'].includes(n.status)) throw new AppError('INVALID_STATE', `This NDR case is already ${n.status}`, { details: { status: n.status } });
  const s = await withVendor(db, ctx.vendorId, (tx) => getShipment(tx, ctx.vendorId, n.shipmentId));
  if (s.status !== 'delivery_failed') throw new AppError('INVALID_STATE', `The shipment is ${s.status}; there is nothing to decide`, { details: { status: s.status } });
  const cfg = await withVendor(db, ctx.vendorId, async (tx) => (await tx.select({ c: SP.config }).from(SP).where(and(eq(SP.vendorId, ctx.vendorId), eq(SP.providerCode, s.providerCode))))[0]?.c ?? {});
  const adapter = getProvider(s.providerCode);
  if (s.awb) {
    if (input.action === 'reattempt') await adapter.requestReattempt?.(s.awb, cfg, { nextAttemptAt: input.nextAttemptAt, note: input.note });
    if (input.action === 'rto') await adapter.initiateRto?.(s.awb, cfg, { note: input.note });
  }
  const w = new Work();
  const out = await withVendor(db, ctx.vendorId, async (tx) => {
    const status = input.action === 'rto' ? 'rto' : 'action_requested';
    const [ndr] = await tx.update(N).set({ status, action: input.action, actionBy: ctx.actor.id, nextAttemptAt: input.nextAttemptAt ?? null, reasonText: input.note ? `${n.reasonText ? `${n.reasonText} | ` : ''}${input.note}` : n.reasonText, resolvedAt: input.action === 'rto' ? new Date() : null }).where(eq(N.id, id)).returning();
    let shipment = await getShipment(tx, ctx.vendorId, n.shipmentId);
    if (input.action === 'rto') shipment = (await applyTracking(tx, ctx, w, n.shipmentId, [{ eventId: `ndr-rto-${id}`, status: 'rto_initiated', rawStatus: 'ndr_rto', note: input.note ?? 'RTO decided from NDR', occurredAt: new Date() }], 'manual')).shipment;
    await effects(tx, ctx).audit({ action: 'ndr.action', resourceType: 'ndr_case', resourceId: id, before: { status: n.status }, after: { status, action: input.action, nextAttemptAt: input.nextAttemptAt ?? null } });
    return { ndr: ndr!, shipment };
  });
  await w.flush(ctx.c);
  return out;
}

// ------------------------------------------------------------------------------------------------
// manifests
// ------------------------------------------------------------------------------------------------
export async function getManifest(tx: Tx, vendorId: string, id: string) {
  const [m] = await tx.select().from(M).where(and(eq(M.id, id), eq(M.vendorId, vendorId)));
  if (!m) throw Errors.notFound('Manifest', id);
  const list = await tx.select().from(S).where(and(eq(S.vendorId, vendorId), eq(S.manifestId, id))).orderBy(S.createdAt);
  return { m, shipments: list };
}
export async function listManifests(tx: Tx, vendorId: string, q: { limit: number; cursor?: string; status?: string; warehouseId?: string }) {
  const ks = keyset<ManifestRow>({ sorts: { createdAt: { column: M.createdAt, kind: 'timestamp' } }, idColumn: M.id, defaultSort: { field: 'createdAt', direction: 'desc' }, cursor: q.cursor, limit: q.limit });
  const rows = await tx.select().from(M).where(and(eq(M.vendorId, vendorId), q.status ? eq(M.status, q.status) : undefined, q.warehouseId ? eq(M.warehouseId, q.warehouseId) : undefined, ks.where)).orderBy(...ks.orderBy).limit(ks.fetch);
  return ks.finish(rows, (r) => ({ sortValue: r.createdAt, id: r.id }));
}

/** Group labelled shipments (same warehouse, same provider) into a handover manifest. */
export async function createManifest(tx: Tx, ctx: OpCtx, input: { warehouseId: string; providerCode?: string; shipmentIds: string[] }) {
  const ids = [...new Set(input.shipmentIds)];
  const rows = await tx.select().from(S).where(and(eq(S.vendorId, ctx.vendorId), inArray(S.id, ids)));
  if (rows.length !== ids.length) throw Errors.notFound('Shipment', ids.find((i) => !rows.some((r) => r.id === i)) ?? ids[0]!);
  const providers = new Set(rows.map((r) => r.providerCode));
  if (providers.size !== 1) throw new AppError('BAD_REQUEST', 'A manifest covers one provider', { details: { providers: [...providers] } });
  const providerCode = [...providers][0]!;
  if (input.providerCode && input.providerCode !== providerCode) throw new AppError('BAD_REQUEST', 'The shipments belong to another provider', { details: { providerCode } });
  const bad = rows.filter((r) => r.status !== 'label_ready' || r.warehouseId !== input.warehouseId || r.manifestId);
  if (bad.length) throw new AppError('CONFLICT', 'Only labelled shipments of this warehouse that are not on a manifest can be added', { details: { shipments: bad.map((b) => ({ id: b.id, status: b.status, manifestId: b.manifestId, warehouseId: b.warehouseId })) } });
  const number = `MAN-${String(await nextCounter(tx, ctx.vendorId, 'manifest')).padStart(6, '0')}`;
  const [m] = await tx.insert(M).values({ vendorId: ctx.vendorId, number, warehouseId: input.warehouseId, providerCode }).returning();
  await tx.update(S).set({ manifestId: m!.id, status: 'manifested', version: sql`${S.version} + 1` }).where(inArray(S.id, ids));
  await effects(tx, ctx).audit({ action: 'manifest.created', resourceType: 'manifest', resourceId: m!.id, after: { number, shipments: ids.length } });
  return getManifest(tx, ctx.vendorId, m!.id);
}

export async function closeManifest(tx: Tx, ctx: OpCtx, id: string) {
  const { m, shipments } = await getManifest(tx, ctx.vendorId, id);
  if (m.status !== 'open') throw new AppError('INVALID_STATE', `This manifest is ${m.status}`, { details: { status: m.status } });
  if (shipments.length === 0) throw new AppError('CONFLICT', 'An empty manifest cannot be closed');
  await tx.update(M).set({ status: 'closed', closedAt: new Date(), version: sql`${M.version} + 1` }).where(eq(M.id, id));
  await effects(tx, ctx).audit({ action: 'manifest.closed', resourceType: 'manifest', resourceId: id, after: { shipments: shipments.length } });
  return getManifest(tx, ctx.vendorId, id);
}

/** Hand the whole manifest to the courier: every shipment is dispatched (and its order marked dispatched). */
export async function dispatchManifest(tx: Tx, ctx: OpCtx, w: Work, id: string, input: { packageBarcodes?: string[] } = {}) {
  const { m, shipments } = await getManifest(tx, ctx.vendorId, id);
  if (m.status !== 'closed') throw new AppError('INVALID_STATE', `Close the manifest before dispatching it (it is ${m.status})`, { details: { status: m.status } });
  for (const s of shipments) await dispatchShipment(tx, ctx, w, s.id, input);
  await tx.update(M).set({ status: 'dispatched', dispatchedAt: new Date(), version: sql`${M.version} + 1` }).where(eq(M.id, id));
  await effects(tx, ctx).audit({ action: 'manifest.dispatched', resourceType: 'manifest', resourceId: id, after: { shipments: shipments.length } });
  return getManifest(tx, ctx.vendorId, id);
}

export async function cancelManifest(tx: Tx, ctx: OpCtx, id: string) {
  const { m } = await getManifest(tx, ctx.vendorId, id);
  if (!['open', 'closed'].includes(m.status)) throw new AppError('INVALID_STATE', `A ${m.status} manifest cannot be cancelled`, { details: { status: m.status } });
  await tx.update(S).set({ manifestId: null, status: 'label_ready', version: sql`${S.version} + 1` }).where(and(eq(S.vendorId, ctx.vendorId), eq(S.manifestId, id)));
  await tx.update(M).set({ status: 'cancelled', version: sql`${M.version} + 1` }).where(eq(M.id, id));
  await effects(tx, ctx).audit({ action: 'manifest.cancelled', resourceType: 'manifest', resourceId: id });
  return getManifest(tx, ctx.vendorId, id);
}

export const latestShipmentOfOrder = async (tx: Tx, vendorId: string, orderId: string): Promise<ShipmentRow[]> => tx.select().from(S).where(and(eq(S.vendorId, vendorId), eq(S.orderId, orderId))).orderBy(desc(S.createdAt));
