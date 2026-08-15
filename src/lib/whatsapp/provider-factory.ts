/**
 * Central provider selection point. This is the ONLY file in the
 * codebase allowed to branch on which WhatsApp provider an account
 * uses — every other call site (send-message.ts, webhook routes,
 * connection routes) works against WhatsAppProviderClient only.
 *
 * Precedence: an account with a `whatsapp_connections` row (Evolution)
 * is resolved to Evolution; otherwise its `whatsapp_config` row (Meta)
 * is used, exactly matching pre-Evolution behavior for Meta-only
 * accounts. The settings UI enforces "one provider at a time" so both
 * existing for one account shouldn't happen, but Evolution wins
 * deterministically if it ever does.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { SendMessageError } from './send-message-error'
import { decrypt, encrypt, isLegacyFormat } from './encryption'
import { createMetaProviderClient } from './providers/meta-provider'
import { createEvolutionProviderClient } from './providers/evolution-provider'
import type { WhatsAppProviderClient, ProviderName } from './provider'

export interface ResolvedProvider {
  client: WhatsAppProviderClient
  kind: ProviderName
  /** id of the whatsapp_config or whatsapp_connections row backing this client. */
  connectionId: string
}

export async function resolveProviderForAccount(
  db: SupabaseClient,
  accountId: string
): Promise<ResolvedProvider> {
  const { data: evolutionConnection } = await db
    .from('whatsapp_connections')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (evolutionConnection) {
    if (evolutionConnection.status !== 'connected') {
      throw new SendMessageError(
        'whatsapp_disconnected',
        'WhatsApp is not connected. Please reconnect via QR code.',
        409
      )
    }
    return {
      client: createEvolutionProviderClient({
        instanceName: evolutionConnection.instance_name,
      }),
      kind: 'evolution',
      connectionId: evolutionConnection.id,
    }
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()

  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    )
  }

  const accessToken = decrypt(config.access_token)

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  // Moved here unchanged from send-message.ts's pre-abstraction inline
  // check — same behavior, same call site relative to config load.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn(
            '[provider-factory] access_token GCM upgrade failed:',
            error.message
          )
        }
      })
  }

  return {
    client: createMetaProviderClient({
      phoneNumberId: config.phone_number_id,
      accessToken,
    }),
    kind: 'meta',
    connectionId: config.id,
  }
}
