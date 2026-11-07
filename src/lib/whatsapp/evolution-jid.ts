/**
 * Number <-> JID conversion for Evolution/Baileys. A leaf module on
 * purpose: the provider needs `phoneToJid` on the send path, and
 * importing it from evolution-webhook-handlers would pull the whole
 * inbound pipeline in behind it — and close an import cycle back
 * through automations/meta-send to provider-factory.
 */

export function jidToPhone(jid: string): string {
  return jid.split('@')[0]?.replace(/\D/g, '') ?? jid
}

/**
 * The inverse of `jidToPhone`, for the paths that have to ADDRESS a
 * contact by key rather than by number — reactions, read receipts.
 * Kept beside it so the two directions stay in sync.
 *
 * Always produces an `@s.whatsapp.net` JID. A contact first seen
 * through a `@lid`-addressed message is stored by the phone derived
 * from `remoteJidAlt` (see extractCounterpartPhone), so the phone JID
 * is the right address for it; the `@lid` form is never reconstructed
 * here because the opaque id it carries is not derivable from a number.
 */
export function phoneToJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`
}
