import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  createInstance,
  setInstanceWebhook,
  setInstanceSettings,
  getInstanceConnect,
  logoutInstance,
  DEFAULT_WEBHOOK_EVENTS,
} from '@/lib/whatsapp/providers/evolution-api'
import { EvolutionApiError, evolutionErrorResponseBody } from '@/lib/whatsapp/evolution-errors'
import { mapEvolutionStatus } from '@/lib/whatsapp/evolution-status'

// Evolution QR codes follow the WhatsApp Web / Baileys pairing protocol,
// whose codes are conventionally short-lived (~60s) — ASSUMPTION, confirm
// against the target Evolution deployment's actual QR TTL.
const QR_TTL_SECONDS = 60

/**
 * Build the plain webhook callback URL — no secret embedded here.
 * URLs routinely end up in access logs, proxy logs, and browser/CLI
 * history, so the connection's auth secret is instead carried as a
 * custom `Authorization` header on the webhook delivery (see
 * webhookAuthHeaders below), never as part of the URL itself.
 */
function buildWebhookUrl(instanceName: string): string {
  // Reuses the app's existing canonical-URL var (also used by
  // /api/account/invitations) rather than introducing a second one.
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL
  if (!appUrl) {
    throw new EvolutionApiError(
      'EVOLUTION_INSTANCE_ERROR',
      undefined,
      'NEXT_PUBLIC_SITE_URL is not configured; cannot register an Evolution webhook callback.'
    )
  }
  return `${appUrl.replace(/\/+$/, '')}/api/whatsapp/webhook/evolution/${encodeURIComponent(instanceName)}`
}

/**
 * Header carrying the connection's secret on every webhook delivery —
 * verified (constant-time) in the Evolution webhook route. ASSUMPTION:
 * Evolution API v2 forwards a `webhook.headers` object configured at
 * instance-create/webhook-set time; if the target deployment doesn't
 * support custom webhook headers, this header is simply never
 * presented back to us and verification falls back to skipping the
 * check (see verifyEvolutionWebhookAuth's own comment) rather than
 * failing closed — tightening that gap requires confirming the real
 * mechanism against the target deployment (see docs/evolution-api.md).
 */
function webhookAuthHeaders(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` }
}

/**
 * GET /api/whatsapp/connections
 *
 * Returns the account's current Evolution connection (or null). Never
 * includes EVOLUTION_API_KEY or any Evolution-internal token.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer')

    const { data: connection, error } = await ctx.supabase
      .from('whatsapp_connections')
      .select('id, provider, status, phone_number, display_name, qr_code, qr_expires_at, connected_at, disconnected_at, last_error')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[whatsapp/connections GET] fetch failed:', error.message)
      return NextResponse.json({ error: 'Failed to fetch connection' }, { status: 500 })
    }

    return NextResponse.json({ connection: connection ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/connections
 *
 * Body: { provider: "evolution" }
 *
 * Creates a new Evolution instance for the account, configures its
 * webhook, and returns the initial QR code. Admin-only. Meta accounts
 * continue to connect via POST /api/whatsapp/config — this route is
 * Evolution-only.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    let body: { provider?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (body.provider !== 'evolution') {
      return NextResponse.json(
        { error: 'Only "evolution" is supported on this endpoint. Configure Meta via /api/whatsapp/config.' },
        { status: 400 }
      )
    }

    // One connection per account (mirrors whatsapp_config's own rule).
    const { data: existing } = await ctx.supabase
      .from('whatsapp_connections')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (existing) {
      return NextResponse.json(
        { error: 'This account already has a WhatsApp connection. Disconnect it before creating a new one.' },
        { status: 409 }
      )
    }

    const instanceName = `wacrm-${ctx.accountId.slice(0, 8)}-${randomUUID().slice(0, 8)}`
    const webhookSecret = randomUUID()
    const webhookUrl = buildWebhookUrl(instanceName)
    const webhookHeaders = webhookAuthHeaders(webhookSecret)

    console.log(`[evolution] creating instance account=${ctx.accountId} instance=${instanceName}`)
    const created = await createInstance({
      instanceName,
      webhookUrl,
      webhookEvents: DEFAULT_WEBHOOK_EVENTS,
      webhookHeaders,
    })

    // Some Evolution deployments require a separate webhook-set call
    // rather than accepting webhook config inline at creation —
    // idempotent, safe to call unconditionally.
    await setInstanceWebhook({
      instanceName,
      url: webhookUrl,
      events: DEFAULT_WEBHOOK_EVENTS,
      headers: webhookHeaders,
    })

    // wacrm has no concept of group chats — without this, a group
    // message would still hit the webhook and create a fake "contact"
    // out of the group's JID (see setInstanceSettings's own comment).
    await setInstanceSettings({ instanceName })

    let qrCode = created.qrCode
    if (!qrCode) {
      console.log(`[evolution] requesting QR account=${ctx.accountId} instance=${instanceName}`)
      const connectResult = await getInstanceConnect({ instanceName })
      qrCode = connectResult.qrCode
    }

    const qrExpiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000).toISOString()

    const { data: row, error: insertError } = await supabaseAdmin()
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        created_by_user_id: ctx.userId,
        provider: 'evolution',
        instance_name: instanceName,
        status: mapEvolutionStatus('connecting'),
        qr_code: qrCode ?? null,
        qr_expires_at: qrCode ? qrExpiresAt : null,
        webhook_secret: encrypt(webhookSecret),
      })
      .select('id, status, qr_code, qr_expires_at')
      .single()

    if (insertError) {
      console.error('[evolution] failed to persist connection:', insertError.message)
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
    }

    console.log(`[evolution] connection created account=${ctx.accountId} connectionId=${row.id} instance=${instanceName}`)

    return NextResponse.json({
      connectionId: row.id,
      provider: 'evolution',
      status: row.status,
      qrCode: row.qr_code,
      qrExpiresAt: row.qr_expires_at,
    })
  } catch (err) {
    if (err instanceof EvolutionApiError) {
      console.error(`[evolution] ${err.code}:`, err.cause ?? err.message)
      return NextResponse.json(evolutionErrorResponseBody(err), { status: err.status })
    }
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/whatsapp/connections
 *
 * Disconnects the account's Evolution connection: logs out the
 * instance (session-preserving, so reconnecting doesn't require
 * recreating it), clears the QR, marks the row disconnected. Message
 * history is never touched.
 */
export async function DELETE() {
  try {
    const ctx = await requireRole('admin')

    const { data: connection, error: fetchError } = await ctx.supabase
      .from('whatsapp_connections')
      .select('id, instance_name')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (fetchError) {
      console.error('[evolution] failed to fetch connection for disconnect:', fetchError.message)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }
    if (!connection) {
      return NextResponse.json({ error: 'No Evolution connection found' }, { status: 404 })
    }

    try {
      await logoutInstance({ instanceName: connection.instance_name })
    } catch (err) {
      // Best-effort — if Evolution is unreachable we still want the
      // local row to reflect "disconnected" so the user isn't stuck.
      console.warn('[evolution] logoutInstance failed (continuing to mark disconnected):', err)
    }

    const { error: updateError } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update({
        status: 'disconnected',
        qr_code: null,
        qr_expires_at: null,
        disconnected_at: new Date().toISOString(),
      })
      .eq('id', connection.id)

    if (updateError) {
      console.error('[evolution] failed to mark connection disconnected:', updateError.message)
      return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
    }

    console.log(`[evolution] disconnected account=${ctx.accountId} connectionId=${connection.id}`)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
