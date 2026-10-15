import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createJsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import type { AppConfig } from '@oms/config';
import { API_TAGS, ErrorBodySchema } from '@oms/contracts';
import type { ModuleManifest } from '@oms/module-kit';

const DESCRIPTION = `
Multi-vendor commerce OMS API.

**Conventions**
- Base path \`/api/v1\`. Breaking changes ship as \`/api/v2\`; additive changes stay in v1.
- Auth: \`Authorization: Bearer <access token>\`. Tenant is derived from the token, never from the request body.
- Success: \`{ "success": true, "data": ..., "requestId": "..." }\`. Lists add \`meta: { limit, nextCursor, hasMore }\`.
- Errors: \`{ "success": false, "error": { "code", "message", "details" }, "requestId": "..." }\`.
- Pagination: keyset (\`?limit=25&cursor=...\`). Sorting: \`?sort=-createdAt,name\`. Filtering: \`?filter[status]=active\`. Search: \`?q=\`.
- Retriable POSTs accept \`Idempotency-Key\` (required where documented).
- Every response carries \`X-Request-Id\` and \`X-Correlation-Id\`.
`.trim();

/**
 * OpenAPI 3 generated from the routes' zod schemas. Every route is documented by construction (route-policy
 * refuses to boot otherwise). Standard error responses and the bearer security requirement are injected
 * automatically from `config.access`, so route authors only describe what is specific to their route.
 */
export const openapiPlugin = fp<{ config: AppConfig; modules: readonly ModuleManifest[] }>(async (app, { config }) => {
  const baseTransform = createJsonSchemaTransform({ skipList: [] });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'OMS Platform API', version: config.APP_VERSION, description: DESCRIPTION },
      servers: [{ url: config.PUBLIC_BASE_URL }],
      tags: [
        ...API_TAGS.map((t) => ({ name: t.name, description: t.description })),
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from POST /api/v1/auth/login' },
        },
      },
    },
    transform: (args) => {
      const access = args.route?.config?.access;
      const schema = (args.schema ?? {}) as Record<string, unknown> & { response?: Record<string, unknown>; body?: unknown; querystring?: unknown; params?: unknown };
      if (schema.hide || access === 'internal') return { schema: { ...schema, hide: true } as never, url: args.url };

      const errorResponses: Record<string, unknown> = { 500: ErrorBodySchema, 429: ErrorBodySchema };
      if (schema.body || schema.querystring || schema.params) errorResponses[400] = ErrorBodySchema;
      if (access !== 'public') { errorResponses[401] = ErrorBodySchema; errorResponses[403] = ErrorBodySchema; }
      const out = baseTransform({ ...args, schema: { ...schema, response: { ...errorResponses, ...schema.response } } as never }) as { schema: Record<string, unknown>; url: string };
      if (access !== 'public' && out.schema) out.schema.security = [{ bearerAuth: [] }];
      // machine-readable access policy (used by docs generation and API clients)
      if (out.schema) out.schema['x-access'] = typeof access === 'object' ? access.permission : access;
      return out as never;
    },
    transformObject: jsonSchemaTransformObject,
  });

  // Interactive docs at /docs, machine-readable spec at /docs/openapi (json) and /docs/openapi.yaml.
  if (config.swaggerEnabled) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', persistAuthorization: true, displayRequestDuration: true, tagsSorter: 'alpha' },
    });
    const hidden = { schema: { hide: true }, config: { access: 'internal' as const } };
    app.get('/docs/openapi', hidden, async () => app.swagger());
    app.get('/docs/openapi.yaml', hidden, async (_req, reply) => reply.type('application/yaml').send(app.swagger({ yaml: true })));
  }
}, { name: 'oms-openapi' });
