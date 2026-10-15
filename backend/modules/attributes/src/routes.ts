import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, created, emit, ok, paginated, vendorTx } from '@oms/module-kit';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, sortQuery, successEnvelope } from '@oms/contracts';
import * as svc from './service';

export const AttributeValueSchema = z.object({ id: z.string(), value: z.string(), label: z.string(), sortOrder: z.number().int() }).meta({ id: 'AttributeValue' });

export const AttributeSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    dataType: z.enum(['text', 'number', 'boolean', 'date', 'enum']),
    appliesTo: z.enum(['product', 'variant']).describe('Whether values are set on the product or on each variant (e.g. size/colour)'),
    unit: z.string().nullable(),
    description: z.string().nullable(),
    values: z.array(AttributeValueSchema).describe('Allowed values (enum attributes only)'),
    version: z.number().int(),
    createdAt: IsoDate,
    updatedAt: IsoDate,
  })
  .meta({ id: 'Attribute' });

const Code = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,39}$/, 'lowercase letters, digits and _ (2-40 chars), starting with a letter');
const ValueInput = z.object({ value: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(120).optional(), sortOrder: z.number().int().min(0).optional() });

const CreateBody = z.object({
  code: Code.meta({ example: 'color' }),
  name: z.string().trim().min(1).max(120).meta({ example: 'Colour' }),
  dataType: z.enum(['text', 'number', 'boolean', 'date', 'enum']).default('text'),
  appliesTo: z.enum(['product', 'variant']).default('product'),
  unit: z.string().trim().max(20).optional(),
  description: z.string().trim().max(500).optional(),
  values: z.array(ValueInput).max(500).optional().describe('Initial allowed values (enum only)'),
});
const UpdateBody = z.object({ name: z.string().trim().min(1).max(120), unit: z.string().trim().max(20).nullable(), description: z.string().trim().max(500).nullable(), version: z.number().int() }).partial();
const ListQuery = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
  'filter[dataType]': z.enum(['text', 'number', 'boolean', 'date', 'enum']).optional(),
  'filter[appliesTo]': z.enum(['product', 'variant']).optional(),
  sort: sortQuery(['name', 'code', 'createdAt'] as const),
});

const CategoryAttributeSchema = z.object({ isRequired: z.boolean(), sortOrder: z.number().int(), attribute: AttributeSchema }).meta({ id: 'CategoryAttribute' });
const SetCategoryAttributesBody = z.object({
  items: z.array(z.object({ attributeId: z.uuid(), isRequired: z.boolean().optional(), sortOrder: z.number().int().min(0).optional() })).max(200),
});

export const attributeRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Attributes'];
  const Msg = z.object({ message: z.string() });

  r.post('/attributes', {
    config: { access: { permission: 'attributes:write' } },
    schema: {
      tags: TAGS,
      summary: 'Define an attribute',
      description: 'Generic, marketplace-neutral attributes (colour, fabric, size...). Marketplace-specific attributes are kept in per-marketplace product data, never here.',
      body: CreateBody,
      response: { 201: successEnvelope(AttributeSchema) },
    },
  }, async (req, reply) => {
    const dto = await vendorTx(req, async (tx, vendorId) => {
      const a = await svc.createAttribute(tx, vendorId, req.body);
      await audit(tx, req, { action: 'attribute.create', resourceType: 'attribute', resourceId: a.id, after: { code: a.code, dataType: a.dataType } });
      await emit(tx, req, { type: 'attribute.updated', aggregateType: 'attribute', aggregateId: a.id, payload: { code: a.code } });
      return a;
    });
    return created(req, reply, dto, `/api/v1/attributes/${dto.id}`);
  });

  r.get('/attributes', {
    config: { access: { permission: 'attributes:read' } },
    schema: { tags: TAGS, summary: 'List attributes', querystring: ListQuery, response: { 200: paginatedEnvelope(AttributeSchema) } },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listAttributes(tx, vendorId, { limit: q.limit, cursor: q.cursor, q: q.q, dataType: q['filter[dataType]'], appliesTo: q['filter[appliesTo]'], sort: q.sort }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/attributes/:id', {
    config: { access: { permission: 'attributes:read' } },
    schema: { tags: TAGS, summary: 'Get an attribute with its values', params: IdParamSchema, response: { 200: successEnvelope(AttributeSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.getAttributeWithValues(tx, vendorId, req.params.id))));

  r.patch('/attributes/:id', {
    config: { access: { permission: 'attributes:write' } },
    schema: { tags: TAGS, summary: 'Update an attribute (code, type and scope are immutable)', params: IdParamSchema, body: UpdateBody, response: { 200: successEnvelope(AttributeSchema) } },
  }, async (req) => {
    const after = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.updateAttribute(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'attribute.update', resourceType: 'attribute', resourceId: req.params.id, before: { name: res.before.name }, after: { name: res.after.name } });
      return res.after;
    });
    return ok(req, after);
  });

  r.delete('/attributes/:id', {
    config: { access: { permission: 'attributes:write' } },
    schema: { tags: TAGS, summary: 'Delete an attribute', description: 'Refused (409) while products use it.', params: IdParamSchema, response: { 200: successEnvelope(Msg) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const a = await svc.deleteAttribute(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'attribute.delete', resourceType: 'attribute', resourceId: a.id, before: { code: a.code } });
    });
    return ok(req, { message: 'Attribute deleted' });
  });

  // ------------------------------------------------------------------ enum values
  r.post('/attributes/:id/values', {
    config: { access: { permission: 'attributes:write' } },
    schema: { tags: TAGS, summary: 'Add an allowed value to an enum attribute', params: IdParamSchema, body: ValueInput, response: { 201: successEnvelope(AttributeValueSchema) } },
  }, async (req, reply) => {
    const v = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.addValue(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'attribute.value_add', resourceType: 'attribute', resourceId: req.params.id, after: { value: res.value } });
      return res;
    });
    return created(req, reply, v);
  });

  const ValueParams = z.object({ id: z.uuid(), valueId: z.uuid() });
  r.patch('/attributes/:id/values/:valueId', {
    config: { access: { permission: 'attributes:write' } },
    schema: { tags: TAGS, summary: 'Update an attribute value (label, order)', params: ValueParams, body: ValueInput.pick({ label: true, sortOrder: true }), response: { 200: successEnvelope(AttributeValueSchema) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.updateValue(tx, vendorId, req.params.id, req.params.valueId, req.body))));

  r.delete('/attributes/:id/values/:valueId', {
    config: { access: { permission: 'attributes:write' } },
    schema: { tags: TAGS, summary: 'Remove an attribute value', description: 'Refused (409) while products use it.', params: ValueParams, response: { 200: successEnvelope(Msg) } },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const v = await svc.deleteValue(tx, vendorId, req.params.id, req.params.valueId);
      await audit(tx, req, { action: 'attribute.value_delete', resourceType: 'attribute', resourceId: req.params.id, before: { value: v.value } });
    });
    return ok(req, { message: 'Value removed' });
  });

  // ------------------------------------------------------------------ category assignments
  r.get('/categories/:id/attributes', {
    config: { access: { permission: 'attributes:read' } },
    schema: { tags: TAGS, summary: 'Attributes expected for a category', params: IdParamSchema, response: { 200: successEnvelope(z.array(CategoryAttributeSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.getCategoryAttributes(tx, vendorId, req.params.id))));

  r.put('/categories/:id/attributes', {
    config: { access: { permission: 'attributes:write' } },
    schema: {
      tags: TAGS,
      summary: 'Set the attributes expected for a category (replaces the set)',
      description: '`isRequired` attributes must be filled before a product in this category counts as marketplace-ready.',
      params: IdParamSchema,
      body: SetCategoryAttributesBody,
      response: { 200: successEnvelope(z.array(CategoryAttributeSchema)) },
    },
  }, async (req) => {
    const out = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.setCategoryAttributes(tx, vendorId, req.params.id, req.body.items);
      await audit(tx, req, { action: 'category.attributes_set', resourceType: 'category', resourceId: req.params.id, after: { attributeIds: req.body.items.map((i) => i.attributeId) } });
      return res;
    });
    return ok(req, out);
  });
};
