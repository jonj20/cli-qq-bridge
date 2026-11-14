// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import fs from "node:fs";
import path from "node:path";

import {
  CHANNEL_DATA_DIR,
  ensureChannelDataDir,
} from "../../wechat/channel-config.ts";

export type StoredQqAccount = {
  version: 1;
  appId: string;
  appSecret: string;
  sandbox: boolean;
  allowedUsers: string[];
  operatorOpenid: string;
  pairedAt: string;
};

export const QQ_DATA_DIR = path.join(CHANNEL_DATA_DIR, "qq");
export const QQ_ACCOUNT_FILE = path.join(QQ_DATA_DIR, "account.json");
export const QQ_INBOUND_ATTACHMENTS_DIR = path.join(
  QQ_DATA_DIR,
  "inbound-attachments",
);
export const QQ_INBOUND_MESSAGE_CLAIMS_DIR = path.join(
  QQ_DATA_DIR,
  "inbound-message-claims",
);

export function ensureQqDataDir(): void {
  ensureChannelDataDir();
  fs.mkdirSync(QQ_DATA_DIR, { recursive: true });
}

export function normalizeStoredQqAccount(
  parsed: Partial<StoredQqAccount>,
): StoredQqAccount | null {
  if (
    typeof parsed.appId !== "string" ||
    !parsed.appId.trim() ||
    typeof parsed.appSecret !== "string" ||
    !parsed.appSecret.trim() ||
    typeof parsed.operatorOpenid !== "string" ||
    !parsed.operatorOpenid.trim()
  ) {
    return null;
  }
  const operatorOpenid = parsed.operatorOpenid.trim();
  const allowedUsers = Array.isArray(parsed.allowedUsers)
    ? Array.from(
        new Set(
          parsed.allowedUsers.filter(
            (entry): entry is string =>
              typeof entry === "string" && Boolean(entry.trim()),
          ),
        ),
      )
    : [];
  if (!allowedUsers.includes(operatorOpenid)) {
    allowedUsers.unshift(operatorOpenid);
  }
  return {
    version: 1,
    appId: parsed.appId.trim(),
    appSecret: parsed.appSecret.trim(),
    sandbox: Boolean(parsed.sandbox),
    allowedUsers,
    operatorOpenid,
    pairedAt:
      typeof parsed.pairedAt === "string" && parsed.pairedAt.trim()
        ? parsed.pairedAt
        : new Date().toISOString(),
  };
}

export function loadQqAccount(
  filePath = QQ_ACCOUNT_FILE,
): StoredQqAccount | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, "utf-8"),
    ) as Partial<StoredQqAccount>;
    return normalizeStoredQqAccount(parsed);
  } catch {
    return null;
  }
}

export function saveQqAccount(
  account: StoredQqAccount,
  filePath = QQ_ACCOUNT_FILE,
): void {
  if (filePath === QQ_ACCOUNT_FILE) {
    ensureQqDataDir();
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(account, null, 2)}\n`, "utf-8");
  try {
    fs.chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on Windows.
  }
  fs.renameSync(tempPath, filePath);
}

export function resolveQqAccount(
  env: NodeJS.ProcessEnv = process.env,
  stored = loadQqAccount(),
): StoredQqAccount | null {
  const appId = env.QQ_APP_ID?.trim() || stored?.appId || "";
  const appSecret = env.QQ_APP_SECRET?.trim() || stored?.appSecret || "";
  const operatorOpenid = env.QQ_OPERATOR_OPENID?.trim() || stored?.operatorOpenid || "";
  if (!appId || !appSecret || !operatorOpenid) {
    return null;
  }
  const sandboxRaw = env.QQ_SANDBOX?.trim().toLowerCase();
  const sandbox =
    sandboxRaw === "1" || sandboxRaw === "true" || sandboxRaw === "on"
      ? true
      : sandboxRaw === "0" || sandboxRaw === "false" || sandboxRaw === "off"
        ? false
        : Boolean(stored?.sandbox);
  const normalized = normalizeStoredQqAccount({
    version: 1,
    appId,
    appSecret,
    sandbox,
    allowedUsers:
      env.QQ_ALLOWED_USERS?.split(",").map((entry) => entry.trim()).filter(Boolean) ||
      stored?.allowedUsers ||
      [],
    operatorOpenid,
    pairedAt: stored?.pairedAt || new Date().toISOString(),
  });
  return normalized;
}