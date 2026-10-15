import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { inList, pk, tenantId, timestamps, tz, version } from './_helpers';
import { vendors, users } from './identity';
import { productVariants } from './catalog';
import { warehouses } from './operations';

/**
 * Physical layout of a warehouse and the people allowed to work in it. `inventory` (per variant per warehouse) stays the
 * source of truth for quantities; `bin_stock` only says WHERE inside the warehouse part of that quantity sits.
 * Invariant (enforced by the service): sum(bin_stock) <= inventory.quantity_on_hand for a (variant, warehouse).
 */
export const LOCATION_TYPES = ['receiving', 'storage', 'packing', 'dispatch', 'returns', 'quarantine'] as const;
export const BIN_STATUSES = ['active', 'inactive', 'blocked'] as const;
export const WAREHOUSE_ROLES = ['manager', 'picker', 'packer', 'receiver', 'dispatcher', 'viewer'] as const;
/** capabilities a warehouse member can hold; a role grants a default set (see warehouses/domain) */
export const WAREHOUSE_CAPABILITIES = ['read', 'pick', 'pack', 'receive', 'dispatch', 'adjust', 'manage'] as const;
export const INBOUND_STATUSES = ['expected', 'receiving', 'received', 'closed', 'cancelled'] as const;

export const warehouseLocations = pgTable('warehouse_locations', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  warehouseId: uuid('warehouse_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull().default('storage'),
  status: text('status').notNull().default('active'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('warehouse_locations_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('warehouse_locations_code_uq').on(t.warehouseId, t.code),
  index('warehouse_locations_vendor_wh_idx').on(t.vendorId, t.warehouseId),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'warehouse_locations_warehouse_fk' }).onDelete('cascade'),
  check('warehouse_locations_type_chk', inList('type', LOCATION_TYPES)),
  check('warehouse_locations_status_chk', inList('status', ['active', 'inactive'])),
]);

export const warehouseBins = pgTable('warehouse_bins', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  warehouseId: uuid('warehouse_id').notNull(),
  locationId: uuid('location_id'),
  code: text('code').notNull(),
  /** scanned to confirm "I am at this bin"; unique per vendor */
  barcode: text('barcode'),
  capacity: integer('capacity'),
  pickable: boolean('pickable').notNull().default(true),
  status: text('status').notNull().default('active'),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('warehouse_bins_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('warehouse_bins_code_uq').on(t.warehouseId, t.code),
  uniqueIndex('warehouse_bins_barcode_uq').on(t.vendorId, t.barcode).where(sql`${t.barcode} IS NOT NULL`),
  index('warehouse_bins_vendor_wh_idx').on(t.vendorId, t.warehouseId),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'warehouse_bins_warehouse_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.locationId], foreignColumns: [warehouseLocations.vendorId, warehouseLocations.id], name: 'warehouse_bins_location_fk' }),
  check('warehouse_bins_status_chk', inList('status', BIN_STATUSES)),
  check('warehouse_bins_capacity_chk', sql`capacity IS NULL OR capacity >= 0`),
]);

/** Which users work in which warehouse, in which role, with which capabilities (empty list = the role's defaults). */
export const warehouseMembers = pgTable('warehouse_members', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  warehouseId: uuid('warehouse_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull(),
  capabilities: text('capabilities').array().notNull().default(sql`'{}'::text[]`),
  ...timestamps(),
}, (t) => [
  uniqueIndex('warehouse_members_uq').on(t.warehouseId, t.userId),
  index('warehouse_members_vendor_user_idx').on(t.vendorId, t.userId),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'warehouse_members_warehouse_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.userId], foreignColumns: [users.vendorId, users.id], name: 'warehouse_members_user_fk' }).onDelete('cascade'),
  check('warehouse_members_role_chk', inList('role', WAREHOUSE_ROLES)),
]);

export const binStock = pgTable('bin_stock', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  warehouseId: uuid('warehouse_id').notNull(),
  binId: uuid('bin_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  quantity: integer('quantity').notNull().default(0),
  ...timestamps(),
}, (t) => [
  uniqueIndex('bin_stock_uq').on(t.binId, t.variantId),
  index('bin_stock_vendor_variant_idx').on(t.vendorId, t.variantId, t.warehouseId),
  foreignKey({ columns: [t.vendorId, t.binId], foreignColumns: [warehouseBins.vendorId, warehouseBins.id], name: 'bin_stock_bin_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'bin_stock_variant_fk' }),
  check('bin_stock_qty_chk', sql`quantity >= 0`),
]);

/** Goods arriving from a supplier / another site. Expected quantities show as `incoming` until received. */
export const inboundShipments = pgTable('inbound_shipments', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  supplier: text('supplier'),
  reference: text('reference'),
  status: text('status').notNull().default('expected'),
  expectedAt: tz('expected_at'),
  receivedAt: tz('received_at'),
  notes: text('notes'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  version: version(),
  ...timestamps(),
}, (t) => [
  unique('inbound_shipments_vendor_id_id_uq').on(t.vendorId, t.id),
  uniqueIndex('inbound_shipments_number_uq').on(t.vendorId, t.number),
  index('inbound_shipments_vendor_status_idx').on(t.vendorId, t.status, t.createdAt.desc()),
  foreignKey({ columns: [t.vendorId, t.warehouseId], foreignColumns: [warehouses.vendorId, warehouses.id], name: 'inbound_shipments_warehouse_fk' }),
  check('inbound_shipments_status_chk', inList('status', INBOUND_STATUSES)),
]);

export const inboundShipmentItems = pgTable('inbound_shipment_items', {
  id: pk(),
  vendorId: tenantId().references(() => vendors.id, { onDelete: 'cascade' }),
  inboundId: uuid('inbound_id').notNull(),
  variantId: uuid('variant_id').notNull(),
  expectedQuantity: integer('expected_quantity').notNull(),
  receivedQuantity: integer('received_quantity').notNull().default(0),
  damagedQuantity: integer('damaged_quantity').notNull().default(0),
  binId: uuid('bin_id'),
  ...timestamps(),
}, (t) => [
  uniqueIndex('inbound_shipment_items_uq').on(t.inboundId, t.variantId),
  index('inbound_shipment_items_vendor_idx').on(t.vendorId, t.inboundId),
  foreignKey({ columns: [t.vendorId, t.inboundId], foreignColumns: [inboundShipments.vendorId, inboundShipments.id], name: 'inbound_shipment_items_inbound_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.vendorId, t.variantId], foreignColumns: [productVariants.vendorId, productVariants.id], name: 'inbound_shipment_items_variant_fk' }),
  foreignKey({ columns: [t.vendorId, t.binId], foreignColumns: [warehouseBins.vendorId, warehouseBins.id], name: 'inbound_shipment_items_bin_fk' }),
  check('inbound_shipment_items_qty_chk', sql`expected_quantity > 0 AND received_quantity >= 0 AND damaged_quantity >= 0 AND damaged_quantity <= received_quantity`),
]);
