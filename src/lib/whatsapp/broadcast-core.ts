// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via the
//                        account's resolved provider (phone-variant
//                        retry), stamp each recipient row + the
//                        aggregate counts, finalize status.
//
// Broadcasts are 100% template-based (`broadcasts.template_name` is
// NOT NULL), and templates are a Meta-only concept — Evolution has no
// template-approval workflow. createBroadcast() resolves the
// account's provider via provider-factory.ts and fails fast with
// `unsupported_message_type_for_provider` before writing any rows if
// the resolved provider has no `sendTemplate`.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveProviderForAccount } from '@/lib/whatsapp/provider-factory';
import { SendMessageError } from '@/lib/whatsapp/send-message-error';
import type { WhatsAppProviderClient, ProviderName } from '@/lib/whatsapp/provider';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate, Contact } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import {
  resolveVariables,
  fetchCustomValueIndex,
  type VariableMapping,
} from '@/lib/whatsapp/template-variables';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  client: WhatsAppProviderClient;
  provider: ProviderName;
  connectionId: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
  /** Contacts excluded because they opted out of broadcasts (migration 039). */
  optedOut: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Resolve the account's provider (Meta or Evolution) — see
  // provider-factory.ts. Broadcasts are 100% template-based, and
  // templates are a Meta-only concept, so fail fast here (before any
  // broadcasts/broadcast_recipients rows are written) if the resolved
  // provider has no sendTemplate.
  let client: WhatsAppProviderClient;
  let provider: ProviderName;
  let connectionId: string;
  try {
    const resolved = await resolveProviderForAccount(db, accountId);
    client = resolved.client;
    provider = resolved.kind;
    connectionId = resolved.connectionId;
  } catch (err) {
    if (err instanceof SendMessageError) {
      throw new BroadcastError(err.code, err.message, err.status);
    }
    throw err;
  }
  if (!client.sendTemplate) {
    throw new BroadcastError(
      'unsupported_message_type_for_provider',
      `Template broadcasts are not supported on ${client.name}-connected accounts.`,
      400
    );
  }

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Exclude contacts who've opted out of broadcasts (migration 039).
  // Neither Meta's template-approval process nor Evolution's lack
  // thereof enforces consent — this is the CRM's own backstop, and
  // it's checked here regardless of which provider the send will use.
  let optedOut = 0;
  let consented = resolved;
  if (resolved.length > 0) {
    const { data: optedOutRows } = await db
      .from('contacts')
      .select('id')
      .in(
        'id',
        resolved.map((r) => r.contactId)
      )
      .not('opted_out_at', 'is', null);
    const optedOutIds = new Set((optedOutRows ?? []).map((row) => row.id as string));
    if (optedOutIds.size > 0) {
      consented = resolved.filter((r) => {
        if (optedOutIds.has(r.contactId)) {
          optedOut++;
          return false;
        }
        return true;
      });
    }
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = consented.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      optedOut > 0 && rejected === 0
        ? 'All recipients have opted out of broadcasts'
        : 'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return { recipientRowId: row.recipient_id, phone: r.phone, params: r.params };
    }
  );

  return {
    broadcastId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    client,
    provider,
    connectionId,
    templateRow,
    planned,
    rejected,
    optedOut,
  };
}

/**
 * Fan out to every planned recipient: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Shared by {@link deliverBroadcast} (immediate send, called inside
 * `after()`) and {@link deliverScheduledBroadcast} (cron-driven
 * deferred send) — same fan-out, different callers.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
async function sendPlannedRecipients(
  db: SupabaseClient,
  broadcastId: string,
  client: WhatsAppProviderClient,
  templateName: string,
  templateLanguage: string,
  templateRow: MessageTemplate | null,
  planned: PlannedRecipient[]
): Promise<void> {
  for (const recipient of planned) {
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        // Callers verify client.sendTemplate exists before reaching
        // this loop (createBroadcast / deliverScheduledBroadcast).
        const result = await client.sendTemplate!({
          to: variant,
          templateName,
          language: templateLanguage,
          template: templateRow ?? undefined,
          params: recipient.params,
        });
        sentMessageId = result.providerMessageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  await finalizeBroadcastStatus(db, broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}

/**
 * Fan out a {@link BroadcastPlan} built moments ago by
 * {@link createBroadcast}. Designed to run inside `after()`.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  await sendPlannedRecipients(
    db,
    plan.broadcastId,
    plan.client,
    plan.templateName,
    plan.templateLanguage,
    plan.templateRow,
    plan.planned
  );
}

/**
 * Deliver a broadcast that was persisted earlier as `status:
 * 'scheduled'` (the dashboard wizard's "schedule for later" option —
 * see use-broadcast-sending.ts) and whose `scheduled_at` has come
 * due. Called by the cron route (src/app/api/broadcasts/cron) after
 * it claims the row.
 *
 * Unlike {@link createBroadcast}, no in-memory plan survives from
 * creation time — the broadcast row and its already-inserted
 * `broadcast_recipients` (status 'pending') are the only state. Each
 * recipient's template variables are re-resolved here from the
 * broadcast's stored `template_variables` mapping against the
 * contact's CURRENT data, exactly mirroring the immediate-send path's
 * resolveVariables() call (template-variables.ts) — by design, a
 * variable resolves to whatever the contact record says at delivery
 * time, not at scheduling time.
 */
export async function deliverScheduledBroadcast(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const { data: broadcast } = await db
    .from('broadcasts')
    .select('id, account_id, template_name, template_language, template_variables')
    .eq('id', broadcastId)
    .maybeSingle();
  if (!broadcast) return;

  const accountId = broadcast.account_id as string;

  let client: WhatsAppProviderClient;
  try {
    const resolved = await resolveProviderForAccount(db, accountId);
    client = resolved.client;
  } catch (err) {
    const message = err instanceof SendMessageError ? err.message : 'WhatsApp provider unavailable';
    await markScheduledBroadcastFailed(db, broadcastId, message);
    return;
  }
  if (!client.sendTemplate) {
    // The account switched to Evolution sometime between scheduling
    // and now — templates are Meta-only. Fail clearly rather than
    // silently dropping the send.
    await markScheduledBroadcastFailed(
      db,
      broadcastId,
      `Template broadcasts are not supported on ${client.name}-connected accounts.`
    );
    return;
  }

  const templateName = broadcast.template_name as string;
  const templateLanguage = broadcast.template_language as string;

  const { data: rawTemplateRow } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();
  const templateRow =
    rawTemplateRow && isMessageTemplate(rawTemplateRow) ? (rawTemplateRow as MessageTemplate) : null;

  const { data: recipients } = await db
    .from('broadcast_recipients')
    .select('id, contact:contacts(id, name, phone, email, company)')
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');

  if (!recipients || recipients.length === 0) {
    await db
      .from('broadcasts')
      .update({ status: 'sent', updated_at: new Date().toISOString() })
      .eq('id', broadcastId);
    return;
  }

  type RecipientRow = {
    id: string;
    contact: { id: string; name?: string; phone: string; email?: string; company?: string } | null;
  };
  const rows = recipients as unknown as RecipientRow[];

  const contactIds = rows.map((r) => r.contact?.id).filter((id): id is string => !!id);
  const customValueIndex = await fetchCustomValueIndex(db, contactIds);
  const variables = (broadcast.template_variables as Record<string, VariableMapping>) ?? {};

  const planned: PlannedRecipient[] = [];
  for (const r of rows) {
    if (!r.contact?.phone) continue;
    const sanitized = sanitizePhoneForMeta(r.contact.phone);
    if (!isValidE164(sanitized)) continue;
    planned.push({
      recipientRowId: r.id,
      phone: sanitized,
      params: resolveVariables(variables, r.contact as Contact, customValueIndex.get(r.contact.id)),
    });
  }

  if (planned.length === 0) {
    await markScheduledBroadcastFailed(db, broadcastId, 'No recipients had a valid E.164 phone number');
    return;
  }

  await sendPlannedRecipients(db, broadcastId, client, templateName, templateLanguage, templateRow, planned);
}

async function markScheduledBroadcastFailed(
  db: SupabaseClient,
  broadcastId: string,
  reason: string
): Promise<void> {
  await db
    .from('broadcast_recipients')
    .update({ status: 'failed', error_message: reason })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
  await db
    .from('broadcasts')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', broadcastId);
}
