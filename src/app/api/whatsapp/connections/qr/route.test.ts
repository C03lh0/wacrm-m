import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account'
  );
  return { ...actual, requireRole };
});

const {
  createInstance,
  setInstanceWebhook,
  setInstanceSettings,
  getInstanceConnect,
  deleteInstance,
  findInstanceWebhook,
} = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({ instanceName: 'wacrm-fresh', qrCode: 'fresh-qr' })),
  setInstanceWebhook: vi.fn(async () => {}),
  setInstanceSettings: vi.fn(async () => {}),
  getInstanceConnect: vi.fn(async () => ({ qrCode: 'refreshed-qr' })),
  deleteInstance: vi.fn(async () => {}),
  findInstanceWebhook: vi.fn(async () => ({ url: null, enabled: false })),
}));
vi.mock('@/lib/whatsapp/providers/evolution-api', () => ({
  createInstance,
  setInstanceWebhook,
  setInstanceSettings,
  getInstanceConnect,
  deleteInstance,
  findInstanceWebhook,
  DEFAULT_WEBHOOK_EVENTS: ['CONNECTION_UPDATE'],
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((v: string) => `enc:${v}`),
  decrypt: vi.fn((v: string) => v.replace(/^enc:/, '')),
}));

let connectionRow: Record<string, unknown> | null = null;
const adminUpdateCalls: { id: string; payload: Record<string, unknown> }[] = [];

function makeCallerSupabase(): SupabaseClient {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: connectionRow, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      let payload: Record<string, unknown> = {};
      b.update = (p: Record<string, unknown>) => {
        payload = p;
        return b;
      };
      b.eq = (col: string, val: string) => {
        if (col === 'id') adminUpdateCalls.push({ id: val, payload });
        return b;
      };
      b.select = () => b;
      b.single = () =>
        Promise.resolve({
          data: {
            id: 'conn-1',
            status: payload.status,
            qr_code: payload.qr_code,
            qr_expires_at: payload.qr_expires_at,
          },
          error: null,
        });
      return b;
    },
  }),
}));

import { POST } from './route';
import { EvolutionApiError } from '@/lib/whatsapp/evolution-errors';

describe('POST /api/whatsapp/connections/qr', () => {
  const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.com';
    connectionRow = {
      id: 'conn-1',
      instance_name: 'wacrm-old',
      status: 'disconnected',
    };
    adminUpdateCalls.length = 0;
    requireRole.mockResolvedValue({
      accountId: 'acct-1',
      userId: 'user-1',
      supabase: makeCallerSupabase(),
    });
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
    vi.clearAllMocks();
  });

  it('refreshes the QR on the existing instance when Evolution cooperates', async () => {
    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.qrCode).toBe('refreshed-qr');
    // The happy path must not churn the instance.
    expect(deleteInstance).not.toHaveBeenCalled();
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('409s when the connection is already live', async () => {
    connectionRow = { id: 'conn-1', instance_name: 'wacrm-old', status: 'connected' };
    const res = await POST();
    expect(res.status).toBe(409);
    expect(getInstanceConnect).not.toHaveBeenCalled();
  });

  // The reported bug: a session goes zombie, the user disconnects, and
  // every reconnect attempt then fails because the QR route keeps
  // asking the same broken instance for a code with no path to replace
  // it.
  it('re-provisions the instance when Evolution refuses to hand out a code', async () => {
    getInstanceConnect.mockRejectedValueOnce(
      new EvolutionApiError('EVOLUTION_CONNECTION_ERROR', 404, 'instance not found')
    );

    const res = await POST();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.qrCode).toBe('fresh-qr');

    expect(deleteInstance).toHaveBeenCalledWith({ instanceName: 'wacrm-old' });
    expect(createInstance).toHaveBeenCalledTimes(1);

    // Same row, new instance — the conversation history hangs off this id.
    expect(adminUpdateCalls).toHaveLength(1);
    expect(adminUpdateCalls[0].id).toBe('conn-1');
    expect(adminUpdateCalls[0].payload.instance_name).not.toBe('wacrm-old');
  });

  it('404s when the account has no connection at all', async () => {
    connectionRow = null;
    const res = await POST();
    expect(res.status).toBe(404);
    expect(createInstance).not.toHaveBeenCalled();
  });
});
