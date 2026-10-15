/**
 * Resilience primitives for talking to marketplaces.
 *  - CircuitBreaker: after `threshold` consecutive infrastructure failures (timeouts, 5xx, 429) a marketplace account is not called
 *    for `openMs` (fail fast, protect the marketplace and our workers); then ONE probe call is allowed (half-open): success closes
 *    the circuit, failure re-opens it. Authentication / validation errors never count: they are not an outage.
 *  - withTimeout: no call may hang a worker forever.
 */
export class CircuitBreaker {
  private readonly state = new Map<string, { failures: number; openedAt: number | null; probing: boolean }>();
  constructor(private readonly threshold = 5, private readonly openMs = 60_000, private readonly now: () => number = Date.now) {}

  /** null = go ahead; a number = the circuit is open, retry after that many milliseconds */
  check(key: string): number | null {
    const s = this.state.get(key);
    if (!s || s.openedAt === null) return null;
    const elapsed = this.now() - s.openedAt;
    if (elapsed < this.openMs) return this.openMs - elapsed;
    if (s.probing) return Math.max(1000, this.openMs / 4); // one probe at a time
    s.probing = true; // half-open: let this call through
    return null;
  }
  success(key: string): void { this.state.delete(key); }
  failure(key: string): void {
    const s = this.state.get(key) ?? { failures: 0, openedAt: null, probing: false };
    s.failures += 1;
    s.probing = false;
    if (s.failures >= this.threshold || s.openedAt !== null) s.openedAt = this.now(); // (re)open; a failed probe re-opens at once
    this.state.set(key, s);
  }
  isOpen(key: string): boolean { return this.check(key) !== null; }
  reset(): void { this.state.clear(); }
}

export class TimeoutError extends Error { constructor(ms: number) { super(`operation timed out after ${ms} ms`); this.name = 'TimeoutError'; } }

export async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(ms)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
