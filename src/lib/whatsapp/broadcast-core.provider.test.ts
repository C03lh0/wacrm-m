import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, BroadcastError } from './broadcast-core';
import { SendMessageError } from './send-message-error';

// A minimal Evolution-shaped client — no sendTemplate, matching what
// createEvolutionProviderClient actually produces (see
// providers/evolution-provider.ts). Broadcasts are 100% template-based,
// so createBroadcast must reject this before writing any rows.
const evolutionClient = {
  name: 'evolution' as const,
  sendText: vi.fn(),
  sendMedia: vi.fn(),
};

const { resolveProviderForAccount } = vi.hoisted(() => ({
  resolveProviderForAccount: vi.fn(),
}));
vi.mock('./provider-factory', () => ({ resolveProviderForAccount }));

describe('createBroadcast — provider gating (Evolution)', () => {
  beforeEach(() => {
    resolveProviderForAccount.mockReset();
  });

  it('fails fast with unsupported_message_type_for_provider before touching the DB when the provider has no sendTemplate', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    });

    const fromCalls: string[] = [];
    const db = {
      from: (table: string) => {
        fromCalls.push(table);
        throw new Error(`unexpected db access: ${table}`);
      },
    } as unknown as SupabaseClient;

    await expect(
      createBroadcast(db, 'acct-1', 'user-1', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({
      code: 'unsupported_message_type_for_provider',
      status: 400,
    });
    expect(fromCalls).toHaveLength(0);
  });

  it('translates a SendMessageError from resolveProviderForAccount (e.g. disconnected) into a BroadcastError', async () => {
    resolveProviderForAccount.mockRejectedValue(
      new SendMessageError(
        'whatsapp_disconnected',
        'WhatsApp is not connected. Please reconnect via QR code.',
        409
      )
    );

    const db = { from: vi.fn() } as unknown as SupabaseClient;

    await expect(
      createBroadcast(db, 'acct-1', 'user-1', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
    await expect(
      createBroadcast(db, 'acct-1', 'user-1', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'whatsapp_disconnected', status: 409 });
  });
});
