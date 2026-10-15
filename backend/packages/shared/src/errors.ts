/**
 * Canonical error model. Every failure that crosses a module/HTTP boundary is an AppError
 * with a stable machine-readable `code`. Codes are part of the public API contract.
 */
export const ErrorCodes = {
  // 400
  VALIDATION_FAILED: { status: 400, message: 'Request validation failed' },
  BAD_REQUEST: { status: 400, message: 'Bad request' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, message: 'Idempotency key was reused with a different request' },
  // 401
  UNAUTHENTICATED: { status: 401, message: 'Authentication required' },
  TOKEN_EXPIRED: { status: 401, message: 'Access token expired' },
  TOKEN_INVALID: { status: 401, message: 'Access token invalid' },
  // 403
  FORBIDDEN: { status: 403, message: 'You do not have permission to perform this action' },
  TENANT_SUSPENDED: { status: 403, message: 'Vendor account is not active' },
  // 404
  NOT_FOUND: { status: 404, message: 'Resource not found' },
  // 409
  CONFLICT: { status: 409, message: 'Conflict with current resource state' },
  VERSION_CONFLICT: { status: 409, message: 'Resource was modified by someone else' },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: 'A request with this idempotency key is still in progress' },
  // 428
  PRECONDITION_REQUIRED: { status: 428, message: 'Precondition required' },
  // 429
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  // 5xx
  NOT_IMPLEMENTED: { status: 501, message: 'Not implemented' },
  UPSTREAM_ERROR: { status: 502, message: 'Upstream service error' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service temporarily unavailable' },
  INTERNAL: { status: 500, message: 'Internal server error' },
  // domain-specific
  CAPABILITY_UNSUPPORTED: { status: 422, message: 'This marketplace does not support the requested capability' },
  ACCOUNT_NOT_CONNECTED: { status: 409, message: 'Marketplace account is not connected' },
  INSUFFICIENT_STOCK: { status: 409, message: 'Not enough available stock' },
  INVALID_STATE: { status: 409, message: 'The resource is not in a state that allows this action' },
  LISTING_NOT_READY: { status: 422, message: 'The listing is not ready for this step' },
  EMAIL_NOT_VERIFIED: { status: 403, message: 'Verify your e-mail address to perform this action' },
  INVALID_CREDENTIALS: { status: 401, message: 'Invalid e-mail or password' },
  ACCOUNT_LOCKED: { status: 423, message: 'Account temporarily locked after repeated failed sign-ins' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Unsupported media type' },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

/** Server-side failures whose message is deliberately client-safe and actionable (marketplace outages, not implemented). */
const EXPOSED_5XX = new Set<ErrorCode>(['UPSTREAM_ERROR', 'SERVICE_UNAVAILABLE', 'NOT_IMPLEMENTED']);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** 4xx messages (and a few curated 5xx, see EXPOSED_5XX) are shown to clients; other 5xx are replaced by a generic message. */
  readonly expose: boolean;

  constructor(code: ErrorCode, message?: string, opts: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message ?? ErrorCodes[code].message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = ErrorCodes[code].status;
    this.details = opts.details;
    this.expose = this.status < 500 || EXPOSED_5XX.has(code);
  }
}

export const Errors = {
  notFound: (resource: string, id?: string) =>
    new AppError('NOT_FOUND', `${resource} not found`, { details: { resource, ...(id ? { id } : {}) } }),
  forbidden: (permission?: string) =>
    new AppError('FORBIDDEN', undefined, { details: permission ? { requiredPermission: permission } : undefined }),
  unauthenticated: (message?: string) => new AppError('UNAUTHENTICATED', message),
  validation: (details: Record<string, unknown>) => new AppError('VALIDATION_FAILED', undefined, { details }),
  conflict: (message: string, details?: Record<string, unknown>) => new AppError('CONFLICT', message, { details }),
  notImplemented: (what: string) => new AppError('NOT_IMPLEMENTED', `${what} is not implemented`),
  upstream: (message: string, details?: Record<string, unknown>, cause?: unknown) =>
    new AppError('UPSTREAM_ERROR', message, { details, cause }),
};

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
