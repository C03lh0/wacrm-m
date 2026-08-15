import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { getInstanceStatus } from '@/lib/whatsapp/providers/evolution-api'
import { mapEvolutionStatus } from '@/lib/whatsapp/evolution-status'
import { applyConnectionStatusUpdate } from '@/lib/whatsapp/evolution-connection-health'
import { backfillMissedMessages, isEvolutionBackfillEnabled } from '@/lib/whatsapp/evolution-backfill'
import { checkAndRecoverInstanceLiveness } from '@/lib/whatsapp/evolution-liveness'

// Mirrors src/app/api/whatsapp/webhook/evolution/[instanceName]/route.ts's
// maxDuration — backfillMissedMessages can page through up to 20 requests
// to Evolution plus per-message DB/contact lookups, longer than a typical
// health-check tick's default timeout.
export const maxDuration = 60

/**
 * Actively verify each non-terminal Evolution connection's live state
 * against Evolution's own `/instance/connectionState` endpoint and
 * correct `whatsapp_connections.status` if it's stale.
 *
 * Why this exists: the webhook's own `CONNECTION_UPDATE` handling only
 * updates status when Evolution decides to push that event — but a
 * WhatsApp-side session drop (the linked phone unlinking, WhatsApp
 * logging the device out, etc.) doesn't reliably produce one. Without
 * this, a dead connection can sit at `status: 'connected'` in the DB
 * indefinitely, so nothing in the UI ever prompts a reconnect and the
 * inbox silently stops receiving anything.
 *
 * Also runs an active liveness probe (evolution-liveness.ts) on every
 * connection this reports as "connected" — including ticks where
 * nothing changed. `connectionState` alone can't catch a "zombie"
 * session (socket reports "open" but WhatsApp silently stopped routing
 * anything through it, confirmed live on 2026-08-15); the probe does a
 * real WhatsApp round trip and restarts the session if that fails.
 *
 * Meant to be hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger), e.g. every 5 minutes — see docs/docker.md.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision, same rationale as src/app/api/flows/cron.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: connections, error } = await admin
    .from('whatsapp_connections')
    .select('id, instance_name, status, account_id, created_by_user_id')
    .eq('provider', 'evolution')
    .in('status', ['connected', 'connecting', 'qr_required'])

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!connections || connections.length === 0) {
    return NextResponse.json({ checked: 0, changed: 0, restarted: 0 })
  }

  let changed = 0
  let restarted = 0
  for (const connection of connections as {
    id: string
    instance_name: string
    status: string
    account_id: string
    created_by_user_id: string
  }[]) {
    let rawState: string
    try {
      const result = await getInstanceStatus({ instanceName: connection.instance_name })
      rawState = result.rawState
    } catch (err) {
      // Evolution being briefly unreachable (or one bad instance) must
      // not stop the rest of the batch from being checked, and isn't
      // itself evidence the connection is dead — leave status untouched.
      console.error(`[evolution] health check failed for connection=${connection.id}:`, err)
      continue
    }

    const liveStatus = mapEvolutionStatus(rawState)

    if (liveStatus !== connection.status) {
      await applyConnectionStatusUpdate(admin, connection.id, liveStatus, {
        errorDetail:
          liveStatus === 'error' ? `Health check: unmapped Evolution state "${rawState}"` : undefined,
      })
      changed++

      if (liveStatus === 'connected' && isEvolutionBackfillEnabled()) {
        try {
          await backfillMissedMessages(admin, connection, connection.created_by_user_id)
        } catch (err) {
          console.error(`[evolution] backfill failed for connection=${connection.id}:`, err)
        }
      }
    }

    // Deliberately NOT gated on `liveStatus !== connection.status` above —
    // a "zombie" session (connectionState stuck reporting "open" while
    // WhatsApp silently stopped routing anything through it) looks
    // identical to a healthy one on every tick where nothing changes,
    // which is exactly the case that early-continue used to skip.
    if (liveStatus === 'connected') {
      try {
        const liveness = await checkAndRecoverInstanceLiveness(connection)
        if (liveness.restarted) restarted++
      } catch (err) {
        console.error(`[evolution] liveness check failed for connection=${connection.id}:`, err)
      }
    }
  }

  return NextResponse.json({ checked: connections.length, changed, restarted })
}
