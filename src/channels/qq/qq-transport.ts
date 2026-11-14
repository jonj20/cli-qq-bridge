// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

import type {
  ChannelAttachment,
  ChannelConversationRef,
} from "../../core/channel-types.ts";
import { tryClaimChannelInboundMessage } from "../../core/inbound-message-claims.ts";
import { truncatePreview } from "../../core/text-utils.ts";
import {
  QQ_INBOUND_ATTACHMENTS_DIR,
  QQ_INBOUND_MESSAGE_CLAIMS_DIR,
} from "./qq-config.ts";
import {
  parseQqInboundEvent,
  toQqChannelInboundMessage,
  type QqChatType,
  type QqGatewayMessage,
  type QqInboundAttachmentDescriptor,
} from "./qq-message.ts";

export const QQ_GATEWAY_URL = "wss://api.sgroup.qq.com/websocket";
export const QQ_API_BASE = "https://api.sgroup.qq.com";
export const QQ_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
export const QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQ_TEXT_CHUNK_CHARS = 2_000;
export const QQ_DEFAULT_HEARTBEAT_MS = 30_000;
export const QQ_DEFAULT_INTENTS = (1 << 0) | (1 << 12) | (1 << 25);

export const QQ_OP_DISPATCH = 0;
export const QQ_OP_HEARTBEAT = 1;
export const QQ_OP_IDENTIFY = 2;
export const QQ_OP_RESUME = 6;
export const QQ_OP_RECONNECT = 7;
export const QQ_OP_INVALID_SESSION = 9;
export const QQ_OP_HELLO = 10;
export const QQ_OP_HEARTBEAT_ACK = 11;

export const QQ_MESSAGE_EVENTS = new Set<string>([
  "MESSAGE_CREATE",
  "GUILD_MESSAGE_CREATE",
  "AT_MESSAGE_CREATE",
  "DIRECT_MESSAGE_CREATE",
  "C2C_MESSAGE_CREATE",
  "GROUP_AT_MESSAGE_CREATE",
  "GROUP_MESSAGE_CREATE",
]);

export type QqGatewayFrame = {
  op?: number;
  s?: number;
  t?: string;
  d?: unknown;
};

export type QqTransportLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type QqTransportHandlers = {
  onMessage: (message: ReturnType<typeof toQqChannelInboundMessage>) => Promise<void>;
  onUnauthorized?: (senderId: string, chatType: QqChatType) => Promise<void>;
  onFatal?: (error: Error) => Promise<void>;
  onConnected?: () => Promise<void>;
};

export type QqTransportOptions = {
  appId: string;
  appSecret: string;
  sandbox?: boolean;
  allowedUsers: string[];
  operatorOpenid: string;
  accountId?: string;
  intents?: number;
  logger?: QqTransportLogger;
  fetchImpl?: typeof fetch;
  wsCtor?: typeof WebSocket;
  claimsDir?: string;
  attachmentsDir?: string;
  downloadInboundAttachments?: boolean;
};

type TokenInfo = {
  access_token: string;
  expires_in?: number;
};

function splitText(text: string, maxChars = QQ_TEXT_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let current = "";
  for (const character of text) {
    if (current && current.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

export class QqTransport {
  private readonly options: QqTransportOptions;
  private readonly logger: QqTransportLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly claimsDir: string;
  private readonly attachmentsDir: string;
  private readonly downloadAttachments: boolean;
  private readonly intents: number;

  private ws: WebSocket | null = null;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private handlers: QqTransportHandlers | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAckTimer: ReturnType<typeof setTimeout> | null = null;
  private seq: number | null = null;
  private session: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private identified = false;
  private shuttingDown = false;

  constructor(options: QqTransportOptions) {
    this.options = options;
    this.logger = options.logger ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketCtor = options.wsCtor ?? WebSocket;
    this.claimsDir = options.claimsDir ?? QQ_INBOUND_MESSAGE_CLAIMS_DIR;
    this.attachmentsDir = options.attachmentsDir ?? QQ_INBOUND_ATTACHMENTS_DIR;
    this.downloadAttachments = options.downloadInboundAttachments !== false;
    this.intents = options.intents ?? QQ_DEFAULT_INTENTS;
  }

  private log(message: string): void {
    this.logger.log?.(`[qq] ${message}`);
  }

  private logError(message: string): void {
    this.logger.error?.(`[qq] ${message}`);
  }

  private apiBase(): string {
    return this.options.sandbox
      ? QQ_SANDBOX_API_BASE
      : QQ_API_BASE;
  }

  async fetchToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const body = JSON.stringify({
      appId: this.options.appId,
      clientSecret: this.options.appSecret,
    });

    const res = await this.fetchImpl(QQ_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QQ token failed HTTP ${res.status}: ${text}`);
    }

    const json = (await res.json()) as unknown as TokenInfo;
    if (!json.access_token) {
      throw new Error(
        `QQ token response missing access_token: ${JSON.stringify(json)}`,
      );
    }

    this.token = json.access_token;
    this.tokenExpiresAt = now + (json.expires_in ?? 7200) * 1000;
    return this.token;
  }

  private apiHeaders(): Record<string, string> {
    return {
      Authorization: `QQBot ${this.token ?? ""}`,
      "Content-Type": "application/json",
    };
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `QQBot ${this.token ?? ""}`,
    };
  }

  setHandlers(handlers: QqTransportHandlers): void {
    this.handlers = handlers;
  }

  get isConnected(): boolean {
    return (
      this.ws !== null &&
      this.ws.readyState === this.WebSocketCtor.OPEN &&
      this.identified
    );
  }

  async start(handlers: QqTransportHandlers): Promise<void> {
    this.handlers = handlers;
    this.shuttingDown = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.stopReconnect();

    try {
      await this.fetchToken();
    } catch (err) {
      this.logError(
        `Failed to fetch QQ access token: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect(5_000);
      return;
    }

    try {
      this.ws = new this.WebSocketCtor(`${QQ_GATEWAY_URL}?v=2`);
    } catch (err) {
      this.logError(
        `Failed to open QQ gateway websocket: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleReconnect(5_000);
      return;
    }

    this.ws.onopen = () => {
      this.log("QQ gateway websocket connected, waiting for HELLO");
      this.identified = false;
    };

    this.ws.onmessage = (event) => {
      if (this.shuttingDown) {
        return;
      }
      try {
        const raw =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBufferLike).toString("utf-8");
        const frame = JSON.parse(raw) as QqGatewayFrame;
        if (typeof frame.s === "number" && frame.s > 0) {
          this.seq = frame.s;
        }
        void this.handleFrame(frame);
      } catch (err) {
        this.logError(
          `QQ gateway message parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    this.ws.onerror = (err) => {
      this.logError(
        `QQ gateway error: ${err instanceof Error ? err.message : String(err)}`,
      );
    };

    this.ws.onclose = () => {
      this.log("QQ gateway closed");
      this.identified = false;
      this.stopHeartbeat();
      if (!this.shuttingDown) {
        this.scheduleReconnect(3_000);
      }
    };
  }

  private async handleFrame(frame: QqGatewayFrame): Promise<void> {
    const op = Number(frame.op);
    switch (op) {
      case QQ_OP_HELLO: {
        if (this.identified) {
          return;
        }
        const helloData =
          frame.d && typeof frame.d === "object"
            ? (frame.d as { heartbeat_interval?: number })
            : {};
        const intervalMs =
          typeof helloData.heartbeat_interval === "number" &&
          helloData.heartbeat_interval > 0
            ? helloData.heartbeat_interval
            : QQ_DEFAULT_HEARTBEAT_MS;
        await this.sendIdentifyOrResume();
        this.scheduleHeartbeat(intervalMs);
        return;
      }
      case QQ_OP_HEARTBEAT: {
        await this.sendHeartbeat();
        return;
      }
      case QQ_OP_HEARTBEAT_ACK: {
        this.clearHeartbeatAckWatchdog();
        return;
      }
      case QQ_OP_RECONNECT: {
        this.log("QQ gateway requested reconnect (op 7)");
        this.reconnectNow();
        return;
      }
      case QQ_OP_INVALID_SESSION: {
        const canResume = frame.d === true;
        this.log(`QQ gateway invalid session (op 9), canResume=${canResume}`);
        if (!canResume) {
          this.session = null;
        }
        this.identified = false;
        this.reconnectNow();
        return;
      }
      case QQ_OP_DISPATCH: {
        const event = typeof frame.t === "string" ? frame.t : "";
        if (event === "READY" && frame.d) {
          const ready = frame.d as { session_id?: string; version?: string };
          this.session =
            typeof ready.session_id === "string" && ready.session_id.trim()
              ? ready.session_id
              : null;
          this.identified = true;
          this.log(`QQ gateway READY, session=${this.session}`);
          await this.handlers?.onConnected?.();
          return;
        }
        if (event === "RESUMED") {
          this.log("QQ gateway session RESUMED");
          this.identified = true;
          await this.handlers?.onConnected?.();
          return;
        }
        if (QQ_MESSAGE_EVENTS.has(event) && frame.d) {
          await this.handleMessage(event, frame.d as QqGatewayMessage);
        }
        return;
      }
      default:
        return;
    }
  }

  private async sendIdentifyOrResume(): Promise<void> {
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) {
      return;
    }
    if (this.session && this.seq !== null) {
      const resumePayload = JSON.stringify({
        op: QQ_OP_RESUME,
        d: {
          token: `QQBot ${this.token ?? ""}`,
          session_id: this.session,
          seq: this.seq,
        },
      });
      this.ws.send(resumePayload);
      this.log("Sent QQ gateway RESUME (op 6)");
      return;
    }
    const identifyPayload = JSON.stringify({
      op: QQ_OP_IDENTIFY,
      d: {
        token: `QQBot ${this.token ?? ""}`,
        intents: this.intents,
        shard: [0, 1],
        properties: {},
      },
    });
    this.ws.send(identifyPayload);
    this.log(`Sent QQ gateway IDENTIFY (op 2) with intents=${this.intents}`);
  }

  private reconnectNow(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Best effort close
      }
      this.ws = null;
    }
    if (!this.shuttingDown) {
      this.scheduleReconnect(1_000);
    }
  }

  private scheduleReconnect(delayMs: number): void {
    this.stopReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    const safeInterval = Math.max(5_000, Math.floor(intervalMs * 0.85));
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      void this.sendHeartbeat();
    }, safeInterval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    this.clearHeartbeatAckWatchdog();
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearHeartbeatAckWatchdog(): void {
    if (this.heartbeatAckTimer) {
      clearTimeout(this.heartbeatAckTimer);
      this.heartbeatAckTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.ws || this.ws.readyState !== this.WebSocketCtor.OPEN) {
      return;
    }
    const payload = JSON.stringify({
      op: QQ_OP_HEARTBEAT,
      d: this.seq,
    });
    try {
      this.ws.send(payload);
      this.clearHeartbeatAckWatchdog();
      this.heartbeatAckTimer = setTimeout(() => {
        this.heartbeatAckTimer = null;
        this.logError("QQ gateway heartbeat ACK timed out, reconnecting");
        this.reconnectNow();
      }, 10_000);
      this.heartbeatAckTimer.unref?.();
    } catch (err) {
      this.logError(
        `QQ heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.scheduleHeartbeat(QQ_DEFAULT_HEARTBEAT_MS);
    }
  }

  private async handleMessage(
    eventName: string,
    msg: QqGatewayMessage,
  ): Promise<void> {
    if (!this.handlers) {
      return;
    }

    const parsed = parseQqInboundEvent(eventName, msg);
    if (!parsed) {
      return;
    }

    if (parsed.text.length === 0 && parsed.attachments.length === 0) {
      return;
    }

    const senderId = parsed.senderId;
    if (
      this.options.allowedUsers.length > 0 &&
      !this.options.allowedUsers.includes(senderId)
    ) {
      this.log(`QQ unauthorized sender ignored sender=${senderId}`);
      await this.handlers.onUnauthorized?.(senderId, parsed.chatType);
      return;
    }

    const claimKey = `qq:${parsed.id}`;
    const claimed = tryClaimChannelInboundMessage(claimKey, {
      claimsDir: this.claimsDir,
    });
    if (!claimed) {
      this.log(`QQ duplicate message ignored msgId=${parsed.id}`);
      return;
    }

    const attachments = await this.resolveInboundAttachments(parsed.attachments);
    const message = toQqChannelInboundMessage(
      parsed,
      attachments,
      this.options.accountId ?? this.options.appId,
    );

    this.log(
      `QQ inbound event=${eventName} msgId=${parsed.id} sender=${senderId} chatType=${parsed.chatType} text=${truncatePreview(parsed.text)}`,
    );
    await this.handlers.onMessage(message);
  }

  private async resolveInboundAttachments(
    descriptors: QqInboundAttachmentDescriptor[],
  ): Promise<ChannelAttachment[]> {
    const resolved: ChannelAttachment[] = [];
    for (const att of descriptors) {
      if (!this.downloadAttachments || !/^https?:\/\//i.test(att.url)) {
        resolved.push({
          kind: att.kind,
          path: att.url,
          ...(att.fileName ? { fileName: att.fileName } : {}),
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
          ...(typeof att.sizeBytes === "number" ? { sizeBytes: att.sizeBytes } : {}),
        });
        continue;
      }
      try {
        const filePath = await this.downloadInboundAttachment(att);
        const sizeBytes = fs.statSync(filePath).size;
        resolved.push({
          kind: att.kind,
          path: filePath,
          ...(att.fileName ? { fileName: att.fileName } : {}),
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
          sizeBytes,
        });
      } catch (error) {
        this.logError(
          `qq_attachment_download_failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        resolved.push({
          kind: att.kind,
          path: att.url,
          ...(att.fileName ? { fileName: att.fileName } : {}),
          ...(att.mimeType ? { mimeType: att.mimeType } : {}),
          ...(typeof att.sizeBytes === "number" ? { sizeBytes: att.sizeBytes } : {}),
        });
      }
    }
    return resolved;
  }

  private async downloadInboundAttachment(
    att: QqInboundAttachmentDescriptor,
  ): Promise<string> {
    const res = await this.fetchImpl(att.url);
    if (!res.ok) {
      throw new Error(`QQ attachment download failed HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const dateDir = path.join(
      this.attachmentsDir,
      new Date().toISOString().slice(0, 10),
    );
    fs.mkdirSync(dateDir, { recursive: true });
    const rawName =
      att.fileName || `qq-attachment-${Date.now().toString(36)}`;
    const safeName = rawName.replace(/[/\\]/g, "_") || "attachment";
    const target = path.join(dateDir, `${Date.now().toString(36)}-${safeName}`);
    fs.writeFileSync(target, buffer);
    return target;
  }

  private resolveTargetKind(target: ChannelConversationRef): {
    chatType: QqChatType;
    id: string;
  } {
    const chatTypeRaw = target.metadata?.chatType ?? target.metadata?.targetType;
    const id = String(
      target.recipientId || target.conversationId || "",
    ).trim();
    if (chatTypeRaw === "group") {
      return { chatType: "group", id };
    }
    if (chatTypeRaw === "channel") {
      return { chatType: "channel", id };
    }
    return { chatType: "c2c", id };
  }

  private resolveMessagesUrl(target: ChannelConversationRef): string {
    const { chatType, id } = this.resolveTargetKind(target);
    const encoded = encodeURIComponent(id);
    if (chatType === "group") {
      return `${this.apiBase()}/v2/groups/${encoded}/messages`;
    }
    if (chatType === "channel") {
      return `${this.apiBase()}/channels/${encoded}/messages`;
    }
    return `${this.apiBase()}/v2/users/${encoded}/messages`;
  }

  private resolveFilesUrl(target: ChannelConversationRef): string {
    const { chatType, id } = this.resolveTargetKind(target);
    const encoded = encodeURIComponent(id);
    if (chatType === "group") {
      return `${this.apiBase()}/v2/groups/${encoded}/files`;
    }
    if (chatType === "channel") {
      return `${this.apiBase()}/channels/${encoded}/files`;
    }
    return `${this.apiBase()}/v2/users/${encoded}/files`;
  }

  private async postJson(
    url: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.apiHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`QQ API POST ${url} failed HTTP ${res.status}: ${errText}`);
    }
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: number };
        if (typeof parsed.code === "number" && parsed.code !== 0 && parsed.message) {
          throw new Error(`QQ API error ${parsed.code}: ${parsed.message}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("QQ API error")) {
          throw err;
        }
      }
    }
  }

  async sendText(
    target: ChannelConversationRef,
    text: string,
    _kind: string,
  ): Promise<boolean> {
    await this.fetchToken();
    const url = this.resolveMessagesUrl(target);
    const chunks = splitText(text, QQ_TEXT_CHUNK_CHARS);
    const baseSeq = Math.floor(Date.now() / 1000) % 1_000_000;
    let index = 0;
    for (const chunk of chunks) {
      if (!chunk) {
        continue;
      }
      index += 1;
      const payload: Record<string, unknown> = {
        msg_type: 0,
        content: chunk,
        msg_seq: baseSeq * 10 + index,
      };
      await this.postJson(url, payload);
    }
    return true;
  }

  async sendAttachment(
    target: ChannelConversationRef,
    attachment: ChannelAttachment,
  ): Promise<void> {
    await this.fetchToken();
    const buffer = await fs.promises.readFile(attachment.path);
    const fileName =
      attachment.fileName || path.basename(attachment.path) || "attachment";
    const fileType =
      attachment.kind === "file"
        ? 4
        : attachment.kind === "voice"
          ? 2
          : attachment.kind === "video"
            ? 3
            : 1;
    const mimeType =
      attachment.mimeType || "application/octet-stream";
    const { chatType } = this.resolveTargetKind(target);

    let fileUuid = "";
    try {
      const form = new FormData();
      form.append("file_type", String(fileType));
      form.append("filename", fileName);
      form.append(
        "file_data",
        new Blob([new Uint8Array(buffer)], { type: mimeType }),
        fileName,
      );
      if (chatType === "c2c" || chatType === "group") {
        form.append("srv_send_msg", "false");
      }
      const uploadRes = await this.fetchImpl(this.resolveFilesUrl(target), {
        method: "POST",
        headers: this.authHeaders(),
        body: form,
      });
      if (uploadRes.ok) {
        const uploadJson = (await uploadRes.json().catch(() => null)) as {
          file_uuid?: string;
          file_info?: string;
          uuid?: string;
        } | null;
        fileUuid = String(
          uploadJson?.file_uuid ?? uploadJson?.file_info ?? uploadJson?.uuid ?? "",
        ).trim();
      } else {
        const errText = await uploadRes.text().catch(() => "");
        this.logError(
          `QQ upload file failed HTTP ${uploadRes.status}: ${truncatePreview(errText, 200)}`,
        );
      }
    } catch (err) {
      this.logError(
        `QQ upload file error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!fileUuid) {
      await this.sendText(
        target,
        `无法上传 QQ 附件 ${fileName}（${attachment.kind}），本地路径：${attachment.path}`,
        "final_reply",
      );
      return;
    }

    const msgType =
      attachment.kind === "image"
        ? 2
        : attachment.kind === "video"
          ? 3
          : attachment.kind === "voice"
            ? 4
            : 7;
    const payload: Record<string, unknown> = {
      msg_type: msgType,
      media: { file_info: fileUuid },
      msg_seq: Math.floor(Date.now() / 1000) % 1_000_000,
    };
    if (msgType === 2) {
      payload.payload = { key: fileUuid };
    } else if (msgType === 7 && (chatType === "c2c" || chatType === "group")) {
      payload.file_image = { url: "" };
    }
    await this.postJson(this.resolveMessagesUrl(target), payload);
    this.log(
      `QQ attachment sent kind=${attachment.kind} file=${fileName} msgType=${msgType}`,
    );
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.stopHeartbeat();
    this.stopReconnect();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Best effort close
      }
      this.ws = null;
    }
  }
}

export type {
  ParsedQqInboundMessage,
  QqGatewayMessage,
  QqInboundAttachmentDescriptor,
} from "./qq-message.ts";