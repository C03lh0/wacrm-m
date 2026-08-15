/**
 * Meta Cloud API provider adapter — a thin wrapper around meta-api.ts
 * that satisfies WhatsAppProviderClient. Contains zero business logic
 * of its own; every call forwards straight through to the existing,
 * unmodified meta-api.ts functions with the same arguments send-message.ts
 * passed them before this abstraction existed.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
} from '../meta-api'
import type {
  WhatsAppProviderClient,
  SendTextArgs,
  SendMediaArgs,
  SendTemplateArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
  ProviderSendResult,
} from '../provider'

export interface MetaProviderConfig {
  phoneNumberId: string
  accessToken: string
}

export function createMetaProviderClient(
  config: MetaProviderConfig
): WhatsAppProviderClient {
  const { phoneNumberId, accessToken } = config

  return {
    name: 'meta',

    async sendText(args: SendTextArgs): Promise<ProviderSendResult> {
      const result = await sendTextMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        text: args.text,
        contextMessageId: args.contextMessageId,
      })
      return { providerMessageId: result.messageId }
    },

    async sendMedia(args: SendMediaArgs): Promise<ProviderSendResult> {
      const result = await sendMediaMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        kind: args.kind,
        link: args.link,
        caption: args.caption,
        filename: args.filename,
        contextMessageId: args.contextMessageId,
      })
      return { providerMessageId: result.messageId }
    },

    async sendTemplate(args: SendTemplateArgs): Promise<ProviderSendResult> {
      const result = await sendTemplateMessage({
        phoneNumberId,
        accessToken,
        to: args.to,
        templateName: args.templateName,
        language: args.language,
        params: args.params,
        template: args.template,
        messageParams: args.messageParams,
        contextMessageId: args.contextMessageId,
      })
      return { providerMessageId: result.messageId }
    },

    async sendInteractiveButtons(
      args: SendInteractiveButtonsArgs
    ): Promise<ProviderSendResult> {
      const result = await metaSendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: args.to,
        bodyText: args.bodyText,
        headerText: args.headerText,
        footerText: args.footerText,
        buttons: args.buttons,
        contextMessageId: args.contextMessageId,
      })
      return { providerMessageId: result.messageId }
    },

    async sendInteractiveList(
      args: SendInteractiveListArgs
    ): Promise<ProviderSendResult> {
      const result = await metaSendInteractiveList({
        phoneNumberId,
        accessToken,
        to: args.to,
        bodyText: args.bodyText,
        buttonLabel: args.buttonLabel,
        headerText: args.headerText,
        footerText: args.footerText,
        sections: args.sections,
        contextMessageId: args.contextMessageId,
      })
      return { providerMessageId: result.messageId }
    },
  }
}
