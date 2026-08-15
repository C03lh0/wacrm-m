import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findMessages,
  isAllowedEvolutionMediaUrl,
  fetchInstanceInfo,
  probeInstanceLiveness,
  restartInstance,
} from './evolution-api'

describe('findMessages', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com'
    process.env.EVOLUTION_API_KEY = 'test-key'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.EVOLUTION_API_URL
    delete process.env.EVOLUTION_API_KEY
  })

  it('POSTs to /chat/findMessages/{instance} with page + offset (page size), and unwraps the nested `messages` envelope', async () => {
    let captured: { url: string; method: string; body: unknown; headers: Record<string, string> } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url,
          method: init.method ?? 'GET',
          body: JSON.parse(String(init.body)),
          headers: init.headers as Record<string, string>,
        }
        return new Response(
          JSON.stringify({
            messages: {
              total: 3,
              pages: 1,
              currentPage: 1,
              records: [
                {
                  key: { id: 'A', remoteJid: '5511@s.whatsapp.net', fromMe: false },
                  pushName: 'Jane',
                  messageTimestamp: 1700000300,
                  message: { conversation: 'hi' },
                },
              ],
            },
          }),
          { status: 200 }
        )
      })
    )

    const result = await findMessages({ instanceName: 'wacrm-acct-0001', page: 1, pageSize: 50 })

    expect(captured).not.toBeNull()
    expect(captured!.url).toBe('https://evolution.example.com/chat/findMessages/wacrm-acct-0001')
    expect(captured!.method).toBe('POST')
    expect(captured!.body).toEqual({ page: 1, offset: 50 })
    expect(captured!.headers.apikey).toBe('test-key')
    expect(result).toEqual({
      records: [
        {
          key: { id: 'A', remoteJid: '5511@s.whatsapp.net', fromMe: false },
          pushName: 'Jane',
          messageTimestamp: 1700000300,
          message: { conversation: 'hi' },
        },
      ],
      currentPage: 1,
      totalPages: 1,
      total: 3,
    })
  })

  it('defaults pageSize to 50 when not provided', async () => {
    let captured: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body))
        return new Response(
          JSON.stringify({ messages: { total: 0, pages: 0, currentPage: 1, records: [] } }),
          { status: 200 }
        )
      })
    )

    await findMessages({ instanceName: 'wacrm-acct-0001', page: 2 })

    expect(captured).toEqual({ page: 2, offset: 50 })
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 404 })))
    await expect(findMessages({ instanceName: 'wacrm-acct-0001', page: 1 })).rejects.toThrow()
  })

  it('defaults missing fields on an empty/malformed envelope to safe empty values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const result = await findMessages({ instanceName: 'wacrm-acct-0001', page: 1 })
    expect(result).toEqual({ records: [], currentPage: 1, totalPages: 0, total: 0 })
  })
})

describe('isAllowedEvolutionMediaUrl', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com'
  })
  afterEach(() => {
    delete process.env.EVOLUTION_API_URL
  })

  it('allows a url on the same host as EVOLUTION_API_URL', () => {
    expect(isAllowedEvolutionMediaUrl('https://evolution.example.com/media/abc.jpg')).toBe(true)
  })

  it('allows a different scheme as long as the host matches', () => {
    expect(isAllowedEvolutionMediaUrl('http://evolution.example.com/media/abc.jpg')).toBe(true)
  })

  it('rejects a url on a different host (the core SSRF case: an attacker- or bug-supplied external/internal target)', () => {
    expect(isAllowedEvolutionMediaUrl('https://attacker.example.net/steal')).toBe(false)
  })

  it('rejects a url pointing at a private/internal address not matching the configured host', () => {
    expect(isAllowedEvolutionMediaUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
  })

  it('rejects a non-http(s) scheme even if the host matches', () => {
    process.env.EVOLUTION_API_URL = 'file:///etc/passwd'
    expect(isAllowedEvolutionMediaUrl('file:///etc/passwd')).toBe(false)
  })

  it('rejects a malformed url', () => {
    expect(isAllowedEvolutionMediaUrl('not a url')).toBe(false)
  })

  it('rejects when EVOLUTION_API_URL is not configured', () => {
    delete process.env.EVOLUTION_API_URL
    expect(isAllowedEvolutionMediaUrl('https://evolution.example.com/media/abc.jpg')).toBe(false)
  })
})

describe('fetchInstanceInfo', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com'
    process.env.EVOLUTION_API_KEY = 'test-key'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.EVOLUTION_API_URL
    delete process.env.EVOLUTION_API_KEY
  })

  it('GETs /instance/fetchInstances?instanceName=X and extracts connectionStatus + ownerJid from the first array entry', async () => {
    let capturedUrl: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url
        return new Response(
          JSON.stringify([{ connectionStatus: 'open', ownerJid: '5511999999999@s.whatsapp.net' }]),
          { status: 200 }
        )
      })
    )

    const result = await fetchInstanceInfo({ instanceName: 'wacrm-acct-0001' })

    expect(capturedUrl).toBe('https://evolution.example.com/instance/fetchInstances?instanceName=wacrm-acct-0001')
    expect(result).toEqual({ connectionStatus: 'open', ownerJid: '5511999999999@s.whatsapp.net' })
  })

  it('defaults to unknown/null on an empty array response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    const result = await fetchInstanceInfo({ instanceName: 'wacrm-acct-0001' })
    expect(result).toEqual({ connectionStatus: 'unknown', ownerJid: null })
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 404 })))
    await expect(fetchInstanceInfo({ instanceName: 'wacrm-acct-0001' })).rejects.toThrow()
  })
})

describe('probeInstanceLiveness', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com'
    process.env.EVOLUTION_API_KEY = 'test-key'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.EVOLUTION_API_URL
    delete process.env.EVOLUTION_API_KEY
  })

  it('POSTs to /chat/fetchProfile/{instance} with the given number and reports alive:true on a 2xx response', async () => {
    let captured: { url: string; body: unknown } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, body: JSON.parse(String(init.body)) }
        return new Response(JSON.stringify({ wuid: '5511999999999@s.whatsapp.net', numberExists: true }), { status: 200 })
      })
    )

    const result = await probeInstanceLiveness({ instanceName: 'wacrm-acct-0001', number: '5511999999999' })

    expect(captured).toEqual({
      url: 'https://evolution.example.com/chat/fetchProfile/wacrm-acct-0001',
      body: { number: '5511999999999' },
    })
    expect(result).toEqual({ alive: true })
  })

  it('reports alive:false (not a throw) on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const result = await probeInstanceLiveness({ instanceName: 'wacrm-acct-0001', number: '5511999999999' })
    expect(result.alive).toBe(false)
    expect(result.reason).toContain('500')
  })

  it('reports alive:false (not a throw) when the underlying fetch rejects (e.g. timeout/network error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failed') }))
    const result = await probeInstanceLiveness({ instanceName: 'wacrm-acct-0001', number: '5511999999999' })
    expect(result.alive).toBe(false)
    expect(result.reason).toBeTruthy()
  })
})

describe('restartInstance', () => {
  beforeEach(() => {
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com'
    process.env.EVOLUTION_API_KEY = 'test-key'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.EVOLUTION_API_URL
    delete process.env.EVOLUTION_API_KEY
  })

  it('POSTs to /instance/restart/{instance}', async () => {
    let captured: { url: string; method: string } | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, method: init.method ?? 'GET' }
        return new Response(JSON.stringify({ instance: { instanceName: 'wacrm-acct-0001', status: 'open' } }), { status: 200 })
      })
    )

    await restartInstance({ instanceName: 'wacrm-acct-0001' })

    expect(captured).toEqual({ url: 'https://evolution.example.com/instance/restart/wacrm-acct-0001', method: 'POST' })
  })

  it('throws on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'nope' }), { status: 500 })))
    await expect(restartInstance({ instanceName: 'wacrm-acct-0001' })).rejects.toThrow()
  })
})
