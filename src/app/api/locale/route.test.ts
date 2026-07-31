import { describe, it, expect } from 'vitest';

import { POST } from './route';

function request(body: unknown) {
  return new Request('http://localhost/api/locale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/locale', () => {
  it('accepts a supported locale and sets the cookie', async () => {
    const response = await POST(request({ locale: 'pt-BR' }));
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json).toEqual({ locale: 'pt-BR' });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('NEXT_LOCALE=pt-BR');
    expect(setCookie.toLowerCase()).toContain('path=/');
  });

  it('rejects an unsupported locale', async () => {
    const response = await POST(request({ locale: 'fr' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Unsupported locale' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a missing/malformed body', async () => {
    const response = await POST(
      new Request('http://localhost/api/locale', { method: 'POST' })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Unsupported locale' });
  });
});
