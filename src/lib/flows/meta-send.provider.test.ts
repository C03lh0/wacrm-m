import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// A minimal Evolution-shaped client — no sendTemplate / sendInteractive*,
// matching what createEvolutionProviderClient actually produces (see
// providers/evolution-provider.ts). The senders below must
// feature-detect these as absent rather than crashing.
const evolutionClient = {
  name: 'evolution' as const,
  sendText: vi.fn(async () => ({ providerMessageId: 'evo-msg-1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'evo-msg-1' })),
}

const metaClient = {
  name: 'meta' as const,
  sendText: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
  sendInteractiveButtons: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
  sendInteractiveList: vi.fn(async () => ({ providerMessageId: 'meta-msg-1' })),
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

import {
  engineSendText,
  engineSendMedia,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from './meta-send'

describe('flows meta-send — provider capability gating (Evolution)', () => {
  beforeEach(() => {
    resolveProviderForAccount.mockReset()
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    })
    evolutionClient.sendText.mockClear()
    evolutionClient.sendMedia.mockClear()
    metaClient.sendInteractiveButtons.mockClear()
    metaClient.sendInteractiveList.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('sends a plain text message through the Evolution client normally', async () => {
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

  it('sends media through the Evolution client normally', async () => {
    const result = await engineSendMedia({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      kind: 'image',
      link: 'https://example.com/pic.jpg',
    })
    expect(result.whatsapp_message_id).toBe('evo-msg-1')
    expect(evolutionClient.sendMedia).toHaveBeenCalledTimes(1)
  })

  it('rejects interactive-buttons on Evolution with unsupported_message_type_for_provider (400)', async () => {
    await expect(
      engineSendInteractiveButtons({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        bodyText: 'Pick one',
        buttons: [{ id: 'a', title: 'A' }],
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_message_type_for_provider',
      status: 400,
    })
  })

  it('rejects interactive-list on Evolution the same way', async () => {
    await expect(
      engineSendInteractiveList({
        accountId: 'acct-1',
        userId: 'user-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        bodyText: 'Pick one',
        buttonLabel: 'Options',
        sections: [{ title: 'Section', rows: [{ id: 'a', title: 'A' }] }],
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_message_type_for_provider',
      status: 400,
    })
  })

  it('sends interactive-buttons through the Meta client normally', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: metaClient,
      kind: 'meta',
      connectionId: 'conn-2',
    })

    const result = await engineSendInteractiveButtons({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      bodyText: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    })

    expect(result.whatsapp_message_id).toBe('meta-msg-1')
    expect(result.provider).toBe('meta')
    expect(metaClient.sendInteractiveButtons).toHaveBeenCalledTimes(1)
  })
})
