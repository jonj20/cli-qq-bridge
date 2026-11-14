// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import type {
  ChannelAttachment,
  ChannelAttachmentKind,
  ChannelInboundMessage,
  ChannelOutputKind,
} from "../../core/channel-types.ts";
import type { ChannelSendKind } from "../../core/channel-types.ts";

export type QqChatType = "c2c" | "group" | "channel";

export type QqInboundAttachmentDescriptor = {
  kind: ChannelAttachmentKind;
  url: string;
  fileName?: string;
  sizeBytes?: number;
  mimeType?: string;
};

export type QqMessageAuthor = {
  id: string;
  username?: string;
  member_openid?: string;
};

export type QqMessageAttachment = {
  url_type?: number;
  url?: string;
  filename?: string;
  name?: string;
  size?: number;
  content_type?: string;
};

export type QqGatewayMessage = {
  id: string;
  timestamp?: string;
  guild_id?: string;
  channel_id?: string;
  group_openid?: string;
  group_id?: string;
  author: QqMessageAuthor;
  member?: { nick?: string };
  content?: string;
  msg_type?: number;
  attachments?: QqMessageAttachment[];
  message_reference?: {
    message_id?: string;
  };
};

export type ParsedQqInboundMessage = {
  id: string;
  senderId: string;
  conversationId: string;
  recipientId: string;
  chatType: QqChatType;
  text: string;
  createdAt: string;
  attachments: QqInboundAttachmentDescriptor[];
};

function inferAttachmentKind(
  fileName?: string,
  mimeType?: string,
): ChannelAttachmentKind {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "voice";
  const ext = fileName
    ? `.${(fileName.split(".").pop() ?? "").toLowerCase()}`
    : "";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".mov", ".webm", ".avi", ".mkv"].includes(ext)) {
    return "video";
  }
  if ([".ogg", ".oga", ".mp3", ".m4a", ".opus", ".wav", ".amr"].includes(ext)) {
    return "voice";
  }
  return "file";
}

export function parseQqInboundEvent(
  eventName: string,
  msg: QqGatewayMessage,
): ParsedQqInboundMessage | null {
  if (!msg || typeof msg.id !== "string" || !msg.id.trim()) {
    return null;
  }
  const senderId = String(msg.author?.id ?? "").trim();
  if (!senderId) {
    return null;
  }

  const groupOpenid = String(
    msg.group_openid ?? msg.group_id ?? "",
  ).trim();
  const channelId = String(msg.channel_id ?? "").trim();

  let chatType: QqChatType = "c2c";
  let conversationId = senderId;
  let recipientId = senderId;

  if (groupOpenid) {
    chatType = "group";
    conversationId = groupOpenid;
    recipientId = groupOpenid;
  } else if (
    channelId &&
    (eventName === "MESSAGE_CREATE" ||
      eventName === "GUILD_MESSAGE_CREATE" ||
      eventName === "AT_MESSAGE_CREATE")
  ) {
    chatType = "channel";
    conversationId = channelId;
    recipientId = channelId;
  } else if (
    eventName === "GROUP_AT_MESSAGE_CREATE" ||
    eventName === "GROUP_MESSAGE_CREATE"
  ) {
    chatType = "group";
    conversationId = senderId;
    recipientId = senderId;
  }

  const attachments: QqInboundAttachmentDescriptor[] = [];
  for (const att of msg.attachments ?? []) {
    const url = String(att.url ?? "").trim();
    if (!url) {
      continue;
    }
    const fileName = String(att.filename ?? att.name ?? "").trim() || undefined;
    const mimeType =
      String(att.content_type ?? "").trim() || undefined;
    attachments.push({
      kind: inferAttachmentKind(fileName, mimeType),
      url,
      ...(fileName ? { fileName } : {}),
      ...(typeof att.size === "number" && att.size > 0
        ? { sizeBytes: att.size }
        : {}),
      ...(mimeType ? { mimeType } : {}),
    });
  }

  return {
    id: msg.id.trim(),
    senderId,
    conversationId,
    recipientId,
    chatType,
    text: typeof msg.content === "string" ? msg.content : "",
    createdAt:
      typeof msg.timestamp === "string" && msg.timestamp.trim()
        ? msg.timestamp
        : new Date().toISOString(),
    attachments,
  };
}

export function toQqChannelInboundMessage(
  parsed: ParsedQqInboundMessage,
  attachments: ChannelAttachment[],
  accountId?: string,
): ChannelInboundMessage {
  return {
    id: parsed.id,
    conversation: {
      channelId: "qq",
      ...(accountId ? { accountId } : {}),
      conversationId: parsed.conversationId,
      recipientId: parsed.recipientId,
      metadata: {
        chatType: parsed.chatType,
        messageId: parsed.id,
      },
    },
    senderId: parsed.senderId,
    text: parsed.text,
    attachments,
    createdAt: parsed.createdAt,
    metadata: {
      chatType: parsed.chatType,
    },
  };
}

export function buildQqInboundPrompt(
  text: string,
  attachments: Array<{
    kind: string;
    path: string;
    fileName?: string;
    sizeBytes?: number;
  }> = [],
): string {
  const normalizedText = text.trim();
  if (attachments.length === 0) {
    return normalizedText;
  }
  const lines = [
    "[QQ inbound attachments — ACTION REQUIRED]",
    "Use the local attachment paths below when the user asks you to inspect or process them.",
  ];
  attachments.forEach((attachment, index) => {
    const metadata = [
      `kind=${attachment.kind}`,
      attachment.fileName ? `name=${attachment.fileName}` : "",
      typeof attachment.sizeBytes === "number"
        ? `bytes=${attachment.sizeBytes}`
        : "",
    ].filter(Boolean);
    lines.push(`${index + 1}. ${metadata.join(" ")} path=${attachment.path}`);
  });
  return [normalizedText || "Received QQ attachment(s).", lines.join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

/** QQ displays plain text and uses qq-* launcher names in notices. */
export function formatQqVisibleText(text: string): string {
  return text
    .replace(/\bWeChat\b/g, "QQ")
    .replace(/\bwechat-(codex|claude|opencode|pi|daemon|setup)\b/g, "qq-$1");
}

export function toQqOutputKind(context: ChannelSendKind): ChannelOutputKind {
  const known = new Set<ChannelOutputKind>([
    "status",
    "notice",
    "thinking",
    "final_reply",
    "approval_required",
    "user_input_required",
    "mirrored_input",
    "task_failed",
    "fatal_error",
  ]);
  return known.has(context as ChannelOutputKind)
    ? (context as ChannelOutputKind)
    : context === "mirrored_user_input"
      ? "mirrored_input"
      : "notice";
}