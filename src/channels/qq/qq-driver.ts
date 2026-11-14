// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { t } from "../../i18n/index.ts";
import type {
  ChannelAttachment,
  ChannelConversationRef,
  ChannelSendKind,
} from "../../core/channel-types.ts";
import type {
  ChannelDriver,
  ChannelDriverInboundHandlers,
  ChannelSendResult,
} from "../../core/channel-driver.ts";
import { truncatePreview } from "../../core/text-utils.ts";
import {
  buildQqInboundPrompt,
  formatQqVisibleText,
  toQqOutputKind,
} from "./qq-message.ts";
import type { QqTransport } from "./qq-transport.ts";

export type QqChannelDriverOptions = {
  transport: QqTransport;
  accountId?: string;
  operatorId: string;
  logError: (message: string) => void;
};

/** ChannelDriver over the QQ Open Platform WebSocket gateway. */
export class QqChannelDriver implements ChannelDriver {
  readonly id = "qq";
  readonly displayName = "QQ";
  get operatorDescription(): string {
    return t("operator.qq");
  }
  readonly capabilities = {
    streamingReplies: false,
    outboundAttachments: true,
    multiConversation: true,
    pushInbound: true,
  } as const;

  private readonly transport: QqTransport;
  private readonly accountId?: string;
  private readonly operatorId: string;
  private readonly logError: (message: string) => void;

  constructor(options: QqChannelDriverOptions) {
    this.transport = options.transport;
    this.accountId = options.accountId;
    this.operatorId = options.operatorId;
    this.logError = options.logError;
  }

  defaultConversation(): ChannelConversationRef {
    return this.directConversation(this.operatorId);
  }

  directConversation(senderId: string): ChannelConversationRef {
    return {
      channelId: "qq",
      ...(this.accountId ? { accountId: this.accountId } : {}),
      conversationId: senderId,
      recipientId: senderId,
      metadata: { chatType: "c2c" },
    };
  }

  start(handlers: ChannelDriverInboundHandlers): Promise<void> {
    return this.transport.start({
      onMessage: (msg) => handlers.onInboundMessage(msg),
      onUnauthorized: handlers.onUnauthorizedSender
        ? (senderId, chatType) => handlers.onUnauthorizedSender!(senderId, chatType)
        : undefined,
      onFatal: handlers.onChannelFatal
        ? (error) => handlers.onChannelFatal!(error)
        : undefined,
      onConnected: handlers.onChannelConnected
        ? () => handlers.onChannelConnected!()
        : undefined,
    });
  }

  async waitUntilReady(): Promise<void> {
    await Promise.resolve();
  }

  async sendText(params: {
    target: ChannelConversationRef;
    text: string;
    context: ChannelSendKind;
    log: (entry: string) => void;
  }): Promise<ChannelSendResult> {
    const { target, text, context, log } = params;
    const recipientId = target.recipientId;
    const startedAtMs = Date.now();
    log(
      `qq_send_started: context=${context} recipient=${recipientId} chars=${Array.from(text).length}`,
    );
    try {
      const sent = await this.transport.sendText(
        target,
        formatQqVisibleText(text),
        toQqOutputKind(context),
      );
      if (!sent) {
        const error = new Error("QQ send returned false");
        log(
          `qq_send_failed: context=${context} recipient=${recipientId} error=${truncatePreview(error.message, 400)}`,
        );
        return { status: "failed", error, target };
      }
      log(
        `qq_send_completed: context=${context} recipient=${recipientId} elapsed_ms=${Date.now() - startedAtMs}`,
      );
      return { status: "sent" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logError(`Failed to send QQ ${context}: ${message}`);
      log(
        `qq_send_failed: context=${context} recipient=${recipientId} error=${truncatePreview(message, 400)}`,
      );
      return {
        status: "failed",
        error,
        target,
      };
    }
  }

  buildInboundPrompt(text: string, attachments: ChannelAttachment[]): string {
    return buildQqInboundPrompt(text, attachments);
  }

  formatVisibleText(text: string): string {
    return formatQqVisibleText(text);
  }
}