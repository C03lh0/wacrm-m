import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { RECOVERY_COOKIE } from '@/lib/auth/recovery';

const { exchangeCodeForSession } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession },
  }),
}));

import { GET } from './route';

function request(query: string) {
  return new NextRequest(`http://localhost:3000/auth/callback${query}`);
}

function location(response: Response): string | null {
  return response.headers.get('location');
}

describe('GET /auth/callback', () => {
  beforeEach(() => {
    exchangeCodeForSession.mockReset();
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it('redirects to /dashboard when the code exchange succeeds and no next is given', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(request('?code=abc123'));

    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123');
    expect(location(response)).toBe('http://localhost:3000/dashboard');
  });

  it('redirects to a safe relative next on success', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(request('?code=abc123&next=%2Fjoin%2Fabc123'));

    expect(location(response)).toBe('http://localhost:3000/join/abc123');
  });

  it('falls back to /dashboard for an absolute-URL next (open-redirect guard)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(
      request('?code=abc123&next=' + encodeURIComponent('https://evil.example.com'))
    );

    expect(location(response)).toBe('http://localhost:3000/dashboard');
  });

  it('falls back to /dashboard for a protocol-relative next (open-redirect guard)', async () => {
    exchangeCodeForSession.mockResolvedValue({ error: null });

    const response = await GET(
      request('?code=abc123&next=' + encodeURIComponent('//evil.example.com'))
    );

    expect(location(response)).toBe('http://localhost:3000/dashboard');
  });

  it('redirects to /login?error=confirmation_failed when the exchange fails', async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: new Error('invalid or expired code'),
    });

    const response = await GET(request('?code=stale-code'));

    expect(location(response)).toBe(
      'http://localhost:3000/login?error=confirmation_failed'
    );
  });

  it('redirects to /login when no code is present', async () => {
    const response = await GET(request(''));

    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(response)).toBe('http://localhost:3000/login');
  });

  // Without this the request-derived origin wins, and behind a proxy
  // that doesn't forward Host it resolves to the address the server is
  // bound to — reset links then point at https://0.0.0.0:3000.
  describe('origin resolution', () => {
    it('prefers the configured site URL over the request origin', async () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com';
      exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

      const response = await GET(request('?code=abc123&next=%2Freset-password'));

      expect(location(response)).toBe('https://crm.example.com/reset-password');
    });

    it('strips a trailing slash from the configured site URL', async () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com/';
      exchangeCodeForSession.mockResolvedValue({ data: {}, error: null });

      const response = await GET(request('?code=abc123'));

      expect(location(response)).toBe('https://crm.example.com/dashboard');
    });

    it('uses the configured site URL for the no-code and failed-exchange redirects too', async () => {
      process.env.NEXT_PUBLIC_SITE_URL = 'https://crm.example.com';
      exchangeCodeForSession.mockResolvedValue({ data: {}, error: new Error('nope') });

      expect(location(await GET(request('')))).toBe('https://crm.example.com/login');
      expect(location(await GET(request('?code=stale')))).toBe(
        'https://crm.example.com/login?error=confirmation_failed'
      );
    });
  });

  describe('password-recovery lock', () => {
    it('marks the session when next is /reset-password', async () => {
      exchangeCodeForSession.mockResolvedValue({
        data: { user: { updated_at: '2026-09-14T10:00:00Z' } },
        error: null,
      });

      const response = await GET(request('?code=abc123&next=%2Freset-password'));
      const cookie = response.cookies.get(RECOVERY_COOKIE);

      expect(cookie?.value).toBe('2026-09-14T10:00:00Z');
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/');
    });

    it('does not mark the session for other destinations', async () => {
      exchangeCodeForSession.mockResolvedValue({
        data: { user: { updated_at: '2026-09-14T10:00:00Z' } },
        error: null,
      });

      const response = await GET(request('?code=abc123&next=%2Fjoin%2Fabc123'));

      expect(response.cookies.get(RECOVERY_COOKIE)).toBeUndefined();
    });

    it('does not mark the session when the exchange fails', async () => {
      exchangeCodeForSession.mockResolvedValue({
        data: {},
        error: new Error('invalid or expired code'),
      });

      const response = await GET(request('?code=stale&next=%2Freset-password'));

      expect(response.cookies.get(RECOVERY_COOKIE)).toBeUndefined();
    });
  });
});
