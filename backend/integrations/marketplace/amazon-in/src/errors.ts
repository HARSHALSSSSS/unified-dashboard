import { ConnectorError, defaultHttpError, parseRetryAfter, type HttpResponse } from '@oms/marketplace-core';

/** SP-API error bodies look like { errors: [{ code, message, details }] }; LWA like { error, error_description }. */
export function mapAmazonError(res: HttpResponse): ConnectorError | null {
  const body = res.body as { errors?: Array<{ code?: string; message?: string }>; error?: string; error_description?: string } | null;
  const first = body?.errors?.[0];
  const code = first?.code ?? body?.error;
  const message = first?.message ?? body?.error_description ?? `Amazon request failed (HTTP ${res.status})`;

  // LWA (login) errors: the grant/credentials are wrong or revoked -> the seller must reconnect
  if (body?.error && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied', 'invalid_token'].includes(body.error)) {
    return new ConnectorError('auth', message, { code: body.error });
  }
  if (res.status === 403 || res.status === 401 || code === 'Unauthorized' || code === 'InvalidSignature') return new ConnectorError('auth', message, { code: code ?? 'Unauthorized' });
  if (res.status === 429 || code === 'QuotaExceeded') {
    return new ConnectorError('rate_limited', message, { code: 'QuotaExceeded', retryAfterMs: parseRetryAfter(res.headers) ?? rateLimitHint(res) });
  }
  if (res.status === 404) return new ConnectorError('permanent', message, { code: code ?? 'NotFound' });
  if (res.status === 400 || code === 'InvalidInput') return new ConnectorError('permanent', message, { code: code ?? 'InvalidInput' });
  if (res.status >= 500) return new ConnectorError('transient', message, { code: code ?? 'InternalFailure' });
  return res.status >= 400 ? defaultHttpError(res) : null;
}

/** SP-API reports its steady-state rate in `x-amzn-RateLimit-Limit` (requests/second): wait one interval. */
function rateLimitHint(res: HttpResponse): number {
  const rps = Number(res.headers['x-amzn-ratelimit-limit']);
  return Number.isFinite(rps) && rps > 0 ? Math.ceil(1000 / rps) : 1000;
}
