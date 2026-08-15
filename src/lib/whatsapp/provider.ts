/**
 * Provider-agnostic contract for sending WhatsApp messages.
 *
 * `resolveProviderForAccount` (provider-factory.ts) is the only place
 * that decides which implementation an account gets — every caller
 * (send-message.ts, and anything added later) works against this
 * interface only, never against Meta or Evolution specifics directly.
 *
 * Template and interactive sends are optional: Evolution/Baileys-style
 * bridges have no template-approval workflow and no native interactive
 * button/list message type, so `EvolutionProviderClient` simply omits
 * those methods. Callers must check for their presence before use.
 */

import type { MessageTemplate } from '@/types'
import type { SendTimeParams } from './template-send-builder'
import type {
  MediaKind,
  InteractiveButton,
  InteractiveListSection,
} from './meta-api'

export type ProviderName = 'meta' | 'evolution'

export interface ProviderSendResult {
  /** The provider's own id for the sent message (Meta's wamid, Evolution's key.id). */
  providerMessageId: string
}

export interface SendTextArgs {
  to: string
  text: string
  contextMessageId?: string
}

export interface SendMediaArgs {
  to: string
  kind: MediaKind
  /** Public URL the provider fetches at send time. */
  link: string
  caption?: string
  filename?: string
  contextMessageId?: string
}

export interface SendTemplateArgs {
  to: string
  templateName: string
  language?: string
  params?: string[]
  template?: MessageTemplate
  messageParams?: SendTimeParams
  contextMessageId?: string
}

export interface SendInteractiveButtonsArgs {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  contextMessageId?: string
}

export interface SendInteractiveListArgs {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  contextMessageId?: string
}

/**
 * A provider client bound to one account's credentials/connection —
 * returned by `resolveProviderForAccount`, ready to call without any
 * further config lookup.
 */
export interface WhatsAppProviderClient {
  readonly name: ProviderName
  sendText(args: SendTextArgs): Promise<ProviderSendResult>
  sendMedia(args: SendMediaArgs): Promise<ProviderSendResult>
  /** Omitted by providers with no template-approval system (Evolution). */
  sendTemplate?(args: SendTemplateArgs): Promise<ProviderSendResult>
  /** Omitted by providers with no native interactive messages (Evolution). */
  sendInteractiveButtons?(args: SendInteractiveButtonsArgs): Promise<ProviderSendResult>
  sendInteractiveList?(args: SendInteractiveListArgs): Promise<ProviderSendResult>
}
