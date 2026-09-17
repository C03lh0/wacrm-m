import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import { logoutInstance } from '@/lib/whatsapp/providers/evolution-api'
import { EvolutionApiError, evolutionErrorResponseBody } from '@/lib/whatsapp/evolution-errors'
import { mapEvolutionStatus } from '@/lib/whatsapp/evolution-status'
import {
  provisionEvolutionInstance,
  reprovisionConnection,
  QR_TTL_SECONDS,
} from '@/lib/whatsapp/evolution-provisioning'

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
      .select('id, provider, status, phone_number, display_name, qr_code, qr_expires_at, connected_at, disconnected_at, last_error, last_inbound_at')
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
      .select('id, instance_name, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    // A live connection is the only thing this route still refuses.
    //
    // It used to refuse whenever ANY row existed, which combined with
    // DELETE keeping the row around (see below) meant that once a
    // connection broke there was no way to create a working one: POST
    // said "disconnect it first" about a connection that was already
    // disconnected. Every reconnect had to go through the QR route,
    // which re-asked the same broken Evolution instance for a code.
    if (existing && existing.status === 'connected') {
      return NextResponse.json(
        { error: 'This account already has a WhatsApp connection. Disconnect it before creating a new one.' },
        { status: 409 }
      )
    }

    // Reconnecting an existing row re-provisions in place: the old
    // Evolution instance is deleted and a fresh one takes its slot on
    // the same row, so `messages.connection_id` and the conversation
    // history it anchors stay intact.
    if (existing) {
      const result = await reprovisionConnection(supabaseAdmin(), ctx.accountId, existing)
      return NextResponse.json({ ...result, provider: 'evolution' })
    }

    const provisioned = await provisionEvolutionInstance(ctx.accountId)
    const qrExpiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000).toISOString()

    const { data: row, error: insertError } = await supabaseAdmin()
      .from('whatsapp_connections')
      .insert({
        account_id: ctx.accountId,
        created_by_user_id: ctx.userId,
        provider: 'evolution',
        instance_name: provisioned.instanceName,
        status: mapEvolutionStatus('connecting'),
        qr_code: provisioned.qrCode,
        qr_expires_at: provisioned.qrCode ? qrExpiresAt : null,
        webhook_secret: encrypt(provisioned.webhookSecret),
      })
      .select('id, status, qr_code, qr_expires_at')
      .single()

    if (insertError) {
      console.error('[evolution] failed to persist connection:', insertError.message)
      return NextResponse.json({ error: 'Failed to save connection' }, { status: 500 })
    }

    console.log(
      `[evolution] connection created account=${ctx.accountId} connectionId=${row.id} instance=${provisioned.instanceName}`
    )

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
 * instance, clears the QR, marks the row disconnected. Message history
 * is never touched.
 *
 * The row is kept rather than deleted because `messages.connection_id`
 * references it. Reconnecting therefore goes through POST, which
 * re-provisions a brand-new Evolution instance onto this same row —
 * the logout below is a courtesy to the Evolution side, not something
 * the reconnect path depends on succeeding.
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
