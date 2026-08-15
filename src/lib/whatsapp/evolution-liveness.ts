/**
 * Detects and recovers from a "zombie" Evolution session: one where
 * `/instance/connectionState` still reports "open" but WhatsApp has
 * silently stopped routing anything through it. CONFIRMED live on
 * 2026-08-15 — a session sat "open" for 3+ hours with zero webhook
 * activity until a manual disconnect/reconnect. The status-only
 * health check (evolution-connection-health.ts / the connections cron)
 * can't catch this on its own, since it reads the exact same
 * misleading "open" flag.
 *
 * Called from the connections cron (src/app/api/whatsapp/connections/
 * cron/route.ts) for any connection whose live status is "connected" —
 * including ticks where nothing changed, which is exactly the case a
 * zombie session looks like from the outside.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchInstanceInfo,
  probeInstanceLiveness,
  restartInstance,
} from './providers/evolution-api'

export interface LivenessCheckConnection {
  id: string
  instance_name: string
}

export interface LivenessCheckResult {
  /** False when there was nothing to probe (not reporting "open", or owner number not yet known). */
  checked: boolean
  alive?: boolean
  /** True once a recovery restart was issued — its own outcome isn't verified until the next check. */
  restarted?: boolean
}

export async function checkAndRecoverInstanceLiveness(
  connection: LivenessCheckConnection
): Promise<LivenessCheckResult> {
  const info = await fetchInstanceInfo({ instanceName: connection.instance_name })

  if (info.connectionStatus !== 'open' || !info.ownerJid) {
    return { checked: false }
  }

  const ownerNumber = info.ownerJid.split('@')[0]
  const probe = await probeInstanceLiveness({ instanceName: connection.instance_name, number: ownerNumber })

  if (probe.alive) {
    return { checked: true, alive: true }
  }

  console.warn(
    `[evolution] liveness probe failed for connection=${connection.id} (reason: ${probe.reason}) — connectionState says "open" but the session looks zombie. Restarting.`
  )

  await restartInstance({ instanceName: connection.instance_name })

  return { checked: true, alive: false, restarted: true }
}
