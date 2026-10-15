import { AsyncLocalStorage } from 'node:async_hooks';
import { pino, type Logger } from 'pino';

export type { Logger } from 'pino';

/** Ambient request/job context. Every log line automatically carries these fields. */
export interface LogContext {
  requestId?: string;
  correlationId?: string;
  vendorId?: string | null;
  actorId?: string | null;
  jobId?: string;
  queue?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => storage.run({ ...storage.getStore(), ...ctx }, fn);
export const getContext = (): LogContext => storage.getStore() ?? {};
/** Mutate the current context (e.g. once authentication has resolved the tenant). */
export const enrichContext = (patch: Partial<LogContext>): void => {
  const s = storage.getStore();
  if (s) Object.assign(s, patch);
};

/** Paths that must never reach logs. Applied to every logger. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  '*.client_secret',
  '*.clientSecret',
  '*.credentials',
  '*.encryptedCredentials',
  '*.apiKey',
  '*.secret',
  // deeper paths (request bodies / nested payloads are not logged today; this keeps it that way if someone logs one)
  'req.body.password', 'req.body.currentPassword', 'req.body.newPassword', 'req.body.token', 'req.body.refreshToken', 'req.body.credentials', 'body.*', 'params',
  'err.params', 'err.cause.params', 'err.query.params',
];

export interface LoggerConfig {
  level: string;
  service: string;
  version?: string;
  pretty?: boolean;
}

export function createLogger(cfg: LoggerConfig): Logger {
  return pino({
    level: cfg.level,
    base: { service: cfg.service, version: cfg.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Ambient context (requestId, vendorId, ...) is injected into every line.
    mixin: () => getContext(),
    ...(cfg.pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } } : {}),
  });
}
