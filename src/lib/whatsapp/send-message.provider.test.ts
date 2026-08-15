import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// A minimal Evolution-shaped client — no sendTemplate / sendInteractive*,
// matching what createEvolutionProviderClient actually produces (see
// providers/evolution-provider.ts). send-message.ts must feature-detect
// these as absent rather than crashing on `undefined is not a function`.
const evolutionClient = {
  name: 'evolution' as const,
  sendText: vi.fn(async () => ({ providerMessageId: 'evo-msg-1' })),
  sendMedia: vi.fn(async () => ({ providerMessageId: 'evo-msg-1' })),
};

const { resolveProviderForAccount } = vi.hoisted(() => ({
  resolveProviderForAccount: vi.fn(),
}));
vi.mock('./provider-factory', () => ({ resolveProviderForAccount }));

const CONTACT = { id: 'contact-1', phone: '+15551234567' };
const CONVERSATION = { id: 'conv-1', account_id: 'acct-1', contact: CONTACT };

function makeDb(): SupabaseClient {
  function builder(table: string) {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain;
    b.eq = chain;
    b.update = chain;
    b.insert = chain;
    b.single = () => {
      if (table === 'conversations') return Promise.resolve({ data: CONVERSATION, error: null });
      if (table === 'messages') return Promise.resolve({ data: { id: 'msg-row-1' }, error: null });
      return Promise.resolve({ data: null, error: null });
    };
    b.maybeSingle = () => Promise.resolve({ data: null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

import { sendMessageToConversation } from './send-message';
import { SendMessageError } from './send-message-error';

describe('sendMessageToConversation — provider capability gating (Evolution)', () => {
  beforeEach(() => {
    resolveProviderForAccount.mockReset();
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    });
    evolutionClient.sendText.mockClear();
    evolutionClient.sendMedia.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a template send on an Evolution connection with unsupported_message_type_for_provider (400), never reaching the network', async () => {
    const db = makeDb();
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'conv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateLanguage: 'en_US',
    }).catch((e: SendMessageError) => {
      expect(e).toBeInstanceOf(SendMessageError);
      expect(e.code).toBe('unsupported_message_type_for_provider');
      expect(e.status).toBe(400);
    });
  });

  it('rejects an interactive-buttons send on an Evolution connection the same way', async () => {
    const db = makeDb();
    await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'conv-1',
      messageType: 'interactive',
      interactivePayload: {
        kind: 'buttons',
        body: 'Pick one',
        buttons: [{ id: 'a', title: 'A' }],
      },
    }).catch((e: SendMessageError) => {
      expect(e.code).toBe('unsupported_message_type_for_provider');
      expect(e.status).toBe(400);
    });
  });

  it('still sends a plain text message through the Evolution client normally', async () => {
    const db = makeDb();
    const result = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'conv-1',
      messageType: 'text',
      contentText: 'hello there',
    });
    expect(result.whatsappMessageId).toBe('evo-msg-1');
    expect(evolutionClient.sendText).toHaveBeenCalledTimes(1);
  });
});
