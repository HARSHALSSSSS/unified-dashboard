import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, created, emit, ok, paginated, vendorTx } from '@oms/module-kit';
import { IdParamSchema, IsoDate, PaginationQuerySchema, SearchQuerySchema, paginatedEnvelope, sortQuery, successEnvelope } from '@oms/contracts';
import * as svc from './service';

const CategorySchema = z
  .object({
    id: z.string(), parentId: z.string().nullable(), name: z.string(), slug: z.string(),
    path: z.string().describe('Slash-separated slugs from the root, e.g. "apparel/men/shirts"'),
    sortOrder: z.number().int(), version: z.number().int(), createdAt: IsoDate, updatedAt: IsoDate,
  })
  .meta({ id: 'Category' });

type CategoryNodeDto = z.infer<typeof CategorySchema> & { children: CategoryNodeDto[] };
const CategoryNodeSchema: z.ZodType<CategoryNodeDto> = CategorySchema.extend({ children: z.lazy(() => z.array(CategoryNodeSchema)) });

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(60).optional().describe('URL-safe identifier; derived from the name when omitted'),
  parentId: z.uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
const UpdateBody = CreateBody.partial().extend({ version: z.number().int().optional() });
const ListQuery = PaginationQuerySchema.extend(SearchQuerySchema.shape).extend({
  'filter[parentId]': z.union([z.uuid(), z.literal('root')]).optional().describe('A parent id, or "root" for top-level categories'),
  sort: sortQuery(['path', 'name', 'createdAt'] as const),
});

export const categoryRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const TAGS = ['Categories'];

  r.post('/categories', {
    config: { access: { permission: 'categories:write' } },
    schema: { tags: TAGS, summary: 'Create a category', body: CreateBody, response: { 201: successEnvelope(CategorySchema) } },
  }, async (req, reply) => {
    const row = await vendorTx(req, async (tx, vendorId) => {
      const c = await svc.createCategory(tx, vendorId, req.body);
      await audit(tx, req, { action: 'category.create', resourceType: 'category', resourceId: c.id, after: { name: c.name, path: c.path } });
      await emit(tx, req, { type: 'category.created', aggregateType: 'category', aggregateId: c.id, payload: { path: c.path } });
      return c;
    });
    return created(req, reply, svc.toCategoryDto(row), `/api/v1/categories/${row.id}`);
  });

  r.get('/categories', {
    config: { access: { permission: 'categories:read' } },
    schema: { tags: TAGS, summary: 'List categories (flat, paginated)', querystring: ListQuery, response: { 200: paginatedEnvelope(CategorySchema) } },
  }, async (req) => {
    const q = req.query;
    const page = await vendorTx(req, (tx, vendorId) => svc.listCategories(tx, vendorId, { limit: q.limit, cursor: q.cursor, q: q.q, parentId: q['filter[parentId]'], sort: q.sort }));
    return paginated(req, page.items, { limit: q.limit, nextCursor: page.nextCursor });
  });

  r.get('/categories/tree', {
    config: { access: { permission: 'categories:read' } },
    schema: { tags: TAGS, summary: 'The whole category tree (nested)', response: { 200: successEnvelope(z.array(CategoryNodeSchema)) } },
  }, async (req) => ok(req, await vendorTx(req, (tx, vendorId) => svc.categoryTree(tx, vendorId))));

  r.get('/categories/:id', {
    config: { access: { permission: 'categories:read' } },
    schema: { tags: TAGS, summary: 'Get a category', params: IdParamSchema, response: { 200: successEnvelope(CategorySchema) } },
  }, async (req) => ok(req, svc.toCategoryDto(await vendorTx(req, (tx, vendorId) => svc.getCategory(tx, vendorId, req.params.id)))));

  r.patch('/categories/:id', {
    config: { access: { permission: 'categories:write' } },
    schema: {
      tags: TAGS,
      summary: 'Update or move a category',
      description: 'Changing `parentId` or `slug` re-computes the paths of the whole subtree. A category cannot be moved under its own descendant.',
      params: IdParamSchema,
      body: UpdateBody,
      response: { 200: successEnvelope(CategorySchema) },
    },
  }, async (req) => {
    const out = await vendorTx(req, async (tx, vendorId) => {
      const res = await svc.updateCategory(tx, vendorId, req.params.id, req.body);
      await audit(tx, req, { action: 'category.update', resourceType: 'category', resourceId: req.params.id, before: { name: res.before.name, path: res.before.path }, after: { name: res.after.name, path: res.after.path } });
      await emit(tx, req, { type: 'category.updated', aggregateType: 'category', aggregateId: req.params.id, payload: { path: res.after.path } });
      return res.after;
    });
    return ok(req, svc.toCategoryDto(out));
  });

  r.delete('/categories/:id', {
    config: { access: { permission: 'categories:write' } },
    schema: {
      tags: TAGS,
      summary: 'Delete a category',
      description: 'Soft delete. Refused (409) while the category has sub-categories or products.',
      params: IdParamSchema,
      response: { 200: successEnvelope(z.object({ message: z.string() })) },
    },
  }, async (req) => {
    await vendorTx(req, async (tx, vendorId) => {
      const c = await svc.deleteCategory(tx, vendorId, req.params.id);
      await audit(tx, req, { action: 'category.delete', resourceType: 'category', resourceId: c.id, before: { name: c.name, path: c.path } });
      await emit(tx, req, { type: 'category.deleted', aggregateType: 'category', aggregateId: c.id, payload: {} });
    });
    return ok(req, { message: 'Category deleted' });
  });
};
