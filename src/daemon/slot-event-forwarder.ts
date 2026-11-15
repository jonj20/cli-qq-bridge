// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 UNLINEARITY <unlinearity@gmail.com>
// Source: https://github.com/UNLINEARITY/CLI-WeChat-Bridge
// This file is part of CLI-WeChat-Bridge. Modifications and derivative works
// must be released under AGPL-3.0-or-later with full source code; see
// LICENSE.txt. Network services built on it must offer source to users.
import { delay } from "../bridge/bridge-adapters.shared.ts";
import type { BridgeEvent } from "../bridge/bridge-types.ts";
import {
  formatApprovalMessage,
  formatMirroredUserInputMessage,
  formatSessionSwitchMessage,
  formatTaskFailedMessage,
  formatAutoApprovalSummary,
} from "../bridge/message-formatting.ts";
import { appendBeforeAttachmentBlock } from "../bridge/outbound-attachments.ts";
import { formatUserInputRequestMessage } from "../bridge/user-input-messages.ts";
import { normalizeOutput, nowIso, truncatePreview } from "../bridge/bridge-utils.ts";
import { shouldForwardSessionSwitchEvent } from "../bridge/bridge-session-resume.ts";
import {
  formatUserFacingBridgeFatalError,
  shouldForwardBridgeEvent,
  shouldSuppressCodexLocalThreadNotice,
  type ChannelSendKind,
} from "../channels/wechat/wechat-forwarding.ts";
import { forwardBridgeEvent } from "../core/bridge-event-forwarder.ts";
import type { ChannelRuntime } from "../channels/channel-registry.ts";
import type { ChannelDriver } from "../core/channel-driver.ts";
import type {
  BridgeChannelPort,
  ChannelConversationRef,
  ChannelOutputKind,
} from "../core/channel-types.ts";
import { log, logError } from "./daemon-shared.ts";
import type { TypingTracker } from "./typing-tracker.ts";
import type { OutboundDispatcher } from "../core/outbound-dispatcher.ts";
import {
  type DaemonSlot,
  toPendingApproval,
  toPendingUserInput,
} from "./daemon-slot.ts";

const FATAL_NOTICE_GRACE_MS = 1_000;
const STOPPED_TYPING_STATUSES = new Set(["idle", "stopped", "error"]);

function toChannelSendKind(kind: ChannelOutputKind): ChannelSendKind {
  if (kind === "mirrored_input") {
    return "mirrored_user_input";
  }
  if (kind === "status") {
    return "message";
  }
  return kind;
}

export type SlotEventHost = {
  channel: ChannelRuntime;
  driver: ChannelDriver;
  typing: TypingTracker;
  operatorId: string;
  fallbackConversation: ChannelConversationRef;
  outbound: OutboundDispatcher;
  queueMessage: (
    senderId: string,
    text: string,
    context?: ChannelSendKind,
    targetOverride?: ChannelConversationRef,
  ) => Promise<boolean>;
  resolveSlotOutputTarget: (slot: DaemonSlot) => ChannelConversationRef;
  maybeDrainDeferredInputs: (slot: DaemonSlot) => Promise<void>;
  disposeDeadSlot: (slot: DaemonSlot) => void;
  releaseSlot: (slot: DaemonSlot) => void;
  /** Persist the session the slot now follows. */
  syncSession: (slot: DaemonSlot) => void;
  /** True once the daemon has started shutting down. */
  isShuttingDown: () => boolean;
  /** Wait before reporting a fatal error, to tell it apart from shutdown. */
  fatalNoticeGraceMs?: number;
  /** Source prefix for slot output (`[adapter]` or `[workspace/adapter]`). */
  prefix: (slot: DaemonSlot, text: string) => string;
  daemonLog: (message: string) => void;
};

function createSlotChannelPort(host: SlotEventHost, slot: DaemonSlot): BridgeChannelPort {
  const adapter = slot.adapter;
  return host.channel.createPort({
    sendTextToTarget: (target, text, kind) =>
      host.queueMessage(
        host.operatorId,
        text,
        toChannelSendKind(kind),
        target,
      ),
    sendTextToRecipient: (recipientId, text, context) =>
      host.queueMessage(recipientId, text, context as ChannelSendKind),
    queueAttachment: (action) => host.outbound.queueAttachment(action),
    prefixText: (_currentAdapter, text) => host.prefix(slot, text),
    onEmptyVisibleReply: (currentAdapter, rawText) => {
      host.daemonLog(
        `empty_visible_final_reply: adapter=${currentAdapter ?? adapter} raw=${truncatePreview(rawText)}`,
      );
    },
    onTextSent: (currentAdapter, text) => {
      host.daemonLog(
        `final_reply_sent: adapter=${currentAdapter ?? adapter} chars=${Array.from(text).length}`,
      );
    },
  });
}

/** Forward one adapter event from a daemon slot to the channel. */
export function handleSlotEvent(host: SlotEventHost, slot: DaemonSlot, event: BridgeEvent): void {
  slot.controller.syncLocalClientEndpoint();
  host.syncSession(slot);
  const adapterState = slot.runtime.getState();
  const channelPort = createSlotChannelPort(host, slot);
  const eventTarget = host.driver.capabilities.multiConversation
    ? host.resolveSlotOutputTarget(slot)
    : host.fallbackConversation;
  const eventTask = slot.turns.activeTask;

  const flushThinkBuffer = (): Promise<void> => {
    if (slot.thinkTimer) {
      clearTimeout(slot.thinkTimer);
      slot.thinkTimer = null;
    }
    if (slot.thinkBuffer.length === 0) {
      return Promise.resolve();
    }
    let text = host.prefix(slot, `[思考]\n${slot.thinkBuffer.join("\n")}`);

    if (slot.showFullThink) {
      // 全文输出
    } else if (text.length > 50) {
      // 截断输出一部分
      text = `${text.slice(0, 47)}...`;
    }

    slot.thinkBuffer = [];
    host.daemonLog(`think_flush: adapter=${slot.adapter} count=${text.split("\n").length} chars=${Array.from(text).length} preview=${truncatePreview(text, 200)}`);
    return host.queueMessage(host.operatorId, text, "notice", eventTarget).then(() => undefined);
  };

  // 去掉每片段首尾的空白（含换行），并把片段内部连续多个换行折叠为单个换行，
  // 避免空行累积；段内单个换行保留。段间由 join("\n") 统一分隔。
  const cleanThinkText = (text: string): string =>
    normalizeOutput(text).trim().replace(/\n{2,}/g, "\n");

  // 工具调用的参数通常是 JSON 字符串，尝试解析并以紧凑的 key: value 列表显示；
  // 解析失败或非对象值时，直接展示原始字符串（截断），避免转义字符导致的乱码。
  const formatToolArgs = (args?: string): string => {
    if (!args) {
      return "";
    }
    try {
      const parsed = JSON.parse(args);
      if (parsed === null || typeof parsed !== "object") {
        return String(parsed);
      }
      const entries = Object.entries(parsed).map(([key, value]) => {
        let str: string;
        if (typeof value === "string") {
          str = value;
        } else if (Array.isArray(value)) {
          str = `[Array: ${value.length}]`;
        } else if (typeof value === "object" && value !== null) {
          str = `[Object: ${Object.keys(value).length} keys]`;
        } else {
          str = String(value);
        }
        return `  ${key}: ${str.length > 80 ? str.slice(0, 80) + "..." : str}`;
      });
      return entries.join("\n");
    } catch {
      return args.length > 200 ? args.slice(0, 200) + "..." : args;
    }
  };

  const flushToolCallBuffer = (): Promise<void> => {
    if (slot.toolCallTimer) {
      clearTimeout(slot.toolCallTimer);
      slot.toolCallTimer = null;
    }
    if (slot.toolCallBuffer.length === 0) {
      return Promise.resolve();
    }
    const lines = slot.toolCallBuffer.map((call) => {
      const argsText = formatToolArgs(call.args);
      return argsText
        ? `[工具调用] ${call.name}\n参数:\n${argsText}`
        : `[工具调用] ${call.name}`;
    });
    const text = host.prefix(slot, lines.join("\n\n"));
    slot.toolCallBuffer = [];
    host.daemonLog(`toolcall_flush: adapter=${slot.adapter} count=${lines.length} chars=${Array.from(text).length} preview=${truncatePreview(text, 200)}`);
    return host.queueMessage(host.operatorId, text, "notice", eventTarget).then(() => undefined);
  };

  if (adapterState.pendingApprovals !== undefined) {
    const previous = new Map(slot.pendingConfirmations.map((pending) => [pending.requestId, pending]));
    slot.pendingConfirmations = adapterState.pendingApprovals.map((request) => {
      const existing = previous.get(request.requestId);
      return existing ? { ...existing, ...request } : toPendingApproval({ type: "approval_required", request, timestamp: nowIso() });
    });
  }
  if (slot.pendingConfirmations.length > 0 && !adapterState.pendingApproval) {
    slot.pendingConfirmations = [];
  }
  if (slot.pendingUserInput && (!adapterState.pendingUserInput
    || (slot.pendingUserInput.requestId !== undefined && slot.pendingUserInput.requestId !== adapterState.pendingUserInput.requestId))) {
    slot.pendingUserInput = null;
  }

  slot.eventForwardChain = slot.eventForwardChain
    .then(() => forwardBridgeEvent(event, {
    stdout: async (next) => {
      slot.lastOutputAt = Date.now();
      // 正文输出前，先发出已缓冲的思考与工具调用，保持实际发生顺序
      await flushThinkBuffer();
      await flushToolCallBuffer();
      if (shouldForwardBridgeEvent(slot.adapter, next.type)) {
        const text = host.prefix(slot, next.text);
        host.daemonLog(`stdout_push: adapter=${slot.adapter} chars=${Array.from(text).length} preview=${truncatePreview(text, 200)}`);
        host.outbound.trackForwardTask(
          host.queueMessage(
            host.operatorId,
            text,
            "message",
            eventTarget,
          ).then(() => undefined),
        );
      } else {
        host.daemonLog(`stdout_skip: adapter=${slot.adapter} chars=${Array.from(next.text).length}`);
      }
    },
    stderr: async (next) => {
      slot.lastOutputAt = Date.now();
      // 正文输出前，先发出已缓冲的思考与工具调用，保持实际发生顺序
      await flushThinkBuffer();
      await flushToolCallBuffer();
      if (shouldForwardBridgeEvent(slot.adapter, next.type)) {
        const text = host.prefix(slot, next.text);
        host.daemonLog(`stderr_push: adapter=${slot.adapter} chars=${Array.from(text).length} preview=${truncatePreview(text, 200)}`);
        host.outbound.trackForwardTask(
          host.queueMessage(
            host.operatorId,
            text,
            "message",
            eventTarget,
          ).then(() => undefined),
        );
      } else {
        host.daemonLog(`stderr_skip: adapter=${slot.adapter} chars=${Array.from(next.text).length}`);
      }
    },
    think: async (next) => {
      slot.lastOutputAt = Date.now();
      // 前面有工具调用缓冲时先发出，保持实际发生顺序
      await flushToolCallBuffer();
      const cleaned = cleanThinkText(next.text);
      // 默认模式：缓冲到 5秒后拼接成一条 QQ 消息发送
      slot.thinkBuffer.push(cleaned);
      if (!slot.thinkTimer) {
        slot.thinkTimer = setTimeout(() => {
          flushThinkBuffer();
        }, 5000);
        slot.thinkTimer.unref?.();
      }
      host.daemonLog(`think_buffered: adapter=${slot.adapter} raw_chars=${Array.from(next.text).length} cleaned_chars=${Array.from(cleaned).length} buffer_len=${slot.thinkBuffer.length}`);
    },
    toolCall: async (next) => {
      slot.lastOutputAt = Date.now();
      // 前面有思考缓冲时先发出，保持实际发生顺序
      await flushThinkBuffer();
      const argsText = formatToolArgs(next.args);
      const text = host.prefix(
        slot,
        argsText ? `[工具调用] ${next.name}\n参数:\n${argsText}` : `[工具调用] ${next.name}`,
      );
      host.daemonLog(`tool_call_push: adapter=${slot.adapter} name=${next.name} args_chars=${Array.from(next.args ?? "").length}`);
      host.outbound.trackForwardTask(
        host.queueMessage(host.operatorId, text, "notice", eventTarget).then(() => undefined),
      );
    },
    finalReply: (next) => {
      host.typing.stop(slot, "final_reply");
      slot.lastFinalReplyAtMs = Date.now();
      host.daemonLog(`final_reply: adapter=${slot.adapter} text=${truncatePreview(next.text)}`);
      const autoSummary = formatAutoApprovalSummary(slot.autoApprovals);
      slot.autoApprovals = {};
      const text = autoSummary ? appendBeforeAttachmentBlock(next.text, autoSummary) : next.text;
      host.daemonLog(`final_reply_send: adapter=${slot.adapter} chars=${Array.from(text).length} preview=${truncatePreview(text, 200)}`);
      host.outbound.trackForwardTask(
        flushThinkBuffer().then(() => flushToolCallBuffer()).then(() =>
          slot.outputBatcher.flushNow().then(async () => {
            await channelPort.send({
              target: eventTarget,
              kind: "final_reply",
              text,
              adapter: slot.adapter,
            });
          })
        ),
      );
    },
    status: (next) => {
      if (next.message) {
        log(`${slot.adapter} ${next.status}: ${next.message}`);
        host.daemonLog(`${slot.adapter}_${next.status}: ${next.message}`);
      }
      // A turn can end without task events (an interrupt, a crash); an idle,
      // stopped, or failed CLI is not typing. The live check skips a stale event.
      if (STOPPED_TYPING_STATUSES.has(next.status) && STOPPED_TYPING_STATUSES.has(slot.runtime.getState().status)) {
        host.typing.stop(slot, `status_${next.status}`);
      }
    },
    notice: (next) => {
      slot.lastOutputAt = Date.now();
      host.daemonLog(`${slot.adapter}_${next.level}_notice: ${truncatePreview(next.text)}`);
      if (shouldForwardBridgeEvent(slot.adapter, next.type, { text: next.text })) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, next.text), "notice", eventTarget);
        }));
      }
    },
    approvalAutoResolved: (next) => {
      slot.autoApprovals[next.kind] = (slot.autoApprovals[next.kind] ?? 0) + 1;
      host.daemonLog(`approval_auto_resolved: adapter=${slot.adapter} kind=${next.kind}`);
    },
    approvalRequired: (next) => {
      host.typing.pause(slot);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        const liveState = slot.runtime.getState();
        if (liveState.pendingApprovals !== undefined && liveState.pendingApproval?.requestId !== next.request.requestId) return;
        const pending = toPendingApproval(next);
        if (liveState.pendingApprovals === undefined) {
          slot.pendingConfirmations = [pending];
        }
        host.daemonLog(`approval_required: adapter=${slot.adapter} source=${pending.source} command=${truncatePreview(pending.commandPreview)}`);
        await host.queueMessage(host.operatorId, host.prefix(slot, formatApprovalMessage(pending, liveState)), "approval_required", eventTarget);
        if (slot.runtime.getState().pendingApproval?.requestId === pending.requestId) {
          slot.displayedApprovalRequestId = pending.requestId;
        }
      }));
    },
    userInputRequired: (next) => {
      host.typing.pause(slot);
      if (next.request.requestId !== undefined && slot.runtime.getState().pendingUserInput?.requestId !== next.request.requestId) return;
      const pending = toPendingUserInput(next.request);
      slot.pendingUserInput = pending;
      host.daemonLog(`user_input_required: adapter=${slot.adapter} questions=${pending.questions.length}`);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        if (pending.requestId !== undefined && slot.runtime.getState().pendingUserInput?.requestId !== pending.requestId) return;
        await host.queueMessage(host.operatorId, host.prefix(slot, formatUserInputRequestMessage(pending, adapterState)), "user_input_required", eventTarget);
      }));
    },
    mirroredUserInput: (next) => {
      host.daemonLog(`mirrored_local_input: adapter=${slot.adapter} text=${truncatePreview(next.text)}`);
      if (shouldForwardBridgeEvent(slot.adapter, next.type, { text: next.text })) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, formatMirroredUserInputMessage(slot.adapter, next.text)), "mirrored_user_input", eventTarget);
        }));
      }
    },
    sessionSwitched: (next) => {
      if (next.source === "local") slot.resumeCoordinator.clear();
      host.daemonLog(`session_switched: adapter=${slot.adapter} session=${next.sessionId} source=${next.source} reason=${next.reason}`);
      if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEvent(slot.adapter, next.type)) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, formatSessionSwitchMessage({ adapter: slot.adapter, sessionId: next.sessionId, source: next.source, reason: next.reason })), "session_switched", eventTarget);
        }));
      }
    },
    threadSwitched: (next) => {
      if (next.source === "local") slot.resumeCoordinator.clear();
      host.daemonLog(`thread_switched: adapter=${slot.adapter} thread=${next.threadId} source=${next.source} reason=${next.reason}`);
      // The first thread is the one a new visible window opens; switching
      // into it is not news to the operator.
      const firstThread = slot.knownThreadId === undefined;
      slot.knownThreadId = next.threadId;
      if (
        firstThread ||
        shouldSuppressCodexLocalThreadNotice({
          adapter: slot.adapter,
          source: next.source,
          activeTurnOrigin: slot.runtime.getState().activeTurnOrigin,
          lastFinalReplyAtMs: slot.lastFinalReplyAtMs,
        })
      ) {
        return;
      }
      if (shouldForwardSessionSwitchEvent(next.reason) && shouldForwardBridgeEvent(slot.adapter, next.type)) {
        host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await host.queueMessage(host.operatorId, host.prefix(slot, formatSessionSwitchMessage({ adapter: slot.adapter, sessionId: next.threadId, source: next.source, reason: next.reason })), "thread_switched", eventTarget);
        }));
      }
    },
    taskComplete: () => {
      host.typing.stop(slot, "task_complete");
      host.outbound.trackForwardTask(
        flushThinkBuffer().then(() => flushToolCallBuffer()).then(() => {
          slot.pendingConfirmations = [];
          slot.autoApprovals = {};
          slot.pendingUserInput = null;
          if (eventTask) {
            slot.turns.complete(eventTask);
          }
          void host.maybeDrainDeferredInputs(slot);
        }),
      );
    },
    taskFailed: (next) => {
      host.typing.stop(slot, "task_failed");
      host.outbound.trackForwardTask(
        flushThinkBuffer().then(() => flushToolCallBuffer()).then(() =>
          slot.outputBatcher.flushNow().then(async () => {
            slot.pendingConfirmations = [];
            slot.autoApprovals = {};
            slot.pendingUserInput = null;
            if (eventTask) {
              slot.turns.complete(eventTask);
            }
            void host.maybeDrainDeferredInputs(slot);
            await host.queueMessage(host.operatorId, host.prefix(slot, formatTaskFailedMessage(slot.adapter, next.message)), "task_failed", eventTarget);
          })
        ),
      );
    },
    fatalError: (next) => {
      host.typing.stop(slot, "fatal_error");
      logError(`${slot.adapter}: ${next.message}`);
      host.daemonLog(`fatal_error: adapter=${slot.adapter} message=${next.message}`);
      slot.pendingConfirmations = [];
      slot.autoApprovals = {};
      slot.pendingUserInput = null;
      if (eventTask) {
        slot.turns.complete(eventTask);
      }
      void host.maybeDrainDeferredInputs(slot);
      host.disposeDeadSlot(slot);
      host.outbound.trackForwardTask(slot.outputBatcher.flushNow().then(async () => {
        // Closing the daemon's terminal ends its CLI children a moment before
        // the daemon sees the signal; those exits are not errors to report.
        await delay(host.fatalNoticeGraceMs ?? FATAL_NOTICE_GRACE_MS);
        if (host.isShuttingDown()) {
          host.daemonLog(`fatal_error_notice_skipped: adapter=${slot.adapter} reason=shutdown`);
          return;
        }
        await host.queueMessage(host.operatorId, host.prefix(slot, formatUserFacingBridgeFatalError(next.message)), "fatal_error", eventTarget);
      }));
    },
    shutdownRequested: (next) => {
      host.daemonLog(`slot_shutdown_requested: adapter=${slot.adapter} reason=${next.reason}`);
      // A window-bound slot ends with its visible window.
      if (slot.boundToWindow) {
        host.releaseSlot(slot);
      }
    },
    }))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      host.daemonLog(`event_forward_failed: adapter=${slot.adapter} message=${message}`);
    });
}
