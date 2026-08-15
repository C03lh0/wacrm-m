/**
 * Companion to resolveProviderForAccount() (provider-factory.ts), but
 * for UI status/display rather than send-time resolution: never
 * throws, and never pings the provider live (reuses the `status`
 * columns already cached on whatsapp_connections/whatsapp_config —
 * same trust model inbox/page.tsx already relied on for Meta before
 * this file existed).
 *
 * Same precedence as resolveProviderForAccount: a whatsapp_connections
 * row (Evolution) wins over whatsapp_config (Meta) if both exist.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderName } from './provider'

export interface WhatsAppConnectionStatus {
  provider: ProviderName | null
  connected: boolean
  /** The Meta Cloud API 24h customer-service-window rule — only applies to the Meta provider. */
  enforcesSessionWindow: boolean
  /** True while a post-reconnect message backfill is running (Evolution only — see evolution-backfill.ts). Always false for Meta. */
  syncing: boolean
}

export async function getWhatsAppConnectionStatus(
  db: SupabaseClient,
  accountId: string
): Promise<WhatsAppConnectionStatus> {
  const { data: evolutionConnection, error: evolutionConnectionError } = await db
    .from('whatsapp_connections')
    .select('status, is_syncing')
    .eq('account_id', accountId)
    .maybeSingle()

  if (evolutionConnectionError) {
    console.error(
      '[whatsapp] failed to query whatsapp_connections for connection status:',
      evolutionConnectionError.message
    )
  }

  if (evolutionConnection) {
    return {
      provider: 'evolution',
      connected: evolutionConnection.status === 'connected',
      enforcesSessionWindow: false,
      syncing: evolutionConnection.is_syncing === true,
    }
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle()

  if (config) {
    return {
      provider: 'meta',
      connected: config.status === 'connected',
      enforcesSessionWindow: true,
      syncing: false,
    }
  }

  return { provider: null, connected: false, enforcesSessionWindow: false, syncing: false }
}
