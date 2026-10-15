import { createRuntime, startOpsServer, startProcessors } from '@oms/runtime';
import { allModules } from '@oms/modules-registry';

/**
 * Webhook processor. Flow (implemented in Stage 3 by the `webhooks` module):
 *   marketplace -> POST /api/v1/webhooks/:marketplace/:accountId   (API: raw-body capture, signature verification
 *   via the connector, dedupe on idempotency key, durable enqueue, 200 within ms)
 *   -> queue `webhooks-inbound` -> THIS process: parse via connector, normalise, apply to domain, emit events.
 * Kept as its own process so a webhook storm (or a poison payload) cannot starve the general worker, and so it can
 * scale independently. It is the first candidate for extraction into a standalone service.
 */
const rt = await createRuntime('webhook-worker');
startOpsServer(rt, rt.config.WORKER_HEALTH_PORT);
startProcessors(rt, allModules, ['webhooksInbound']);
rt.logger.info('webhook-worker started');
