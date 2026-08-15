/**
 * Builds/applies the `whatsapp_connections` field set for a given
 * normalized status transition — shared by the webhook's own
 * `CONNECTION_UPDATE` handling (src/app/api/whatsapp/webhook/evolution/
 * [instanceName]/route.ts) and the active health-check cron (src/app/
 * api/whatsapp/connections/cron/route.ts), which both need to persist
 * the exact same field shape when the connection's status changes —
 * one reacts to Evolution pushing an event, the other polls Evolution's
 * live connection-state endpoint for connections Evolution never told
 * us about.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { InternalConnectionStatus } from './evolution-status'

export interface ConnectionStatusUpdateOptions {
  phoneNumber?: string
  errorDetail?: string
}

export function buildConnectionStatusUpdate(
  status: InternalConnectionStatus,
  opts: ConnectionStatusUpdateOptions = {}
): Record<string, unknown> {
  const update: Record<string, unknown> = { status }
  if (status === 'connected') {
    update.connected_at = new Date().toISOString()
    update.qr_code = null
    update.qr_expires_at = null
    update.last_error = null
    if (opts.phoneNumber) update.phone_number = opts.phoneNumber
  } else if (status === 'disconnected') {
    update.disconnected_at = new Date().toISOString()
  } else if (status === 'error' && opts.errorDetail) {
    update.last_error = opts.errorDetail
  }
  return update
}

export async function applyConnectionStatusUpdate(
  db: SupabaseClient,
  connectionId: string,
  status: InternalConnectionStatus,
  opts: ConnectionStatusUpdateOptions = {}
): Promise<void> {
  await db
    .from('whatsapp_connections')
    .update(buildConnectionStatusUpdate(status, opts))
    .eq('id', connectionId)
}
