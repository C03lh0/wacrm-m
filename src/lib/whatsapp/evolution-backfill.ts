/**
 * Post-reconnect message backfill for Evolution API connections.
 *
 * The Evolution integration is otherwise pure push (webhook events) —
 * nothing catches up on messages exchanged while a session was down.
 * This module closes that gap: once a connection comes back to
 * `connected` from some other state (wired in by the webhook's
 * CONNECTION_UPDATE handler and the connections cron — see
 * src/app/api/whatsapp/webhook/evolution/[instanceName]/route.ts and
 * src/app/api/whatsapp/connections/cron/route.ts), this walks
 * Evolution's `/chat/findMessages` history, newest-first, until it
 * reaches the last message the CRM already has for this connection
 * (the "watermark"), delivering anything newer to the same
 * processEvolutionMessage() the live webhook uses.
 *
 * Deliberately scoped to contacts the CRM already knows (see
 * docs/superpowers/specs/2026-08-13-evolution-backfill-design.md) —
 * messages from unknown numbers are skipped, never creating a new
 * contact — and bounded by EVOLUTION_BACKFILL_MAX_PAGES so a very long
 * outage or a huge instance history can't turn a reconnect into an
 * unbounded fetch.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { findMessages } from './providers/evolution-api'
import { processEvolutionMessage, extractCounterpartPhone, isGroupJid } from './evolution-webhook-handlers'

export const EVOLUTION_BACKFILL_MAX_PAGES = 20
export const EVOLUTION_BACKFILL_PAGE_SIZE = 50

/**
 * Kill switch for the automatic reconnect/health-check triggers (see the
 * webhook's CONNECTION_UPDATE handler and the connections cron route) —
 * defaults to disabled. A live bug (fixed in evolution-webhook-handlers.ts's
 * processOwnDeviceMessage) let a mass backfill run rename most of an
 * account's contacts to the connection owner's own name in one shot;
 * this flag lets the trigger stay off until it's been tested more
 * carefully, without touching backfillMissedMessages itself (still
 * correct and fully covered by this file's own tests). Set to 'true' to
 * re-enable the automatic trigger.
 */
export function isEvolutionBackfillEnabled(): boolean {
  return process.env.EVOLUTION_BACKFILL_ENABLED === 'true'
}

export interface EvolutionConnectionForBackfill {
  id: string
  account_id: string
  instance_name: string
}

export interface BackfillResult {
  fetched: number
  ingested: number
  cappedAt?: number
}

function messageTimestampMs(messageTimestamp: number | string): number {
  const seconds = typeof messageTimestamp === 'string' ? parseInt(messageTimestamp, 10) : messageTimestamp
  return (seconds || 0) * 1000
}

export async function backfillMissedMessages(
  db: SupabaseClient,
  connection: EvolutionConnectionForBackfill,
  configOwnerUserId: string
): Promise<BackfillResult> {
  const { data: lastMessage } = await db
    .from('messages')
    .select('created_at')
    .eq('connection_id', connection.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lastMessage) {
    // Nothing on file for this connection yet — there is nothing to
    // "catch up" on (also covers the very first-ever connect, which
    // never fires the reconnect trigger anyway — see the webhook/cron
    // wiring).
    return { fetched: 0, ingested: 0 }
  }
  const watermarkMs = new Date(lastMessage.created_at).getTime()

  await db.from('whatsapp_connections').update({ is_syncing: true }).eq('id', connection.id)

  let fetched = 0
  let ingested = 0
  let cappedAt: number | undefined

  try {
    for (let page = 1; page <= EVOLUTION_BACKFILL_MAX_PAGES; page++) {
      const result = await findMessages({
        instanceName: connection.instance_name,
        page,
        pageSize: EVOLUTION_BACKFILL_PAGE_SIZE,
      })

      if (result.records.length === 0) break

      let reachedWatermark = false
      for (const record of result.records) {
        fetched++

        if (messageTimestampMs(record.messageTimestamp) <= watermarkMs) {
          reachedWatermark = true
          break
        }

        if (isGroupJid(record.key.remoteJid)) continue

        const phone = extractCounterpartPhone(record.key)
        const knownContact = await findExistingContact(db, connection.account_id, phone)
        if (!knownContact) continue

        await processEvolutionMessage(db, connection, configOwnerUserId, record)
        ingested++
      }

      if (reachedWatermark) break

      if (page === EVOLUTION_BACKFILL_MAX_PAGES) {
        cappedAt = Math.max(result.total - fetched, 0)
        console.warn(
          `[evolution] backfill hit the ${EVOLUTION_BACKFILL_MAX_PAGES}-page cap for connection=${connection.id}, ~${cappedAt} older messages left unchecked`
        )
      }
    }
  } finally {
    await db.from('whatsapp_connections').update({ is_syncing: false }).eq('id', connection.id)
  }

  console.log(
    `[evolution] backfill connection=${connection.id} fetched=${fetched} ingested=${ingested}` +
      (cappedAt !== undefined ? ` cappedAt=${cappedAt}` : '')
  )

  return { fetched, ingested, cappedAt }
}
