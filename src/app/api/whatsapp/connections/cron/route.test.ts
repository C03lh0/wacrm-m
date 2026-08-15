import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getInstanceStatus } = vi.hoisted(() => ({
  getInstanceStatus: vi.fn(),
}))
vi.mock('@/lib/whatsapp/providers/evolution-api', () => ({ getInstanceStatus }))

const { backfillMissedMessages, isEvolutionBackfillEnabled } = vi.hoisted(() => ({
  backfillMissedMessages: vi.fn(async () => ({ fetched: 0, ingested: 0 })),
  isEvolutionBackfillEnabled: vi.fn(() => true),
}))
vi.mock('@/lib/whatsapp/evolution-backfill', () => ({ backfillMissedMessages, isEvolutionBackfillEnabled }))

const { checkAndRecoverInstanceLiveness } = vi.hoisted(() => ({
  checkAndRecoverInstanceLiveness: vi.fn(
    async (
      _connection: { id: string }
    ): Promise<{ checked: boolean; alive?: boolean; restarted?: boolean }> => ({ checked: false })
  ),
}))
vi.mock('@/lib/whatsapp/evolution-liveness', () => ({ checkAndRecoverInstanceLiveness }))

interface FakeConnectionRow {
  id: string
  instance_name: string
  status: string
  account_id: string
  created_by_user_id: string
}

const h = vi.hoisted(() => ({
  state: {
    connections: [] as FakeConnectionRow[],
    updateCalls: [] as { id: string; payload: Record<string, unknown> }[],
  },
}))

vi.mock('@/lib/whatsapp/admin-client', () => {
  const { state } = h
  function builder(table: string) {
    let mode: 'select' | 'update' = 'select'
    let pendingUpdate: Record<string, unknown> | null = null
    let eqId: string | null = null
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.eq = (col: string, val: string) => {
      if (col === 'id') eqId = val
      return b
    }
    b.in = () => b
    b.update = (payload: Record<string, unknown>) => {
      mode = 'update'
      pendingUpdate = payload
      return b
    }
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'whatsapp_connections' && mode === 'select') {
        return resolve({ data: state.connections, error: null })
      }
      if (table === 'whatsapp_connections' && mode === 'update' && eqId) {
        state.updateCalls.push({ id: eqId, payload: pendingUpdate! })
      }
      return resolve({ data: null, error: null })
    }
    return b
  }
  return { supabaseAdmin: () => ({ from: (t: string) => builder(t) }) }
})

import { GET } from './route'

function req(secret: string | null) {
  const headers = new Headers()
  if (secret !== null) headers.set('x-cron-secret', secret)
  return new Request('https://example.com/api/whatsapp/connections/cron', { headers })
}

describe('GET /api/whatsapp/connections/cron', () => {
  const ORIGINAL_SECRET = process.env.AUTOMATION_CRON_SECRET

  beforeEach(() => {
    h.state.connections = []
    h.state.updateCalls = []
    getInstanceStatus.mockReset()
    backfillMissedMessages.mockClear()
    checkAndRecoverInstanceLiveness.mockClear()
    checkAndRecoverInstanceLiveness.mockResolvedValue({ checked: false })
    process.env.AUTOMATION_CRON_SECRET = 'test-secret'
  })

  afterEach(() => {
    process.env.AUTOMATION_CRON_SECRET = ORIGINAL_SECRET
    vi.clearAllMocks()
  })

  it('returns 503 when no cron secret is configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(req('anything'))
    expect(res.status).toBe(503)
    expect(getInstanceStatus).not.toHaveBeenCalled()
  })

  it('rejects a missing or wrong secret', async () => {
    const missing = await GET(req(null))
    expect(missing.status).toBe(401)

    const wrong = await GET(req('not-the-secret'))
    expect(wrong.status).toBe(401)

    expect(getInstanceStatus).not.toHaveBeenCalled()
  })

  it('checks nothing when there are no non-terminal connections', async () => {
    h.state.connections = []
    const res = await GET(req('test-secret'))
    const json = await res.json()
    expect(json).toEqual({ checked: 0, changed: 0, restarted: 0 })
    expect(getInstanceStatus).not.toHaveBeenCalled()
  })

  it('flips a connected row to disconnected when the live state comes back close', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connected', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'close' })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 1, changed: 1, restarted: 0 })
    expect(h.state.updateCalls).toHaveLength(1)
    expect(h.state.updateCalls[0]).toMatchObject({
      id: 'conn-1',
      payload: expect.objectContaining({ status: 'disconnected' }),
    })
    expect(backfillMissedMessages).not.toHaveBeenCalled()
    expect(checkAndRecoverInstanceLiveness).not.toHaveBeenCalled()
  })

  it('leaves a connected row untouched when the live state is still open, and still runs the liveness probe (the zombie-session case lives here)', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connected', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'open' })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 1, changed: 0, restarted: 0 })
    expect(h.state.updateCalls).toHaveLength(0)
    expect(backfillMissedMessages).not.toHaveBeenCalled()
    expect(checkAndRecoverInstanceLiveness).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conn-1', instance_name: 'wacrm-acct1-0001' })
    )
  })

  it('checks a qr_required/connecting connection too (not just connected) — query includes all non-terminal statuses', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connecting', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'connecting' })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(getInstanceStatus).toHaveBeenCalledWith({ instanceName: 'wacrm-acct1-0001' })
    expect(json).toEqual({ checked: 1, changed: 0, restarted: 0 })
    expect(checkAndRecoverInstanceLiveness).not.toHaveBeenCalled()
  })

  it('an Evolution error for one connection does not prevent others in the same batch from being checked', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connected', account_id: 'acct-1', created_by_user_id: 'user-1' },
      { id: 'conn-2', instance_name: 'wacrm-acct2-0002', status: 'connected', account_id: 'acct-2', created_by_user_id: 'user-2' },
    ]
    getInstanceStatus.mockImplementation(async ({ instanceName }: { instanceName: string }) => {
      if (instanceName === 'wacrm-acct1-0001') throw new Error('Evolution unreachable')
      return { rawState: 'close' }
    })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 2, changed: 1, restarted: 0 })
    expect(h.state.updateCalls).toHaveLength(1)
    expect(h.state.updateCalls[0].id).toBe('conn-2')
  })

  it('triggers a backfill when a connection reconnects (flips into connected from another status)', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'qr_required', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'open' })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 1, changed: 1, restarted: 0 })
    expect(backfillMissedMessages).toHaveBeenCalledTimes(1)
    const [, connectionArg, userIdArg] = backfillMissedMessages.mock.calls[0] as unknown as [
      unknown,
      { id: string },
      string,
    ]
    expect(connectionArg.id).toBe('conn-1')
    expect(userIdArg).toBe('user-1')
    expect(checkAndRecoverInstanceLiveness).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn-1' }))
  })

  it('does not trigger a backfill on a genuine reconnect when EVOLUTION_BACKFILL_ENABLED is off (the default kill switch)', async () => {
    isEvolutionBackfillEnabled.mockReturnValueOnce(false)
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'qr_required', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'open' })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 1, changed: 1, restarted: 0 })
    expect(backfillMissedMessages).not.toHaveBeenCalled()
  })

  it('does not trigger a backfill when a connection flips away from connected', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connected', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'close' })

    await GET(req('test-secret'))

    expect(backfillMissedMessages).not.toHaveBeenCalled()
  })

  it('does not run the liveness probe on a connection that stays qr_required/connecting (only "connected" ones)', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connecting', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'connecting' })

    await GET(req('test-secret'))

    expect(checkAndRecoverInstanceLiveness).not.toHaveBeenCalled()
  })

  it('counts a liveness-triggered restart in the response, and does not treat it as a status "change"', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connected', account_id: 'acct-1', created_by_user_id: 'user-1' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'open' })
    checkAndRecoverInstanceLiveness.mockResolvedValue({ checked: true, alive: false, restarted: true })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 1, changed: 0, restarted: 1 })
    expect(h.state.updateCalls).toHaveLength(0)
  })

  it('a liveness-check failure for one connection does not stop the rest of the batch from being checked', async () => {
    h.state.connections = [
      { id: 'conn-1', instance_name: 'wacrm-acct1-0001', status: 'connected', account_id: 'acct-1', created_by_user_id: 'user-1' },
      { id: 'conn-2', instance_name: 'wacrm-acct2-0002', status: 'connected', account_id: 'acct-2', created_by_user_id: 'user-2' },
    ]
    getInstanceStatus.mockResolvedValue({ rawState: 'open' })
    checkAndRecoverInstanceLiveness.mockImplementation(async (connection: { id: string }) => {
      if (connection.id === 'conn-1') throw new Error('Evolution unreachable')
      return { checked: true, alive: false, restarted: true }
    })

    const res = await GET(req('test-secret'))
    const json = await res.json()

    expect(json).toEqual({ checked: 2, changed: 0, restarted: 1 })
    expect(checkAndRecoverInstanceLiveness).toHaveBeenCalledTimes(2)
  })
})
