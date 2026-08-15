import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>(
    '@/lib/auth/account'
  );
  return { ...actual, requireRole };
});

const { getWhatsAppConnectionStatus } = vi.hoisted(() => ({
  getWhatsAppConnectionStatus: vi.fn(),
}));
vi.mock('@/lib/whatsapp/connection-status', () => ({ getWhatsAppConnectionStatus }));

import { GET } from './route';

function ctxFor(accountId: string) {
  return {
    supabase: {} as SupabaseClient,
    userId: 'user-1',
    accountId,
    role: 'viewer' as const,
    account: { id: accountId, name: 'Acme' },
  };
}

describe('GET /api/whatsapp/status', () => {
  it('rejects an unauthenticated caller', async () => {
    const { ForbiddenError } = await import('@/lib/auth/account');
    requireRole.mockRejectedValue(new ForbiddenError("This action requires the 'viewer' role or higher"));

    const res = await GET();
    expect(res.status).toBe(403);
    expect(getWhatsAppConnectionStatus).not.toHaveBeenCalled();
  });

  it("returns the caller's account status, scoped to their own account_id", async () => {
    requireRole.mockResolvedValue(ctxFor('acct-1'));
    getWhatsAppConnectionStatus.mockResolvedValue({
      provider: 'evolution',
      connected: true,
      enforcesSessionWindow: false,
      syncing: false,
    });

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ provider: 'evolution', connected: true, enforcesSessionWindow: false, syncing: false });
    expect(getWhatsAppConnectionStatus).toHaveBeenCalledWith(expect.anything(), 'acct-1');
  });
});
