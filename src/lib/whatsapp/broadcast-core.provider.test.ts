import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createBroadcast, BroadcastError } from './broadcast-core';
import { SendMessageError } from './send-message-error';

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

// A minimal Evolution-shaped client — no sendTemplate, matching what
// createEvolutionProviderClient actually produces (see
// providers/evolution-provider.ts). A *template* broadcast must be
// rejected before any rows are written; a plain_text one goes through
// on sendText (migration 044).
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

  it('rejects a plain_text broadcast with no body_text before touching the DB', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    });

    const db = { from: vi.fn() } as unknown as SupabaseClient;

    await expect(
      createBroadcast(db, 'acct-1', 'user-1', {
        sendMode: 'plain_text',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('accepts a plain_text broadcast on an Evolution-connected account (sendText, not sendTemplate)', async () => {
    resolveProviderForAccount.mockResolvedValue({
      client: evolutionClient,
      kind: 'evolution',
      connectionId: 'conn-1',
    });

    const db = {
      from: (table: string) => {
        if (table === 'contacts') {
          return {
            select: () => ({
              in: () => ({
                not: () => Promise.resolve({ data: [], error: null }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table: ${table}`);
      },
      rpc: () =>
        Promise.resolve({
          data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
          error: null,
        }),
    } as unknown as SupabaseClient;

    const plan = await createBroadcast(db, 'acct-1', 'user-1', {
      sendMode: 'plain_text',
      bodyText: 'Hi {{1}}, we are open today!',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.sendMode).toBe('plain_text');
    expect(plan.templateName).toBeNull();
    expect(plan.bodyText).toBe('Hi {{1}}, we are open today!');
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
