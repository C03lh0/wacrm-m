import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findOrCreateContact,
  identityFromPhone,
  ingestOwnDeviceMessage,
  ingestParsedMessage,
  type ResolvedContactAndConversation,
} from './inbound-message-pipeline';

// ------------------------------------------------------------
// The dispatch engines (Flows / automations / AI auto-reply / outbound
// webhooks) each own their own admin client internally — mock them out
// entirely so this test only exercises the pipeline's own DB calls
// (dedup lookup, message insert, conversation update, broadcast-reply
// flag) and the decision of whether those dispatchers are called.
// ------------------------------------------------------------
const { dispatchInboundToFlows } = vi.hoisted(() => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: false })),
}));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows }));

const { runAutomationsForTrigger } = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger }));

const { dispatchInboundToAiReply } = vi.hoisted(() => ({
  dispatchInboundToAiReply: vi.fn(async () => {}),
}));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply }));

const { dispatchWebhookEvent } = vi.hoisted(() => ({
  dispatchWebhookEvent: vi.fn(async () => {}),
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent }));

const { reopenClosedConversation } = vi.hoisted(() => ({
  reopenClosedConversation: vi.fn(async () => false),
}));
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation }));

const { findExistingContact } = vi.hoisted(() => ({
  findExistingContact: vi.fn(),
}));
vi.mock('@/lib/contacts/dedupe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/contacts/dedupe')>();
  return { ...actual, findExistingContact };
});

interface Script {
  /** Result of the first dedup lookup (provider+connection+providerMessageId). */
  existingMessage?: { id: string } | null;
  /** Result of the post-race re-lookup, if the insert hits a unique violation. */
  existingMessageAfterRace?: { id: string } | null;
  insertMessageError?: { code?: string } | null;
  insertedMessageId?: string;
  priorCustomerMsgCount?: number;
  broadcastRecipients?: unknown[];
}

function makeDb(script: Script) {
  let dedupLookupCalls = 0;
  const messageInserts: Record<string, unknown>[] = [];
  const conversationUpdates: Record<string, unknown>[] = [];
  const flowRunUpdates: Record<string, unknown>[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  function builder(table: string) {
    let mode: 'select' | 'insert' | 'update' = 'select';
    const b: Record<string, unknown> = {};
    const chain = () => b;

    b.select = chain;
    b.eq = chain;
    b.in = chain;
    b.order = chain;
    b.limit = chain;
    b.insert = (payload: Record<string, unknown>) => {
      mode = 'insert';
      if (table === 'messages') messageInserts.push(payload);
      return b;
    };
    b.update = (payload: Record<string, unknown>) => {
      mode = 'update';
      if (table === 'conversations') conversationUpdates.push(payload);
      if (table === 'flow_runs') flowRunUpdates.push(payload);
      return b;
    };

    b.maybeSingle = () => {
      if (table === 'messages' && mode === 'select') {
        dedupLookupCalls += 1;
        const row =
          dedupLookupCalls === 1
            ? (script.existingMessage ?? null)
            : (script.existingMessageAfterRace ?? null);
        return Promise.resolve({ data: row, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };

    b.single = () => {
      if (table === 'messages' && mode === 'insert') {
        if (script.insertMessageError) {
          return Promise.resolve({ data: null, error: script.insertMessageError });
        }
        return Promise.resolve({
          data: { id: script.insertedMessageId ?? 'msg-new' },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    };

    // Thenable — covers the prior-inbound-count query (no terminal call)
    // and the broadcast_recipients / conversations update queries.
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'messages' && mode === 'select') {
        return resolve({ data: [], error: null, count: script.priorCustomerMsgCount ?? 0 });
      }
      if (table === 'broadcast_recipients') {
        return resolve({ data: script.broadcastRecipients ?? [], error: null });
      }
      return resolve({ data: null, error: null });
    };

    return b;
  }

  const db = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
  } as unknown as SupabaseClient;
  return { db, messageInserts, conversationUpdates, flowRunUpdates, rpcCalls };
}

const RESOLVED: ResolvedContactAndConversation = {
  contact: { id: 'contact-1' },
  conversation: { id: 'conv-1', unread_count: 0, status: 'open' },
  contactWasCreated: false,
  conversationWasCreated: false,
};

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    configOwnerUserId: 'user-1',
    provider: 'evolution' as const,
    connectionId: 'conn-1',
    providerMessageId: 'wamid-abc',
    content: { contentType: 'text', contentText: 'hello', mediaUrl: null },
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ingestParsedMessage — idempotency', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a new message and dispatches downstream exactly once', async () => {
    const { db, messageInserts, rpcCalls } = makeDb({
      existingMessage: null,
      insertedMessageId: 'msg-1',
      priorCustomerMsgCount: 0,
    });

    const result = await ingestParsedMessage(db, RESOLVED, baseParams());

    expect(result).toEqual({ messageId: 'msg-1', duplicate: false });
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0]).toMatchObject({
      provider: 'evolution',
      connection_id: 'conn-1',
      provider_message_id: 'wamid-abc',
      conversation_id: 'conv-1',
      sender_type: 'customer',
    });
    // Unread bump goes through the atomic RPC (migration 037), not a
    // read-modify-write of the resolved conversation snapshot — a
    // concurrent inbound message must never lose an increment (#369).
    expect(rpcCalls).toEqual([
      {
        name: 'bump_conversation_on_inbound',
        args: { p_conversation_id: 'conv-1', p_last_message_text: 'hello' },
      },
    ]);
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledTimes(1);
    expect(dispatchWebhookEvent).toHaveBeenCalledWith(
      db,
      'acct-1',
      'message.received',
      expect.objectContaining({ whatsapp_message_id: 'wamid-abc' })
    );
  });

  it('a duplicate providerMessageId is detected up front and never re-dispatched (webhook retry)', async () => {
    const { db, messageInserts } = makeDb({
      existingMessage: { id: 'msg-existing' },
    });

    const result = await ingestParsedMessage(db, RESOLVED, baseParams());

    expect(result).toEqual({ messageId: 'msg-existing', duplicate: true });
    expect(messageInserts).toHaveLength(0);
    expect(dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('a duplicate delivered concurrently (unique-violation race on insert) resolves to the winning row, not a second message', async () => {
    const { db, messageInserts } = makeDb({
      existingMessage: null, // first lookup misses
      insertMessageError: { code: '23505' },
      existingMessageAfterRace: { id: 'msg-raced' },
    });

    const result = await ingestParsedMessage(db, RESOLVED, baseParams());

    expect(result).toEqual({ messageId: 'msg-raced', duplicate: true });
    // The insert was attempted (and rejected) but no second row exists —
    // messageInserts records the attempt, not a persisted duplicate.
    expect(messageInserts).toHaveLength(1);
    expect(dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('two different providerMessageId values on the same connection both ingest (not falsely deduped)', async () => {
    const { db: db1 } = makeDb({ existingMessage: null, insertedMessageId: 'msg-1' });
    const { db: db2 } = makeDb({ existingMessage: null, insertedMessageId: 'msg-2' });

    const r1 = await ingestParsedMessage(db1, RESOLVED, baseParams({ providerMessageId: 'wamid-1' }));
    const r2 = await ingestParsedMessage(db2, RESOLVED, baseParams({ providerMessageId: 'wamid-2' }));

    expect(r1?.messageId).toBe('msg-1');
    expect(r2?.messageId).toBe('msg-2');
    expect(r1?.duplicate).toBe(false);
    expect(r2?.duplicate).toBe(false);
  });
});

describe('ingestParsedMessage — automation dispatch is awaited (#368)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('every triggered automation settles before ingestParsedMessage resolves', async () => {
    let started = 0;
    let completed = 0;
    runAutomationsForTrigger.mockImplementation(() => {
      started++;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          completed++;
          resolve();
        }, 0);
      });
    });

    const { db } = makeDb({ existingMessage: null, insertedMessageId: 'msg-1' });
    await ingestParsedMessage(db, RESOLVED, baseParams());

    // first_inbound_message + new_message_received + keyword_match.
    expect(started).toBe(3);
    // If the dispatches were fire-and-forget, `completed` would still be
    // 0 here — ingestParsedMessage would have resolved before the timers
    // fired.
    expect(completed).toBe(3);
  });
});

describe('ingestOwnDeviceMessage — messages sent from the linked phone (fromMe)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a new message as sender_type agent, does not bump unread_count, and pauses an active flow run', async () => {
    const { db, messageInserts, conversationUpdates, flowRunUpdates } = makeDb({
      existingMessage: null,
      insertedMessageId: 'msg-1',
    });

    const result = await ingestOwnDeviceMessage(db, RESOLVED, {
      accountId: 'acct-1',
      provider: 'evolution',
      connectionId: 'conn-1',
      providerMessageId: 'wamid-phone-1',
      content: { contentType: 'text', contentText: 'hello from phone', mediaUrl: null },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(result).toEqual({ messageId: 'msg-1', duplicate: false });
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0]).toMatchObject({
      provider: 'evolution',
      connection_id: 'conn-1',
      provider_message_id: 'wamid-phone-1',
      conversation_id: 'conv-1',
      sender_type: 'agent',
      status: 'sent',
    });

    expect(conversationUpdates).toHaveLength(1);
    expect(conversationUpdates[0]).not.toHaveProperty('unread_count');
    expect(conversationUpdates[0]).toMatchObject({ last_message_text: 'hello from phone' });

    expect(flowRunUpdates).toHaveLength(1);
    expect(flowRunUpdates[0]).toMatchObject({ status: 'paused_by_agent', end_reason: 'agent_replied' });

    expect(reopenClosedConversation).not.toHaveBeenCalled();
    expect(dispatchInboundToFlows).not.toHaveBeenCalled();
    expect(runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dispatchInboundToAiReply).not.toHaveBeenCalled();
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
  });

  it('a duplicate providerMessageId (echo of our own CRM-initiated send) is returned as-is, no insert or flow pause', async () => {
    const { db, messageInserts, conversationUpdates, flowRunUpdates } = makeDb({
      existingMessage: { id: 'msg-existing' },
    });

    const result = await ingestOwnDeviceMessage(db, RESOLVED, {
      accountId: 'acct-1',
      provider: 'evolution',
      connectionId: 'conn-1',
      providerMessageId: 'wamid-echo-1',
      content: { contentType: 'text', contentText: 'hello', mediaUrl: null },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(result).toEqual({ messageId: 'msg-existing', duplicate: true });
    expect(messageInserts).toHaveLength(0);
    expect(conversationUpdates).toHaveLength(0);
    expect(flowRunUpdates).toHaveLength(0);
  });
});

describe('findOrCreateContact — empty name (own-device/fromMe messages)', () => {
  afterEach(() => {
    findExistingContact.mockReset();
  });

  function makeContactsDb() {
    const updates: Record<string, unknown>[] = [];
    const inserts: Record<string, unknown>[] = [];
    const db = {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        b.update = (payload: Record<string, unknown>) => {
          if (table === 'contacts') updates.push(payload);
          return b;
        };
        b.insert = (payload: Record<string, unknown>) => {
          if (table === 'contacts') inserts.push(payload);
          return b;
        };
        b.eq = () => b;
        b.select = () => b;
        b.single = () => Promise.resolve({ data: { id: 'contact-new', ...inserts[0] }, error: null });
        b.maybeSingle = () => Promise.resolve({ data: null, error: null });
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return b;
      },
    } as unknown as SupabaseClient;
    return { db, updates, inserts };
  }

  it('passing an empty name (fromMe path) does not overwrite an existing contact\'s name', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1', phone: '5511999999999', name: 'Jane Real Name' });
    const { db, updates } = makeContactsDb();

    const result = await findOrCreateContact(db, 'acct-1', 'user-1', identityFromPhone('5511999999999', ''));

    expect(result).toEqual({ contact: { id: 'contact-1', phone: '5511999999999', name: 'Jane Real Name' }, wasCreated: false });
    expect(updates).toHaveLength(0);
  });

  it('passing an empty name for a brand-new contact falls back to the phone number', async () => {
    findExistingContact.mockResolvedValue(null);
    const { db, inserts } = makeContactsDb();

    await findOrCreateContact(db, 'acct-1', 'user-1', identityFromPhone('5511999999999', ''));

    expect(inserts).toHaveLength(1);
    expect(inserts[0].name).toBe('5511999999999');
  });
});

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta stopped sending the phone number for a customer who has adopted
// a WhatsApp username: `messages[].from` and `contacts[].wa_id` are
// both absent, and only `from_user_id` / `user_id` identify them. The
// webhook route turns that into a `WaIdentity`; everything below is
// what this pipeline does with one.
//
// Before the fix the phone resolved to '', which `findExistingContact`
// refuses to look up, so every such delivery inserted a NEW contact —
// migration 022's unique index is partial (`WHERE phone_normalized <> ''`)
// so nothing stopped it. One contact and one conversation per message.
// ============================================================

const BSUID = 'US.13491208655302741918';
const PARENT_BSUID = 'US.ENT.11815799212886844830';

const USERNAME_ONLY_IDENTITY = {
  phone: '',
  waUserId: BSUID,
  waParentUserId: PARENT_BSUID,
  waUsername: 'realsheenanelson',
  name: 'Sheena Nelson',
};

describe('findOrCreateContact — business-scoped user IDs (#519)', () => {
  afterEach(() => {
    findExistingContact.mockReset();
  });

  /**
   * `contacts` mock that tells the three chains apart:
   *   BSUID lookup:      select('*').eq().eq().maybeSingle()
   *   identity backfill: update().eq().select().maybeSingle()
   *   create:            insert().select().single()
   */
  function makeDb(contactByWaUserId: Record<string, unknown> | null = null) {
    const updates: Record<string, unknown>[] = [];
    const inserts: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: contactByWaUserId, error: null }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return {
            eq: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        },
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'contact-new', ...row }, error: null }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;
    return { db, updates, inserts };
  }

  it('creates ONE contact keyed on the BSUID when there is no phone', async () => {
    findExistingContact.mockResolvedValue(null);
    const { db, inserts } = makeDb(null);

    const result = await findOrCreateContact(db, 'acct-1', 'user-1', USERNAME_ONLY_IDENTITY);

    expect(result?.wasCreated).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      account_id: 'acct-1',
      phone: '',
      wa_user_id: BSUID,
      wa_parent_user_id: PARENT_BSUID,
      wa_username: 'realsheenanelson',
      name: 'Sheena Nelson',
    });
  });

  it('never looks the sender up by phone when there is no phone', async () => {
    findExistingContact.mockResolvedValue(null);
    const { db } = makeDb(null);

    await findOrCreateContact(db, 'acct-1', 'user-1', USERNAME_ONLY_IDENTITY);

    // The old code called this with '' and got null every time, which
    // is exactly how the duplicate contacts got created.
    expect(findExistingContact).not.toHaveBeenCalled();
  });

  it('reuses the existing contact on the SECOND message from the same BSUID', async () => {
    findExistingContact.mockResolvedValue(null);
    const { db, updates, inserts } = makeDb({
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: BSUID,
      wa_parent_user_id: PARENT_BSUID,
      wa_username: 'realsheenanelson',
    });

    const result = await findOrCreateContact(db, 'acct-1', 'user-1', USERNAME_ONLY_IDENTITY);

    expect(result?.wasCreated).toBe(false);
    expect(inserts).toHaveLength(0);
    // Nothing about the identity changed, so no pointless UPDATE either.
    expect(updates).toHaveLength(0);
  });

  it('backfills the BSUID onto a contact we already knew by phone', async () => {
    // Transition payload: both keys present. We match on the phone and
    // stamp the BSUID so the next phone-less message finds this row.
    findExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Pablo',
      phone: '16505551234',
    });
    const { db, updates, inserts } = makeDb(null);

    await findOrCreateContact(db, 'acct-1', 'user-1', {
      phone: '16505551234',
      waUserId: BSUID,
      waParentUserId: null,
      waUsername: 'pablomorales',
      name: 'Pablo',
    });

    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      wa_user_id: BSUID,
      wa_username: 'pablomorales',
    });
    // The number we already had is left alone.
    expect(updates[0]).not.toHaveProperty('phone');
  });

  it('fills in the phone once Meta finally discloses it', async () => {
    findExistingContact.mockResolvedValue(null);
    const { db, updates } = makeDb({
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: BSUID,
      wa_username: 'realsheenanelson',
    });

    await findOrCreateContact(db, 'acct-1', 'user-1', {
      ...USERNAME_ONLY_IDENTITY,
      phone: '16505551234',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ phone: '16505551234' });
  });
});

describe('findOrCreateContact — name backfill (#519 regression guard)', () => {
  afterEach(() => {
    findExistingContact.mockReset();
  });

  function makeDb() {
    const updates: Record<string, unknown>[] = [];
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return {
            eq: () => ({
              select: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              }),
            }),
          };
        },
      }),
    } as unknown as SupabaseClient;
    return { db, updates };
  }

  it('never overwrites an edited name with the phone number', async () => {
    // No profile name. The display fallback would resolve to the phone
    // number, and writing that back would replace whatever an agent
    // typed on the contact — on every single inbound message.
    findExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Ada (VIP, calls Mondays)',
      phone: '15551230000',
    });
    const { db, updates } = makeDb();

    await findOrCreateContact(db, 'acct-1', 'user-1', identityFromPhone('15551230000', ''));

    expect(updates).toHaveLength(0);
  });

  it('does adopt a username when that is all we were given', async () => {
    findExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: '15551230000',
      phone: '15551230000',
    });
    const { db, updates } = makeDb();

    await findOrCreateContact(db, 'acct-1', 'user-1', {
      phone: '15551230000',
      waUserId: null,
      waParentUserId: null,
      waUsername: 'ada',
      name: '',
    });

    expect(updates[0]).toMatchObject({ name: 'ada' });
  });
});

/**
 * The production incident this guards against: the merge from upstream
 * added the BSUID columns to this insert, but the matching migration was
 * never applied to the live database because its version number collided
 * with a fork migration and the tooling skipped it. Every inbound
 * message from a not-yet-known contact then failed with
 * `42703 column "wa_user_id" does not exist`, was not a unique violation,
 * and fell through to a single console line. Sending kept working, so
 * the connection looked healthy while the inbox silently stopped
 * growing.
 */
describe('findOrCreateContact — schema drift', () => {
  afterEach(() => {
    findExistingContact.mockReset();
  });

  function makeFailingDb(error: { code?: string; message: string }) {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    return db;
  }

  it('reports the SQLSTATE when the insert fails, not just the message', async () => {
    findExistingContact.mockResolvedValue(null);
    const db = makeFailingDb({
      code: '42703',
      message: 'column "wa_user_id" of relation "contacts" does not exist',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await findOrCreateContact(
      db,
      'acct-1',
      'user-1',
      identityFromPhone('15551230000', 'Ada')
    );

    expect(result).toBeNull();

    const logged = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    // Naming the code is what turns "the inbox is broken" into "a
    // migration was not applied" without a debugging session.
    expect(logged).toContain('42703');
    expect(logged).toMatch(/migration has not been applied/i);

    errorSpy.mockRestore();
  });

  it('does not claim a migration is missing for an unrelated insert failure', async () => {
    findExistingContact.mockResolvedValue(null);
    const db = makeFailingDb({ code: '23503', message: 'foreign key violation' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await findOrCreateContact(
      db,
      'acct-1',
      'user-1',
      identityFromPhone('15551230000', 'Ada')
    );

    const logged = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
    expect(logged).toContain('23503');
    expect(logged).not.toMatch(/migration has not been applied/i);

    errorSpy.mockRestore();
  });
});
