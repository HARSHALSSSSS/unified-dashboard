import { ConnectorError, defaultHttpError, parseRetryAfter, type HttpResponse } from '@oms/marketplace-core';
import type { FkError } from './dto';

/** Flipkart returns OAuth errors as { error, error_description } and API errors as { message | errors[] }. */
export function mapFlipkartError(res: HttpResponse): ConnectorError | null {
  const b = (res.body ?? {}) as FkError;
  const first = b.errors?.[0];
  const message = b.error_description ?? b.message ?? first?.message ?? `Flipkart request failed (HTTP ${res.status})`;
  if (b.error && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token', 'access_denied'].includes(b.error)) return new ConnectorError('auth', message, { code: b.error });
  if (res.status === 401 || res.status === 403) return new ConnectorError('auth', message, { code: `http_${res.status}` });
  if (res.status === 429) return new ConnectorError('rate_limited', message, { code: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers) ?? 1000 });
  if (res.status === 400 || res.status === 422) return new ConnectorError('permanent', message, { code: first?.code ?? 'bad_request', field: first?.attribute });
  if (res.status === 404) return new ConnectorError('permanent', message, { code: 'not_found' });
  if (res.status >= 500) return new ConnectorError('transient', message, { code: `http_${res.status}`, retryAfterMs: parseRetryAfter(res.headers) });
  return res.status >= 400 ? defaultHttpError(res) : null;
}
