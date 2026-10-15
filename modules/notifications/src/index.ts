import type { EventConsumer } from '@oms/module-kit';
import { manifest } from './manifest';
import { notificationRoutes } from './routes';
import { SPECS } from './catalog';
import { notifyEvent } from './service';

export { manifest };
export { notificationRoutes } from './routes';
export { notifyEvent, notifyVendor, registerPushProvider, type PushProvider } from './service';
export { SPECS, TYPE_CATALOG, NOTIFICATION_TYPES, DEFAULT_CHANNELS } from './catalog';

/** one consumer per source event: a failure of one alert type never blocks another */
const consumers: EventConsumer[] = Object.keys(SPECS).map((event) => ({
  event,
  name: `notifications.${event}`,
  async handle(e, c) { await notifyEvent(c, e); },
}));

/**
 * Notifications: order alerts, low stock, failed syncs, listing rejections, returns, disconnected marketplaces and operational
 * exceptions become in-app notifications per user, with e-mail and push (push-ready) per the user's preferences and the vendor's
 * notification rules. Alert storms collapse into one unread notification.
 */
export const notificationsModule = { manifest, routes: notificationRoutes, consumers };
