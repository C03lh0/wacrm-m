import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { deliverScheduledBroadcast } = vi.hoisted(() => ({
  deliverScheduledBroadcast: vi.fn(),
}))
vi.mock('@/lib/whatsapp/broadcast-core', () => ({ deliverScheduledBroadcast }))

const h = vi.hoisted(() => ({
  state: {
    due: [] as { id: string }[],
    /** ids that lose the optimistic-lock race (claim returns null). */
    alreadyClaimed: new Set<string>(),
    claimedIds: [] as string[],
  },
}))

vi.mock('@/lib/whatsapp/admin-client', () => {
  const { state } = h
  function builder(table: string) {
    const ops: { type: 'select' | 'update'; filters: [string, unknown][] } = {
      type: 'select',
      filters: [],
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => ((ops.type = 'update'), b),
      eq: (k: string, v: unknown) => (ops.filters.push([k, v]), b),
      lte: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        const id = ops.filters.find(([k]) => k === 'id')?.[1] as string
        if (state.alreadyClaimed.has(id)) {
          return Promise.resolve({ data: null, error: null })
        }
        state.claimedIds.push(id)
        return Promise.resolve({ data: { id }, error: null })
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table === 'broadcasts' && ops.type === 'select') {
          return resolve({ data: state.due, error: null })
        }
        return resolve({ data: null, error: null })
      },
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }
})

import { GET } from './route'

function req(secret: string | null) {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('https://example.com/api/broadcasts/cron', { headers })
}

describe('GET /api/broadcasts/cron', () => {
  const ORIGINAL_SECRET = process.env.AUTOMATION_CRON_SECRET

  beforeEach(() => {
    h.state.due = []
    h.state.alreadyClaimed = new Set()
    h.state.claimedIds = []
    deliverScheduledBroadcast.mockReset()
    process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  })

  afterEach(() => {
    process.env.AUTOMATION_CRON_SECRET = ORIGINAL_SECRET
  })

  it('returns 503 when no cron secret is configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(req('anything'))
    expect(res.status).toBe(503)
    expect(deliverScheduledBroadcast).not.toHaveBeenCalled()
  })

  it('rejects a missing or wrong secret', async () => {
    const missing = await GET(req(null))
    expect(missing.status).toBe(401)

    const wrong = await GET(req('not-the-secret'))
    expect(wrong.status).toBe(401)

    expect(deliverScheduledBroadcast).not.toHaveBeenCalled()
  })

  it('processes zero when nothing is due', async () => {
    h.state.due = []
    const res = await GET(req('test-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 0 })
    expect(deliverScheduledBroadcast).not.toHaveBeenCalled()
  })

  it('claims and delivers each due broadcast', async () => {
    h.state.due = [{ id: 'b1' }, { id: 'b2' }]
    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ processed: 2 })
    expect(deliverScheduledBroadcast).toHaveBeenCalledTimes(2)
    expect(deliverScheduledBroadcast).toHaveBeenCalledWith(expect.anything(), 'b1')
    expect(deliverScheduledBroadcast).toHaveBeenCalledWith(expect.anything(), 'b2')
  })

  it('skips a broadcast that a concurrent invocation already claimed (double-invocation safety)', async () => {
    h.state.due = [{ id: 'b1' }, { id: 'b2' }]
    h.state.alreadyClaimed = new Set(['b1'])

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ processed: 1 })
    expect(deliverScheduledBroadcast).toHaveBeenCalledTimes(1)
    expect(deliverScheduledBroadcast).toHaveBeenCalledWith(expect.anything(), 'b2')
  })
})
