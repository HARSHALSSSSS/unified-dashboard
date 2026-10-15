import { ConnectorError } from './connector-error';

/**
 * HTTP layer shared by every connector. Connectors never call `fetch` directly: they receive an `HttpTransport`.
 *  - FetchTransport     real network (live or the marketplace's official sandbox URL)
 *  - SimulatedTransport in-process sandbox (see simulation.ts): deterministic tests and development without access
 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** absolute URL, or a path (resolved against the client's baseUrl) */
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | Array<string | number>>;
  /** JSON body (object) */
  json?: unknown;
  /** application/x-www-form-urlencoded body */
  form?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** lower-cased header names */
  headers: Record<string, string>;
  body: unknown;
  text: string;
}

export interface HttpTransport { send(req: HttpRequest): Promise<HttpResponse> }

export function buildUrl(base: string, url: string, query?: HttpRequest['query']): string {
  const u = new URL(url, base.endsWith('/') ? base : `${base}/`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return u.toString();
}

/** Retry-After as milliseconds (seconds or HTTP-date). */
export function parseRetryAfter(headers: Record<string, string>, now = Date.now()): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  // a hostile / buggy upstream must not be able to park a job for years (or make a Date invalid): cap at 10 minutes
  const CAP = 10 * 60_000;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(CAP, Math.max(0, Math.round(secs * 1000)));
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.min(CAP, Math.max(0, at - now));
}

/** Generic HTTP-status -> ConnectorError mapping; connectors refine it with their own error codes first. */
export function defaultHttpError(res: HttpResponse, what = 'request'): ConnectorError {
  const msg = extractMessage(res.body) ?? `${what} failed with HTTP ${res.status}`;
  // only 401 means "the credentials are no good". A 403 is usually "not allowed to do THIS" (one listing, one feature) and must not
  // switch the whole account off.
  if (res.status === 401) return new ConnectorError('auth', msg, { code: 'http_401' });
  if (res.status === 403) return new ConnectorError('permanent', msg, { code: 'http_403' });
  if (res.status === 429) return new ConnectorError('rate_limited', msg, { code: 'http_429', retryAfterMs: parseRetryAfter(res.headers) ?? 1000 });
  if (res.status === 408 || res.status >= 500) return new ConnectorError('transient', msg, { code: `http_${res.status}`, retryAfterMs: parseRetryAfter(res.headers) });
  return new ConnectorError('permanent', msg, { code: `http_${res.status}` });
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const first = Array.isArray(b.errors) ? (b.errors[0] as Record<string, unknown> | undefined) : undefined;
  const m = b.message ?? b.error_description ?? b.error ?? first?.message ?? first?.detail;
  return typeof m === 'string' ? m.slice(0, 300) : undefined;
}

export class FetchTransport implements HttpTransport {
  constructor(private readonly defaultTimeoutMs = 20_000) {}

  async send(req: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
    let body: string | undefined;
    if (req.json !== undefined) { body = JSON.stringify(req.json); headers['content-type'] ??= 'application/json'; }
    else if (req.form) { body = new URLSearchParams(req.form).toString(); headers['content-type'] ??= 'application/x-www-form-urlencoded'; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const res = await fetch(buildUrl(req.url, req.url, req.query), { method: req.method, headers, body, signal: controller.signal });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, headers: Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])), body: parsed, text };
    } catch (e) {
      const aborted = (e as { name?: string }).name === 'AbortError';
      throw new ConnectorError('transient', aborted ? 'Marketplace request timed out' : 'Could not reach the marketplace', { code: aborted ? 'timeout' : 'network', cause: e });
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface ClientOptions {
  baseUrl: string;
  transport: HttpTransport;
  headers?: Record<string, string> | (() => Record<string, string>);
  /** refine HTTP errors with marketplace error codes; return null to fall back to the generic mapping */
  mapError?: (res: HttpResponse, req: HttpRequest) => ConnectorError | null;
  /** observes every response (adaptive rate limiting, quota headers) */
  onResponse?: (res: HttpResponse, req: HttpRequest) => void;
  timeoutMs?: number;
}

/** Thin JSON client: URL building, default headers, error mapping. Marketplace clients compose it. */
export class MarketplaceHttpClient {
  constructor(private readonly o: ClientOptions) {}

  async request<T = unknown>(req: Omit<HttpRequest, 'url'> & { path: string }): Promise<{ status: number; headers: Record<string, string>; body: T }> {
    const { path, ...rest } = req;
    const headers = { ...(typeof this.o.headers === 'function' ? this.o.headers() : this.o.headers), ...rest.headers };
    const full: HttpRequest = { ...rest, headers, url: buildUrl(this.o.baseUrl, path, rest.query), query: undefined, timeoutMs: rest.timeoutMs ?? this.o.timeoutMs };
    const res = await this.o.transport.send(full);
    this.o.onResponse?.(res, full);
    if (res.status >= 400) throw this.o.mapError?.(res, full) ?? defaultHttpError(res, `${req.method} ${path}`);
    return { status: res.status, headers: res.headers, body: res.body as T };
  }

  get = <T>(path: string, query?: HttpRequest['query'], headers?: Record<string, string>) => this.request<T>({ method: 'GET', path, query, headers });
  post = <T>(path: string, json?: unknown, headers?: Record<string, string>) => this.request<T>({ method: 'POST', path, json, headers });
  put = <T>(path: string, json?: unknown, query?: HttpRequest['query']) => this.request<T>({ method: 'PUT', path, json, query });
  patch = <T>(path: string, json?: unknown, query?: HttpRequest['query']) => this.request<T>({ method: 'PATCH', path, json, query });
  delete = <T>(path: string, query?: HttpRequest['query']) => this.request<T>({ method: 'DELETE', path, query });
}
