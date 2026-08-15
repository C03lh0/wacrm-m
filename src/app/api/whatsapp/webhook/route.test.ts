import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  resolveContactAndConversation: vi.fn(),
  ingestParsedMessage: vi.fn(),
  lookupInternalIdByProviderMessageId: vi.fn(),
  state: {
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    afterCallbacks: [] as (() => Promise<void> | void)[],
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

// resolveContactAndConversation / ingestParsedMessage now own contact
// resolution, idempotent insert, the unread bump, and every downstream
// dispatch (Flow runner / automations / AI auto-reply / message.received) —
// that's covered by inbound-message-pipeline.test.ts. This suite only needs
// to verify route.ts parses the Meta payload correctly and calls the shared
// pipeline with the right arguments (content mapping, connectionId,
// mirror_inbound_media gating).
vi.mock('@/lib/whatsapp/inbound-message-pipeline', () => ({
  resolveContactAndConversation: h.resolveContactAndConversation,
  ingestParsedMessage: h.ingestParsedMessage,
  lookupInternalIdByProviderMessageId: h.lookupInternalIdByProviderMessageId,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'cfg-1',
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                  ],
                  error: null,
                }),
            }),
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string },
          ) => {
            h.state.storageUploads.push({ bucket, path, options })
            return Promise.resolve({ error: h.state.storageUploadError })
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        }
      },
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: () => false,
  handleTemplateWebhookChange: vi.fn(),
}))

import { POST } from './route'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

function inboundRequest(message: Record<string, unknown> = TEXT_MESSAGE) {
  const body = {
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '15551230000', profile: { name: 'Ada' } }],
              messages: [message],
            },
          },
        ],
      },
    ],
  }
  return {
    text: async () => JSON.stringify(body),
    headers: { get: () => 'sha256=stub' },
  } as unknown as Request
}

async function runWebhook(message?: Record<string, unknown>) {
  const res = await POST(inboundRequest(message))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.afterCallbacks = []
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.resolveContactAndConversation.mockResolvedValue({
    contact: { id: 'contact-1', phone: '15551230000', name: 'Ada' },
    conversation: h.state.conversation,
    contactWasCreated: false,
    conversationWasCreated: false,
  })
  h.ingestParsedMessage.mockResolvedValue({ messageId: 'msg-1', duplicate: false })
  h.lookupInternalIdByProviderMessageId.mockResolvedValue(null)
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
})

function lastIngestCall() {
  const calls = h.ingestParsedMessage.mock.calls
  return calls[calls.length - 1]?.[2] as
    | {
        accountId: string
        configOwnerUserId: string
        provider: string
        connectionId: string
        providerMessageId: string
        content: {
          contentType: string
          contentText: string | null
          mediaUrl: string | null
          mediaType?: string | null
          interactiveReplyId?: string | null
        }
      }
    | undefined
}

describe('inbound webhook: dispatch to the shared pipeline', () => {
  it('resolves the contact/conversation and ingests exactly once per message', async () => {
    await runWebhook()

    expect(h.resolveContactAndConversation).toHaveBeenCalledTimes(1)
    expect(h.ingestParsedMessage).toHaveBeenCalledTimes(1)

    const call = lastIngestCall()
    expect(call).toMatchObject({
      accountId: 'acc-1',
      configOwnerUserId: 'user-1',
      provider: 'meta',
      connectionId: 'cfg-1',
      providerMessageId: 'wamid.TEST1',
      content: { contentType: 'text', contentText: 'hello' },
    })
  })
})

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap)

    expect(lastIngestCall()?.content).toMatchObject({
      contentType: 'interactive',
      contentText: 'Yes, interested',
      interactiveReplyId: 'YES_INTERESTED',
    })
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    })

    expect(lastIngestCall()?.content).toMatchObject({
      contentType: 'interactive',
      contentText: 'Track my order',
      interactiveReplyId: 'Track my order',
    })
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  }

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
    )
    expect(lastIngestCall()?.content).toMatchObject({
      mediaUrl:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      mediaType: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.ingestParsedMessage).toHaveBeenCalledTimes(1)
    expect(lastIngestCall()?.content).toMatchObject({
      mediaUrl: '/api/whatsapp/media/1234567890123456',
      mediaType: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(new Error('Media download failed: 404'))

    await runWebhook(IMAGE_MESSAGE)

    expect(lastIngestCall()?.content).toMatchObject({
      mediaUrl: '/api/whatsapp/media/1234567890123456',
    })
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    })

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(lastIngestCall()?.content).toMatchObject({
      mediaUrl: '/api/whatsapp/media/999',
      mediaType: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    })
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf',
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(lastIngestCall()?.content).toMatchObject({
      mediaUrl: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      mediaType: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 042', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(lastIngestCall()?.content).toMatchObject({ mediaType: null })
  })
})
