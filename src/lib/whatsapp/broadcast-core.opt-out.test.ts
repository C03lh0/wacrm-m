import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const metaClient = {
  name: 'meta' as const,
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  sendTemplate: vi.fn(async () => ({ providerMessageId: 'm1' })),
};

const { resolveProviderForAccount } = vi.hoisted(() => ({
  resolveProviderForAccount: vi.fn(),
}));
vi.mock('./provider-factory', () => ({ resolveProviderForAccount }));

const { findOrCreateContact } = vi.hoisted(() => ({
  findOrCreateContact: vi.fn(),
}));
vi.mock('@/lib/api/v1/contacts', () => ({ findOrCreateContact }));

import { createBroadcast } from './broadcast-core';

/** contactId → whether that contact is opted out. */
function makeDb(optedOutContactIds: Set<string>): SupabaseClient {
  function builder(table: string) {
    const b: Record<string, unknown> = { __inIds: [] as string[] };
    b.select = () => b;
    b.eq = () => b;
    b.in = (_col: string, ids: string[]) => {
      b.__inIds = ids;
      return b;
    };
    b.not = () => b;
    b.insert = (payload: unknown) => {
      b.__insertPayload = payload;
      return b;
    };
    b.maybeSingle = () => Promise.resolve({ data: null, error: null });
    b.single = () => {
      if (table === 'broadcasts') {
        return Promise.resolve({ data: { id: 'broadcast-1' }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'contacts') {
        const ids = (b.__inIds as string[]) ?? [];
        const rows = ids
          .filter((id) => optedOutContactIds.has(id))
          .map((id) => ({ id }));
        return resolve({ data: rows, error: null });
      }
      if (table === 'broadcast_recipients') {
        const payload = b.__insertPayload as
          | { contact_id: string }[]
          | undefined;
        const rows = (payload ?? []).map((p, i) => ({
          id: `recipient-${i}`,
          contact_id: p.contact_id,
        }));
        return resolve({ data: rows, error: null });
      }
      return resolve({ data: null, error: null });
    };
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

describe('createBroadcast — opt-out filtering (migration 039)', () => {
  beforeEach(() => {
    resolveProviderForAccount.mockReset();
    resolveProviderForAccount.mockResolvedValue({
      client: metaClient,
      kind: 'meta',
      connectionId: 'conn-1',
    });
    findOrCreateContact.mockReset();
    findOrCreateContact.mockImplementation(
      async (_db, _accountId, _auditUserId, input: { phone: string }) => ({
        id: `contact-${input.phone}`,
        created: false,
      })
    );
  });

  it('excludes an opted-out contact from the plan and counts it separately', async () => {
    const db = makeDb(new Set(['contact-14155550123']));

    const plan = await createBroadcast(db, 'acct-1', 'user-1', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
    });

    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0].phone).toBe('14155550124');
    expect(plan.optedOut).toBe(1);
    expect(plan.rejected).toBe(0);
  });

  it('does not exclude anyone when nobody has opted out', async () => {
    const db = makeDb(new Set());

    const plan = await createBroadcast(db, 'acct-1', 'user-1', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
    });

    expect(plan.planned).toHaveLength(2);
    expect(plan.optedOut).toBe(0);
  });

  it('throws bad_request with an opt-out-specific message when every recipient has opted out', async () => {
    const db = makeDb(
      new Set(['contact-14155550123', 'contact-14155550124'])
    );

    await expect(
      createBroadcast(db, 'acct-1', 'user-1', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }, { to: '+14155550124' }],
      })
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: 'All recipients have opted out of broadcasts',
    });
  });
});
