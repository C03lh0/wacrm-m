import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findMessages } = vi.hoisted(() => ({ findMessages: vi.fn() }))
vi.mock('./providers/evolution-api', () => ({ findMessages }))

const { processEvolutionMessage, extractCounterpartPhone, isGroupJid } = vi.hoisted(() => ({
  processEvolutionMessage: vi.fn(async () => {}),
  extractCounterpartPhone: vi.fn((key: { remoteJidAlt?: string; remoteJid: string }) =>
    (key.remoteJidAlt ?? key.remoteJid).split('@')[0]
  ),
  isGroupJid: vi.fn((jid: string) => jid.endsWith('@g.us')),
}))
vi.mock('./evolution-webhook-handlers', () => ({
  processEvolutionMessage,
  extractCounterpartPhone,
  isGroupJid,
}))

const { findExistingContact } = vi.hoisted(() => ({ findExistingContact: vi.fn() }))
vi.mock('@/lib/contacts/dedupe', () => ({ findExistingContact }))

import { backfillMissedMessages, EVOLUTION_BACKFILL_MAX_PAGES } from './evolution-backfill'

const CONNECTION = { id: 'conn-1', account_id: 'acct-1', instance_name: 'wacrm-acct1-0001' }
const WATERMARK_SECONDS = 1700000000
const WATERMARK_ISO = new Date(WATERMARK_SECONDS * 1000).toISOString()

function record(id: string, tsSeconds: number, remoteJid = '5511999999999@s.whatsapp.net') {
  return {
    key: { id, remoteJid, fromMe: false },
    pushName: 'Jane',
    messageTimestamp: tsSeconds,
    message: { conversation: 'hi' },
  }
}

function makeFakeDb(lastMessage: { created_at: string } | null) {
  const updateCalls: { table: string; id: string; payload: Record<string, unknown> }[] = []
  const db = {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      let mode: 'select' | 'update' = 'select'
      let pendingUpdate: Record<string, unknown> | null = null
      let eqId = ''
      b.select = () => { mode = 'select'; return b }
      b.update = (payload: Record<string, unknown>) => { mode = 'update'; pendingUpdate = payload; return b }
      b.eq = (col: string, val: string) => { if (col === 'id' || col === 'connection_id') eqId = val; return b }
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = () => {
        if (table === 'messages' && mode === 'select') {
          return Promise.resolve({ data: lastMessage, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'whatsapp_connections' && mode === 'update') {
          updateCalls.push({ table, id: eqId, payload: pendingUpdate! })
        }
        return resolve({ data: null, error: null })
      }
      return b
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, updateCalls }
}

describe('backfillMissedMessages', () => {
  beforeEach(() => {
    findMessages.mockReset()
    processEvolutionMessage.mockClear()
    findExistingContact.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does nothing when the connection has no messages on file yet', async () => {
    const { db, updateCalls } = makeFakeDb(null)
    const result = await backfillMissedMessages(db, CONNECTION, 'user-1')
    expect(result).toEqual({ fetched: 0, ingested: 0 })
    expect(findMessages).not.toHaveBeenCalled()
    expect(updateCalls).toHaveLength(0)
  })

  it('ingests messages newer than the watermark and stops once it reaches it', async () => {
    const { db, updateCalls } = makeFakeDb({ created_at: WATERMARK_ISO })
    findExistingContact.mockResolvedValue({ id: 'contact-1' })
    findMessages.mockResolvedValueOnce({
      records: [
        record('m3', WATERMARK_SECONDS + 300),
        record('m2', WATERMARK_SECONDS + 200),
        record('m1', WATERMARK_SECONDS), // == watermark, stop here
      ],
      currentPage: 1,
      totalPages: 1,
      total: 3,
    })

    const result = await backfillMissedMessages(db, CONNECTION, 'user-1')

    expect(findMessages).toHaveBeenCalledTimes(1)
    expect(findMessages).toHaveBeenCalledWith({ instanceName: 'wacrm-acct1-0001', page: 1, pageSize: 50 })
    expect(processEvolutionMessage).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ fetched: 3, ingested: 2, cappedAt: undefined })
    expect(updateCalls).toEqual([
      { table: 'whatsapp_connections', id: 'conn-1', payload: { is_syncing: true } },
      { table: 'whatsapp_connections', id: 'conn-1', payload: { is_syncing: false } },
    ])
  })

  it('pages until it reaches the watermark, across multiple pages', async () => {
    const { db } = makeFakeDb({ created_at: WATERMARK_ISO })
    findExistingContact.mockResolvedValue({ id: 'contact-1' })
    findMessages
      .mockResolvedValueOnce({
        records: [record('m2', WATERMARK_SECONDS + 200), record('m1', WATERMARK_SECONDS + 100)],
        currentPage: 1,
        totalPages: 2,
        total: 3,
      })
      .mockResolvedValueOnce({
        records: [record('m0', WATERMARK_SECONDS)], // == watermark, stop
        currentPage: 2,
        totalPages: 2,
        total: 3,
      })

    const result = await backfillMissedMessages(db, CONNECTION, 'user-1')

    expect(findMessages).toHaveBeenCalledTimes(2)
    expect(findMessages).toHaveBeenNthCalledWith(2, { instanceName: 'wacrm-acct1-0001', page: 2, pageSize: 50 })
    expect(result.fetched).toBe(3)
    expect(result.ingested).toBe(2)
  })

  it('ignores messages from contacts the CRM does not already know, without ingesting them', async () => {
    const { db } = makeFakeDb({ created_at: WATERMARK_ISO })
    findExistingContact.mockResolvedValue(null)
    findMessages.mockResolvedValueOnce({
      records: [record('m1', WATERMARK_SECONDS + 100), record('m0', WATERMARK_SECONDS)],
      currentPage: 1,
      totalPages: 1,
      total: 2,
    })

    const result = await backfillMissedMessages(db, CONNECTION, 'user-1')

    expect(processEvolutionMessage).not.toHaveBeenCalled()
    expect(result.ingested).toBe(0)
  })

  it('skips group messages without looking up a contact for them', async () => {
    const { db } = makeFakeDb({ created_at: WATERMARK_ISO })
    findMessages.mockResolvedValueOnce({
      records: [record('m1', WATERMARK_SECONDS + 100, '120363@g.us'), record('m0', WATERMARK_SECONDS)],
      currentPage: 1,
      totalPages: 1,
      total: 2,
    })

    await backfillMissedMessages(db, CONNECTION, 'user-1')

    expect(findExistingContact).not.toHaveBeenCalled()
    expect(processEvolutionMessage).not.toHaveBeenCalled()
  })

  it('stops once Evolution returns an empty page, without looping to the page cap', async () => {
    const { db } = makeFakeDb({ created_at: WATERMARK_ISO })
    findMessages.mockResolvedValueOnce({ records: [], currentPage: 1, totalPages: 0, total: 0 })

    const result = await backfillMissedMessages(db, CONNECTION, 'user-1')

    expect(findMessages).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ fetched: 0, ingested: 0, cappedAt: undefined })
  })

  it('stops at the page cap when the watermark is never reached, and reports an approximate remaining count', async () => {
    const { db } = makeFakeDb({ created_at: WATERMARK_ISO })
    findExistingContact.mockResolvedValue({ id: 'contact-1' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    findMessages.mockImplementation(async ({ page }: { page: number }) => ({
      records: [record(`m${page}`, WATERMARK_SECONDS + 100_000 - page)], // always newer than watermark
      currentPage: page,
      totalPages: 1000,
      total: 1000,
    }))

    const result = await backfillMissedMessages(db, CONNECTION, 'user-1')

    expect(findMessages).toHaveBeenCalledTimes(EVOLUTION_BACKFILL_MAX_PAGES)
    expect(result.cappedAt).toBeDefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('flips is_syncing on before paging and off afterward even when findMessages throws mid-loop', async () => {
    const { db, updateCalls } = makeFakeDb({ created_at: WATERMARK_ISO })
    findMessages.mockRejectedValueOnce(new Error('Evolution unreachable'))

    await expect(backfillMissedMessages(db, CONNECTION, 'user-1')).rejects.toThrow('Evolution unreachable')

    expect(updateCalls).toEqual([
      { table: 'whatsapp_connections', id: 'conn-1', payload: { is_syncing: true } },
      { table: 'whatsapp_connections', id: 'conn-1', payload: { is_syncing: false } },
    ])
  })
})
