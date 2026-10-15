import { createRuntime, startOpsServer, startProcessors, startOutboxRelay } from '@oms/runtime';
import { allModules } from '@oms/modules-registry';
import { maintenanceHandlers } from './maintenance';
import { startBusinessMetrics } from './business-metrics';

/**
 * General background worker: domain-event fan-out, marketplace sync/push, notifications, heavy jobs,
 * maintenance. Scale horizontally; to isolate a workload (e.g. marketplace pushes), run another replica
 * with WORKER_QUEUES=marketplacePush (no code change).
 */
const rt = await createRuntime('worker');

const ALL = ['domainEvents', 'syncMarketplace', 'marketplacePush', 'notifications', 'heavy', 'maintenance'] as const;
const requested = (process.env.WORKER_QUEUES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const queues = requested.length ? ALL.filter((q) => requested.includes(q)) : [...ALL];

startOpsServer(rt, rt.config.WORKER_HEALTH_PORT);
startProcessors(rt, allModules, [...queues], maintenanceHandlers);
if (queues.includes('domainEvents')) startOutboxRelay(rt);
if (rt.config.METRICS_ENABLED) { const stop = startBusinessMetrics(rt); rt.onShutdown('business-metrics', async () => stop()); }

rt.logger.info({ queues }, 'worker started');
