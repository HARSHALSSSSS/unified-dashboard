import type { RuleAction } from '@oms/mod-rules';

/**
 * Pure pricing maths. Money is always integer minor units. A price is computed from the BASE price by the vendor's matching
 * pricing rules (highest priority first):
 *   1. arithmetic actions in order: markup_percent, markup_fixed, discount_percent, fixed_price (replaces the running price)
 *   2. margin_floor: never below cost + margin
 *   3. round_to: "nearest" step or psychological "ending" (e.g. ...99)
 *   4. cap_to_mrp
 *   5. final clamp: at least 1 minor unit, never above the MRP when there is one
 * Returns the steps taken, so the result is explainable.
 */
export interface PriceBasis { baseMinor: number; mrpMinor: number | null; costMinor: number | null }
export interface PriceResult { priceMinor: number; steps: string[]; belowMargin: boolean }

export function computePrice(basis: PriceBasis, actions: RuleAction[]): PriceResult {
  let price = basis.baseMinor;
  const steps: string[] = [`base ${price}`];
  const p = (a: RuleAction) => a.params as Record<string, number | string | undefined>;
  for (const a of actions) {
    switch (a.type) {
      case 'markup_percent': price = Math.round(price * (1 + Number(p(a).percent) / 100)); steps.push(`markup ${p(a).percent}% -> ${price}`); break;
      case 'markup_fixed': price += Number(p(a).amountMinor); steps.push(`markup ${p(a).amountMinor} -> ${price}`); break;
      case 'discount_percent': price = Math.round(price * (1 - Number(p(a).percent) / 100)); steps.push(`discount ${p(a).percent}% -> ${price}`); break;
      case 'fixed_price': price = Number(p(a).priceMinor); steps.push(`fixed ${price}`); break;
      default: break;
    }
  }
  let belowMargin = false;
  const floor = actions.find((a) => a.type === 'margin_floor');
  if (floor && basis.costMinor !== null) {
    const min = Math.ceil(basis.costMinor * (1 + Number(p(floor).minMarginPercent) / 100));
    if (price < min) { price = min; steps.push(`margin floor ${p(floor).minMarginPercent}% -> ${price}`); }
  }
  const round = actions.find((a) => a.type === 'round_to');
  if (round) {
    if (p(round).mode === 'nearest' && Number(p(round).step) > 0) { const s = Number(p(round).step); price = Math.round(price / s) * s; }
    if (p(round).mode === 'ending') {
      // the rupee amount ends in e.g. 99: pick the nearest such amount (ties go up)
      const e = Number(p(round).ending ?? 99);
      const major = price / 100;
      const h = Math.floor(major / 100) * 100;
      const cands = [h - 100 + e, h + e, h + 100 + e].filter((x) => x > 0);
      price = cands.reduce((best, c) => (Math.abs(c - major) < Math.abs(best - major) || (Math.abs(c - major) === Math.abs(best - major) && c > best) ? c : best), cands[0]!) * 100;
    }
    steps.push(`round -> ${price}`);
  }
  if (basis.mrpMinor !== null && price > basis.mrpMinor) { price = basis.mrpMinor; steps.push(`capped to MRP ${price}`); }
  if (price < 1) price = 1;
  if (floor && basis.costMinor !== null && price < Math.ceil(basis.costMinor * (1 + Number(p(floor).minMarginPercent) / 100))) belowMargin = true;
  return { priceMinor: price, steps, belowMargin };
}

export interface SaleWindow { salePriceMinor: number | null; saleStartsAt: Date | null; saleEndsAt: Date | null }
export const saleActive = (s: SaleWindow, now: Date): boolean => s.salePriceMinor !== null && (!s.saleStartsAt || s.saleStartsAt <= now) && (!s.saleEndsAt || s.saleEndsAt > now);

/** the price a marketplace should show right now: the sale price while a sale runs, else the marketplace price, else null (follow the variant) */
export const effectivePrice = (row: SaleWindow & { priceMinor: number | null }, now: Date): number | null => (saleActive(row, now) ? row.salePriceMinor : row.priceMinor);

/** bulk change arithmetic */
export type Change = { kind: 'set'; value: number } | { kind: 'percent'; value: number } | { kind: 'amount'; value: number };
export function applyChange(current: number, c: Change): number {
  const next = c.kind === 'set' ? c.value : c.kind === 'percent' ? Math.round(current * (1 + c.value / 100)) : current + c.value;
  return Math.max(1, Math.round(next));
}
