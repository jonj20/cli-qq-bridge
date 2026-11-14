// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadQqAccount,
  normalizeStoredQqAccount,
  resolveQqAccount,
  saveQqAccount,
  type StoredQqAccount,
} from "../../src/channels/qq/qq-config.ts";
import {
  buildConnectUrl,
  createBindTask,
  decryptBotSecret,
  generateBindKey,
  pollBindResult,
  QqBindStatus,
} from "../../src/channels/qq/qq-bind.ts";
import {
  buildQqInboundPrompt,
  formatQqVisibleText,
  parseQqInboundEvent,
  toQqChannelInboundMessage,
  toQqOutputKind,
} from "../../src/channels/qq/qq-message.ts";
import {
  QQ_OP_DISPATCH,
  QQ_OP_HEARTBEAT,
  QQ_OP_HELLO,
  QQ_OP_IDENTIFY,
  QqTransport,
} from "../../src/channels/qq/qq-transport.ts";
import {
  createQqPairingCode,
  formatQqSetupUsage,
  isQqPairingText,
  parseQqSetupCliArgs,
} from "../../src/channels/qq/setup.ts";
import { QqChannelDriver } from "../../src/channels/qq/qq-driver.ts";
import { QqChannelPort } from "../../src/channels/qq/qq-channel-port.ts";
import type { ChannelInboundMessage } from "../../src/core/channel-types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qq-channel-test-"));
  tempDirs.push(directory);
  return directory;
}

const account: StoredQqAccount = {
  version: 1,
  appId: "102000",
  appSecret: "secret-key",
  sandbox: false,
  allowedUsers: ["op-user-1"],
  operatorOpenid: "op-user-1",
  pairedAt: "2026-10-13T00:00:00.000Z",
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class MockQqWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockQqWebSocket[] = [];

  readyState = MockQqWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    MockQqWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === MockQqWebSocket.CLOSED) {
      return;
    }
    this.readyState = MockQqWebSocket.CLOSED;
    this.onclose?.();
  }

  emitOpen(): void {
    this.readyState = MockQqWebSocket.OPEN;
    this.onopen?.();
  }

  emitJson(payload: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("qq config", () => {
  test("round-trips a stored account and guarantees operator in allowedUsers", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "account.json");
    saveQqAccount(account, file);
    expect(loadQqAccount(file)).toEqual(account);

    const normalized = normalizeStoredQqAccount({
      ...account,
      allowedUsers: ["other-user"],
    });
    expect(normalized?.allowedUsers).toEqual(["op-user-1", "other-user"]);
  });

  test("rejects incomplete accounts", () => {
    expect(normalizeStoredQqAccount({ version: 1 } as never)).toBeNull();
    expect(
      normalizeStoredQqAccount({
        ...account,
        operatorOpenid: "  ",
      }),
    ).toBeNull();
    expect(
      normalizeStoredQqAccount({
        ...account,
        appSecret: "",
      }),
    ).toBeNull();
  });

  test("resolves from environment overrides", () => {
    const resolved = resolveQqAccount(
      {
        QQ_APP_ID: "env-app",
        QQ_APP_SECRET: "env-secret",
        QQ_OPERATOR_OPENID: "env-op",
        QQ_SANDBOX: "true",
      },
      null,
    );
    expect(resolved?.appId).toBe("env-app");
    expect(resolved?.appSecret).toBe("env-secret");
    expect(resolved?.operatorOpenid).toBe("env-op");
    expect(resolved?.sandbox).toBe(true);
    expect(resolved?.allowedUsers).toContain("env-op");
  });
});

describe("qq bind protocol", () => {
  test("builds connect URL and decrypts AES-256-GCM secret", () => {
    const key = generateBindKey();
    const url = buildConnectUrl("task-123", "cli-wechat-bridge");
    expect(url).toContain("https://q.qq.com/qqbot/openclaw/connect.html");
    expect(url).toContain("task_id=task-123");

    const rawKey = Buffer.from(key, "base64");
    const iv = crypto.randomBytes(12);
    const plaintext = "my-bot-app-secret";
    const cipher = crypto.createCipheriv("aes-256-gcm", rawKey, iv);
    const encrypted = Buffer.concat([
      iv,
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expect(decryptBotSecret(encrypted.toString("base64"), key)).toBe(plaintext);
  });

  test("createBindTask and pollBindResult handle completion and expiry", async () => {
    const key = generateBindKey();
    const rawKey = Buffer.from(key, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", rawKey, iv);
    const encryptedSecret = Buffer.concat([
      iv,
      cipher.update("secret-1", "utf-8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");

    const task = await createBindTask({
      source: "test-bridge",
      fetchImpl: (async () =>
        jsonResponse({
          retcode: 0,
          data: { task_id: "tid-99" },
        })) as typeof fetch,
    });
    expect(task.taskId).toBe("tid-99");
    expect(task.connectUrl).toContain("task_id=tid-99");

    const completed = await pollBindResult("tid-99", {
      key,
      fetchImpl: (async () =>
        jsonResponse({
          retcode: 0,
          data: {
            status: QqBindStatus.COMPLETED,
            bot_appid: "app-1",
            bot_encrypt_secret: encryptedSecret,
            user_openid: "user-1",
          },
        })) as typeof fetch,
    });
    expect(completed).toEqual({
      status: QqBindStatus.COMPLETED,
      credentials: {
        appId: "app-1",
        appSecret: "secret-1",
        userOpenid: "user-1",
      },
    });

    const expired = await pollBindResult("tid-99", {
      key,
      fetchImpl: (async () =>
        jsonResponse({
          retcode: 0,
          data: { status: QqBindStatus.EXPIRED },
        })) as typeof fetch,
    });
    expect(expired).toEqual({ status: QqBindStatus.EXPIRED });
  });
});

describe("qq message helpers", () => {
  test("parses C2C, group, and channel inbound events", () => {
    const c2c = parseQqInboundEvent("C2C_MESSAGE_CREATE", {
      id: "msg-c2c",
      author: { id: "user-a" },
      content: "hello private",
      timestamp: "2026-10-13T01:00:00Z",
    });
    expect(c2c).toEqual({
      id: "msg-c2c",
      senderId: "user-a",
      conversationId: "user-a",
      recipientId: "user-a",
      chatType: "c2c",
      text: "hello private",
      createdAt: "2026-10-13T01:00:00Z",
      attachments: [],
    });

    const group = parseQqInboundEvent("GROUP_AT_MESSAGE_CREATE", {
      id: "msg-grp",
      group_openid: "grp-1",
      author: { id: "user-b" },
      content: "hello group",
    });
    expect(group?.chatType).toBe("group");
    expect(group?.conversationId).toBe("grp-1");
    expect(group?.recipientId).toBe("grp-1");

    const channel = parseQqInboundEvent("MESSAGE_CREATE", {
      id: "msg-ch",
      channel_id: "chan-1",
      guild_id: "guild-1",
      author: { id: "user-c" },
      content: "hello channel",
    });
    expect(channel?.chatType).toBe("channel");
    expect(channel?.conversationId).toBe("chan-1");
    expect(channel?.recipientId).toBe("chan-1");
  });

  test("builds prompt, formats visible text, and maps kinds", () => {
    const prompt = buildQqInboundPrompt("check file", [
      { kind: "file", path: "/tmp/qq/a.pdf", fileName: "a.pdf", sizeBytes: 42 },
    ]);
    expect(prompt).toContain("check file");
    expect(prompt).toContain("kind=file name=a.pdf bytes=42 path=/tmp/qq/a.pdf");

    expect(formatQqVisibleText("Run wechat-opencode or WeChat bridge")).toBe(
      "Run qq-opencode or QQ bridge",
    );
    expect(toQqOutputKind("mirrored_user_input")).toBe("mirrored_input");
    expect(toQqOutputKind("status")).toBe("status");
  });
});

describe("qq transport & driver", () => {
  test("performs op 10 Hello -> op 2 Identify -> READY -> op 1 Heartbeat flow", async () => {
    const dir = makeTempDir();
    MockQqWebSocket.instances = [];
    const transport = new QqTransport({
      appId: account.appId,
      appSecret: account.appSecret,
      allowedUsers: account.allowedUsers,
      operatorOpenid: account.operatorOpenid,
      claimsDir: path.join(dir, "claims"),
      attachmentsDir: path.join(dir, "attachments"),
      fetchImpl: (async () => jsonResponse({ access_token: "tok-1", expires_in: 7200 })) as typeof fetch,
      wsCtor: MockQqWebSocket as unknown as typeof WebSocket,
    });

    const connected: boolean[] = [];
    await transport.start({
      onMessage: async () => {},
      onConnected: async () => {
        connected.push(true);
      },
    });

    const ws = MockQqWebSocket.instances[0]!;
    expect(ws.url).toBe("wss://api.sgroup.qq.com/websocket?v=2");
    ws.emitOpen();
    ws.emitJson({ op: QQ_OP_HELLO, d: { heartbeat_interval: 45000 } });

    const identify = JSON.parse(ws.sent[0]!) as {
      op: number;
      d: { token: string; intents: number };
    };
    expect(identify.op).toBe(QQ_OP_IDENTIFY);
    expect(identify.d.token).toBe("QQBot tok-1");

    ws.emitJson({ op: QQ_OP_DISPATCH, t: "READY", s: 1, d: { session_id: "sess-1" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connected).toEqual([true]);

    ws.emitJson({ op: QQ_OP_HEARTBEAT, d: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeat = JSON.parse(ws.sent[1]!) as { op: number; d: number | null };
    expect(heartbeat).toEqual({ op: QQ_OP_HEARTBEAT, d: 1 });

    await transport.stop();
  });

  test("downloads inbound attachments and routes messages to C2C and Group targets", async () => {
    const dir = makeTempDir();
    MockQqWebSocket.instances = [];
    const received: ChannelInboundMessage[] = [];
    const sentUrls: string[] = [];

    const transport = new QqTransport({
      appId: account.appId,
      appSecret: account.appSecret,
      allowedUsers: account.allowedUsers,
      operatorOpenid: account.operatorOpenid,
      claimsDir: path.join(dir, "claims"),
      attachmentsDir: path.join(dir, "attachments"),
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.sgroup.qq.com/auth") {
          return jsonResponse({ access_token: "tok-2", expires_in: 7200 });
        }
        if (url.includes("bots.qq.com")) {
          return jsonResponse({ access_token: "tok-2", expires_in: 7200 });
        }
        if (url.startsWith("https://cdn.qq.com/att.png")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
        }
        sentUrls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response("", { status: 200 });
      }) as typeof fetch,
      wsCtor: MockQqWebSocket as unknown as typeof WebSocket,
    });

    await transport.start({
      onMessage: async (msg) => {
        received.push(msg);
      },
    });
    const ws = MockQqWebSocket.instances[0]!;
    ws.emitOpen();
    ws.emitJson({
      op: QQ_OP_DISPATCH,
      t: "C2C_MESSAGE_CREATE",
      s: 2,
      d: {
        id: "in-1",
        author: { id: "op-user-1" },
        content: "see image",
        timestamp: "2026-10-13T02:00:00Z",
        attachments: [
          { url: "https://cdn.qq.com/att.png", filename: "pic.png", size: 4 },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("see image");
    expect(received[0]?.conversation.recipientId).toBe("op-user-1");
    const localPath = received[0]?.attachments[0]?.path ?? "";
    expect(localPath.startsWith(path.join(dir, "attachments"))).toBe(true);
    expect(fs.existsSync(localPath)).toBe(true);

    // Send back to C2C
    await transport.sendText(received[0]!.conversation, "reply text", "final_reply");
    expect(sentUrls.some((entry) => entry.includes("POST https://api.sgroup.qq.com/v2/users/op-user-1/messages"))).toBe(true);

    // Send to Group
    sentUrls.length = 0;
    const groupTarget = {
      channelId: "qq",
      conversationId: "grp-9",
      recipientId: "grp-9",
      metadata: { chatType: "group" },
    };
    await transport.sendText(groupTarget, "group reply", "notice");
    expect(sentUrls.some((entry) => entry.includes("POST https://api.sgroup.qq.com/v2/groups/grp-9/messages"))).toBe(true);

    await transport.stop();
  });

  test("driver and port format text and validate targets", async () => {
    const transport = new QqTransport({
      appId: account.appId,
      appSecret: account.appSecret,
      allowedUsers: account.allowedUsers,
      operatorOpenid: account.operatorOpenid,
      fetchImpl: (async () => jsonResponse({ access_token: "tok" })) as typeof fetch,
    });
    const driver = new QqChannelDriver({
      transport,
      accountId: account.appId,
      operatorId: account.operatorOpenid,
      logError: () => {},
    });
    expect(driver.defaultConversation()).toEqual({
      channelId: "qq",
      accountId: "102000",
      conversationId: "op-user-1",
      recipientId: "op-user-1",
      metadata: { chatType: "c2c" },
    });
    expect(driver.formatVisibleText?.("wechat-codex")).toBe("qq-codex");
    expect(
      toQqChannelInboundMessage(
        {
          id: "m1",
          senderId: "op-user-1",
          conversationId: "op-user-1",
          recipientId: "op-user-1",
          chatType: "c2c",
          text: "hi",
          createdAt: "2026-10-13T00:00:00Z",
          attachments: [],
        },
        [],
      ).conversation.channelId,
    ).toBe("qq");

    const port = new QqChannelPort({ transport });
    expect(port.channelId).toBe("qq");
    await expect(
      port.send({
        kind: "notice",
        target: { channelId: "telegram", conversationId: "1", recipientId: "1" },
        text: "wrong",
      }),
    ).rejects.toThrow("QQ channel cannot send to telegram");
  });
});

describe("qq setup helpers", () => {
  test("validates CLI args and pairing helpers", () => {
    const code = createQqPairingCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(isQqPairingText(`/pair ${code}`, code)).toBe(true);
    expect(isQqPairingText(`nope ${code}`, code)).toBe(false);

    expect(parseQqSetupCliArgs(["--manual", "--qr-mode=normal"])).toEqual({
      help: false,
      manual: true,
      check: false,
      qrMode: "normal",
    });
    expect(formatQqSetupUsage()).toContain("qq-setup [--manual]");
  });
});