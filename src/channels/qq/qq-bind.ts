// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
/**
 * QQ official scan-to-bind protocol.
 *
 * Mirrors the `@tencent-connect/qqbot-connector` flow:
 *   1. generate a local 32-byte AES key and register it via
 *      `POST /lite/create_bind_task` -> `task_id`;
 *   2. the QR code encodes `https://q.qq.com/qqbot/openclaw/connect.html`,
 *      which mobile QQ opens inside the QQ Bot assistant;
 *   3. poll `POST /lite/poll_bind_result` until the scan completes;
 *   4. the returned `bot_encrypt_secret` is AES-256-GCM encrypted with the
 *      key generated in step 1, so the secret never travels in plaintext.
 *
 * Layout of the decrypted payload: `iv(12) | ciphertext(n) | tag(16)`.
 */
import crypto from "node:crypto";

const QQ_BIND_HOST = "https://q.qq.com";
const QQ_CONNECT_PATH = "/qqbot/openclaw/connect.html";

/** Bind task lifecycle reported by `poll_bind_result`. */
export enum QqBindStatus {
  NONE = 0,
  PENDING = 1,
  COMPLETED = 2,
  EXPIRED = 3,
}

export type QqBindCredentials = {
  appId: string;
  appSecret: string;
  /** OpenID of the account that scanned the QR code, when the portal reports it. */
  userOpenid?: string;
};

export type QqBindTask = {
  taskId: string;
  /** base64 AES key; keep it local, it decrypts the bot secret. */
  key: string;
  /** URL the QR code encodes. */
  connectUrl: string;
};

export type QqBindTaskOptions = {
  /** Attribution marker so Tencent can see third-party adoption. */
  source?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type CreateBindTaskResponse = {
  retcode?: number;
  msg?: string;
  data?: { task_id?: string };
};

type PollBindResultResponse = {
  retcode?: number;
  msg?: string;
  data?: {
    status?: number;
    bot_appid?: string;
    bot_encrypt_secret?: string;
    user_openid?: string;
  };
};

export function generateBindKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

export function buildConnectUrl(taskId: string, source = "cli-wechat-bridge"): string {
  const params = new URLSearchParams({
    task_id: taskId,
    _wv: "2",
    source,
  });
  return `${QQ_BIND_HOST}${QQ_CONNECT_PATH}?${params.toString()}`;
}

/**
 * Decrypt the portal-encrypted bot secret.
 *
 * The base64 payload decodes to `iv(12) | ciphertext | tag(16)`; AES-256-GCM
 * expects the tag appended to the ciphertext.
 */
export function decryptBotSecret(encryptedBase64: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("QQ bind key must be 32 bytes.");
  }
  const raw = Buffer.from(encryptedBase64, "base64");
  if (raw.length <= 28) {
    throw new Error("QQ encrypted secret payload is too short.");
  }
  const iv = raw.subarray(0, 12);
  const ciphertextWithTag = raw.subarray(12);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(ciphertextWithTag.subarray(ciphertextWithTag.length - 16));
  const plaintext = Buffer.concat([
    decipher.update(ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16)),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}

/** Register a bind task and return the QR code target. */
export async function createBindTask(
  options: QqBindTaskOptions = {},
): Promise<QqBindTask> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const key = generateBindKey();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );

  try {
    const res = await fetchImpl(`${QQ_BIND_HOST}/lite/create_bind_task`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ key }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QQ create_bind_task failed HTTP ${res.status}: ${text}`);
    }
    const body = (await res.json()) as CreateBindTaskResponse;
    if (Number(body.retcode ?? -1) !== 0) {
      throw new Error(
        `QQ create_bind_task failed: ${body.msg ?? "unknown error"} (retcode ${body.retcode})`,
      );
    }
    const taskId = String(body.data?.task_id ?? "").trim();
    if (!taskId) {
      throw new Error("QQ create_bind_task returned no task_id.");
    }
    return {
      taskId,
      key,
      connectUrl: buildConnectUrl(taskId, options.source),
    };
  } finally {
    clearTimeout(timer);
  }
}

export type QqBindPollResult =
  | { status: QqBindStatus.PENDING }
  | { status: QqBindStatus.EXPIRED }
  | { status: QqBindStatus.COMPLETED; credentials: QqBindCredentials };

/** Read the current bind state once. */
export async function pollBindResult(
  taskId: string,
  options: { key: string; fetchImpl?: typeof fetch; timeoutMs?: number } = { key: "" },
): Promise<QqBindPollResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 15_000,
  );

  try {
    const res = await fetchImpl(`${QQ_BIND_HOST}/lite/poll_bind_result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ task_id: taskId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`QQ poll_bind_result failed HTTP ${res.status}: ${text}`);
    }
    const body = (await res.json()) as PollBindResultResponse;
    if (Number(body.retcode ?? -1) !== 0) {
      throw new Error(
        `QQ poll_bind_result failed: ${body.msg ?? "unknown error"} (retcode ${body.retcode})`,
      );
    }
    const status = Number(body.data?.status ?? 0);
    if (status === QqBindStatus.COMPLETED) {
      const appId = String(body.data?.bot_appid ?? "").trim();
      const encrypted = String(body.data?.bot_encrypt_secret ?? "").trim();
      if (!appId || !encrypted) {
        throw new Error("QQ bind result is missing the bot credentials.");
      }
      const appSecret = decryptBotSecret(encrypted, options.key);
      const userOpenid = String(body.data?.user_openid ?? "").trim();
      return {
        status: QqBindStatus.COMPLETED,
        credentials: {
          appId,
          appSecret,
          ...(userOpenid ? { userOpenid } : {}),
        },
      };
    }
    if (status === QqBindStatus.EXPIRED) {
      return { status: QqBindStatus.EXPIRED };
    }
    return { status: QqBindStatus.PENDING };
  } finally {
    clearTimeout(timer);
  }
}
