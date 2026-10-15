import type { Tx } from '@oms/database';
import { businessHealth, dailyRevenueSeries, inventoryHealth, overview, productHealth, productPerformance, profitability, DEFAULT_THRESHOLDS } from '@oms/mod-analytics';
import { detectAnomalies } from './detect';

/**
 * Natural-language questions answered from REAL data. A question is routed to an intent; the intent's retriever runs the same
 * analytics the dashboards use; the answer text is composed from those numbers. If no intent matches, the assistant says what it can
 * answer instead of guessing. (An optional language model may re-word the result; it never sees more than these facts.)
 */
export type Intent = 'stockout_risk' | 'low_stock' | 'excess_stock' | 'top_products' | 'sales_summary' | 'returns' | 'cancellations' | 'business_issues' | 'product_quality' | 'profitability' | 'anomalies' | 'unknown';

const INTENTS: Array<{ intent: Intent; any: RegExp }> = [
  { intent: 'stockout_risk', any: /(run out|running out|stock ?out|out of stock|going to sell out|sell out|run short|short of stock)/i },
  { intent: 'low_stock', any: /(low stock|reorder|re-order|restock|replenish|need to order)/i },
  { intent: 'excess_stock', any: /(excess|overstock|dead stock|slow[- ]moving|not selling|aging|ageing|old stock|too much stock)/i },
  { intent: 'top_products', any: /(best[- ]sell|top (selling )?product|top sku|most sold|popular|fast[- ]moving|which products? (sell|perform))/i },
  { intent: 'profitability', any: /(profit|margin|contribution|earning|making money|loss)/i },
  { intent: 'returns', any: /(return|refund|rto)/i },
  { intent: 'cancellations', any: /(cancel)/i },
  { intent: 'anomalies', any: /(unusual|anomal|spike|drop|sudden|weird|strange|abnormal)/i },
  { intent: 'product_quality', any: /(listing (error|issue)|missing (info|data|image|description)|incomplete|catalog(ue)? quality|product (quality|health)|rejected listing)/i },
  { intent: 'business_issues', any: /(problem|issue|wrong|stuck|bottleneck|delay|failing|failed|attention|health|risk)/i },
  { intent: 'sales_summary', any: /(sales|revenue|orders?|how (are|is) (we|the business|my business)|summary|performance|doing)/i },
];

export const classify = (q: string): Intent => INTENTS.find((i) => i.any.test(q))?.intent ?? 'unknown';
const inr = (minor: number): string => `INR ${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const list = <T>(xs: T[], f: (x: T) => string, max = 5): string => xs.slice(0, max).map(f).join('; ');
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

export interface Answer { intent: Intent; answer: string; data: unknown; sources: string[]; confidence: 'data' | 'none' }

export async function answerQuestion(tx: Tx, vendorId: string, question: string): Promise<Answer> {
  const intent = classify(question);
  const horizon = /\b(this|next) week\b|\b7 days\b/i.test(question) ? 7 : /\b(this|next) month\b|\b30 days\b/i.test(question) ? 30 : 7;
  switch (intent) {
    case 'stockout_risk': {
      const h = await inventoryHealth(tx, vendorId, { ...DEFAULT_THRESHOLDS, riskDays: horizon }, 10);
      const risk = [...h.outOfStock, ...h.stockoutRisk];
      const text = risk.length === 0
        ? `No product is projected to run out within ${horizon} days based on the last ${h.thresholds.windowDays} days of sales (${h.skusAnalysed} SKUs checked).`
        : `${risk.length} product(s) are out of stock or projected to run out within ${horizon} days: ${list(risk, (f) => `${f.sku} (${f.available} left, selling ${f.unitsPerDay}/day${f.daysOfCover !== null ? `, about ${f.daysOfCover} days of cover` : ''}${f.stockoutDate ? `, runs out around ${f.stockoutDate}` : ''})`)}.`;
      return { intent, answer: text, data: { horizonDays: horizon, outOfStock: h.outOfStock, stockoutRisk: h.stockoutRisk }, sources: ['inventory (stock levels)', 'analytics_daily_products (units sold)'], confidence: 'data' };
    }
    case 'low_stock': {
      const h = await inventoryHealth(tx, vendorId, DEFAULT_THRESHOLDS, 10);
      const rows = [...h.lowStock, ...h.outOfStock];
      return { intent, answer: rows.length ? `${rows.length} product(s) are at or below their reorder level or out of stock: ${list(rows, (f) => `${f.sku} (${f.available} available${f.reorderLevel !== null ? `, reorder level ${f.reorderLevel}` : ''}${f.suggestedReorderUnits ? `, suggest ordering ${f.suggestedReorderUnits}` : ''})`)}.` : 'No product is below its reorder level.', data: { lowStock: h.lowStock, outOfStock: h.outOfStock }, sources: ['inventory'], confidence: 'data' };
    }
    case 'excess_stock': {
      const h = await inventoryHealth(tx, vendorId, DEFAULT_THRESHOLDS, 10);
      const rows = [...h.excess, ...h.aging];
      return { intent, answer: rows.length ? `${h.counts.excess} product(s) hold more than ${h.thresholds.excessDays} days of stock and ${h.counts.aging} have sat for over ${h.thresholds.agingDays} days with slow sales: ${list(rows, (f) => `${f.sku} (${f.available} units${f.ageDays !== null ? `, last received ${f.ageDays} days ago` : ''}, selling ${f.unitsPerDay}/day)`)}.` : 'No excess or aging stock was found.', data: { excess: h.excess, aging: h.aging, slowMoving: h.slowMoving.slice(0, 10) }, sources: ['inventory', 'inventory_movements (last receipt)', 'analytics_daily_products'], confidence: 'data' };
    }
    case 'top_products': {
      const range = { from: daysAgo(29), to: today() };
      const top = await productPerformance(tx, vendorId, range, { sort: 'revenue', limit: 5 });
      return { intent, answer: top.length ? `Top products by revenue in the last 30 days: ${list(top, (p) => `${p.sku} (${inr(p.revenueMinor)}, ${p.units} units${p.unitsChangePercent !== null ? `, ${p.unitsChangePercent >= 0 ? '+' : ''}${p.unitsChangePercent}% vs the previous 30 days` : ''})`)}.` : 'There were no sales in the last 30 days.', data: { range, products: top }, sources: ['analytics_daily_products'], confidence: 'data' };
    }
    case 'returns': {
      const range = { from: daysAgo(29), to: today() };
      const o = await overview(tx, vendorId, range);
      const worst = await productPerformance(tx, vendorId, range, { sort: 'returns', limit: 3 });
      return { intent, answer: `Return rate over the last 30 days is ${(o.rates.returnRate * 100).toFixed(1)}% of units sold; refunds processed: ${inr(o.refundsMinor)}.${worst.some((w) => w.returnedUnits > 0) ? ` Most returned: ${list(worst.filter((w) => w.returnedUnits > 0), (w) => `${w.sku} (${w.returnedUnits} returned, ${(w.returnRate * 100).toFixed(1)}%)`)}.` : ''}`, data: { rates: o.rates, refundsMinor: o.refundsMinor, mostReturned: worst }, sources: ['analytics_daily_sales', 'analytics_daily_products'], confidence: 'data' };
    }
    case 'cancellations': {
      const range = { from: daysAgo(29), to: today() };
      const o = await overview(tx, vendorId, range);
      return { intent, answer: `Cancellation rate over the last 30 days is ${(o.rates.cancellationRate * 100).toFixed(1)}% of orders placed (${o.kpis.orders!.value} orders kept).`, data: { rates: o.rates }, sources: ['analytics_daily_sales'], confidence: 'data' };
    }
    case 'sales_summary': {
      const range = { from: daysAgo(29), to: today() };
      const o = await overview(tx, vendorId, range);
      const k = o.kpis;
      const ch = (x: { changePercent: number | null }) => (x.changePercent === null ? 'no previous period to compare' : `${x.changePercent >= 0 ? '+' : ''}${x.changePercent}% vs the previous 30 days`);
      return { intent, answer: `Last 30 days: ${k.orders!.value} orders (${ch(k.orders!)}), revenue ${inr(k.revenueMinor!.value)} (${ch(k.revenueMinor!)}), average order ${inr(k.averageOrderValueMinor!.value)}. Cancellation rate ${(o.rates.cancellationRate * 100).toFixed(1)}%, return rate ${(o.rates.returnRate * 100).toFixed(1)}%.`, data: o, sources: ['analytics_daily_sales'], confidence: 'data' };
    }
    case 'profitability': {
      const range = { from: daysAgo(29), to: today() };
      const p = await profitability(tx, vendorId, range, 'marketplace');
      const t = p.total;
      const text = t.contributionMinor !== null
        ? `Contribution over the last 30 days is ${inr(t.contributionMinor)} (${t.marginPercent}% of revenue, data ${t.completeness}).`
        : `A real contribution figure cannot be given yet: ${t.missing.join(', ')} ${t.missing.length === 1 ? 'is' : 'are'} missing. Revenue is ${inr(t.revenue.amountMinor!)}; revenue minus the known costs is ${inr(t.knownPartMinor)} (not a profit figure). Add the missing costs (product cost prices, marketplace fees via order financials or a fee profile) to see profitability.`;
      return { intent, answer: text, data: p, sources: ['orders', 'order_items', 'shipments (courier cost)', 'order_financials', 'fee_profiles'], confidence: 'data' };
    }
    case 'anomalies': {
      const series = await dailyRevenueSeries(tx, vendorId, 40);
      const an = detectAnomalies(series);
      return { intent, answer: an.length ? `Unusual activity: ${an.map((a) => a.message).join('; ')}.` : 'Nothing unusual: recent days are within the normal range of the last two weeks.', data: { anomalies: an }, sources: ['analytics_daily_sales'], confidence: 'data' };
    }
    case 'product_quality': {
      const p = await productHealth(tx, vendorId, 5);
      return { intent, answer: `${p.products} products checked, average completeness ${p.averageScore ?? 'n/a'}/100; ${p.complete} are complete. Most common gaps: ${list(Object.entries(p.issueCounts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]), ([k, c]) => `${k.replace(/_/g, ' ')} (${c})`, 4) || 'none'}.${p.openOrderLinesWithUnmappedSku ? ` ${p.openOrderLinesWithUnmappedSku} open order line(s) have an unmapped SKU.` : ''}`, data: p, sources: ['products', 'product_variants', 'documents', 'marketplace_listings'], confidence: 'data' };
    }
    case 'business_issues': {
      const b = await businessHealth(tx, vendorId);
      return { intent, answer: b.issues.length ? `Business health ${b.score}/100 (${b.grade.replace('_', ' ')}). ${b.issues.length} problem(s): ${list(b.issues, (i) => `${i.message} (${i.count})`, 6)}.` : `Business health ${b.score}/100: no operational problems found.`, data: b, sources: ['orders', 'fulfillments', 'shipments', 'return_orders', 'sync_jobs', 'marketplace_accounts'], confidence: 'data' };
    }
    default:
      return { intent: 'unknown', answer: 'I can only answer from your business data. Try: which products are likely to run out this week? What are my best sellers? How are sales doing? What is stuck in operations? Which products have excess or aging stock? What is my return rate? Is anything unusual? What is my profitability?', data: null, sources: [], confidence: 'none' };
  }
}
