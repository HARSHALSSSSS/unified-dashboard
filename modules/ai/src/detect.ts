/** Anomaly detection on daily series (pure, unit-tested): a day that is far outside the vendor's own recent normal. */
export interface DayPoint { day: string; orders: number; cancelled: number; returnedUnits: number; units: number; revenueMinor: number }
export interface Anomaly { metric: 'revenue' | 'orders' | 'cancellation_rate' | 'return_rate'; day: string; direction: 'up' | 'down'; value: number; baselineMean: number; baselineStd: number; zScore: number; message: string }

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const std = (xs: number[], m: number): number => Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, xs.length));

/**
 * Compares the most recent COMPLETE days with the 14 days before them. Needs at least 14 days of history with some activity; below
 * that it reports nothing (no baseline, no anomaly). z >= 2.5 and a meaningful absolute change are required, so a quiet shop is not
 * flagged for going from 1 order to 2.
 */
export function detectAnomalies(series: DayPoint[], opts: { lookbackDays?: number; recentDays?: number; z?: number } = {}): Anomaly[] {
  const recentDays = opts.recentDays ?? 1;
  const lookback = opts.lookbackDays ?? 14;
  const zMin = opts.z ?? 2.5;
  if (series.length < lookback + recentDays) return [];
  const sorted = [...series].sort((a, b) => a.day.localeCompare(b.day));
  const base = sorted.slice(-(lookback + recentDays), -recentDays);
  const recent = sorted.slice(-recentDays);
  const out: Anomaly[] = [];
  const check = (metric: Anomaly['metric'], pick: (p: DayPoint) => number, minAbs: number, fmt: (v: number) => string, minRel = 0) => {
    const xs = base.map(pick);
    const m = mean(xs);
    if (m === 0 && xs.every((x) => x === 0)) return;
    const sd = Math.max(std(xs, m), m * 0.05, 0.0001);
    for (const p of recent) {
      const v = pick(p);
      const z = (v - m) / sd;
      if (Math.abs(z) >= zMin && Math.abs(v - m) >= Math.max(minAbs, m * minRel)) {
        out.push({ metric, day: p.day, direction: z > 0 ? 'up' : 'down', value: Math.round(v * 1000) / 1000, baselineMean: Math.round(m * 1000) / 1000, baselineStd: Math.round(sd * 1000) / 1000, zScore: Math.round(z * 10) / 10, message: `${metric.replace('_', ' ')} on ${p.day} was ${fmt(v)} against a usual ${fmt(m)}` });
      }
    }
  };
  check('revenue', (p) => p.revenueMinor, 100_000, (v) => `INR ${(v / 100).toFixed(2)}`, 0.3);
  check('orders', (p) => p.orders, 3, (v) => `${Math.round(v * 10) / 10} orders`, 0.3);
  check('cancellation_rate', (p) => (p.orders + p.cancelled > 0 ? p.cancelled / (p.orders + p.cancelled) : 0), 0.1, (v) => `${Math.round(v * 1000) / 10}%`);
  check('return_rate', (p) => (p.units > 0 ? p.returnedUnits / p.units : 0), 0.1, (v) => `${Math.round(v * 1000) / 10}%`);
  return out;
}
