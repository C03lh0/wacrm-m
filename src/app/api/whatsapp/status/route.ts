import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getWhatsAppConnectionStatus } from '@/lib/whatsapp/connection-status'

/**
 * GET /api/whatsapp/status
 *
 * Provider-agnostic connection status for UI display (Settings
 * overview card, inbox "not connected" banner, 24h session-window
 * gating) — unlike GET /api/whatsapp/config, this never pings Meta
 * live and works for either provider. See connection-status.ts.
 */
export async function GET() {
  try {
    const ctx = await requireRole('viewer')
    const status = await getWhatsAppConnectionStatus(ctx.supabase, ctx.accountId)
    return NextResponse.json(status)
  } catch (err) {
    return toErrorResponse(err)
  }
}
