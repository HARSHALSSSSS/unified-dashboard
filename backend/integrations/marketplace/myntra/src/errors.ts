import { ConnectorError, defaultHttpError, parseRetryAfter, type HttpResponse } from '@oms/marketplace-core';
import type { MynError } from './dto';

export function mapMyntraError(res: HttpResponse): ConnectorError | null {
  const b = (res.body ?? {}) as MynError;
  const message = b.message ?? `Myntra request failed (HTTP ${res.status})`;
  if (res.status === 401 || res.status === 403) return new ConnectorError('auth', message, { code: b.code ?? `http_${res.status}` });
  if (res.status === 429) return new ConnectorError('rate_limited', message, { code: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers) ?? 2000 });
  if (res.status === 404) return new ConnectorError('permanent', message, { code: 'not_found' });
  if (res.status === 400 || res.status === 409 || res.status === 422) return new ConnectorError('permanent', message, { code: b.code ?? 'bad_request', field: b.field });
  if (res.status >= 500) return new ConnectorError('transient', message, { code: `http_${res.status}`, retryAfterMs: parseRetryAfter(res.headers) });
  return res.status >= 400 ? defaultHttpError(res) : null;
}
