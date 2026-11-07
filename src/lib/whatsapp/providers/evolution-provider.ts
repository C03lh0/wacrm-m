/**
 * Evolution API provider adapter — implements WhatsAppProviderClient
 * over evolution-api.ts. Translates the generic send args into
 * Evolution's request shape and maps EvolutionApiError into
 * SendMessageError so send-message.ts (and its callers) only ever
 * see one error type regardless of provider.
 */

import { SendMessageError } from '../send-message-error'
import { EvolutionApiError } from '../evolution-errors'
import * as evolutionApi from './evolution-api'
import { phoneToJid } from '../evolution-jid'
import type {
  WhatsAppProviderClient,
  SendTextArgs,
  SendMediaArgs,
  SendReactionArgs,
  ProviderSendResult,
} from '../provider'

export interface EvolutionProviderConfig {
  instanceName: string
}

function toSendMessageError(err: unknown): SendMessageError {
  if (err instanceof EvolutionApiError) {
    return new SendMessageError(err.code.toLowerCase(), err.message, err.status)
  }
  const message = err instanceof Error ? err.message : 'Unknown Evolution API error'
  return new SendMessageError('message_send_failed', message, 502)
}

export function createEvolutionProviderClient(
  config: EvolutionProviderConfig
): WhatsAppProviderClient {
  const { instanceName } = config

  return {
    name: 'evolution',

    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      try {
        const result = await evolutionApi.sendText({
          instanceName,
          to: args.to,
          text: args.text,
          quotedMessageId: args.contextMessageId,
        })
        return { providerMessageId: result.providerMessageId }
      } catch (err) {
        throw toSendMessageError(err)
      }
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      try {
        const result = await evolutionApi.sendMedia({
          instanceName,
          to: args.to,
          kind: args.kind,
          mediaUrl: args.link,
          caption: args.caption,
          filename: args.filename,
          quotedMessageId: args.contextMessageId,
        })
        return { providerMessageId: result.providerMessageId }
      } catch (err) {
        throw toSendMessageError(err)
      }
    },

    async sendReaction(args: SendReactionArgs): Promise<void> {
      try {
        await evolutionApi.sendReaction({
          instanceName,
          // `to` is the contact's number everywhere in this interface;
          // reactions are the one call that needs it as a JID.
          remoteJid: phoneToJid(args.to),
          messageId: args.targetMessageId,
          fromMe: args.fromMe,
          emoji: args.emoji,
        })
      } catch (err) {
        throw toSendMessageError(err)
      }
    },

    // sendTemplate / sendInteractiveButtons / sendInteractiveList are
    // intentionally omitted — Evolution/Baileys has no template
    // approval workflow and no native interactive message type.
    // send-message.ts checks for their presence before dispatch and
    // rejects with `unsupported_message_type_for_provider` instead of
    // calling an undefined method.
  }
}
