// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type { BridgeAdapterKind } from "../../bridge/bridge-types.ts";
import { forwardWecomFinalReply } from "../wecom/bridge-final-reply.ts";
import type {
  BridgeChannelPort,
  ChannelAttachment,
  ChannelConversationRef,
  ChannelOutput,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import { formatQqVisibleText } from "./qq-message.ts";
import type { QqTransport } from "./qq-transport.ts";

export type QqChannelPortDependencies = {
  transport: Pick<QqTransport, "sendText" | "sendAttachment">;
  sendText?: (
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ) => Promise<boolean>;
  sendAttachment?: (
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ) => Promise<void>;
  prefixText?: (adapter: BridgeAdapterKind | undefined, text: string) => string;
  onEmptyVisibleReply?: (adapter: BridgeAdapterKind | undefined, rawText: string) => void;
  onTextSent?: (adapter: BridgeAdapterKind | undefined, text: string) => void;
};

export class QqChannelPort implements BridgeChannelPort {
  readonly channelId = "qq";
  private readonly deps: QqChannelPortDependencies;

  constructor(deps: QqChannelPortDependencies) {
    this.deps = deps;
  }

  private sendText(
    target: ChannelConversationRef,
    text: string,
    kind: ChannelOutputKind,
  ): Promise<boolean> {
    return (
      this.deps.sendText?.(target, text, kind) ??
      this.deps.transport.sendText(target, text, kind)
    );
  }

  private sendAttachment(
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ): Promise<void> {
    return (
      this.deps.sendAttachment?.(target, attachment) ??
      this.deps.transport.sendAttachment(target, attachment)
    );
  }

  async send(output: ChannelOutput): Promise<boolean> {
    if (output.target.channelId !== this.channelId) {
      throw new Error(`QQ channel cannot send to ${output.target.channelId}.`);
    }
    const prefixText = (text: string) =>
      formatQqVisibleText(
        this.deps.prefixText?.(output.adapter, text) ?? text,
      );

    if (output.kind === "final_reply") {
      await forwardWecomFinalReply({
        adapter: output.adapter ?? "opencode",
        rawText: output.text ?? "",
        target: output.target,
        onEmptyVisibleReply: (rawText) => {
          this.deps.onEmptyVisibleReply?.(output.adapter, rawText);
        },
        sender: {
          sendText: async (text) => {
            const sent = await this.sendText(
              output.target,
              prefixText(text),
              "final_reply",
            );
            if (sent) {
              this.deps.onTextSent?.(output.adapter, text);
            }
            return sent;
          },
          sendAttachment: (attachment) =>
            this.sendAttachment(output.target, attachment),
        },
      });
      return true;
    }

    if (output.attachment) {
      await this.sendAttachment(output.target, output.attachment);
    }

    if (output.text?.trim()) {
      return Boolean(
        await this.sendText(
          output.target,
          prefixText(output.text),
          output.kind,
        ),
      );
    }

    return true;
  }
}