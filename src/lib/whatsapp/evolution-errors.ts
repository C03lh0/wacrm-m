/**
 * Normalized error codes for the Evolution API integration. Route
 * handlers and provider adapters throw/catch this type and map it to
 * a safe, pre-written user-facing message — the raw Evolution error
 * (`cause`) is logged server-side only and never serialized to the
 * client, so nothing about the self-hosted instance's internals leaks.
 */

export type EvolutionErrorCode =
  | 'EVOLUTION_UNAVAILABLE'
  | 'EVOLUTION_AUTH_ERROR'
  | 'EVOLUTION_INSTANCE_ERROR'
  | 'EVOLUTION_CONNECTION_ERROR'
  | 'QR_CODE_UNAVAILABLE'
  | 'WHATSAPP_DISCONNECTED'
  | 'MESSAGE_SEND_FAILED'
  | 'MEDIA_DOWNLOAD_FAILED'

const DEFAULT_MESSAGES: Record<EvolutionErrorCode, string> = {
  EVOLUTION_UNAVAILABLE:
    'The Evolution API server is unreachable. Please try again shortly.',
  EVOLUTION_AUTH_ERROR:
    'The server could not authenticate with the Evolution API. Contact your administrator.',
  EVOLUTION_INSTANCE_ERROR:
    'Evolution API could not create or manage the WhatsApp instance.',
  EVOLUTION_CONNECTION_ERROR:
    'The WhatsApp connection could not be found or is no longer valid.',
  QR_CODE_UNAVAILABLE:
    'The QR code is not available right now. Please request a new one.',
  WHATSAPP_DISCONNECTED:
    'WhatsApp is not connected. Please reconnect via QR code.',
  MESSAGE_SEND_FAILED: 'The message could not be sent. Please try again.',
  MEDIA_DOWNLOAD_FAILED: 'The media attached to this message could not be processed.',
}

const STATUS_BY_CODE: Record<EvolutionErrorCode, number> = {
  EVOLUTION_UNAVAILABLE: 503,
  EVOLUTION_AUTH_ERROR: 502,
  EVOLUTION_INSTANCE_ERROR: 502,
  EVOLUTION_CONNECTION_ERROR: 404,
  QR_CODE_UNAVAILABLE: 409,
  WHATSAPP_DISCONNECTED: 409,
  MESSAGE_SEND_FAILED: 502,
  MEDIA_DOWNLOAD_FAILED: 502,
}

export class EvolutionApiError extends Error {
  readonly code: EvolutionErrorCode
  readonly status: number
  /** Raw upstream error, for server-side logging only — never serialize this to a client response. */
  readonly cause?: unknown

  constructor(code: EvolutionErrorCode, cause?: unknown, message?: string) {
    super(message || DEFAULT_MESSAGES[code])
    this.name = 'EvolutionApiError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.cause = cause
  }
}

/** Safe `{ error: { code, message } }` body — never includes `cause`. */
export function evolutionErrorResponseBody(err: EvolutionApiError) {
  return { error: { code: err.code, message: err.message } }
}
