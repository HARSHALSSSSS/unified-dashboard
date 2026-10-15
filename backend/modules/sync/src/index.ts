import { manifest } from './manifest';
import { syncRoutes } from './routes';
import { syncJobHandlers } from './jobs';

export { manifest };
export {
  createSyncJob, resetForManualRetry, dispatchSyncJob, enqueueSyncJob, executeSyncJob, appendSyncLog, classifyFailure, backoffMs, getSyncJobRow, latestJobs, SYNC_QUEUE, syncJobName,
  type CreateJobInput, type SyncContext, type SyncJobRow, type SyncRunner, type SyncType, type SyncTrigger,
} from './engine';
export { SyncJobSchema, toSyncJobDto, listSyncJobs, syncRoutes } from './routes';

/**
 * Synchronization: the async job engine (durable rows, idempotent enqueue, retries with exponential backoff,
 * dead-lettering, progress, failure details, manual retry) plus scheduled fan-out and crash recovery.
 * Domain modules (listings, orders, ...) own the RUNNERS; they call `executeSyncJob` from their own job handlers.
 */
export const syncModule = { manifest, routes: syncRoutes, jobs: syncJobHandlers };
