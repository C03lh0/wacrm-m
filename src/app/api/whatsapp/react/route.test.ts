import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  sendReaction: vi.fn(),
  setBusinessReaction: vi.fn(),
  removeBusinessReaction: vi.fn(),
  state: {
    /** Provider resolveProviderForAccount hands back, or an error to throw. */
    providerName: 'evolution' as 'evolution' | 'meta',
    /** false = a provider that cannot react at all. */
    providerReacts: true,
    resolveError: null as unknown,
    message: {
      id: 'msg-1',
      message_id: 'ABC123',
      conversation_id: 'conv-1',
      sender_type: 'customer',
    } as Record<string, unknown> | null,
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    supabase: fakeDb(),
    accountId: 'acc-1',
    userId: 'user-1',
  }),
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 500,
  }),
}))

vi.mock('@/lib/whatsapp/provider-factory', () => ({
  resolveProviderForAccount: async () => {
    if (h.state.resolveError) throw h.state.resolveError
    return {
      client: {
        name: h.state.providerName,
        ...(h.state.providerReacts ? { sendReaction: h.sendReaction } : {}),
      },
      kind: h.state.providerName,
    }
  },
}))

vi.mock('@/lib/inbox/business-reaction', () => ({
  setBusinessReaction: h.setBusinessReaction,
  removeBusinessReaction: h.removeBusinessReaction,
}))

/**
 * Minimal chained stub: the route reads the target message, then its
 * conversation (with the contact embedded). Both land on `maybeSingle`,
 * so the table name picked at `from()` is what decides the row.
 */
function fakeDb() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (table === 'messages') return { data: h.state.message, error: null }
          if (table === 'conversations') {
            return {
              data: {
                id: 'conv-1',
                account_id: 'acc-1',
                contact: { phone: '5511999999999', wa_user_id: null },
              },
              error: null,
            }
          }
          return { data: null, error: null }
        },
      }
      return builder
    },
  }
}

import { POST } from './route'
import { SendMessageError } from '@/lib/whatsapp/send-message-error'

type RouteResponse = { body: { error?: string; success?: boolean }; status: number }

function react(body: unknown): Promise<RouteResponse> {
  return POST(
    new Request('http://localhost/api/whatsapp/react', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ) as unknown as Promise<RouteResponse>
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.providerName = 'evolution'
  h.state.providerReacts = true
  h.state.resolveError = null
  h.state.message = {
    id: 'msg-1',
    message_id: 'ABC123',
    conversation_id: 'conv-1',
    sender_type: 'customer',
  }
  h.setBusinessReaction.mockResolvedValue(null)
  h.removeBusinessReaction.mockResolvedValue(null)
  h.sendReaction.mockResolvedValue(undefined)
})

describe('POST /api/whatsapp/react — provider dispatch', () => {
  // The bug this route had: it read whatsapp_config directly and called
  // Meta, so an Evolution account — which has no config row by design —
  // was told "WhatsApp not configured" for a working connection.
  it('reacts through the account provider and mirrors the row', async () => {
    const res = await react({ message_id: 'msg-1', emoji: '👍' })

    expect(res.status).toBe(200)
    expect(h.sendReaction).toHaveBeenCalledWith({
      to: '5511999999999',
      targetMessageId: 'ABC123',
      fromMe: false,
      emoji: '👍',
    })
    expect(h.setBusinessReaction).toHaveBeenCalledOnce()
  })

  it('marks fromMe for a message the account sent', async () => {
    h.state.message = { ...h.state.message!, sender_type: 'agent' }

    await react({ message_id: 'msg-1', emoji: '👍' })

    expect(h.sendReaction.mock.calls[0][0]).toMatchObject({ fromMe: true })
  })

  it('removes the reaction on an empty emoji', async () => {
    const res = await react({ message_id: 'msg-1', emoji: '' })

    expect(res.status).toBe(200)
    expect(h.sendReaction.mock.calls[0][0]).toMatchObject({ emoji: '' })
    expect(h.removeBusinessReaction).toHaveBeenCalledOnce()
    expect(h.setBusinessReaction).not.toHaveBeenCalled()
  })

  it('answers "not supported" when the provider cannot react', async () => {
    h.state.providerReacts = false

    const res = await react({ message_id: 'msg-1', emoji: '👍' })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not supported')
    expect(h.setBusinessReaction).not.toHaveBeenCalled()
  })

  // provider-factory raises this for an Evolution instance that exists
  // but is not connected — a 409 the route used to turn into a 400
  // about configuration.
  it('passes a SendMessageError through with its own status', async () => {
    h.state.resolveError = new SendMessageError(
      'whatsapp_disconnected',
      'WhatsApp is not connected. Please reconnect via QR code.',
      409
    )

    const res = await react({ message_id: 'msg-1', emoji: '👍' })

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('not connected')
  })

  it('does not mirror a reaction the provider refused', async () => {
    h.sendReaction.mockRejectedValue(new Error('Evolution exploded'))

    const res = await react({ message_id: 'msg-1', emoji: '👍' })

    expect(res.status).toBe(502)
    expect(h.setBusinessReaction).not.toHaveBeenCalled()
  })

  it('refuses a message that never reached WhatsApp', async () => {
    h.state.message = { ...h.state.message!, message_id: null }

    const res = await react({ message_id: 'msg-1', emoji: '👍' })

    expect(res.status).toBe(400)
    expect(h.sendReaction).not.toHaveBeenCalled()
  })
})
