// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
/**
 * QQ channel setup.
 *
 * The default path is a pure scan-to-bind flow, matching the WeChat setup:
 * the terminal prints a QR code, mobile QQ scans it, and the portal hands
 * back the bot AppID and an AES-256-GCM encrypted AppSecret.
 * If the portal does not return the scanner's OpenID, setup falls back to a
 * 6-digit `/pair <code>` confirmation so `operatorOpenid` is always bound.
 *
 * A manual path (`--manual`) stays available for bot credentials that were
 * created by hand on the QQ Open Platform.
 */
import crypto from "node:crypto";
import readline from "node:readline";
import { Writable } from "node:stream";

import {
  loadQqAccount,
  normalizeStoredQqAccount,
  resolveQqAccount,
  saveQqAccount,
} from "./qq-config.ts";
import { QqTransport } from "./qq-transport.ts";
import {
  createBindTask,
  pollBindResult,
  QqBindStatus,
  type QqBindCredentials,
} from "./qq-bind.ts";

const PAIRING_TIMEOUT_MS = 5 * 60 * 1000;
const QR_POLL_INTERVAL_MS = 2_000;
const QR_BIND_TTL_MS = 5 * 60 * 1000;

type SetupLogger = (message: string) => void;

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return ask(prompt);
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) {
        process.stdout.write(chunk);
      }
      callback();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  return new Promise<string>((resolve) => {
    rl.question(prompt, (answer) => {
      muted = false;
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\u001b\[[0-9;]*m/g;

export function getQRCodeVisibleWidth(qr: string): number {
  return Math.max(
    0,
    ...qr
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => Array.from(line.replace(ANSI_SGR_RE, "")).length),
  );
}

export function selectQRCodePresentation(params: {
  isTTY: boolean;
  columns?: number;
  renderedWidth: number;
}): "qr_with_url" | "url_only" {
  if (
    !params.isTTY ||
    typeof params.columns !== "number" ||
    !Number.isFinite(params.columns) ||
    params.columns <= 0 ||
    params.renderedWidth + 1 > params.columns
  ) {
    return "url_only";
  }
  return "qr_with_url";
}

export function formatQRCodeLoginInstruction(
  presentation: "qr_with_url" | "url_only",
): string {
  return presentation === "qr_with_url"
    ? "用手机 QQ 扫描上面的二维码，在手机 QQ 机器人助手里确认授权。扫码失败时，用浏览器打开上面的 URL。\n"
    : "终端未渲染二维码。请用浏览器打开上面的 URL，再用手机 QQ 扫码确认授权。\n";
}

async function generateQRCode(
  qrContent: string,
  options: { small: boolean },
): Promise<string> {
  const qrterm = await import("qrcode-terminal");
  return await new Promise<string>((resolve, reject) => {
    try {
      qrterm.default.generate(qrContent, options, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

export async function printQRCode(
  qrContent: string,
  write: (message: string) => void,
  terminal: { isTTY: boolean; columns?: number },
  qrMode: "small" | "normal" = "small",
): Promise<"qr_with_url" | "url_only"> {
  if (!terminal.isTTY) {
    write(
      `终端未渲染二维码。请用浏览器打开这个短时有效的 QQ 登录 URL，再用手机 QQ 扫码：\n${qrContent}\n\n`,
    );
    return "url_only";
  }

  try {
    const qr = await generateQRCode(qrContent, { small: qrMode === "small" });
    const presentation = selectQRCodePresentation({
      isTTY: terminal.isTTY,
      columns: terminal.columns,
      renderedWidth: getQRCodeVisibleWidth(qr),
    });
    if (presentation === "qr_with_url") {
      write(`${qr}\n`);
    }
    write(
      presentation === "qr_with_url"
        ? `扫码失败时，用浏览器打开这个短时有效的 QQ 登录 URL，不要分享给他人：\n${qrContent}\n\n`
        : `用浏览器打开这个短时有效的 QQ 登录 URL，不要分享给他人：\n${qrContent}\n\n`,
    );
    return presentation;
  } catch {
    write(`二维码渲染失败。请用浏览器打开这个短时有效的 QQ 登录 URL：\n${qrContent}\n\n`);
    return "url_only";
  }
}

export function createQqPairingCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function isQqPairingText(text: string, code: string): boolean {
  return text.trim() === `/pair ${code}`;
}

export type QqScanLoginOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: SetupLogger;
  write?: (message: string) => void;
  terminal?: { isTTY: boolean; columns?: number };
  qrMode?: "small" | "normal";
};

/**
 * Scan-to-bind: ask the QQ portal for a bind task, show the QR code, and
 * wait for the scan. The portal returns the bot credentials; the secret is
 * decrypted locally with the key generated for this task.
 */
export async function runQqScanLogin(
  options: QqScanLoginOptions = {},
): Promise<QqBindCredentials> {
  const log = options.log ?? ((message: string) => console.log(message));
  const write = options.write ?? ((message: string) => process.stdout.write(message));
  const fetchImpl = options.fetchImpl ?? fetch;
  const terminal = options.terminal ?? {
    isTTY: process.stdout.isTTY === true,
    ...(typeof process.stdout.columns === "number" && process.stdout.columns > 0
      ? { columns: process.stdout.columns }
      : {}),
  };
  const qrMode = options.qrMode ?? "small";
  const timeoutMs = options.timeoutMs ?? QR_BIND_TTL_MS;

  log("正在获取 QQ 登录二维码...\n");
  const task = await createBindTask({ fetchImpl });
  const presentation = await printQRCode(task.connectUrl, write, terminal, qrMode);
  log(formatQRCodeLoginInstruction(presentation));

  const deadline = Date.now() + timeoutMs;
  let dots = 0;
  while (Date.now() < deadline) {
    const result = await pollBindResult(task.taskId, {
      key: task.key,
      fetchImpl,
    });
    if (result.status === QqBindStatus.COMPLETED) {
      write("\n");
      log("QQ 扫码授权成功。");
      return result.credentials;
    }
    if (result.status === QqBindStatus.EXPIRED) {
      throw new Error("QQ 登录二维码已过期，请重新运行 qq-setup。");
    }
    dots = (dots + 1) % 4;
    write(".".repeat(dots === 0 ? 1 : dots));
    await new Promise((resolve) => setTimeout(resolve, QR_POLL_INTERVAL_MS));
  }

  throw new Error("QQ 扫码登录超时，请重新运行 qq-setup。");
}

/**
 * Pair the operator by asking the user to send `/pair <code>` to the bot.
 * Used when QR scan does not return `user_openid` or in `--manual` mode.
 */
export async function pairQqOperator(options: {
  appId: string;
  appSecret: string;
  sandbox?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: SetupLogger;
}): Promise<{ operatorOpenid: string }> {
  const log = options.log ?? console.log;
  const pairingCode = createQqPairingCode();

  const transport = new QqTransport({
    appId: options.appId,
    appSecret: options.appSecret,
    sandbox: options.sandbox,
    allowedUsers: [],
    operatorOpenid: "",
    fetchImpl: options.fetchImpl,
    downloadInboundAttachments: false,
    logger: { log },
  });

  try {
    await transport.fetchToken();
    log("QQ 机器人凭据已验证。");
    return await new Promise<{ operatorOpenid: string }>((resolve, reject) => {
      let settled = false;
      const finish = (
        error?: Error,
        result?: { operatorOpenid: string },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void transport.stop();
        if (error || !result) {
          reject(error ?? new Error("QQ 手动配对失败。"));
          return;
        }
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish(new Error("QQ 操作者配对超时，请重新运行 qq-setup。"));
      }, options.timeoutMs ?? PAIRING_TIMEOUT_MS);
      timer.unref?.();

      void transport.start({
        onMessage: async (message) => {
          if (message.text && isQqPairingText(message.text, pairingCode)) {
            log(`QQ 操作者配对成功：${message.senderId}`);
            finish(undefined, { operatorOpenid: message.senderId });
          }
        },
        onConnected: async () => {
          log(`请用你的 QQ 给机器人发送：/pair ${pairingCode}（5 分钟内有效）`);
        },
        onFatal: async (error: Error) => {
          finish(error);
        },
      });
    });
  } catch (error) {
    await transport.stop();
    throw error;
  }
}

/**
 * Manual path: credentials come from the QQ Open Platform, and the operator
 * binds by sending `/pair <code>` to the bot.
 */
export async function runQqManualLogin(options: {
  appId: string;
  appSecret: string;
  sandbox?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: SetupLogger;
}): Promise<{ appId: string; appSecret: string; sandbox: boolean; operatorOpenid: string }> {
  const paired = await pairQqOperator({
    appId: options.appId,
    appSecret: options.appSecret,
    sandbox: options.sandbox,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
    log: options.log,
  });
  return {
    appId: options.appId,
    appSecret: options.appSecret,
    sandbox: options.sandbox ?? false,
    operatorOpenid: paired.operatorOpenid,
  };
}

export type QqSetupCliOptions = {
  help: boolean;
  manual: boolean;
  check: boolean;
  qrMode: "small" | "normal";
};

export function parseQqSetupCliArgs(argv: string[]): QqSetupCliOptions {
  const options: QqSetupCliOptions = {
    help: false,
    manual: false,
    check: false,
    qrMode: "small",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--manual") {
      options.manual = true;
      continue;
    }
    if (arg === "--qr-mode") {
      const value = argv[index + 1];
      if (value !== "small" && value !== "normal") {
        throw new Error("--qr-mode requires small or normal.");
      }
      options.qrMode = value;
      index += 1;
      continue;
    }
    if (arg === "--qr-mode=small" || arg === "--qr-mode=normal") {
      options.qrMode = arg.endsWith("=small") ? "small" : "normal";
      continue;
    }
    throw new Error(`Unknown qq-setup option: ${arg}`);
  }
  return options;
}

export function formatQqSetupUsage(): string {
  return [
    "Usage: qq-setup [--manual] [--qr-mode <small|normal>] [--check]",
    "",
    "Bind a QQ bot to the local CLI bridge.",
    "",
    "By default the setup shows a QR code: scan it with mobile QQ and confirm",
    "in the QQ bot assistant. The bot AppID, AppSecret and your OpenID are",
    "filled in automatically.",
    "",
    "--manual   enter the bot AppID/AppSecret by hand and bind the operator",
    "           by sending /pair <code> to the bot.",
    "--check    verify the saved credentials and exit.",
    "",
    "QR mode defaults to small; use --qr-mode normal when the terminal renders",
    "small QR blocks incorrectly.",
    "",
  ].join("\n");
}

export async function runQqSetup(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseQqSetupCliArgs(argv);
  if (cli.help) {
    console.log(formatQqSetupUsage());
    return;
  }

  const existing = loadQqAccount();
  if (cli.check) {
    const account = resolveQqAccount(process.env, existing);
    if (!account || !account.appId || !account.operatorOpenid) {
      throw new Error("No complete QQ credentials are configured.");
    }
    const transport = new QqTransport({
      appId: account.appId,
      appSecret: account.appSecret,
      sandbox: account.sandbox,
      allowedUsers: account.allowedUsers,
      operatorOpenid: account.operatorOpenid,
    });
    await transport.fetchToken();
    console.log(
      `QQ credentials are valid. AppID: ${account.appId}, paired operator: ${account.operatorOpenid}`,
    );
    return;
  }

  const sandboxInput = process.env.QQ_SANDBOX?.trim() || "false";
  const sandbox = sandboxInput === "true" || sandboxInput === "1" || sandboxInput === "on";

  let appId: string;
  let appSecret: string;
  let operatorOpenid: string;

  if (cli.manual) {
    appId =
      process.env.QQ_APP_ID?.trim() ||
      (await ask(
        `QQ App ID${existing?.appId ? " [press Enter to keep saved value]" : ""}: `,
      )) ||
      existing?.appId ||
      "";
    if (!appId) {
      throw new Error("A QQ App ID is required.");
    }
    appSecret =
      process.env.QQ_APP_SECRET?.trim() ||
      (await askSecret(
        `QQ App Secret${existing?.appSecret ? " [press Enter to keep saved value]" : " (from https://q.qq.com)"}: `,
      )) ||
      existing?.appSecret ||
      "";
    if (!appSecret) {
      throw new Error("A QQ App Secret is required.");
    }
    const manual = await runQqManualLogin({ appId, appSecret, sandbox });
    operatorOpenid = manual.operatorOpenid;
  } else {
    const credentials = await runQqScanLogin({ qrMode: cli.qrMode });
    appId = credentials.appId;
    appSecret = credentials.appSecret;
    operatorOpenid = credentials.userOpenid?.trim() || "";
    if (!operatorOpenid) {
      const paired = await pairQqOperator({ appId, appSecret, sandbox });
      operatorOpenid = paired.operatorOpenid;
    }
  }

  const saved = normalizeStoredQqAccount({
    version: 1,
    appId,
    appSecret,
    sandbox,
    allowedUsers: existing?.allowedUsers ?? [],
    operatorOpenid,
    pairedAt: new Date().toISOString(),
  });
  if (!saved) {
    throw new Error("Failed to save QQ credentials.");
  }
  saveQqAccount(saved);

  console.log("");
  console.log("QQ bot bound to the bridge.");
  if (appId) {
    console.log(`AppID: ${appId}`);
  }
  if (operatorOpenid) {
    console.log(`Operator OpenID: ${operatorOpenid}`);
  }
  console.log("");
  console.log("Start from a project directory with one of:");
  console.log("  qq-opencode");
  console.log("  qq-codex");
  console.log("  qq-claude");
  console.log("  qq-pi");
  console.log("  qq-daemon");
  console.log("");
  console.log("Run qq-setup again any time you need to refresh the binding.");
}

export async function ensureQqAccount(options: {
  log?: SetupLogger;
  setup?: () => Promise<void>;
} = {}): Promise<void> {
  const existing = resolveQqAccount();
  if (existing?.appId && existing.operatorOpenid) {
    return;
  }
  options.log?.("No bound QQ bot found. Starting QQ setup...");
  await (options.setup ?? (() => runQqSetup([])))();
}