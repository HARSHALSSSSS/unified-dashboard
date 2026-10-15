import { manifest } from './manifest';
import { ruleRoutes } from './routes';

export { manifest };
export { ruleRoutes } from './routes';
export {
  evaluate, matches, validateRule, conditionMatches, isLive, RULE_TYPES, RULE_TYPE_SPECS, OPS,
  type Condition, type ConditionSet, type Facts, type Matched, type RuleAction, type RuleDef, type RuleType,
} from './engine';
export { evaluateRules, liveRules, recordExecutions, toRuleDef, createRule, getRule } from './service';

/**
 * Business Rules: a controlled, data-driven rule engine. Modules call `evaluateRules(tx, vendorId, type, facts)`; vendors
 * manage the rules through the API. Only whitelisted facts, operators and actions exist: no scripts.
 */
export const rulesModule = { manifest, routes: ruleRoutes };
