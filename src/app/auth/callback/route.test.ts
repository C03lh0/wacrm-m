import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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
});
