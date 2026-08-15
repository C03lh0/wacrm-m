/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Extracted from send-message.ts so provider adapters (which
 * send-message.ts itself depends on via provider-factory.ts) can throw
 * this type without creating an import cycle. Re-exported from
 * send-message.ts unchanged for every existing caller.
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}
