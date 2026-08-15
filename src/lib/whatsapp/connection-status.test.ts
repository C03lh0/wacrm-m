import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getWhatsAppConnectionStatus } from './connection-status';

interface Script {
  evolutionConnection?: Record<string, unknown> | null;
  evolutionConnectionError?: { message: string } | null;
  metaConfig?: Record<string, unknown> | null;
}

function makeDb(script: Script): SupabaseClient {
  let table = '';

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => {
      if (table === 'whatsapp_connections') {
        return Promise.resolve({
          data: script.evolutionConnection ?? null,
          error: script.evolutionConnectionError ?? null,
        });
      }
      if (table === 'whatsapp_config') {
        return Promise.resolve({ data: script.metaConfig ?? null, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };

  return {
    from: (t: string) => {
      table = t;
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('getWhatsAppConnectionStatus', () => {
  it('returns provider: null, connected: false, syncing: false when neither provider is set up', async () => {
    const db = makeDb({ evolutionConnection: null, metaConfig: null });
    const status = await getWhatsAppConnectionStatus(db, 'acct-1');
    expect(status).toEqual({ provider: null, connected: false, enforcesSessionWindow: false, syncing: false });
  });

  it('resolves to Meta, enforcing the 24h session window, syncing always false, when only whatsapp_config exists and is connected', async () => {
    const db = makeDb({ evolutionConnection: null, metaConfig: { status: 'connected' } });
    const status = await getWhatsAppConnectionStatus(db, 'acct-1');
    expect(status).toEqual({ provider: 'meta', connected: true, enforcesSessionWindow: true, syncing: false });
  });

  it('resolves to Meta but not connected when whatsapp_config exists with a non-connected status', async () => {
    const db = makeDb({ evolutionConnection: null, metaConfig: { status: 'disconnected' } });
    const status = await getWhatsAppConnectionStatus(db, 'acct-1');
    expect(status).toEqual({ provider: 'meta', connected: false, enforcesSessionWindow: true, syncing: false });
  });

  it('resolves to Evolution, without the 24h session window, when a whatsapp_connections row exists — Evolution wins over Meta', async () => {
    const db = makeDb({
      evolutionConnection: { status: 'connected', is_syncing: false },
      // Even if a Meta config also exists, Evolution wins deterministically —
      // same precedence as resolveProviderForAccount.
      metaConfig: { status: 'connected' },
    });
    const status = await getWhatsAppConnectionStatus(db, 'acct-1');
    expect(status).toEqual({ provider: 'evolution', connected: true, enforcesSessionWindow: false, syncing: false });
  });

  it('resolves to Evolution but not connected when the connection row is not in a connected state', async () => {
    const db = makeDb({ evolutionConnection: { status: 'qr_required', is_syncing: false } });
    const status = await getWhatsAppConnectionStatus(db, 'acct-1');
    expect(status).toEqual({ provider: 'evolution', connected: false, enforcesSessionWindow: false, syncing: false });
  });

  it('reports syncing: true while a post-reconnect backfill is running, even though the connection is already connected', async () => {
    const db = makeDb({ evolutionConnection: { status: 'connected', is_syncing: true } });
    const status = await getWhatsAppConnectionStatus(db, 'acct-1');
    expect(status).toEqual({ provider: 'evolution', connected: true, enforcesSessionWindow: false, syncing: true });
  });

  it('logs via console.error but still resolves without throwing when the whatsapp_connections query errors (e.g. is_syncing column missing pre-migration)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({
      evolutionConnection: null,
      evolutionConnectionError: { message: 'column "is_syncing" does not exist' },
      metaConfig: null,
    });

    const status = await getWhatsAppConnectionStatus(db, 'acct-1');

    expect(status).toEqual({ provider: null, connected: false, enforcesSessionWindow: false, syncing: false });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
