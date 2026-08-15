import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account'
  );
  return { ...actual, requireRole };
});

const { createInstance, setInstanceWebhook, setInstanceSettings, getInstanceConnect, logoutInstance } =
  vi.hoisted(() => ({
    createInstance: vi.fn(async () => ({ instanceName: 'wacrm-x', qrCode: 'base64-qr' })),
    setInstanceWebhook: vi.fn(async () => {}),
    setInstanceSettings: vi.fn(async () => {}),
    getInstanceConnect: vi.fn(async () => ({ qrCode: 'base64-qr' })),
    logoutInstance: vi.fn(async () => {}),
  }));
vi.mock('@/lib/whatsapp/providers/evolution-api', () => ({
  createInstance,
  setInstanceWebhook,
  setInstanceSettings,
  getInstanceConnect,
  logoutInstance,
  DEFAULT_WEBHOOK_EVENTS: ['CONNECTION_UPDATE'],
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
}));

// ------------------------------------------------------------
// whatsapp_connections rows, keyed by account_id — models RLS at the
// data layer: ctx.supabase (per-caller) only ever queries scoped by
// `.eq('account_id', ctx.accountId)`, so a test can prove tenant A
// never sees tenant B's row without needing real Postgres RLS.
// ------------------------------------------------------------
let connectionsByAccount: Record<string, Record<string, unknown> | undefined> = {};
const insertedRows: Record<string, unknown>[] = [];
const adminUpdateCalls: { id: string; payload: Record<string, unknown> }[] = [];

function makeCallerSupabase(accountId: string): SupabaseClient {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: string) => {
      if (col === 'account_id' && val !== accountId) {
        // The caller's own client is scoped to their account — a
        // mismatched account_id should never be queryable through it.
        throw new Error('cross-tenant query attempted through caller-scoped client');
      }
      return builder;
    },
    maybeSingle: () =>
      Promise.resolve({ data: connectionsByAccount[accountId] ?? null, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let mode: 'insert' | 'update' = 'insert';
      let payload: Record<string, unknown> = {};
      let eqVal = '';
      b.insert = (p: Record<string, unknown>) => {
        mode = 'insert';
        payload = p;
        insertedRows.push(p);
        connectionsByAccount[p.account_id as string] = { id: 'conn-new', ...p };
        return b;
      };
      b.update = (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return b;
      };
      b.eq = (col: string, val: string) => {
        if (mode === 'update' && col === 'id') {
          eqVal = val;
          if (table === 'whatsapp_connections') adminUpdateCalls.push({ id: eqVal, payload });
        }
        return b;
      };
      b.select = () => b;
      b.single = () =>
        Promise.resolve({
          data: { id: 'conn-new', status: 'connecting', qr_code: payload.qr_code, qr_expires_at: payload.qr_expires_at },
          error: null,
        });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
      return b;
    },
  }),
}));

import { GET, POST, DELETE } from './route';

function ctxFor(role: 'viewer' | 'agent' | 'admin' | 'owner', accountId: string, userId = 'user-1') {
  return {
    supabase: makeCallerSupabase(accountId),
    userId,
    accountId,
    role,
    account: { id: accountId, name: 'Acme' },
  };
}

describe('POST /api/whatsapp/connections', () => {
  beforeEach(() => {
    connectionsByAccount = {};
    insertedRows.length = 0;
    adminUpdateCalls.length = 0;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.com';
    process.env.EVOLUTION_API_KEY = 'super-secret-evolution-key';
    requireRole.mockReset();
    createInstance.mockClear();
    setInstanceWebhook.mockClear();
    setInstanceSettings.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function post(body: unknown) {
    return POST(
      new Request('http://localhost/api/whatsapp/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  }

  it('rejects a non-admin caller (403) and never touches Evolution', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account');
    requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"));

    const res = await post({ provider: 'evolution' });
    expect(res.status).toBe(403);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('400s for any provider other than "evolution"', async () => {
    requireRole.mockResolvedValue(ctxFor('admin', 'acct-1'));
    const res = await post({ provider: 'meta' });
    expect(res.status).toBe(400);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('409s when the account already has a connection, without creating a second one', async () => {
    connectionsByAccount['acct-1'] = { id: 'conn-existing' };
    requireRole.mockResolvedValue(ctxFor('admin', 'acct-1'));

    const res = await post({ provider: 'evolution' });
    expect(res.status).toBe(409);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('creates a connection scoped to the caller\'s own account and never leaks EVOLUTION_API_KEY in the response', async () => {
    requireRole.mockResolvedValue(ctxFor('admin', 'acct-1', 'user-1'));

    const res = await post({ provider: 'evolution' });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.qrCode).toBe('base64-qr');

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      account_id: 'acct-1',
      created_by_user_id: 'user-1',
      provider: 'evolution',
    });
    // The stored secret is encrypted, never the raw value.
    expect(insertedRows[0].webhook_secret).toMatch(/^enc:/);

    // Nothing in the response body is (or contains) the Evolution API key.
    const bodyText = JSON.stringify(json);
    expect(bodyText).not.toContain('super-secret-evolution-key');
    expect(bodyText).not.toContain('EVOLUTION_API_KEY');
    expect(json.webhook_secret).toBeUndefined();
    expect(json.instanceName).toBeUndefined();
  });

  it('never embeds the webhook secret in the webhook URL passed to Evolution (query-string leak)', async () => {
    requireRole.mockResolvedValue(ctxFor('admin', 'acct-1'));
    await post({ provider: 'evolution' });

    const createArgs = (createInstance.mock.calls[0] as unknown[])[0] as {
      webhookUrl: string;
      webhookHeaders?: Record<string, string>;
    };
    expect(createArgs.webhookUrl).not.toContain('secret=');
    expect(createArgs.webhookHeaders?.Authorization).toMatch(/^Bearer /);

    const setWebhookArgs = (setInstanceWebhook.mock.calls[0] as unknown[])[0] as {
      url: string;
    };
    expect(setWebhookArgs.url).not.toContain('secret=');
  });
});

describe('GET /api/whatsapp/connections — tenant isolation', () => {
  beforeEach(() => {
    connectionsByAccount = {
      'acct-a': { id: 'conn-a', status: 'connected', phone_number: '5511900000000' },
    };
    requireRole.mockReset();
  });

  it("account B gets null even though account A has a connection — never account A's row", async () => {
    requireRole.mockResolvedValue(ctxFor('viewer', 'acct-b'));
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.connection).toBeNull();
  });

  it("account A sees its own connection", async () => {
    requireRole.mockResolvedValue(ctxFor('viewer', 'acct-a'));
    const res = await GET();
    const json = await res.json();
    expect(json.connection).toMatchObject({ id: 'conn-a', status: 'connected' });
  });
});

describe('DELETE /api/whatsapp/connections', () => {
  beforeEach(() => {
    connectionsByAccount = {
      'acct-1': { id: 'conn-1', instance_name: 'wacrm-acct1-0001' },
    };
    adminUpdateCalls.length = 0;
    requireRole.mockReset();
    logoutInstance.mockClear();
  });

  it('rejects a non-admin caller and never logs out the instance', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account');
    requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'admin' role or higher"));
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(logoutInstance).not.toHaveBeenCalled();
  });

  it('404s when the account has no connection', async () => {
    connectionsByAccount = {};
    requireRole.mockResolvedValue(ctxFor('admin', 'acct-1'));
    const res = await DELETE();
    expect(res.status).toBe(404);
  });

  it('logs out the instance and marks only that connection disconnected, preserving history', async () => {
    requireRole.mockResolvedValue(ctxFor('admin', 'acct-1'));
    const res = await DELETE();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(logoutInstance).toHaveBeenCalledWith({ instanceName: 'wacrm-acct1-0001' });
    expect(adminUpdateCalls).toHaveLength(1);
    expect(adminUpdateCalls[0].id).toBe('conn-1');
    expect(adminUpdateCalls[0].payload.status).toBe('disconnected');
  });
});
