import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getInstanceConnect } from '@/lib/whatsapp/providers/evolution-api'
import { EvolutionApiError, evolutionErrorResponseBody } from '@/lib/whatsapp/evolution-errors'
import { reprovisionConnection, QR_TTL_SECONDS } from '@/lib/whatsapp/evolution-provisioning'

/**
 * POST /api/whatsapp/connections/qr
 *
 * Re-requests a QR code for the account's existing Evolution
 * connection once the previous one expires. This is the ONLY polling-
 * adjacent call in the Evolution flow — the frontend calls it on a
 * timer-driven expiry, not on an interval, and connection status
 * itself is pushed via Supabase Realtime once the webhook updates the
 * row (see src/hooks/use-realtime.ts).
 *
 * If Evolution refuses to hand out a code for the existing instance,
 * the instance is replaced rather than the error being passed to the
 * user. An instance that has been logged out, restarted into a bad
 * state, or deleted underneath us cannot be talked back into pairing,
 * and before this fallback existed that answer was simply the end of
 * the road: the reconnect button produced an error every time, with no
 * other path in the UI that could create a working instance.
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

    let result
    try {
      result = await getInstanceConnect({ instanceName: connection.instance_name })
    } catch (err) {
      if (!(err instanceof EvolutionApiError)) throw err
      // The instance can't produce a code. Replace it and return the
      // new one — re-provisioning writes the row itself, so there is
      // nothing left to persist below.
      console.warn(
        `[evolution] ${err.code} refreshing QR for instance=${connection.instance_name}; re-provisioning:`,
        err.cause ?? err.message
      )
      const reprovisioned = await reprovisionConnection(
        supabaseAdmin(),
        ctx.accountId,
        connection
      )
      return NextResponse.json({ ...reprovisioned, provider: 'evolution' })
    }

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
