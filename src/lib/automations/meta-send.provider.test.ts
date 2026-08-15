import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// A minimal Evolution-shaped client — no sendTemplate, matching what
// createEvolutionProviderClient actually produces (see
// providers/evolution-provider.ts). engineSendTemplate must
// feature-detect this as absent rather than crashing.
const evolutionClient = {
  name: 'evolution' as const,
  sendText: vi.fn(async () => ({ providerMessageId: 'evo-msg-1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'evo-msg-1' })),
}

const metaClient = {
  name: 'meta' as const,
  sendText: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
  sendTemplate: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
}

const { resolveProviderForAccount } = vi.hoisted(() => ({
  resolveProviderForAccount: vi.fn(),
}))
vi.mock('@/lib/whatsapp/provider-factory', () => ({ resolveProviderForAccount }))

const CONTACT = { id: 'contact-1', phone: '+15551234567' }

function makeDb(): SupabaseClient {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const chain = () => b
    b.select = chain
    b.eq = chain
    b.update = chain
    b.insert = chain
    b.single = () => Promise.resolve({ data: null, error: null })
    b.maybeSingle = () => {
      if (table === 'contacts') return Promise.resolve({ data: CONTACT, error: null })
      return Promise.resolve({ data: null, error: null })
    }
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null })
    return b
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient
}

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => makeDb(),
}))

import { engineSendText, engineSendTemplate } from './meta-send'
import { SendMessageError } from '@/lib/whatsapp/send-message-error'

describe('automations meta-send — provider capability gating (Evolution)', () => {
  beforeEach(() => {
    resolveProviderForAccount.mockReset()
    evolutionClient.sendText.mockClear()
    evolutionClient.sendMedia.mockClear()
    metaClient.sendTemplate.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a template send on an Evolution connection with unsupported_message_type_for_provider (400)', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    })

    await expect(
      engineSendTemplate({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        templateName: 'order_update',
        language: 'en_US',
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_message_type_for_provider',
      status: 400,
    })
    expect(evolutionClient.sendText).not.toHaveBeenCalled()
  })

  it('still sends a plain text message through the Evolution client normally', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    })

    const result = await engineSendText({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      text: 'hello there',
    })

    expect(result.whatsapp_message_id).toBe('evo-msg-1')
    expect(result.provider).toBe('evolution')
    expect(evolutionClient.sendText).toHaveBeenCalledTimes(1)
  })

  it('sends a template through the Meta client normally', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: metaClient,
      kind: 'meta',
      connectionId: 'conn-2',
    })

    const result = await engineSendTemplate({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      templateName: 'order_update',
      language: 'en_US',
    })

    expect(result.whatsapp_message_id).toBe('meta-msg-1')
    expect(result.provider).toBe('meta')
    expect(metaClient.sendTemplate).toHaveBeenCalledTimes(1)
  })

  it('propagates whatsapp_not_configured / whatsapp_disconnected from resolveProviderForAccount unchanged', async () => {
    resolveProviderForAccount.mockRejectedValue(
      new SendMessageError('whatsapp_disconnected', 'WhatsApp is not connected.', 409),
    )

    await expect(
      engineSendText({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'whatsapp_disconnected', status: 409 })
  })
})
