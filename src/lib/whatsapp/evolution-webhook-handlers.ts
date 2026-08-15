/**
 * Evolution webhook event handlers — normalizes Evolution/Baileys
 * webhook payloads into the shared inbound-message-pipeline shape and
 * performs the media/status side-work specific to Evolution.
 *
 * Payload shapes below follow Baileys' well-known message envelope
 * (`key`, `message`, `messageTimestamp`, `pushName`), which Evolution
 * API v2 exposes close to unchanged in its `messages.upsert` /
 * `messages.update` webhook events — this is a stated ASSUMPTION (see
 * the implementation plan's "Pontos assumidos que precisam validação").
 * Validate the exact field names against the target deployment before
 * relying on this in production.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveContactAndConversation,
  ingestParsedMessage,
  ingestOwnDeviceMessage,
  type ParsedInboundContent,
} from './inbound-message-pipeline'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { isAllowedEvolutionMediaUrl } from './providers/evolution-api'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhatsAppConnectionRow = any

export interface EvolutionMessageKey {
  id: string
  /** e.g. "5511999999999@s.whatsapp.net" — the contact's JID. */
  remoteJid: string
  /**
   * The counterpart's real `@s.whatsapp.net` phone JID, present when
   * `remoteJid` uses WhatsApp's newer `@lid` (Linked ID) addressing
   * scheme — in that case `remoteJid` is an opaque identifier, NOT a
   * phone number. CONFIRMED live against a real instance on
   * 2026-08-13. Prefer this over `remoteJid` when extracting a phone
   * number (see extractCounterpartPhone below).
   */
  remoteJidAlt?: string
  /** True when this event is an echo of a message WE sent via Evolution. */
  fromMe: boolean
}

export interface EvolutionMediaMessage {
  mimetype?: string
  caption?: string
  fileName?: string
  /** Present when the instance is configured to inline media as base64. */
  base64?: string
  /** Present when Evolution instead gives a fetchable (possibly temporary) URL. */
  url?: string
}

export interface EvolutionMessagePayload {
  key: EvolutionMessageKey
  pushName?: string
  messageTimestamp: number | string
  message?: {
    conversation?: string
    extendedTextMessage?: { text?: string; contextInfo?: { stanzaId?: string } }
    imageMessage?: EvolutionMediaMessage
    videoMessage?: EvolutionMediaMessage
    documentMessage?: EvolutionMediaMessage
    audioMessage?: EvolutionMediaMessage
    stickerMessage?: EvolutionMediaMessage
  }
}

function jidToPhone(jid: string): string {
  return jid.split('@')[0]?.replace(/\D/g, '') ?? jid
}

/**
 * Group JIDs end in `@g.us` (vs. `@s.whatsapp.net`/`@lid` for a 1:1
 * contact) — Baileys' own convention, which Evolution passes through
 * unchanged. The instance is configured with `groupsIgnore: true`
 * (see setInstanceSettings) so Evolution shouldn't even dispatch these,
 * but this is cheap defense-in-depth: without it, a group message
 * would create a fake "contact" out of the group's JID digits.
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

/**
 * Prefers `remoteJidAlt` (the real phone JID) over `remoteJid` when the
 * counterpart is "lid"-addressed. Used both by the backfill path
 * (src/lib/whatsapp/evolution-backfill.ts, which gates which messages to
 * ingest on this same phone derivation) and by the live MESSAGES_UPSERT
 * path (processEvolutionMessage/processOwnDeviceMessage below) — the two
 * must agree, otherwise a lid-addressed contact resolved correctly by the
 * backfill gate gets re-derived to a different (wrong) phone here and a
 * ghost contact/conversation gets created for it.
 */
export function extractCounterpartPhone(key: EvolutionMessageKey): string {
  return jidToPhone(key.remoteJidAlt ?? key.remoteJid)
}

interface ParsedEvolutionContent {
  content: ParsedInboundContent
  mediaBase64?: string
  mediaUrl?: string
  mediaMimeType?: string
  mediaFileName?: string
}

/** Extract text/media out of Baileys' nested `message` union — mirrors meta-api's parseMessageContent switch. */
function parseEvolutionContent(payload: EvolutionMessagePayload): ParsedEvolutionContent {
  const m = payload.message ?? {}

  if (m.conversation) {
    return { content: { contentType: 'text', contentText: m.conversation, mediaUrl: null } }
  }
  if (m.extendedTextMessage?.text) {
    return { content: { contentType: 'text', contentText: m.extendedTextMessage.text, mediaUrl: null } }
  }
  if (m.imageMessage) {
    return {
      content: { contentType: 'image', contentText: m.imageMessage.caption ?? null, mediaUrl: null },
      mediaBase64: m.imageMessage.base64,
      mediaUrl: m.imageMessage.url,
      mediaMimeType: m.imageMessage.mimetype,
    }
  }
  if (m.videoMessage) {
    return {
      content: { contentType: 'video', contentText: m.videoMessage.caption ?? null, mediaUrl: null },
      mediaBase64: m.videoMessage.base64,
      mediaUrl: m.videoMessage.url,
      mediaMimeType: m.videoMessage.mimetype,
    }
  }
  if (m.documentMessage) {
    return {
      content: {
        contentType: 'document',
        contentText: m.documentMessage.caption ?? m.documentMessage.fileName ?? null,
        mediaUrl: null,
      },
      mediaBase64: m.documentMessage.base64,
      mediaUrl: m.documentMessage.url,
      mediaMimeType: m.documentMessage.mimetype,
      mediaFileName: m.documentMessage.fileName,
    }
  }
  if (m.audioMessage) {
    return {
      content: { contentType: 'audio', contentText: null, mediaUrl: null },
      mediaBase64: m.audioMessage.base64,
      mediaUrl: m.audioMessage.url,
      mediaMimeType: m.audioMessage.mimetype,
    }
  }
  if (m.stickerMessage) {
    // Stickers are images under the hood — same convention as the Meta path.
    return {
      content: { contentType: 'image', contentText: null, mediaUrl: null },
      mediaBase64: m.stickerMessage.base64,
      mediaUrl: m.stickerMessage.url,
      mediaMimeType: m.stickerMessage.mimetype,
    }
  }

  return { content: { contentType: 'text', contentText: '[Unsupported message type]', mediaUrl: null } }
}

/**
 * Persist inbound media into the CRM's own storage (chat-media bucket,
 * the same one outbound composer uploads use) rather than depending on
 * a possibly-temporary Evolution URL — preferred over Meta's own
 * proxy-on-demand approach per the durability guidance in the plan.
 * Best-effort: a failure here degrades to a text-only message rather
 * than dropping the whole webhook event.
 */
async function persistEvolutionMedia(
  db: SupabaseClient,
  accountId: string,
  parsed: ParsedEvolutionContent
): Promise<string | null> {
  if (!parsed.mediaBase64 && !parsed.mediaUrl) {
    // Expected for text messages (never called with media fields set).
    // For an actual media type, this was silent by omission until now —
    // an image/video Evolution never inlines (e.g. omitted above some
    // size threshold) degraded with zero signal. Log it so a future
    // "media doesn't show up, no console error" report is diagnosable
    // from the logs alone.
    if (parsed.content.contentType !== 'text') {
      console.warn(
        `[evolution] no media payload for ${parsed.content.contentType} message — Evolution sent neither base64 nor a url`
      )
    }
    return null
  }

  try {
    let bytes: Buffer
    if (parsed.mediaBase64) {
      bytes = Buffer.from(parsed.mediaBase64, 'base64')
    } else {
      // SSRF guard: only fetch from the same host as the configured
      // Evolution instance — see isAllowedEvolutionMediaUrl's doc comment.
      if (!isAllowedEvolutionMediaUrl(parsed.mediaUrl!)) {
        console.warn(`[evolution] rejected media url outside configured Evolution host: ${parsed.mediaUrl}`)
        return null
      }
      const res = await fetch(parsed.mediaUrl!)
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
      bytes = Buffer.from(await res.arrayBuffer())
    }

    const ext = parsed.mediaFileName?.split('.').pop() || (parsed.mediaMimeType?.split('/')[1] ?? 'bin')
    const path = buildMediaPath(accountId, `media.${ext}`)
    // Baileys sends parameterized mime strings for some types (voice
    // notes: `audio/ogg; codecs=opus`) — Supabase Storage's
    // allowed_mime_types check is an exact match against the bare type
    // (023_chat_media.sql lists `audio/ogg`, not the codecs variant), so
    // an unstripped contentType gets rejected with a 415.
    const contentType = parsed.mediaMimeType?.split(';')[0].trim() || 'application/octet-stream'
    const { error: uploadError } = await db.storage
      .from('chat-media')
      .upload(path, bytes, {
        cacheControl: '3600',
        upsert: false,
        contentType,
      })
    if (uploadError) throw uploadError

    const { data } = db.storage.from('chat-media').getPublicUrl(path)
    return data.publicUrl
  } catch (err) {
    console.error('[evolution] media persist failed (MEDIA_DOWNLOAD_FAILED), continuing without media:', err)
    return null
  }
}

/**
 * Normalize + ingest one Evolution `messages.upsert` event. Mirrors
 * Meta's processMessage(): resolve contact/conversation, parse content,
 * persist media, then hand off to the shared pipeline for dedup +
 * insert + downstream dispatch.
 */
export async function processEvolutionMessage(
  db: SupabaseClient,
  connection: WhatsAppConnectionRow,
  configOwnerUserId: string,
  payload: EvolutionMessagePayload
): Promise<void> {
  if (isGroupJid(payload.key.remoteJid)) return

  // fromMe=true covers two distinct cases: an echo of a message the CRM
  // itself already sent (a row for it exists, keyed by provider_message_id
  // — this is just an ack, the status webhook branch handles delivery
  // updates) vs. a brand-new message the user typed directly into the
  // linked phone's WhatsApp app (no row exists yet — needs to be ingested).
  if (payload.key.fromMe) {
    await processOwnDeviceMessage(db, connection, configOwnerUserId, payload)
    return
  }

  const senderPhone = extractCounterpartPhone(payload.key)
  const senderName = payload.pushName || senderPhone

  const resolved = await resolveContactAndConversation(
    db,
    connection.account_id,
    configOwnerUserId,
    senderPhone,
    senderName
  )
  if (!resolved) return

  const parsed = parseEvolutionContent(payload)
  const mediaUrl = await persistEvolutionMedia(db, connection.account_id, parsed)

  const timestampMs =
    typeof payload.messageTimestamp === 'string'
      ? parseInt(payload.messageTimestamp, 10) * 1000
      : payload.messageTimestamp * 1000

  await ingestParsedMessage(db, resolved, {
    accountId: connection.account_id,
    configOwnerUserId,
    provider: 'evolution',
    connectionId: connection.id,
    providerMessageId: payload.key.id,
    content: { ...parsed.content, mediaUrl },
    createdAt: new Date(timestampMs || Date.now()),
    replyToProviderMessageId: payload.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
  })
}

/**
 * Handle a fromMe=true upsert event. Checked up front against the same
 * (provider, connection_id, provider_message_id) dedup key the pipeline
 * uses: a hit means this is just an ack echo of a send we already
 * inserted via send-message.ts (contact/conversation resolution and
 * media download would be wasted work); a miss means the user sent this
 * from the linked phone itself and it needs to be ingested for the
 * first time.
 */
async function processOwnDeviceMessage(
  db: SupabaseClient,
  connection: WhatsAppConnectionRow,
  configOwnerUserId: string,
  payload: EvolutionMessagePayload
): Promise<void> {
  const { data: existingMessage, error: dedupLookupError } = await db
    .from('messages')
    .select('id')
    .eq('provider', 'evolution')
    .eq('connection_id', connection.id)
    .eq('provider_message_id', payload.key.id)
    .maybeSingle()

  if (dedupLookupError) {
    console.error('[evolution] fromMe dedup lookup failed:', dedupLookupError.message)
  }
  if (existingMessage) return

  const counterpartPhone = extractCounterpartPhone(payload.key)
  // payload.pushName on a fromMe event is the connection owner's own
  // WhatsApp display name (they're the sender), not the counterpart's —
  // passing it through would rename the counterpart's contact to the
  // owner's own name. An empty string makes findOrCreateContact skip the
  // name overwrite for an existing contact, and fall back to the phone
  // number for a brand-new one.
  const counterpartName = ''

  const resolved = await resolveContactAndConversation(
    db,
    connection.account_id,
    configOwnerUserId,
    counterpartPhone,
    counterpartName
  )
  if (!resolved) return

  const parsed = parseEvolutionContent(payload)
  const mediaUrl = await persistEvolutionMedia(db, connection.account_id, parsed)

  const timestampMs =
    typeof payload.messageTimestamp === 'string'
      ? parseInt(payload.messageTimestamp, 10) * 1000
      : payload.messageTimestamp * 1000

  await ingestOwnDeviceMessage(db, resolved, {
    accountId: connection.account_id,
    provider: 'evolution',
    connectionId: connection.id,
    providerMessageId: payload.key.id,
    content: { ...parsed.content, mediaUrl },
    createdAt: new Date(timestampMs || Date.now()),
  })
}

export interface EvolutionMessageStatusUpdate {
  key: EvolutionMessageKey
  /** Baileys status codes: 0=error 1=pending 2=server_ack 3=delivery_ack 4=read — ASSUMPTION, confirm against target version. */
  status: number | string
}

const BAILEYS_STATUS_MAP: Record<string, string> = {
  '2': 'sent',
  '3': 'delivered',
  '4': 'read',
  server_ack: 'sent',
  delivery_ack: 'delivered',
  read: 'read',
}

/**
 * Mirror an Evolution outbound-status update onto messages.status,
 * scoped precisely by (provider, connection_id, provider_message_id) —
 * unlike Meta's mirror (which can't use a unique key because wamid
 * isn't unique across numbers), this lookup is exact.
 */
export async function processEvolutionMessageStatus(
  db: SupabaseClient,
  connection: WhatsAppConnectionRow,
  update: EvolutionMessageStatusUpdate
): Promise<void> {
  const mapped = BAILEYS_STATUS_MAP[String(update.status)]
  if (!mapped) {
    console.warn(`[evolution] unmapped message status: ${update.status}`)
    return
  }

  const { error } = await db
    .from('messages')
    .update({ status: mapped })
    .eq('provider', 'evolution')
    .eq('connection_id', connection.id)
    .eq('provider_message_id', update.key.id)

  if (error) {
    console.error('[evolution] failed to update message status:', error.message)
  }
}
