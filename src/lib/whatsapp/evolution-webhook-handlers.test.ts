import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { resolveContactAndConversation, ingestParsedMessage, ingestOwnDeviceMessage } = vi.hoisted(() => ({
  resolveContactAndConversation: vi.fn(async () => ({
    contact: { id: 'contact-1' },
    conversation: { id: 'conv-1' },
    contactWasCreated: false,
    conversationWasCreated: false,
  })),
  ingestParsedMessage: vi.fn(async () => {}),
  ingestOwnDeviceMessage: vi.fn(async () => {}),
}));
vi.mock('./inbound-message-pipeline', () => ({
  resolveContactAndConversation,
  ingestParsedMessage,
  ingestOwnDeviceMessage,
}));

import { processEvolutionMessage, extractCounterpartPhone, type EvolutionMessagePayload } from './evolution-webhook-handlers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = {} as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeConnection = { id: 'conn-1', account_id: 'acct-1', created_by_user_id: 'user-1' } as any;

describe('extractCounterpartPhone', () => {
  it('prefers remoteJidAlt over remoteJid when present (a "lid"-addressed contact)', () => {
    const phone = extractCounterpartPhone({
      id: 'msg-1',
      remoteJid: '201786254225419@lid',
      remoteJidAlt: '558198505578@s.whatsapp.net',
      fromMe: false,
    });
    expect(phone).toBe('558198505578');
  });

  it('falls back to remoteJid when remoteJidAlt is absent', () => {
    const phone = extractCounterpartPhone({
      id: 'msg-2',
      remoteJid: '5511999999999@s.whatsapp.net',
      fromMe: false,
    });
    expect(phone).toBe('5511999999999');
  });
});

/** Fake db supporting only the `messages` dedup-lookup chain used by the fromMe branch. */
function makeFakeDedupDb(existing: { id: string } | null) {
  const db = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () =>
        table === 'messages' ? Promise.resolve({ data: existing, error: null }) : Promise.resolve({ data: null, error: null });
      return chain;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return db;
}

function makeFakeStorageDb(uploadResult: { error: unknown } = { error: null }) {
  const uploadCalls: { path: string; options: Record<string, unknown> }[] = [];
  const db = {
    storage: {
      from: (_bucket: string) => ({
        upload: (path: string, _bytes: unknown, options: Record<string, unknown>) => {
          uploadCalls.push({ path, options });
          return Promise.resolve(uploadResult);
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example.com/${path}` } }),
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, uploadCalls };
}

describe('processEvolutionMessage — group filtering', () => {
  beforeEach(() => {
    resolveContactAndConversation.mockClear();
    ingestParsedMessage.mockClear();
  });

  it('skips messages from a group JID (@g.us) without touching contacts/conversations', async () => {
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-group-1', remoteJid: '120363012345678901@g.us', fromMe: false },
      pushName: 'Some Group Member',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello from a group' },
    };

    await processEvolutionMessage(fakeDb, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).not.toHaveBeenCalled();
    expect(ingestParsedMessage).not.toHaveBeenCalled();
  });

  it('still processes a normal 1:1 contact message (@s.whatsapp.net)', async () => {
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-dm-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello' },
    };

    await processEvolutionMessage(fakeDb, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).toHaveBeenCalledTimes(1);
    expect(ingestParsedMessage).toHaveBeenCalledTimes(1);
  });
});

describe('processEvolutionMessage — lid-addressed contacts', () => {
  beforeEach(() => {
    resolveContactAndConversation.mockClear();
    ingestParsedMessage.mockClear();
  });

  it('resolves the contact using remoteJidAlt (the real phone), not remoteJid (the opaque lid), when both are present', async () => {
    const payload: EvolutionMessagePayload = {
      key: {
        id: 'wamid-lid-1',
        remoteJid: '201786254225419@lid',
        remoteJidAlt: '558198505578@s.whatsapp.net',
        fromMe: false,
      },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello from a lid-addressed contact' },
    };

    await processEvolutionMessage(fakeDb, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).toHaveBeenCalledWith(
      fakeDb,
      'acct-1',
      'user-1',
      '558198505578',
      'Jane'
    );
  });
});

describe('processEvolutionMessage — inbound media', () => {
  beforeEach(() => {
    resolveContactAndConversation.mockClear();
    ingestParsedMessage.mockClear();
  });

  it('strips codec parameters from the mime type before uploading (Supabase Storage rejects audio/ogg; codecs=opus as 415)', async () => {
    const { db, uploadCalls } = makeFakeStorageDb();
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-audio-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: {
        audioMessage: { mimetype: 'audio/ogg; codecs=opus', base64: 'ZmFrZS1hdWRpby1ieXRlcw==' },
      },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0].options.contentType).toBe('audio/ogg');
  });

  it('warns when a media message (e.g. image) arrives with neither base64 nor a url', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-image-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { imageMessage: { mimetype: 'image/jpeg' } },
    };

    await processEvolutionMessage(fakeDb, fakeConnection, 'user-1', payload);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no media payload for image'));
    warnSpy.mockRestore();
  });

  it('does not warn for an ordinary text message (no media expected)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-text-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello' },
    };

    await processEvolutionMessage(fakeDb, fakeConnection, 'user-1', payload);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('processEvolutionMessage — inbound media via url (SSRF guard)', () => {
  const originalEvolutionApiUrl = process.env.EVOLUTION_API_URL;

  beforeEach(() => {
    resolveContactAndConversation.mockClear();
    ingestParsedMessage.mockClear();
    process.env.EVOLUTION_API_URL = 'https://evolution.example.com';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalEvolutionApiUrl === undefined) delete process.env.EVOLUTION_API_URL;
    else process.env.EVOLUTION_API_URL = originalEvolutionApiUrl;
  });

  it('fetches media whose url is on the configured Evolution host', async () => {
    const { db, uploadCalls } = makeFakeStorageDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    );
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-image-url-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://evolution.example.com/media/abc.jpg' } },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(uploadCalls).toHaveLength(1);
  });

  it('rejects and skips a media url pointing at a different host, without fetching it (SSRF guard)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, uploadCalls } = makeFakeStorageDb();
    const fetchSpy = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-image-url-2', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { imageMessage: { mimetype: 'image/jpeg', url: 'http://169.254.169.254/latest/meta-data/' } },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(uploadCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rejected media url outside configured Evolution host'));
    expect(ingestParsedMessage).toHaveBeenCalledTimes(1);
    const [, , paramsArg] = ingestParsedMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { content: { mediaUrl: string | null } },
    ];
    expect(paramsArg.content.mediaUrl).toBeNull();
    warnSpy.mockRestore();
  });
});

describe('processEvolutionMessage — own-device (fromMe) messages', () => {
  beforeEach(() => {
    resolveContactAndConversation.mockClear();
    ingestParsedMessage.mockClear();
    ingestOwnDeviceMessage.mockClear();
  });

  it('a message sent from the linked phone (fromMe, no existing row) resolves the contact/conversation and ingests as an own-device message', async () => {
    const db = makeFakeDedupDb(null);
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-phone-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { conversation: 'sent from my phone' },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).toHaveBeenCalledTimes(1);
    expect(ingestOwnDeviceMessage).toHaveBeenCalledTimes(1);
    expect(ingestParsedMessage).not.toHaveBeenCalled();
    expect(ingestOwnDeviceMessage).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ contact: { id: 'contact-1' } }),
      expect.objectContaining({
        provider: 'evolution',
        connectionId: 'conn-1',
        providerMessageId: 'wamid-phone-1',
        content: expect.objectContaining({ contentText: 'sent from my phone' }),
      })
    );
  });

  it('an echo of a CRM-initiated send (fromMe, row already exists) is a no-op — no contact resolution, no ingest', async () => {
    const db = makeFakeDedupDb({ id: 'msg-existing' });
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-echo-1', remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
      pushName: 'Jane',
      messageTimestamp: 1700000000,
      message: { conversation: 'echo of our own send' },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).not.toHaveBeenCalled();
    expect(ingestOwnDeviceMessage).not.toHaveBeenCalled();
    expect(ingestParsedMessage).not.toHaveBeenCalled();
  });

  it('never passes payload.pushName as the contact name for a fromMe message (it is the connection owner\'s own name, not the counterpart\'s)', async () => {
    const db = makeFakeDedupDb(null);
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-phone-2', remoteJid: '5511999999999@s.whatsapp.net', fromMe: true },
      pushName: 'Matheus (the connection owner)',
      messageTimestamp: 1700000000,
      message: { conversation: 'sent from my phone' },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).toHaveBeenCalledWith(
      db,
      'acct-1',
      'user-1',
      '5511999999999',
      ''
    );
  });

  it('still skips a group JID even when fromMe is true, without hitting the dedup lookup', async () => {
    const db = makeFakeDedupDb(null);
    const payload: EvolutionMessagePayload = {
      key: { id: 'wamid-group-2', remoteJid: '120363012345678901@g.us', fromMe: true },
      pushName: 'Some Group Member',
      messageTimestamp: 1700000000,
      message: { conversation: 'hello from a group, from me' },
    };

    await processEvolutionMessage(db, fakeConnection, 'user-1', payload);

    expect(resolveContactAndConversation).not.toHaveBeenCalled();
    expect(ingestOwnDeviceMessage).not.toHaveBeenCalled();
    expect(ingestParsedMessage).not.toHaveBeenCalled();
  });
});
