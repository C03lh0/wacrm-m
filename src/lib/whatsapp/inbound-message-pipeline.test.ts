import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findOrCreateContact,
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

  const db = { from: (t: string) => builder(t) } as unknown as SupabaseClient;
  return { db, messageInserts, conversationUpdates, flowRunUpdates };
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
    const { db, messageInserts } = makeDb({
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
        b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
        return b;
      },
    } as unknown as SupabaseClient;
    return { db, updates, inserts };
  }

  it('passing an empty name (fromMe path) does not overwrite an existing contact\'s name', async () => {
    findExistingContact.mockResolvedValue({ id: 'contact-1', phone: '5511999999999', name: 'Jane Real Name' });
    const { db, updates } = makeContactsDb();

    const result = await findOrCreateContact(db, 'acct-1', 'user-1', '5511999999999', '');

    expect(result).toEqual({ contact: { id: 'contact-1', phone: '5511999999999', name: 'Jane Real Name' }, wasCreated: false });
    expect(updates).toHaveLength(0);
  });

  it('passing an empty name for a brand-new contact falls back to the phone number', async () => {
    findExistingContact.mockResolvedValue(null);
    const { db, inserts } = makeContactsDb();

    await findOrCreateContact(db, 'acct-1', 'user-1', '5511999999999', '');

    expect(inserts).toHaveLength(1);
    expect(inserts[0].name).toBe('5511999999999');
  });
});
