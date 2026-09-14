import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RECOVERY_COOKIE } from '@/lib/auth/recovery';

const { getUser, cookieJar } = vi.hoisted(() => ({
  getUser: vi.fn(),
  cookieJar: new Map<string, string>(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser } }),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
  }),
}));

import { POST } from './route';

const MARKER = '2026-09-14T10:00:00Z';

describe('POST /api/auth/recovery-complete', () => {
  beforeEach(() => {
    getUser.mockReset();
    cookieJar.clear();
    cookieJar.set(RECOVERY_COOKIE, MARKER);
  });

  it('rejects an anonymous caller', async () => {
    getUser.mockResolvedValue({ data: { user: null } });

    const response = await POST();

    expect(response.status).toBe(401);
  });

  // The whole point of the lock: holding a recovery session must not be
  // enough to get back into the app. Only an actual password change —
  // visible as a moved updated_at — lifts it.
  it('keeps the lock when the password has not changed', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u1', updated_at: MARKER } },
    });

    const response = await POST();

    expect(response.status).toBe(409);
    expect(response.cookies.get(RECOVERY_COOKIE)).toBeUndefined();
  });

  it('clears the marker once updated_at has moved', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u1', updated_at: '2026-09-14T10:05:00Z' } },
    });

    const response = await POST();

    expect(response.status).toBe(200);
    expect(response.cookies.get(RECOVERY_COOKIE)?.value).toBe('');
  });

  it('is a no-op when there is no marker to clear', async () => {
    cookieJar.clear();
    getUser.mockResolvedValue({
      data: { user: { id: 'u1', updated_at: MARKER } },
    });

    const response = await POST();

    expect(response.status).toBe(200);
  });
});
