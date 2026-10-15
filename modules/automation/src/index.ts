import type { EventConsumer } from '@oms/module-kit';
import { manifest } from './manifest';
import { automationRoutes } from './routes';
import { TRIGGERS, handleEvent } from './engine';

export { manifest };
export { automationRoutes } from './routes';
export { TRIGGERS as AUTOMATION_TRIGGERS, ACTIONS as AUTOMATION_ACTIONS, factsOf, render } from './engine';

/** one consumer per trigger event: a failing rule never blocks another trigger */
const consumers: EventConsumer[] = Object.keys(TRIGGERS).map((event) => ({
  event,
  name: `automation.${event}`,
  async handle(e, c) { await handleEvent(c, e); },
}));

/**
 * Automation: trigger -> conditions -> whitelisted action, with execution history, approval and rollback. A rule runs at most once per
 * event, is throttled, and (unless the vendor chose `auto`) waits for a person.
 */
export const automationModule = { manifest, routes: automationRoutes, consumers };
