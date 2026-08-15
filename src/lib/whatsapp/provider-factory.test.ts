import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveProviderForAccount } from './provider-factory';
import { SendMessageError } from './send-message-error';

vi.mock('./encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}));

interface Script {
  evolutionConnection?: Record<string, unknown> | null;
  metaConfig?: Record<string, unknown> | null;
}

function makeDb(script: Script): SupabaseClient {
  let table = '';

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    update: () => builder,
    maybeSingle: () => {
      if (table === 'whatsapp_connections') {
        return Promise.resolve({ data: script.evolutionConnection ?? null, error: null });
      }
      if (table === 'whatsapp_config') {
        return Promise.resolve({ data: script.metaConfig ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then: (resolve: (v: { data: null; error: null }) => void) =>
      resolve({ data: null, error: null }),
  };

  return {
    from: (t: string) => {
      table = t;
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('resolveProviderForAccount', () => {
  it('throws whatsapp_not_configured when the account has neither provider set up', async () => {
    const db = makeDb({ evolutionConnection: null, metaConfig: null });
    await expect(resolveProviderForAccount(db, 'acct-1')).rejects.toBeInstanceOf(
      SendMessageError
    );
    await resolveProviderForAccount(db, 'acct-1').catch((e: SendMessageError) => {
      expect(e.code).toBe('whatsapp_not_configured');
      expect(e.status).toBe(400);
    });
  });

  it('resolves to the Meta provider when only whatsapp_config exists', async () => {
    const db = makeDb({
      evolutionConnection: null,
      metaConfig: { id: 'cfg-1', phone_number_id: 'PNID-1', access_token: 'enc' },
    });
    const result = await resolveProviderForAccount(db, 'acct-1');
    expect(result.kind).toBe('meta');
    expect(result.connectionId).toBe('cfg-1');
    expect(result.client.name).toBe('meta');
    // Meta has no template-approval-free-form-only restriction — these
    // are present on the client.
    expect(result.client.sendTemplate).toBeDefined();
    expect(result.client.sendInteractiveButtons).toBeDefined();
  });

  it('resolves to the Evolution provider when a connected whatsapp_connections row exists — Evolution takes precedence', async () => {
    const db = makeDb({
      evolutionConnection: {
        id: 'conn-1',
        instance_name: 'wacrm-acct1-abcd',
        status: 'connected',
      },
      // Even if a Meta config also exists, Evolution wins deterministically.
      metaConfig: { id: 'cfg-1', phone_number_id: 'PNID-1', access_token: 'enc' },
    });
    const result = await resolveProviderForAccount(db, 'acct-1');
    expect(result.kind).toBe('evolution');
    expect(result.connectionId).toBe('conn-1');
    expect(result.client.name).toBe('evolution');
    // Evolution has no template/interactive support — the methods must
    // be absent so callers can feature-detect before calling them.
    expect(result.client.sendTemplate).toBeUndefined();
    expect(result.client.sendInteractiveButtons).toBeUndefined();
    expect(result.client.sendInteractiveList).toBeUndefined();
  });

  it('throws whatsapp_disconnected (409) when the Evolution connection exists but is not connected', async () => {
    const db = makeDb({
      evolutionConnection: { id: 'conn-1', instance_name: 'wacrm-acct1-abcd', status: 'qr_required' },
    });
    await resolveProviderForAccount(db, 'acct-1').catch((e: SendMessageError) => {
      expect(e.code).toBe('whatsapp_disconnected');
      expect(e.status).toBe(409);
    });
  });
});
