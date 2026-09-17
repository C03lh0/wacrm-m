/**
 * Creating and re-creating an account's Evolution instance.
 *
 * Extracted from `src/app/api/whatsapp/connections/route.ts` so the QR
 * route can reach the same code. Before this existed, a connection whose
 * Evolution-side instance had broken was unrecoverable from the UI:
 *
 *   - DELETE /connections logged the instance out best-effort and left
 *     the row behind marked `disconnected`,
 *   - POST /connections refused with 409 whenever a row existed at all,
 *     so a fresh instance could never be created,
 *   - POST /connections/qr re-requested a QR from the SAME broken
 *     instance and surfaced whatever Evolution answered.
 *
 * A session that had gone zombie (socket reporting "open" while
 * WhatsApp had stopped routing through it — see evolution-liveness.ts)
 * therefore ended with the user staring at an error and no way forward.
 *
 * Re-provisioning always replaces the Evolution instance rather than
 * trying to revive it: a logged-out or half-broken instance cannot be
 * reliably resumed, and re-pairing by QR is what the user is doing
 * anyway. The `whatsapp_connections` ROW is deliberately kept and
 * updated in place — `messages.connection_id` references it, so
 * deleting the row would take the conversation history with it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { encrypt, decrypt } from './encryption'
import { EvolutionApiError } from './evolution-errors'
import {
  createInstance,
  setInstanceWebhook,
  setInstanceSettings,
  getInstanceConnect,
  findInstanceWebhook,
  deleteInstance,
  DEFAULT_WEBHOOK_EVENTS,
} from './providers/evolution-api'

/**
 * Evolution QR codes follow the WhatsApp Web / Baileys pairing
 * protocol, whose codes are conventionally short-lived (~60s) —
 * ASSUMPTION, confirm against the target Evolution deployment's actual
 * QR TTL.
 */
export const QR_TTL_SECONDS = 60

/**
 * Build the plain webhook callback URL — no secret embedded here.
 * URLs routinely end up in access logs, proxy logs, and browser/CLI
 * history, so the connection's auth secret is instead carried as a
 * custom `Authorization` header on the webhook delivery (see
 * webhookAuthHeaders below), never as part of the URL itself.
 */
export function buildWebhookUrl(instanceName: string): string {
  // Reuses the app's existing canonical-URL var (also used by
  // /api/account/invitations) rather than introducing a second one.
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL
  if (!appUrl) {
    throw new EvolutionApiError(
      'EVOLUTION_INSTANCE_ERROR',
      undefined,
      'NEXT_PUBLIC_SITE_URL is not configured; cannot register an Evolution webhook callback.'
    )
  }
  return `${appUrl.replace(/\/+$/, '')}/api/whatsapp/webhook/evolution/${encodeURIComponent(instanceName)}`
}

/**
 * Header carrying the connection's secret on every webhook delivery —
 * verified (constant-time) in the Evolution webhook route. ASSUMPTION:
 * Evolution API v2 forwards a `webhook.headers` object configured at
 * instance-create/webhook-set time; if the target deployment doesn't
 * support custom webhook headers, this header is simply never
 * presented back to us and verification falls back to skipping the
 * check (see verifyEvolutionWebhookAuth's own comment) rather than
 * failing closed — tightening that gap requires confirming the real
 * mechanism against the target deployment (see docs/evolution-api.md).
 */
export function webhookAuthHeaders(secret: string): Record<string, string> {
  return { Authorization: `Bearer ${secret}` }
}

export interface ProvisionedInstance {
  instanceName: string
  /** Plaintext. The caller encrypts it before it touches the database. */
  webhookSecret: string
  qrCode: string | null
}

/**
 * Create a brand-new Evolution instance for an account, wire its
 * webhook and settings, and fetch its first QR code.
 *
 * The instance name embeds a fresh UUID fragment, so every call
 * produces a name that has never been used before. That is what makes
 * re-provisioning safe: there is no chance of colliding with the
 * lingering state of the instance being replaced.
 */
export async function provisionEvolutionInstance(
  accountId: string
): Promise<ProvisionedInstance> {
  const instanceName = `wacrm-${accountId.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  const webhookSecret = randomUUID()
  const webhookUrl = buildWebhookUrl(instanceName)
  const webhookHeaders = webhookAuthHeaders(webhookSecret)

  console.log(`[evolution] creating instance account=${accountId} instance=${instanceName}`)
  const created = await createInstance({
    instanceName,
    webhookUrl,
    webhookEvents: DEFAULT_WEBHOOK_EVENTS,
    webhookHeaders,
  })

  // Some Evolution deployments require a separate webhook-set call
  // rather than accepting webhook config inline at creation —
  // idempotent, safe to call unconditionally.
  await setInstanceWebhook({
    instanceName,
    url: webhookUrl,
    events: DEFAULT_WEBHOOK_EVENTS,
    headers: webhookHeaders,
  })

  // wacrm has no concept of group chats — without this, a group
  // message would still hit the webhook and create a fake "contact"
  // out of the group's JID (see setInstanceSettings's own comment).
  await setInstanceSettings({ instanceName })

  let qrCode = created.qrCode
  if (!qrCode) {
    console.log(`[evolution] requesting QR account=${accountId} instance=${instanceName}`)
    const connectResult = await getInstanceConnect({ instanceName })
    qrCode = connectResult.qrCode
  }

  return { instanceName, webhookSecret, qrCode: qrCode ?? null }
}

export interface ReconcilableConnection {
  id: string
  instance_name: string
  /** Ciphertext straight off the row, or null when none was stored. */
  webhook_secret: string | null
}

/**
 * Make sure Evolution is still delivering this instance's events to
 * this deployment, and re-register the webhook if it isn't.
 *
 * Returns whether a re-registration was actually performed.
 *
 * The auth header is re-sent along with the URL. Setting the URL alone
 * would drop it, and the webhook route fails closed on a connection
 * that has a `webhook_secret` but receives no matching header — so a
 * half-repair here would turn a silent delivery failure into a loud
 * 401 one, which is not an improvement.
 */
export async function reconcileInstanceWebhook(
  connection: ReconcilableConnection
): Promise<boolean> {
  const expectedUrl = buildWebhookUrl(connection.instance_name)
  const current = await findInstanceWebhook({ instanceName: connection.instance_name })

  if (current.enabled && current.url === expectedUrl) return false

  let secret: string | null = null
  if (connection.webhook_secret) {
    try {
      secret = decrypt(connection.webhook_secret)
    } catch (err) {
      // Without the plaintext secret the header can't be reproduced,
      // and re-registering without it would guarantee 401s. This
      // connection needs re-provisioning, not rewiring — leave it
      // alone and say so.
      console.error(
        `[evolution] cannot reconcile webhook for connection=${connection.id}: webhook_secret failed to decrypt.`,
        err
      )
      return false
    }
  }

  console.warn(
    `[evolution] webhook drift on connection=${connection.id}: Evolution has ${current.url ?? 'none'}, expected ${expectedUrl}. Re-registering.`
  )

  await setInstanceWebhook({
    instanceName: connection.instance_name,
    url: expectedUrl,
    events: DEFAULT_WEBHOOK_EVENTS,
    ...(secret ? { headers: webhookAuthHeaders(secret) } : {}),
  })

  return true
}

export interface ReprovisionResult {
  connectionId: string
  status: string
  qrCode: string | null
  qrExpiresAt: string | null
}

export interface ExistingConnection {
  id: string
  instance_name: string
}

/**
 * Replace the Evolution instance behind an existing connection row and
 * point the row at the new one.
 *
 * Deleting the old instance is best-effort on purpose. The common
 * reason to be here at all is that the old instance is already broken
 * or already gone, and refusing to re-provision because the cleanup of
 * a corpse failed would recreate the dead end this function exists to
 * remove. A leaked instance on the Evolution side costs a little
 * memory; a user who cannot reconnect costs them their inbox.
 */
export async function reprovisionConnection(
  db: SupabaseClient,
  accountId: string,
  connection: ExistingConnection
): Promise<ReprovisionResult> {
  try {
    await deleteInstance({ instanceName: connection.instance_name })
    console.log(
      `[evolution] deleted stale instance account=${accountId} instance=${connection.instance_name}`
    )
  } catch (err) {
    console.warn(
      `[evolution] deleteInstance failed for ${connection.instance_name} (continuing to re-provision):`,
      err
    )
  }

  const provisioned = await provisionEvolutionInstance(accountId)
  const qrExpiresAt = provisioned.qrCode
    ? new Date(Date.now() + QR_TTL_SECONDS * 1000).toISOString()
    : null

  const { data: row, error } = await db
    .from('whatsapp_connections')
    .update({
      instance_name: provisioned.instanceName,
      webhook_secret: encrypt(provisioned.webhookSecret),
      status: provisioned.qrCode ? 'qr_required' : 'connecting',
      qr_code: provisioned.qrCode,
      qr_expires_at: qrExpiresAt,
      // A re-provision is a clean slate: the previous failure reason
      // describes an instance that no longer exists.
      last_error: null,
      disconnected_at: null,
    })
    .eq('id', connection.id)
    .select('id, status, qr_code, qr_expires_at')
    .single()

  if (error) {
    // The new instance exists on Evolution but the row still points at
    // the old name, so nothing can reach it. Surfacing this rather than
    // returning a QR the webhook could never match is the honest
    // failure.
    throw new EvolutionApiError(
      'EVOLUTION_INSTANCE_ERROR',
      undefined,
      `Re-provisioned instance ${provisioned.instanceName} but failed to persist it: ${error.message}`
    )
  }

  console.log(
    `[evolution] re-provisioned account=${accountId} connectionId=${row.id} instance=${provisioned.instanceName}`
  )

  return {
    connectionId: row.id,
    status: row.status,
    qrCode: row.qr_code,
    qrExpiresAt: row.qr_expires_at,
  }
}
