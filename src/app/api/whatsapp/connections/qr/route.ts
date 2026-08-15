import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getInstanceConnect } from '@/lib/whatsapp/providers/evolution-api'
import { EvolutionApiError, evolutionErrorResponseBody } from '@/lib/whatsapp/evolution-errors'

const QR_TTL_SECONDS = 60

/**
 * POST /api/whatsapp/connections/qr
 *
 * Re-requests a QR code for the account's existing Evolution
 * connection once the previous one expires. This is the ONLY polling-
 * adjacent call in the Evolution flow — the frontend calls it on a
 * timer-driven expiry, not on an interval, and connection status
 * itself is pushed via Supabase Realtime once the webhook updates the
 * row (see src/hooks/use-realtime.ts).
 */
export async function POST() {
  try {
    const ctx = await requireRole('admin')

    const { data: connection, error: fetchError } = await ctx.supabase
      .from('whatsapp_connections')
      .select('id, instance_name, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (fetchError) {
      console.error('[evolution] failed to fetch connection for QR refresh:', fetchError.message)
      return NextResponse.json({ error: 'Failed to refresh QR code' }, { status: 500 })
    }
    if (!connection) {
      return NextResponse.json({ error: 'No Evolution connection found' }, { status: 404 })
    }
    if (connection.status === 'connected') {
      return NextResponse.json(
        { error: 'WhatsApp is already connected.' },
        { status: 409 }
      )
    }

    console.log(`[evolution] refreshing QR account=${ctx.accountId} connectionId=${connection.id}`)
    const result = await getInstanceConnect({ instanceName: connection.instance_name })
    const qrExpiresAt = new Date(Date.now() + QR_TTL_SECONDS * 1000).toISOString()

    const { data: row, error: updateError } = await supabaseAdmin()
      .from('whatsapp_connections')
      .update({
        status: 'qr_required',
        qr_code: result.qrCode ?? null,
        qr_expires_at: result.qrCode ? qrExpiresAt : null,
      })
      .eq('id', connection.id)
      .select('id, status, qr_code, qr_expires_at')
      .single()

    if (updateError) {
      console.error('[evolution] failed to persist refreshed QR:', updateError.message)
      return NextResponse.json({ error: 'Failed to refresh QR code' }, { status: 500 })
    }

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
