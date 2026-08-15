import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { deliverScheduledBroadcast } from '@/lib/whatsapp/broadcast-core'

/**
 * Drain due scheduled broadcasts (`status='scheduled'`, `scheduled_at`
 * in the past) — the dashboard wizard's "schedule for later" option.
 * Meant to be hit on a schedule (Vercel Cron / GitHub Actions /
 * external pinger).
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision, same rationale as src/app/api/flows/cron.
 *
 * The claim step (status='scheduled' → 'sending', guarded by the
 * precondition) serves as a simple lock so overlapping invocations
 * don't double-send the same broadcast. Best-effort only; an
 * expensive SELECT ... FOR UPDATE is avoided in favor of a two-step
 * UPDATE-by-id, matching the automations cron's pattern.
 *
 * Delivery runs sequentially and awaited here (not deferred via
 * `after()`, unlike the immediate-send path) — this route's whole job
 * is the deferred send, so there's no request/response latency to
 * hide behind.
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
  const { data: due, error } = await admin
    .from('broadcasts')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('broadcasts')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await deliverScheduledBroadcast(admin, row.id as string)
    processed++
  }

  return NextResponse.json({ processed })
}
