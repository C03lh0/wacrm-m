import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextResponse } from 'next/server';

import { RECOVERY_COOKIE } from '@/lib/auth/recovery';

// The server client wraps `next/headers`, which has no request scope
// under vitest — stub the whole module and script the two exchange
// methods the route can call.
const mocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));

import { GET } from './route';

function request(query: string): Request {
  return new Request(`http://localhost:3000/auth/callback?${query}`);
}

const SESSION = { user: { updated_at: '2026-09-14T10:00:00Z' } };

beforeEach(() => {
  mocks.exchangeCodeForSession.mockResolvedValue({ data: SESSION, error: null });
  mocks.verifyOtp.mockResolvedValue({ data: SESSION, error: null });
  mocks.createClient.mockResolvedValue({
    auth: {
      exchangeCodeForSession: mocks.exchangeCodeForSession,
      verifyOtp: mocks.verifyOtp,
    },
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('GET /auth/callback', () => {
  it('exchanges a PKCE code and redirects to the validated next path', async () => {
    const res = await GET(request('code=pkce-123&next=%2Freset-password'));

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('pkce-123');
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/reset-password');
  });

  it('verifies a token_hash link through verifyOtp', async () => {
    const res = await GET(
      request('token_hash=th-1&type=recovery&next=%2Freset-password'),
    );

    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      type: 'recovery',
      token_hash: 'th-1',
    });
    expect(mocks.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('/reset-password');
  });

  it('defaults next to /dashboard when absent', async () => {
    const res = await GET(request('code=abc'));
    expect(res.headers.get('location')).toBe('/dashboard');
  });

  // `next` is attacker-controllable query input: the callback has just
  // minted a session and must not hand the browser to another origin.
  it('refuses an off-origin next and falls back to /dashboard', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\x']) {
      const res = await GET(request(`code=abc&next=${encodeURIComponent(next)}`));
      expect(res.headers.get('location')).toBe('/dashboard');
    }
  });

  it('sends a failed exchange to /login with a reason, not a 404 or a raw error', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({
      data: {},
      error: { message: 'PKCE code verifier not found' },
    });

    const res = await GET(request('code=stale&next=%2Freset-password'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login?error=link_invalid');
    expect(console.warn).toHaveBeenCalled();
  });

  it('reports a link Supabase already rejected as expired, without touching the client', async () => {
    const res = await GET(
      request(
        'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
      ),
    );

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('/login?error=link_expired');
  });

  it('treats a bare visit with no credential as an invalid link', async () => {
    const res = await GET(request('next=%2Fdashboard'));

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(res.headers.get('location')).toBe('/login?error=link_invalid');
  });

  it('emits a relative Location so the redirect works behind a reverse proxy', async () => {
    const res = await GET(request('code=abc&next=%2Fjoin%2Ftoken-1'));
    expect(res.headers.get('location')).toBe('/join/token-1');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // A reset link mints an ordinary session, so the lock cookie is what
  // keeps it from being a one-click sign-in (see lib/auth/recovery).
  describe('password-recovery lock', () => {
    it('marks the session when next is /reset-password', async () => {
      const res = (await GET(
        request('code=abc123&next=%2Freset-password'),
      )) as NextResponse;
      const cookie = res.cookies.get(RECOVERY_COOKIE);

      expect(cookie?.value).toBe('2026-09-14T10:00:00Z');
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.path).toBe('/');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('marks a type=recovery token_hash link that carries no next', async () => {
      const res = (await GET(
        request('token_hash=th-1&type=recovery'),
      )) as NextResponse;

      expect(res.cookies.get(RECOVERY_COOKIE)?.value).toBe(
        '2026-09-14T10:00:00Z',
      );
      expect(res.headers.get('location')).toBe('/reset-password');
    });

    it('does not mark the session for other destinations', async () => {
      const res = await GET(request('code=abc123&next=%2Fjoin%2Fabc123'));

      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('does not mark the session when the exchange fails', async () => {
      mocks.exchangeCodeForSession.mockResolvedValue({
        data: {},
        error: { message: 'invalid or expired code' },
      });

      const res = await GET(request('code=stale&next=%2Freset-password'));

      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('sets Secure when a proxy terminated TLS upstream', async () => {
      const req = new Request(
        'http://localhost:3000/auth/callback?code=abc&next=%2Freset-password',
        { headers: { 'x-forwarded-proto': 'https' } },
      );

      const res = (await GET(req)) as NextResponse;

      expect(res.cookies.get(RECOVERY_COOKIE)?.secure).toBe(true);
    });
  });
});
