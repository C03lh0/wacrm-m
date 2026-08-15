import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { mapEvolutionStatus } from '@/lib/whatsapp/evolution-status'
import {
  processEvolutionMessage,
  processEvolutionMessageStatus,
  type EvolutionMessagePayload,
  type EvolutionMessageStatusUpdate,
} from '@/lib/whatsapp/evolution-webhook-handlers'
import { applyConnectionStatusUpdate } from '@/lib/whatsapp/evolution-connection-health'
import { backfillMissedMessages, isEvolutionBackfillEnabled } from '@/lib/whatsapp/evolution-backfill'

// Mirrors src/app/api/whatsapp/webhook/route.ts's maxDuration — inbound
// processing can fan out to media download + storage upload calls.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Evolution's webhook payload envelope — CONFIRMED against a real
 * example payload from the official docs (docs.evolutionfoundation.com.br,
 * /concepts/webhooks): a single configured URL receives every
 * subscribed event as one POST with `{ event, instance, data,
 * destination, date_time, sender, server_url, apikey }`. Only the
 * fields this route actually reads are typed here.
 */
interface EvolutionWebhookBody {
  event?: string
  instance?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any
}

/**
 * Normalize an Evolution event name for matching. CONFIRMED real
 * payloads use UPPER_SNAKE_CASE (`"event": "MESSAGES_UPSERT"` — from
 * the official docs' example payload), but an older GitHub issue
 * thread referenced dot.case (`messages.upsert`), suggesting the
 * convention may differ by version. Normalizing to upper-snake makes
 * the switch below match either convention instead of silently
 * matching neither (the bug this replaced: comparing a lowercased
 * event against dot.case literals never matched real
 * `MESSAGES_UPSERT`-style payloads, so every event fell through to
 * the unhandled-event log line).
 */
function normalizeEventName(event: string | undefined): string {
  return (event || '').trim().toUpperCase().replace(/[.\s-]+/g, '_')
}

/**
 * Verify the inbound call actually belongs to this connection's
 * configured webhook. The secret is carried as a custom `Authorization:
 * Bearer <secret>` header, configured on the Evolution instance's
 * webhook at creation time (src/app/api/whatsapp/connections/route.ts's
 * webhookAuthHeaders) — deliberately NOT in the URL, since URLs
 * routinely end up in access/proxy logs even when headers don't.
 *
 * ASSUMPTION: this depends on the target Evolution deployment actually
 * forwarding custom `webhook.headers` on delivery — confirm against
 * your instance (see docs/evolution-api.md). When the connection has
 * no webhook_secret stored, verification is skipped rather than
 * failing closed — instance_name in the URL path is still an
 * unguessable-enough routing key on its own, but this is weaker than
 * Meta's HMAC verification. Every reconnect mints a fresh instance +
 * secret, so exposure from a skipped check is bounded to that
 * connection's lifetime.
 *
 * A connection that DOES have a webhook_secret but fails to decrypt
 * it (corrupted ciphertext, rotated ENCRYPTION_KEY, ...) is NOT
 * treated the same as "no secret configured" — the caller sees a
 * generic 401 rather than being let through, since a decrypt failure
 * means we genuinely can't verify the caller and silently accepting
 * would defeat the point of having a secret at all.
 */
function verifyEvolutionWebhookAuth(request: Request, expectedSecret: string | null): boolean {
  if (!expectedSecret) return true
  const authHeader = request.headers.get('authorization')
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : authHeader
  if (!provided) return false
  // Constant-time compare to avoid a timing side-channel on the secret.
  if (provided.length !== expectedSecret.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expectedSecret.charCodeAt(i)
  }
  return diff === 0
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ instanceName: string }> }
) {
  const { instanceName } = await params

  const { data: connection, error: fetchError } = await supabaseAdmin()
    .from('whatsapp_connections')
    .select('*')
    .eq('instance_name', instanceName)
    .maybeSingle()

  // 404-as-200: never reveal whether an instance name exists to an
  // unauthenticated caller.
  if (fetchError || !connection) {
    console.warn(`[evolution] webhook for unknown instance: ${instanceName}`)
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  let expectedSecret: string | null = null
  let secretDecryptFailed = false
  if (connection.webhook_secret) {
    try {
      expectedSecret = decrypt(connection.webhook_secret)
    } catch (err) {
      console.error('[evolution] failed to decrypt webhook_secret:', err)
      secretDecryptFailed = true
    }
  }
  // A decrypt failure must fail closed even though a missing secret
  // fails open (see verifyEvolutionWebhookAuth's doc comment) — an
  // undecryptable secret means we can't verify the caller at all.
  if (secretDecryptFailed || !verifyEvolutionWebhookAuth(request, expectedSecret)) {
    console.warn(`[evolution] rejected webhook with invalid auth for instance: ${instanceName}`)
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }

  const rawBody = await request.text()
  let body: EvolutionWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack immediately, process after — same reasoning as the Meta webhook
  // (src/app/api/whatsapp/webhook/route.ts): serverless functions can be
  // frozen the instant the response is sent, so DB writes must happen
  // inside `after()` to be guaranteed to complete.
  after(async () => {
    try {
      await processEvolutionWebhookEvent(connection, body)
    } catch (error) {
      console.error('[evolution] error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processEvolutionWebhookEvent(connection: any, body: EvolutionWebhookBody) {
  const event = normalizeEventName(body.event)
  const db = supabaseAdmin()

  console.log(`[evolution] webhook received account=${connection.account_id} connectionId=${connection.id} event=${event}`)

  switch (event) {
    case 'QRCODE_UPDATED': {
      const qrCode = body.data?.qrcode?.base64 ?? body.data?.base64 ?? null
      await db
        .from('whatsapp_connections')
        .update({
          status: 'qr_required',
          qr_code: qrCode,
          qr_expires_at: qrCode ? new Date(Date.now() + 60_000).toISOString() : null,
        })
        .eq('id', connection.id)
      break
    }

    case 'CONNECTION_UPDATE': {
      const rawState = body.data?.state ?? body.data?.connection ?? 'unknown'
      const status = mapEvolutionStatus(rawState)
      // KNOWN GAP: the real CONNECTION_UPDATE payload confirmed via the
      // official docs is `{ state, statusReason }` — no phone-number
      // field. `wuid` was an unconfirmed guess and will never be
      // present, so phone_number is never populated by this event.
      // Getting the connected number needs a separate call (e.g.
      // fetching the instance's own info) not yet implemented; the
      // connection still works, the UI just won't show the number.
      const phoneNumber = body.data?.wuid ? String(body.data.wuid).split('@')[0] : undefined
      const errorDetail =
        status === 'error'
          ? typeof body.data === 'object'
            ? JSON.stringify(body.data).slice(0, 500)
            : String(body.data)
          : undefined

      await applyConnectionStatusUpdate(db, connection.id, status, { phoneNumber, errorDetail })
      console.log(`[evolution] connection status account=${connection.account_id} connectionId=${connection.id} status=${status}`)

      if (status === 'connected' && connection.status !== 'connected' && isEvolutionBackfillEnabled()) {
        try {
          await backfillMissedMessages(db, connection, connection.created_by_user_id)
        } catch (err) {
          console.error(`[evolution] backfill failed for connection=${connection.id}:`, err)
        }
      }
      break
    }

    case 'MESSAGES_UPSERT': {
      const messages = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean)
      for (const msg of messages as EvolutionMessagePayload[]) {
        if (!msg?.key?.id) continue
        await processEvolutionMessage(db, connection, connection.created_by_user_id, msg)
      }
      break
    }

    case 'MESSAGES_UPDATE': {
      const updates = Array.isArray(body.data) ? body.data : [body.data].filter(Boolean)
      for (const update of updates as EvolutionMessageStatusUpdate[]) {
        if (!update?.key?.id) continue
        await processEvolutionMessageStatus(db, connection, update)
      }
      break
    }

    case 'SEND_MESSAGE': {
      // Outbound-send acknowledgment — the message row is already
      // inserted by send-message.ts at send time, so there is nothing
      // additional to persist here. Logged for observability only.
      break
    }

    default:
      console.log(`[evolution] unhandled webhook event: ${event}`)
  }
}
