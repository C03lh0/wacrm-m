/**
 * Evolution API raw REST client — the Evolution equivalent of
 * ../meta-api.ts. Same style: standalone async functions with a
 * single named-args object each (no class), so a typo in argument
 * order surfaces as a TypeScript error instead of a runtime mismatch.
 *
 * Endpoint shapes below were cross-checked against
 * docs.evolutionfoundation.com.br (the current official Evolution API
 * docs — doc.evolution-api.com redirects there) plus a community
 * integration gist and GitHub issue history. Most instance-management
 * endpoints are CONFIRMED by the official docs (marked per-function
 * below). `sendText` and `sendMedia` have CONFLICTING sources — see
 * their own comments — and could not be resolved without a live
 * instance; docs/evolution-api.md tracks the full list of what's
 * confirmed vs. still uncertain, plus a recommendation to check your
 * own instance's Swagger/OpenAPI page (usually `{EVOLUTION_API_URL}/docs`
 * or `/manager`) before relying on those two in production.
 *
 * EVOLUTION_API_URL / EVOLUTION_API_KEY are read from process.env at
 * call time (never at module load) so a missing/late env var fails
 * the specific call, not the whole module import.
 */

import { EvolutionApiError } from '../evolution-errors'
import type { EvolutionMessagePayload } from '../evolution-webhook-handlers'

export type EvolutionMediaKind = 'image' | 'video' | 'document' | 'audio'

function evolutionBaseUrl(): string {
  const url = process.env.EVOLUTION_API_URL
  if (!url) {
    throw new EvolutionApiError(
      'EVOLUTION_UNAVAILABLE',
      undefined,
      'EVOLUTION_API_URL is not configured.'
    )
  }
  return url.replace(/\/+$/, '')
}

/**
 * Guards persistEvolutionMedia's inbound-media download
 * (evolution-webhook-handlers.ts) against SSRF: `imageMessage.url` etc.
 * arrive inside a webhook payload from Evolution, so an unguarded
 * `fetch(mediaUrl)` would let anything that can shape that payload make
 * the server request an arbitrary host — including internal services
 * unreachable from outside. Self-hosted Evolution instances commonly
 * run on `localhost` or a private Docker network, so the general
 * "reject all private IPs" guard (src/lib/webhooks/ssrf.ts, built for
 * admin-supplied outbound webhook URLs) would wrongly block the normal
 * case here. Instead, trust only the same host the operator already
 * configured and authenticates against — i.e. EVOLUTION_API_URL itself.
 */
export function isAllowedEvolutionMediaUrl(rawUrl: string): boolean {
  let media: URL
  try {
    media = new URL(rawUrl)
  } catch {
    return false
  }
  if (media.protocol !== 'http:' && media.protocol !== 'https:') return false

  const base = process.env.EVOLUTION_API_URL
  if (!base) return false
  let baseUrl: URL
  try {
    baseUrl = new URL(base)
  } catch {
    return false
  }

  return media.host === baseUrl.host
}

function evolutionAuthHeaders(): Record<string, string> {
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!apiKey) {
    throw new EvolutionApiError(
      'EVOLUTION_AUTH_ERROR',
      undefined,
      'EVOLUTION_API_KEY is not configured.'
    )
  }
  // CONFIRMED (official docs + community gist, both agree): Evolution
  // authenticates instance-management and send calls via a plain
  // `apikey` header, not a Bearer token.
  return { apikey: apiKey }
}

async function evolutionFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = `${evolutionBaseUrl()}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...evolutionAuthHeaders(),
        ...init.headers,
      },
    })
  } catch (err) {
    // Network failure (DNS, connection refused, timeout) — the
    // Evolution server itself is unreachable.
    throw new EvolutionApiError('EVOLUTION_UNAVAILABLE', err)
  }
  return response
}

async function throwEvolutionError(
  response: Response,
  fallbackCode: 'EVOLUTION_INSTANCE_ERROR' | 'EVOLUTION_CONNECTION_ERROR' | 'MESSAGE_SEND_FAILED'
): Promise<never> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  if (response.status === 401 || response.status === 403) {
    throw new EvolutionApiError('EVOLUTION_AUTH_ERROR', body)
  }
  if (response.status === 404) {
    throw new EvolutionApiError('EVOLUTION_CONNECTION_ERROR', body)
  }
  if (response.status >= 500) {
    throw new EvolutionApiError('EVOLUTION_UNAVAILABLE', body)
  }
  throw new EvolutionApiError(fallbackCode, body)
}

// ============================================================
// Instance lifecycle
// ============================================================

export interface CreateInstanceArgs {
  instanceName: string
  /** If the target version accepts webhook config inline at creation. */
  webhookUrl?: string
  webhookEvents?: string[]
  /**
   * Custom headers Evolution should send with every webhook delivery —
   * used to carry the connection's auth secret (`Authorization: Bearer
   * <secret>`) so it never appears in the webhook URL itself (URLs are
   * commonly captured in access/proxy logs). MIXED EVIDENCE: the
   * current official docs (docs.evolutionfoundation.com.br/evolution-api/
   * set-webhook) show a `headers` object field in the request schema
   * with a worked example — but two GitHub feature requests asking for
   * exactly this (#1933, #2276, both closed "not planned") suggest it
   * may not have actually worked in earlier self-hosted releases, or
   * only ships on a hosted/cloud tier. If the target deployment doesn't
   * forward custom headers, the secret in these headers is simply
   * never presented and verifyEvolutionWebhookAuth falls back to
   * skipping the check (see that function's own comment) — confirm
   * against your instance rather than trusting this as a real defense.
   */
  webhookHeaders?: Record<string, string>
}

export interface CreateInstanceResult {
  instanceName: string
  /** Present when the create call itself returns an initial QR. */
  qrCode?: string
}

export async function createInstance(
  args: CreateInstanceArgs
): Promise<CreateInstanceResult> {
  const { instanceName, webhookUrl, webhookEvents, webhookHeaders } = args
  const body: Record<string, unknown> = {
    instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  }
  if (webhookUrl) {
    // CONFIRMED nested under `webhook` here (unlike the standalone
    // /webhook/set/{name} endpoint — see setInstanceWebhook's comment)
    // per docs.evolutionfoundation.com.br/evolution-api/create-instance's
    // example request body. `base64: true` mirrors setInstanceWebhook's
    // own flag, in case this deployment honors the inline config
    // instead of requiring the separate webhook/set call.
    body.webhook = {
      url: webhookUrl,
      events: webhookEvents ?? DEFAULT_WEBHOOK_EVENTS,
      base64: true,
      ...(webhookHeaders ? { headers: webhookHeaders } : {}),
    }
  }
  const response = await evolutionFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_INSTANCE_ERROR')
  }
  const data = (await response.json()) as {
    instance?: { instanceName?: string }
    qrcode?: { base64?: string }
  }
  return {
    instanceName: data.instance?.instanceName ?? instanceName,
    qrCode: data.qrcode?.base64,
  }
}

export const DEFAULT_WEBHOOK_EVENTS = [
  'QRCODE_UPDATED',
  'CONNECTION_UPDATE',
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'SEND_MESSAGE',
]

export interface SetInstanceWebhookArgs {
  instanceName: string
  url: string
  events?: string[]
  /** See CreateInstanceArgs.webhookHeaders. */
  headers?: Record<string, string>
}

/**
 * CONFIRMED against a live v2.3.7 instance: the docs site's "top-level,
 * no wrapper" shape is wrong for this version. POSTing the fields at
 * the top level gets rejected with 400 `instance requires property
 * "webhook"`; nesting everything under a `webhook` key (same shape
 * /instance/create uses for its inline config) returns 201. Reproduced
 * directly against the running container with curl on 2026-08-12.
 *
 * `base64: true` is set explicitly so Evolution inlines inbound media
 * as base64 in the MESSAGES_UPSERT payload — evolution-webhook-handlers.ts
 * already prefers that path over fetching a temporary URL.
 */
export async function setInstanceWebhook(args: SetInstanceWebhookArgs): Promise<void> {
  const { instanceName, url, events, headers } = args
  const response = await evolutionFetch(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url,
        events: events ?? DEFAULT_WEBHOOK_EVENTS,
        base64: true,
        ...(headers ? { headers } : {}),
      },
    }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_INSTANCE_ERROR')
  }
}

export interface SetInstanceSettingsArgs {
  instanceName: string
}

/**
 * CONFIRMED against a live v2.3.7 instance (curl, 2026-08-12):
 * `/settings/set/{instance}` rejects a partial body — it requires all
 * six fields in the same request (400 `instance requires property
 * "..."` for whichever are missing). `groupsIgnore: true` is this
 * integration's whole reason for calling this: wacrm has no concept of
 * group chats, so group messages must never reach the webhook and
 * create a fake "contact" out of a group JID. The other fields mirror
 * a fresh instance's own defaults (all off) — this call only exists to
 * flip `groupsIgnore`, not to change instance behavior otherwise.
 */
export async function setInstanceSettings(args: SetInstanceSettingsArgs): Promise<void> {
  const { instanceName } = args
  const response = await evolutionFetch(`/settings/set/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({
      rejectCall: false,
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
    }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_INSTANCE_ERROR')
  }
}

export interface GetInstanceConnectArgs {
  instanceName: string
}

export interface GetInstanceConnectResult {
  /** Base64 QR image (data URI or raw base64, provider-dependent) or pairing code string. */
  qrCode?: string
  /** Raw pairing code, if the instance is in pairing-code mode instead of QR. */
  pairingCode?: string
}

/**
 * CONFIRMED against docs.evolutionfoundation.com.br/evolution-api/connect-instance:
 * response is `{ pairingCode, code, base64, count }` — `base64` is a
 * ready-to-render `data:image/png;base64,...` image, `code` is the raw
 * Baileys ref string (would need client-side QR rendering), so `base64`
 * is preferred. No QR TTL/expiry is documented anywhere found — the
 * 60s `QR_TTL_SECONDS` in connections/route.ts stays a guess.
 */
export async function getInstanceConnect(
  args: GetInstanceConnectArgs
): Promise<GetInstanceConnectResult> {
  const { instanceName } = args
  const response = await evolutionFetch(`/instance/connect/${encodeURIComponent(instanceName)}`)
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
  const data = (await response.json()) as { base64?: string; code?: string; pairingCode?: string }
  if (!data.base64 && !data.code) {
    throw new EvolutionApiError('QR_CODE_UNAVAILABLE', data)
  }
  return { qrCode: data.base64 ?? data.code, pairingCode: data.pairingCode }
}

export interface GetInstanceStatusArgs {
  instanceName: string
}

export interface GetInstanceStatusResult {
  /** Raw Evolution connection state string — pass through evolution-status.ts before use. */
  rawState: string
}

/**
 * CONFIRMED against docs.evolutionfoundation.com.br/evolution-api/get-connection-state:
 * response is exactly `{ instance: { state: "open"|"close"|"connecting" } }`.
 */
export async function getInstanceStatus(
  args: GetInstanceStatusArgs
): Promise<GetInstanceStatusResult> {
  const { instanceName } = args
  const response = await evolutionFetch(
    `/instance/connectionState/${encodeURIComponent(instanceName)}`
  )
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
  const data = (await response.json()) as { instance?: { state?: string } }
  return { rawState: data.instance?.state ?? 'unknown' }
}

export interface LogoutInstanceArgs {
  instanceName: string
}

/**
 * Session-preserving disconnect — allows reconnecting without
 * recreating the instance. Path CONFIRMED (`DELETE /instance/logout/
 * {name}`, docs.evolutionfoundation.com.br/evolution-api/logout-instance),
 * but that page doesn't document whether a logged-out session can
 * actually resume via a fresh QR without recreating the instance —
 * still an open question, only testable against a live instance.
 */
export async function logoutInstance(args: LogoutInstanceArgs): Promise<void> {
  const { instanceName } = args
  const response = await evolutionFetch(`/instance/logout/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
}

export interface DeleteInstanceArgs {
  instanceName: string
}

/** Permanently removes the instance — use only when the connection itself is being removed for good. */
export async function deleteInstance(args: DeleteInstanceArgs): Promise<void> {
  const { instanceName } = args
  const response = await evolutionFetch(`/instance/delete/${encodeURIComponent(instanceName)}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
}

// ============================================================
// Sending
// ============================================================

export interface EvolutionSendResult {
  providerMessageId: string
}

function extractSendResultId(data: unknown): string {
  const key = (data as { key?: { id?: string } } | undefined)?.key
  if (!key?.id) {
    throw new EvolutionApiError('MESSAGE_SEND_FAILED', data, 'Evolution API did not return a message id.')
  }
  return key.id
}

export interface EvolutionSendTextArgs {
  instanceName: string
  to: string
  text: string
  /** Evolution's own message id being quoted, if replying. */
  quotedMessageId?: string
}

/**
 * UNRESOLVED — CONFLICTING SOURCES for the request body shape:
 *   - Official docs (docs.evolutionfoundation.com.br/evolution-api/
 *     send-text-message) show a NESTED body:
 *     { number, textMessage: { text }, delay?, quoted?, linkPreview?, mentioned? }
 *   - A community integration gist (widely cited, and the shape most
 *     tutorials use) shows a FLAT body: { number, text }.
 * This function currently sends the FLAT shape — the more commonly
 * corroborated one in practice, and consistent with the rest of this
 * client (QR/media already use flat, non-nested JSON). This is a bet,
 * not a certainty. Before relying on this in production, check your
 * own instance's live Swagger/OpenAPI page (usually
 * `{EVOLUTION_API_URL}/docs` or `/manager`) — that's the only fully
 * authoritative source for your exact deployed version. If sends
 * fail with a 400, this is the first thing to try switching.
 */
export async function sendText(args: EvolutionSendTextArgs): Promise<EvolutionSendResult> {
  const { instanceName, to, text, quotedMessageId } = args
  const body: Record<string, unknown> = { number: to, text }
  if (quotedMessageId) body.quoted = { key: { id: quotedMessageId } }
  const response = await evolutionFetch(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'MESSAGE_SEND_FAILED')
  }
  return { providerMessageId: extractSendResultId(await response.json()) }
}

export interface EvolutionSendMediaArgs {
  instanceName: string
  to: string
  kind: EvolutionMediaKind
  /** Public URL or base64 payload — one of the two is required. */
  mediaUrl?: string
  mediaBase64?: string
  caption?: string
  filename?: string
  quotedMessageId?: string
}

/**
 * UNRESOLVED — CONFLICTING SOURCES for the request format:
 *   - Official docs (docs.evolutionfoundation.com.br/evolution-api/
 *     send-media-message) describe `multipart/form-data` with the
 *     file as raw binary — `media` typed `format: binary`.
 *   - A community integration gist (and the general Baileys/Evolution
 *     convention used pervasively in tutorials) sends plain JSON with
 *     `media` as either a base64 string or a URL string — no
 *     multipart at all.
 * This function sends the JSON+base64-or-URL shape — kept because
 * it's more broadly corroborated and consistent with how this same
 * API handles media elsewhere (QR as base64, inbound webhook media as
 * base64 when `base64: true` is set on the webhook config). The
 * "binary" typing in the official docs may just be an artifact of an
 * auto-generated OpenAPI spec rather than the real wire format — but
 * this is unconfirmed. Same caveat as sendText: check your instance's
 * live Swagger before relying on this, and switch to multipart/
 * form-data here if JSON sends 400.
 */
export async function sendMedia(args: EvolutionSendMediaArgs): Promise<EvolutionSendResult> {
  const { instanceName, to, kind, mediaUrl, mediaBase64, caption, filename, quotedMessageId } = args
  if (kind === 'audio') {
    return sendWhatsAppAudio({ instanceName, to, audioUrl: mediaUrl, audioBase64: mediaBase64, quotedMessageId })
  }
  if (!mediaUrl && !mediaBase64) {
    throw new EvolutionApiError('MESSAGE_SEND_FAILED', undefined, 'sendMedia requires mediaUrl or mediaBase64.')
  }
  const body: Record<string, unknown> = {
    number: to,
    mediatype: kind,
    media: mediaUrl ?? mediaBase64,
  }
  if (caption) body.caption = caption
  if (filename) body.fileName = filename
  if (quotedMessageId) body.quoted = { key: { id: quotedMessageId } }
  const response = await evolutionFetch(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'MESSAGE_SEND_FAILED')
  }
  return { providerMessageId: extractSendResultId(await response.json()) }
}

export interface EvolutionSendAudioArgs {
  instanceName: string
  to: string
  audioUrl?: string
  audioBase64?: string
  quotedMessageId?: string
}

/**
 * Evolution treats voice notes as a distinct endpoint from generic
 * media (renders as a playable waveform, not a file attachment) —
 * matches Meta's own audio special-case in meta-api.ts. The endpoint
 * path (`/message/sendWhatsAppAudio/{name}`) and request shape
 * (`{ number, audio, quoted? }`) are corroborated by a community gist
 * (which also showed an `encoding: true` field this function doesn't
 * send) — the official docs page for this endpoint 404'd during
 * research, so this one is weaker evidence than sendText/sendMedia's
 * conflicting-but-at-least-present sources. Still unconfirmed against
 * a live instance.
 */
export async function sendWhatsAppAudio(
  args: EvolutionSendAudioArgs
): Promise<EvolutionSendResult> {
  const { instanceName, to, audioUrl, audioBase64, quotedMessageId } = args
  if (!audioUrl && !audioBase64) {
    throw new EvolutionApiError('MESSAGE_SEND_FAILED', undefined, 'sendWhatsAppAudio requires audioUrl or audioBase64.')
  }
  const body: Record<string, unknown> = { number: to, audio: audioUrl ?? audioBase64 }
  if (quotedMessageId) body.quoted = { key: { id: quotedMessageId } }
  const response = await evolutionFetch(
    `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`,
    { method: 'POST', body: JSON.stringify(body) }
  )
  if (!response.ok) {
    await throwEvolutionError(response, 'MESSAGE_SEND_FAILED')
  }
  return { providerMessageId: extractSendResultId(await response.json()) }
}

export interface MarkMessageAsReadArgs {
  instanceName: string
  remoteJid: string
  messageId: string
}

/**
 * Path and top-level `{ readMessages: [...] }` shape CONFIRMED against
 * docs.evolutionfoundation.com.br/evolution-api/mark-message-as-read.
 * The exact shape of each entry in `readMessages` wasn't documented
 * there — `{ remoteJid, id }` follows the Baileys key convention used
 * consistently elsewhere in this file.
 */
export async function markMessageAsRead(args: MarkMessageAsReadArgs): Promise<void> {
  const { instanceName, remoteJid, messageId } = args
  const response = await evolutionFetch(
    `/chat/markMessageAsRead/${encodeURIComponent(instanceName)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ readMessages: [{ remoteJid, id: messageId }] }),
    }
  )
  if (!response.ok) {
    await throwEvolutionError(response, 'MESSAGE_SEND_FAILED')
  }
}

export interface FetchProfileArgs {
  instanceName: string
  number: string
}

export interface FetchProfileResult {
  name?: string
  pictureUrl?: string
}

/** Optional enrichment (contact avatar/name) — not required for the MVP send/receive path. */
export async function fetchProfile(args: FetchProfileArgs): Promise<FetchProfileResult> {
  const { instanceName, number } = args
  const response = await evolutionFetch(`/chat/fetchProfile/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ number }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
  const data = (await response.json()) as { name?: string; picture?: string }
  return { name: data.name, pictureUrl: data.picture }
}

// ============================================================
// Message history (backfill)
// ============================================================

export interface FindMessagesArgs {
  instanceName: string
  page: number
  /** Records per page. Defaults to 50. */
  pageSize?: number
}

export interface FindMessagesResult {
  records: EvolutionMessagePayload[]
  currentPage: number
  totalPages: number
  total: number
}

const FIND_MESSAGES_DEFAULT_PAGE_SIZE = 50

/**
 * CONFIRMED against a live v2.3.7 instance (curl, 2026-08-13): the
 * response envelope is nested under a `messages` key —
 * `{ messages: { total, pages, currentPage, records } }` — not at the
 * top level as the publicly documented schema implies. Each
 * `records[]` entry has the same `key`/`message`/`messageTimestamp`/
 * `pushName` shape MESSAGES_UPSERT webhook events use.
 *
 * UNRESOLVED: the request body's `offset` field appears to control
 * page SIZE (5 requested → 5 returned), not a skip-within-page offset
 * — only observed with one value. Confirm against your own instance
 * before relying on a page size other than the default here.
 */
export async function findMessages(args: FindMessagesArgs): Promise<FindMessagesResult> {
  const { instanceName, page, pageSize = FIND_MESSAGES_DEFAULT_PAGE_SIZE } = args
  const response = await evolutionFetch(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
    body: JSON.stringify({ page, offset: pageSize }),
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
  const data = (await response.json()) as {
    messages?: {
      total?: number
      pages?: number
      currentPage?: number
      records?: EvolutionMessagePayload[]
    }
  }
  const messages = data.messages ?? {}
  return {
    records: messages.records ?? [],
    currentPage: messages.currentPage ?? page,
    totalPages: messages.pages ?? 0,
    total: messages.total ?? 0,
  }
}

// ============================================================
// Session liveness check + recovery
//
// /instance/connectionState only reports the WebSocket's local state
// ("open"/"close"/"connecting") — it does NOT prove WhatsApp is still
// routing anything through it. CONFIRMED live on 2026-08-15: a session
// sat "open" for 3+ hours with zero webhook activity (a "zombie"
// session — WhatsApp silently stopped delivering, but the socket never
// closed) until a manual disconnect/reconnect. See evolution-liveness.ts,
// which uses the functions below to detect and recover from this
// automatically.
// ============================================================

export interface FetchInstanceInfoArgs {
  instanceName: string
}

export interface FetchInstanceInfoResult {
  /** Raw Evolution connection state string ("open"/"close"/"connecting"/etc). */
  connectionStatus: string
  /** The connection's own WhatsApp JID (e.g. "5511999999999@s.whatsapp.net"), or null if not yet known. */
  ownerJid: string | null
}

/**
 * CONFIRMED against a live v2.3.7 instance (curl, 2026-08-15):
 * `GET /instance/fetchInstances?instanceName=X` returns an array (one
 * entry when filtered by name) with `connectionStatus` and `ownerJid`
 * among its fields — this is the only endpoint found that exposes the
 * connection's own number without depending on the webhook's
 * unconfirmed `wuid` field (see CONNECTION_UPDATE's KNOWN GAP comment
 * in the webhook route).
 */
export async function fetchInstanceInfo(args: FetchInstanceInfoArgs): Promise<FetchInstanceInfoResult> {
  const { instanceName } = args
  const response = await evolutionFetch(
    `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`
  )
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
  const data = (await response.json()) as Array<{ connectionStatus?: string; ownerJid?: string | null }>
  const row = data[0]
  return { connectionStatus: row?.connectionStatus ?? 'unknown', ownerJid: row?.ownerJid ?? null }
}

const LIVENESS_PROBE_TIMEOUT_MS = 10_000

export interface ProbeInstanceLivenessArgs {
  instanceName: string
  /** Digits-only phone number to probe with — the connection's own number (from fetchInstanceInfo's ownerJid) works well since it always exists. */
  number: string
}

export interface ProbeInstanceLivenessResult {
  alive: boolean
  /** Present when `alive` is false — for logging, not for programmatic branching. */
  reason?: string
}

/**
 * Active liveness probe: a real WhatsApp round trip (fetchProfile),
 * bounded by a timeout so a hung socket can't stall a health-check
 * caller indefinitely. Failure (error, non-2xx, or timeout) means the
 * session is not actually alive even if connectionState says "open".
 * Never throws — failure is reported in the return value so a caller
 * can decide how to react (see evolution-liveness.ts).
 */
export async function probeInstanceLiveness(
  args: ProbeInstanceLivenessArgs
): Promise<ProbeInstanceLivenessResult> {
  const { instanceName, number } = args
  try {
    const response = await evolutionFetch(`/chat/fetchProfile/${encodeURIComponent(instanceName)}`, {
      method: 'POST',
      body: JSON.stringify({ number }),
      signal: AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return { alive: false, reason: `fetchProfile returned HTTP ${response.status}` }
    }
    return { alive: true }
  } catch (err) {
    return { alive: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export interface RestartInstanceArgs {
  instanceName: string
}

/**
 * CONFIRMED against the running v2.3.7 image's own compiled source
 * (docker exec ... instance.router.js, 2026-08-15): `POST
 * /instance/restart/{instanceName}` reuses the already-paired session's
 * stored credentials (no new QR) — the same graceful recovery a manual
 * "disconnect and reconnect" achieves, just without discarding the
 * pairing.
 */
export async function restartInstance(args: RestartInstanceArgs): Promise<void> {
  const { instanceName } = args
  const response = await evolutionFetch(`/instance/restart/${encodeURIComponent(instanceName)}`, {
    method: 'POST',
  })
  if (!response.ok) {
    await throwEvolutionError(response, 'EVOLUTION_CONNECTION_ERROR')
  }
}
