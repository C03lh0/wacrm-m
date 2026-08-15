/**
 * Shared inbound-message pipeline — the provider-independent back half
 * of what used to be Meta-only logic inside
 * src/app/api/whatsapp/webhook/route.ts's processMessage(). Extracted
 * so the Evolution webhook (src/app/api/whatsapp/webhook/evolution/
 * [instanceName]/route.ts) can reuse the exact same contact/
 * conversation/message/dispatch flow instead of duplicating it.
 *
 * Provider-specific work (parsing the raw webhook payload into text/
 * media, resolving media URLs, reaction handling) stays in each
 * provider's own webhook route — only what happens once a message has
 * been normalized lives here.
 *
 * This is a pure extraction of the tail of the pre-Evolution
 * processMessage(): find-or-create contact → find-or-create
 * conversation → conversation.created emit → idempotency check →
 * insert message → update conversation → reopen if closed → flag
 * broadcast reply → Flow dispatch → automation dispatch → AI
 * auto-reply → message.received emit. No behavior change versus the
 * original Meta-only code path.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import type { ProviderName } from './provider'

export interface ParsedInboundContent {
  /** Already mapped to the messages.content_type CHECK constraint's allowed values. */
  contentType: string
  contentText: string | null
  mediaUrl: string | null
  /**
   * The attachment's MIME type (migration 042). Without it the download
   * path had to guess an extension from the fetched blob, which was only
   * possible after the bytes were already fetched.
   */
  mediaType?: string | null
  /** Interactive button/list tap id, if applicable. Meta-only today. */
  interactiveReplyId?: string | null
}

export interface ResolvedContactAndConversation {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contact: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversation: any
  contactWasCreated: boolean
  conversationWasCreated: boolean
}

export interface IngestParsedMessageParams {
  accountId: string
  /** Audit user_id for downstream dispatch (Flow runner / automations). */
  configOwnerUserId: string
  provider: ProviderName
  /** id of the whatsapp_config or whatsapp_connections row this message arrived on. */
  connectionId: string
  /** The provider's own message id — the dedup key together with (provider, connectionId). */
  providerMessageId: string
  content: ParsedInboundContent
  createdAt: Date
  /** The provider message id being replied to (swipe-reply / quoted message), if any. */
  replyToProviderMessageId?: string | null
}

export interface IngestParsedMessageResult {
  /** Our internal messages.id. */
  messageId: string
  /** True when this providerMessageId was already ingested — caller should not treat this as an error. */
  duplicate: boolean
}

/**
 * Resolve a provider message id into the matching internal UUID,
 * scoped to one conversation. Returns null when we never received
 * the parent (e.g. a reply to a message older than this CRM install,
 * or one that arrived before dedup columns existed).
 */
export async function lookupInternalIdByProviderMessageId(
  db: SupabaseClient,
  providerMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', providerMessageId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[inbound-pipeline] lookupInternalIdByProviderMessageId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(db, accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound-pipeline] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[inbound-pipeline] error finding conversation:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[inbound-pipeline] error creating conversation:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures here must
 * not break the main inbound-message flow.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string
) {
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const row = recs[0]
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id)

    if (updErr) {
      console.error('[inbound-pipeline] error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('[inbound-pipeline] flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Resolve (find-or-create) the contact and conversation an inbound
 * event belongs to, emitting `conversation.created` when a new thread
 * was just opened. Split out from message ingestion because reaction
 * events (Meta-only today) also need the contact/conversation
 * resolved but must NOT go through message insertion.
 */
export async function resolveContactAndConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  senderPhone: string,
  senderName: string
): Promise<ResolvedContactAndConversation | null> {
  const contactOutcome = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName
  )
  if (!contactOutcome) return null

  const convResult = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contactOutcome.contact.id
  )
  if (!convResult) return null

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: convResult.conversation.id,
      contact_id: contactOutcome.contact.id,
    })
  }

  return {
    contact: contactOutcome.contact,
    conversation: convResult.conversation,
    contactWasCreated: contactOutcome.wasCreated,
    conversationWasCreated: convResult.created,
  }
}

/**
 * Persist a normalized inbound message against an already-resolved
 * contact/conversation and fan out to the Flow runner, automations,
 * AI auto-reply, and the message.received outbound webhook.
 * Idempotent — a repeat delivery of the same providerMessageId is
 * detected via migration 041's messages_dedup_key unique index and
 * skipped (dispatch is not re-run).
 */
export async function ingestParsedMessage(
  db: SupabaseClient,
  resolved: ResolvedContactAndConversation,
  params: IngestParsedMessageParams
): Promise<IngestParsedMessageResult | null> {
  const { contact: contactRecord, conversation, contactWasCreated } = resolved
  const {
    accountId,
    configOwnerUserId,
    provider,
    connectionId,
    providerMessageId,
    content,
    createdAt,
    replyToProviderMessageId,
  } = params

  // Idempotency check — lookup-then-insert-then-resolve-on-conflict,
  // the same house pattern as findOrCreateContact/findOrCreateConversation
  // above, keyed on the (provider, connection_id, provider_message_id)
  // unique index from migration 041.
  const { data: existingMessage, error: dedupLookupError } = await db
    .from('messages')
    .select('id')
    .eq('provider', provider)
    .eq('connection_id', connectionId)
    .eq('provider_message_id', providerMessageId)
    .maybeSingle()

  if (dedupLookupError) {
    console.error('[inbound-pipeline] dedup lookup failed:', dedupLookupError.message)
  }
  if (existingMessage) {
    console.log(
      `[inbound-pipeline] duplicate message (provider=${provider} connection=${connectionId} providerMessageId=${providerMessageId}), skipping`
    )
    return { messageId: existingMessage.id, duplicate: true }
  }

  let replyToInternalId: string | null = null
  if (replyToProviderMessageId) {
    replyToInternalId = await lookupInternalIdByProviderMessageId(
      db,
      replyToProviderMessageId,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn('[inbound-pipeline] reply context parent not found:', replyToProviderMessageId)
    }
  }

  const { count: priorCustomerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { data: insertedMessage, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: content.contentType,
      content_text: content.contentText,
      media_url: content.mediaUrl,
      media_type: content.mediaType ?? null,
      message_id: providerMessageId,
      provider,
      connection_id: connectionId,
      provider_message_id: providerMessageId,
      status: 'delivered',
      created_at: createdAt.toISOString(),
      reply_to_message_id: replyToInternalId,
      interactive_reply_id: content.interactiveReplyId ?? null,
    })
    .select('id')
    .single()

  if (msgError) {
    // Lost a race — a concurrent delivery of the same event inserted
    // first and the unique index (migration 041) rejected ours.
    // Re-resolve instead of dropping the event or double-counting it.
    if (isUniqueViolation(msgError)) {
      const { data: raced } = await db
        .from('messages')
        .select('id')
        .eq('provider', provider)
        .eq('connection_id', connectionId)
        .eq('provider_message_id', providerMessageId)
        .maybeSingle()
      if (raced) {
        console.log(
          `[inbound-pipeline] duplicate message lost insert race (provider=${provider} providerMessageId=${providerMessageId}), skipping`
        )
        return { messageId: raced.id, duplicate: true }
      }
    }
    console.error('[inbound-pipeline] error inserting message:', msgError)
    return null
  }

  // The unread bump is done DB-side (migration 037's
  // bump_conversation_on_inbound) rather than as a read-modify-write of
  // the `conversation` snapshot resolved earlier: two inbound messages
  // for the same conversation can process concurrently, and computing
  // `snapshot + 1` in the app lets both reads see the same value and
  // write the same increment, losing one (issue #369). The RPC
  // increments in a single UPDATE and refreshes the last-message summary
  // in the same statement.
  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: content.contentText || `[${content.contentType}]`,
  })

  if (convError) {
    console.error('[inbound-pipeline] error updating conversation:', convError)
  }

  await reopenClosedConversation(db, conversation)
  await flagBroadcastReplyIfAny(db, accountId, contactRecord.id)

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message:
      content.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: content.interactiveReplyId,
            reply_title: content.contentText ?? '',
            meta_message_id: providerMessageId,
          }
        : {
            kind: 'text',
            text: content.contentText ?? '',
            meta_message_id: providerMessageId,
          },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const inboundText = content.contentText ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
    if (content.interactiveReplyId) {
      automationTriggers.push('interactive_reply')
    }
  }
  if (contactWasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: content.interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }

  if (!flowConsumed && !content.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    })
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: providerMessageId,
    content_type: content.contentType,
    text: content.contentText,
  })

  return { messageId: insertedMessage.id, duplicate: false }
}

export interface IngestOwnDeviceMessageParams {
  accountId: string
  provider: ProviderName
  connectionId: string
  providerMessageId: string
  content: ParsedInboundContent
  createdAt: Date
}

/**
 * Persist a message the connected WhatsApp number sent from its own
 * linked phone (Baileys `fromMe: true` with no matching provider_message_id
 * already on file — an echo of a CRM-initiated send is handled by the
 * caller before this is reached). Mirrors send-message.ts's own
 * persistence (sender_type 'agent', no unread bump, pause the active
 * Flow run) rather than the customer-inbound pipeline above — this is
 * an outbound message, just one the CRM didn't originate.
 */
export async function ingestOwnDeviceMessage(
  db: SupabaseClient,
  resolved: ResolvedContactAndConversation,
  params: IngestOwnDeviceMessageParams
): Promise<IngestParsedMessageResult | null> {
  const { contact: contactRecord, conversation } = resolved
  const { accountId, provider, connectionId, providerMessageId, content, createdAt } = params

  const { data: existingMessage, error: dedupLookupError } = await db
    .from('messages')
    .select('id')
    .eq('provider', provider)
    .eq('connection_id', connectionId)
    .eq('provider_message_id', providerMessageId)
    .maybeSingle()

  if (dedupLookupError) {
    console.error('[inbound-pipeline] own-device dedup lookup failed:', dedupLookupError.message)
  }
  if (existingMessage) {
    return { messageId: existingMessage.id, duplicate: true }
  }

  const { data: insertedMessage, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'agent',
      content_type: content.contentType,
      content_text: content.contentText,
      media_url: content.mediaUrl,
      message_id: providerMessageId,
      provider,
      connection_id: connectionId,
      provider_message_id: providerMessageId,
      status: 'sent',
      created_at: createdAt.toISOString(),
    })
    .select('id')
    .single()

  if (msgError) {
    if (isUniqueViolation(msgError)) {
      const { data: raced } = await db
        .from('messages')
        .select('id')
        .eq('provider', provider)
        .eq('connection_id', connectionId)
        .eq('provider_message_id', providerMessageId)
        .maybeSingle()
      if (raced) {
        return { messageId: raced.id, duplicate: true }
      }
    }
    console.error('[inbound-pipeline] error inserting own-device message:', msgError)
    return null
  }

  const { error: convError } = await db
    .from('conversations')
    .update({
      last_message_text: content.contentText || `[${content.contentType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  if (convError) {
    console.error('[inbound-pipeline] error updating conversation for own-device message:', convError)
  }

  // The agent stepping in from the linked phone is the same "yield,
  // human is here" signal as replying from the CRM composer — mirrors
  // send-message.ts's pause-on-agent-send. Best-effort.
  try {
    const { error: pauseErr } = await db
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactRecord.id)
      .eq('status', 'active')
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send (own-device) failed:', pauseErr.message)
    }
  } catch (err) {
    console.error('[flows] pause-on-agent-send (own-device) threw:', err instanceof Error ? err.message : err)
  }

  return { messageId: insertedMessage.id, duplicate: false }
}
