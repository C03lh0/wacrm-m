import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `after()` normally requires a live Next.js request scope. Replace it
// with a stub that records the callback so the test can await it
// explicitly instead of relying on a real request lifecycle.
const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void>>,
}));
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: (cb: () => Promise<void>) => {
      afterCallbacks.push(cb);
    },
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  // Fake reversible "encryption" — enc:<secret> -> <secret>.
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
}));

const { processEvolutionMessage, processEvolutionMessageStatus } = vi.hoisted(() => ({
  processEvolutionMessage: vi.fn(async () => {}),
  processEvolutionMessageStatus: vi.fn(async () => {}),
}));
vi.mock('@/lib/whatsapp/evolution-webhook-handlers', () => ({
  processEvolutionMessage,
  processEvolutionMessageStatus,
}));

const { backfillMissedMessages, isEvolutionBackfillEnabled } = vi.hoisted(() => ({
  backfillMissedMessages: vi.fn(async () => ({ fetched: 0, ingested: 0 })),
  isEvolutionBackfillEnabled: vi.fn(() => true),
}));
vi.mock('@/lib/whatsapp/evolution-backfill', () => ({ backfillMissedMessages, isEvolutionBackfillEnabled }));

// ------------------------------------------------------------
// Fake admin Supabase client. `whatsapp_connections` rows are seeded
// per test via `connectionsTable`; `.update()` calls are recorded so a
// test can assert exactly which connection id was touched — the crux
// of the multi-tenant isolation checks below.
// ------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connectionsTable: any[] = [];
const updateCalls: { id: string; payload: Record<string, unknown> }[] = [];

function makeFakeDb() {
  return {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {};
      let mode: 'select' | 'update' = 'select';
      let pendingUpdate: Record<string, unknown> | null = null;
      let eqCol = '';
      let eqVal = '';
      b.select = () => {
        mode = 'select';
        return b;
      };
      b.update = (payload: Record<string, unknown>) => {
        mode = 'update';
        pendingUpdate = payload;
        return b;
      };
      b.eq = (col: string, val: string) => {
        eqCol = col;
        eqVal = val;
        return b;
      };
      b.maybeSingle = () => {
        if (table === 'whatsapp_connections' && mode === 'select' && eqCol === 'instance_name') {
          const row = connectionsTable.find((c) => c.instance_name === eqVal) ?? null;
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      };
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'whatsapp_connections' && mode === 'update') {
          updateCalls.push({ id: eqVal, payload: pendingUpdate! });
        }
        return resolve({ data: null, error: null });
      };
      return b;
    },
  };
}

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>(
    '@supabase/supabase-js'
  );
  return { ...actual, createClient: vi.fn(() => makeFakeDb()) };
});

import { POST } from './route';

const CONNECTION_A = {
  id: 'conn-a',
  account_id: 'acct-a',
  instance_name: 'wacrm-accta-0001',
  created_by_user_id: 'user-a',
  webhook_secret: null as string | null,
  status: 'qr_required',
};
const CONNECTION_B = {
  id: 'conn-b',
  account_id: 'acct-b',
  instance_name: 'wacrm-acctb-0002',
  created_by_user_id: 'user-b',
  webhook_secret: null as string | null,
  status: 'qr_required',
};

function postTo(instanceName: string, body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`http://localhost/api/whatsapp/webhook/evolution/${instanceName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ instanceName }) }
  );
}

async function flushAfter() {
  const callbacks = afterCallbacks.splice(0);
  await Promise.all(callbacks.map((cb) => cb()));
}

describe('POST /api/whatsapp/webhook/evolution/[instanceName]', () => {
  beforeEach(() => {
    connectionsTable = [
      { ...CONNECTION_A },
      { ...CONNECTION_B },
    ];
    updateCalls.length = 0;
    afterCallbacks.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 "ignored" for an unknown instance name without leaking whether it exists', async () => {
    const res = await postTo('does-not-exist', { event: 'messages.upsert', data: {} });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.status).toBe('ignored');
    await flushAfter();
    expect(processEvolutionMessage).not.toHaveBeenCalled();
  });

  it('rejects a webhook with a missing/incorrect Authorization header when the connection has a secret', async () => {
    connectionsTable[0].webhook_secret = 'enc:correct-secret';

    const res = await postTo(CONNECTION_A.instance_name, { event: 'messages.upsert', data: {} });
    expect(res.status).toBe(401);

    const resWrong = await postTo(
      CONNECTION_A.instance_name,
      { event: 'messages.upsert', data: {} },
      { Authorization: 'Bearer wrong-secret' }
    );
    expect(resWrong.status).toBe(401);

    await flushAfter();
    expect(processEvolutionMessage).not.toHaveBeenCalled();
  });

  it('matches the real-world event casing (UPPER_SNAKE_CASE, confirmed via official docs) — the bug this route used to have', async () => {
    // Regression test for the bug found during doc research: the route
    // used to lowercase the event and compare against dot.case
    // literals ('messages.upsert'), which real `MESSAGES_UPSERT`
    // payloads never matched — every event silently fell through to
    // the unhandled-event branch. normalizeEventName() must now match
    // this real casing.
    const res = await postTo(CONNECTION_A.instance_name, {
      event: 'MESSAGES_UPSERT',
      data: { key: { id: 'wamid-real-casing', remoteJid: '55@s.whatsapp.net', fromMe: false } },
    });
    expect(res.status).toBe(200);
    await flushAfter();
    expect(processEvolutionMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts a webhook with the correct Authorization header', async () => {
    connectionsTable[0].webhook_secret = 'enc:correct-secret';

    const res = await postTo(
      CONNECTION_A.instance_name,
      { event: 'messages.upsert', data: { key: { id: 'wamid-1', remoteJid: '55@s.whatsapp.net', fromMe: false } } },
      { Authorization: 'Bearer correct-secret' }
    );
    expect(res.status).toBe(200);

    await flushAfter();
    expect(processEvolutionMessage).toHaveBeenCalledTimes(1);
  });

  it('routes an event to only the connection whose instance_name matches the URL — never a different tenant', async () => {
    const res = await postTo(CONNECTION_A.instance_name, {
      event: 'messages.upsert',
      data: { key: { id: 'wamid-a', remoteJid: '55@s.whatsapp.net', fromMe: false } },
    });
    expect(res.status).toBe(200);
    await flushAfter();

    expect(processEvolutionMessage).toHaveBeenCalledTimes(1);
    const [, connectionArg, userIdArg] = processEvolutionMessage.mock.calls[0] as unknown as [
      unknown,
      { id: string; account_id: string },
      string,
    ];
    expect(connectionArg.id).toBe('conn-a');
    expect(connectionArg.account_id).toBe('acct-a');
    expect(userIdArg).toBe('user-a');

    // Connection B was never touched by an event addressed to A's instance.
    expect(updateCalls.every((c) => c.id !== 'conn-b')).toBe(true);
  });

  it('a connection.update event only updates that one connection row, never another account\'s', async () => {
    const res = await postTo(CONNECTION_B.instance_name, {
      event: 'connection.update',
      data: { state: 'open', wuid: '5511999999999@s.whatsapp.net' },
    });
    expect(res.status).toBe(200);
    await flushAfter();

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('conn-b');
    expect(updateCalls[0].payload).toMatchObject({ status: 'connected', phone_number: '5511999999999' });
  });

  it('ignores an unrecognized event type without error', async () => {
    const res = await postTo(CONNECTION_A.instance_name, { event: 'some.future.event', data: {} });
    expect(res.status).toBe(200);
    await flushAfter();
    expect(processEvolutionMessage).not.toHaveBeenCalled();
    expect(processEvolutionMessageStatus).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await POST(
      new Request(`http://localhost/api/whatsapp/webhook/evolution/${CONNECTION_A.instance_name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      }),
      { params: Promise.resolve({ instanceName: CONNECTION_A.instance_name }) }
    );
    expect(res.status).toBe(400);
  });

  it('triggers a backfill when the connection transitions into connected from a different status', async () => {
    connectionsTable[1].status = 'qr_required'; // CONNECTION_B
    const res = await postTo(CONNECTION_B.instance_name, {
      event: 'CONNECTION_UPDATE',
      data: { state: 'open' },
    });
    expect(res.status).toBe(200);
    await flushAfter();

    expect(backfillMissedMessages).toHaveBeenCalledTimes(1);
    const [, connectionArg, userIdArg] = backfillMissedMessages.mock.calls[0] as unknown as [
      unknown,
      { id: string },
      string,
    ];
    expect(connectionArg.id).toBe('conn-b');
    expect(userIdArg).toBe('user-b');
  });

  it('does not trigger a backfill on a genuine reconnect when EVOLUTION_BACKFILL_ENABLED is off (the default kill switch)', async () => {
    isEvolutionBackfillEnabled.mockReturnValueOnce(false);
    connectionsTable[1].status = 'qr_required'; // CONNECTION_B
    const res = await postTo(CONNECTION_B.instance_name, {
      event: 'CONNECTION_UPDATE',
      data: { state: 'open' },
    });
    expect(res.status).toBe(200);
    await flushAfter();

    expect(backfillMissedMessages).not.toHaveBeenCalled();
  });

  it('does not trigger a backfill when the connection was already connected and stays connected', async () => {
    connectionsTable[1].status = 'connected';
    const res = await postTo(CONNECTION_B.instance_name, {
      event: 'CONNECTION_UPDATE',
      data: { state: 'open' },
    });
    expect(res.status).toBe(200);
    await flushAfter();

    expect(backfillMissedMessages).not.toHaveBeenCalled();
  });

  it('does not trigger a backfill when the connection.update event reports a non-connected status', async () => {
    connectionsTable[1].status = 'connected';
    const res = await postTo(CONNECTION_B.instance_name, {
      event: 'CONNECTION_UPDATE',
      data: { state: 'close' },
    });
    expect(res.status).toBe(200);
    await flushAfter();

    expect(backfillMissedMessages).not.toHaveBeenCalled();
  });
});
