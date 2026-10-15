export type ConnectorErrorKind =
  | 'auth' // credentials rejected/expired: host refreshes once, then marks the authorization expired
  | 'rate_limited' // 429 / throttled: retry after delay
  | 'transient' // 5xx / network: retry with backoff
  | 'permanent' // 4xx validation etc.: never retry
  | 'unsupported';

export class ConnectorError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly opts: { code?: string; retryAfterMs?: number; cause?: unknown; /** marketplace field/attribute the error refers to */ field?: string } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'ConnectorError';
    this.retryable = kind === 'rate_limited' || kind === 'transient';
  }
  get code(): string { return this.opts.code ?? this.kind; }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** never wait longer than this for a marketplace Retry-After inside one call (the caller / job retry owns longer waits) */
  retryAfterCapMs?: number;
  /** injectable for tests */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ConnectorError }) => void;
}

/** Exponential backoff with full jitter; honours `retryAfterMs`; retries only retryable ConnectorErrors. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rnd = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!(e instanceof ConnectorError) || !e.retryable || attempt >= attempts) throw e;
      const backoff = Math.min(o.maxDelayMs ?? 5_000, (o.baseDelayMs ?? 200) * 2 ** (attempt - 1));
      const retryAfter = Math.min(e.opts.retryAfterMs ?? 0, o.retryAfterCapMs ?? 10_000);
      const delayMs = Math.max(retryAfter, Math.round(rnd() * backoff));
      o.onRetry?.({ attempt, delayMs, error: e });
      await sleep(delayMs);
    }
  }
}
