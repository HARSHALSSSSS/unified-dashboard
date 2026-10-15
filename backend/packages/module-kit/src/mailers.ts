import type { Logger } from '@oms/logging';
import type { MailMessage, Mailer } from './index';

/** Development mailer: writes the message to the log. Links (which contain one-time tokens) are logged only when asked. */
export class LogMailer implements Mailer {
  constructor(private readonly logger: Logger, private readonly includeLinks: boolean) {}
  async send(m: MailMessage): Promise<void> {
    this.logger.info({ to: m.to, kind: m.kind, subject: m.subject, ...(this.includeLinks ? { link: m.data.link } : {}) }, 'mail (not delivered: log mailer)');
  }
}

/** Test mailer: keeps messages in memory so tests can read tokens out of them. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage): Promise<void> { this.sent.push(m); }
  last(kind?: MailMessage['kind'], to?: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => (!kind || m.kind === kind) && (!to || m.to === to));
  }
  clear(): void { this.sent.length = 0; }
}
