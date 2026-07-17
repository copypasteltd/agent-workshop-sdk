import { existsSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import {
  bridgeEventSchema,
  runConversationMessageSchema,
  type ApproveRunInput,
  type BridgeEvent,
  type BridgeSessionContext,
  type MessageKind,
  type MessageRole,
  type RunStatus,
  type SendRunMessageInput,
} from "@lingban/contracts";
import { EventParser } from "./event-parser.js";
import type { CodexSessionDiagnostics } from "../observability.js";

const MAX_REPLAY_HISTORY_ENTRIES = 200;
const MAX_REPLAY_HISTORY_BYTES = 256 * 1024;

type CodexLaunchOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
};

type CodexRecoveryOptions = {
  maxRestartAttempts?: number;
  restartBackoffMs?: number;
  restartResetWindowMs?: number;
};

type CodexSessionOptions = {
  context: BridgeSessionContext;
  launch: CodexLaunchOptions;
  recovery?: CodexRecoveryOptions;
  emit: (event: BridgeEvent) => void;
  now?: () => string;
};

function resolveExecutablePath(command: string, env: NodeJS.ProcessEnv) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return command;
  }

  const rawPath = env.PATH ?? process.env.PATH ?? "";
  const searchRoots = rawPath.split(path.delimiter).filter(Boolean);
  const rawExtensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  const hasExtension = path.extname(command).length > 0;
  const candidates = hasExtension ? [""] : rawExtensions;

  for (const root of searchRoots) {
    for (const suffix of candidates) {
      const candidate = path.join(root, `${command}${suffix}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

function formatUserMessage(input: SendRunMessageInput) {
  const lines = [input.text];

  for (const attachment of input.attachments) {
    lines.push(`Attachment: ${attachment.label} (${attachment.path})`);
  }

  return `${lines.join("\n")}\n`;
}

function formatApproval(input: ApproveRunInput) {
  const decision = input.approved
    ? "Approval granted. Continue execution."
    : "Approval rejected. Stop execution.";
  const note = input.note ? `\nNote: ${input.note}` : "";
  return `${decision}${note}\n`;
}

function normalizePtyInput(input: string) {
  if (process.platform !== "win32") {
    return input;
  }

  return input.replace(/\r?\n/g, "\r");
}

function createMessageEvent(
  runId: string,
  role: MessageRole,
  kind: MessageKind,
  text: string,
  createdAt: string
): BridgeEvent {
  return bridgeEventSchema.parse({
    type: "conversation.message",
    message: runConversationMessageSchema.parse({
      messageId: `msg_${randomUUID()}`,
      runId,
      role,
      kind,
      text,
      attachments: [],
      createdAt,
    }),
  });
}

export class CodexSession {
  #options: Required<Omit<CodexSessionOptions, "now" | "recovery">> & {
    now: () => string;
    recovery: {
      maxRestartAttempts: number;
      restartBackoffMs: number;
      restartResetWindowMs: number;
    };
  };
  #pty: pty.IPty | null = null;
  #parser: EventParser;
  #runtimeEnv: Record<string, string> = {};
  #status: RunStatus | "IDLE" = "IDLE";
  #startedAt: string | null = null;
  #lastLaunchAt: string | null = null;
  #lastStdoutAt: string | null = null;
  #lastMessageAt: string | null = null;
  #lastApprovalAt: string | null = null;
  #lastCancelAt: string | null = null;
  #lastHeartbeatAt: string | null = null;
  #lastUnexpectedExitAt: string | null = null;
  #lastRestartAt: string | null = null;
  #lastRestartReason: string | null = null;
  #lastExitCode: number | null = null;
  #lastExitSignal: number | null = null;
  #terminalStatusOnExit: "CANCELLED" | null = null;
  #restartAttemptsTotal = 0;
  #restartSuccessTotal = 0;
  #restartFailuresTotal = 0;
  #restartBudgetUsed = 0;
  #recovering = false;
  #stopRequested = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #replayHistory: string[] = [];
  #replayHistoryBytes = 0;
  #deferredInitialPromptPending = false;

  constructor(options: CodexSessionOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date().toISOString()),
      recovery: {
        maxRestartAttempts: Math.max(0, options.recovery?.maxRestartAttempts ?? 2),
        restartBackoffMs: Math.max(0, options.recovery?.restartBackoffMs ?? 1_000),
        restartResetWindowMs: Math.max(0, options.recovery?.restartResetWindowMs ?? 30_000),
      },
    };
    this.#parser = new EventParser({
      runId: options.context.runId,
      emit: options.emit,
      now: this.#options.now,
    });
    this.#deferredInitialPromptPending = options.context.deferInitialTurn;
  }

  start() {
    if (this.#pty || this.#recovering) {
      return;
    }

    this.#stopRequested = false;
    this.#terminalStatusOnExit = null;
    this.#startedAt = this.#startedAt ?? this.#options.now();
    this.#lastExitCode = null;
    this.#lastExitSignal = null;
    this.#status = "STARTING";

    this.#options.emit(
      bridgeEventSchema.parse({
        type: "run.status.changed",
        runId: this.#options.context.runId,
        status: "STARTING",
        occurredAt: this.#options.now(),
        reason: "container bridge is starting Codex CLI",
      })
    );

    this.#launchSession({
      recovery: false,
    });
  }

  setRuntimeEnv(env: Record<string, string>) {
    this.#runtimeEnv = {
      ...this.#runtimeEnv,
      ...env,
    };
  }

  sendMessage(input: SendRunMessageInput) {
    const userPayload = formatUserMessage(input);
    const payload = this.#deferredInitialPromptPending
      ? `${this.#options.context.initialPrompt}\n\n${userPayload}`
      : userPayload;
    this.#deferredInitialPromptPending = false;
    this.#recordReplayInput(payload);
    this.#lastMessageAt = this.#options.now();

    if (this.#pty) {
      this.#writeToPty(payload);
      return;
    }

    if (this.#recovering) {
      return;
    }

    throw new Error("Codex session is not running");
  }

  approve(input: ApproveRunInput) {
    const payload = formatApproval(input);
    this.#recordReplayInput(payload);
    this.#lastApprovalAt = this.#options.now();

    if (this.#pty) {
      this.#writeToPty(payload);
      return;
    }

    if (this.#recovering) {
      return;
    }

    throw new Error("Codex session is not running");
  }

  cancel(reason?: string) {
    if (!this.#pty && !this.#recovering) {
      return;
    }

    this.#stopRequested = true;
    this.#clearRestartTimer();
    this.#recovering = false;
    this.#terminalStatusOnExit = "CANCELLED";
    this.#lastCancelAt = this.#options.now();
    this.#status = "CANCELLED";

    if (!this.#pty) {
      this.#options.emit(
        bridgeEventSchema.parse({
          type: "run.status.changed",
          runId: this.#options.context.runId,
          status: "CANCELLED",
          occurredAt: this.#options.now(),
          reason: reason ?? "received cancel command",
        })
      );
      return;
    }

    if (reason) {
      this.#writeToPty(`This run has been cancelled. Reason: ${reason}\n`);
    }

    const activePty = this.#pty;
    this.#pty = null;
    activePty.kill();
    this.#options.emit(
      bridgeEventSchema.parse({
        type: "run.status.changed",
        runId: this.#options.context.runId,
        status: "CANCELLED",
        occurredAt: this.#options.now(),
        reason: reason ?? "received cancel command",
      })
    );
  }

  heartbeat() {
    this.#lastHeartbeatAt = this.#options.now();
    return bridgeEventSchema.parse({
      type: "heartbeat",
      runId: this.#options.context.runId,
      occurredAt: this.#lastHeartbeatAt,
    });
  }

  stop() {
    this.cancel("Bridge is shutting down the current Codex session");
  }

  getDiagnostics(): CodexSessionDiagnostics {
    return {
      protocol: "legacy-pty",
      running: this.#pty !== null,
      recovering: this.#recovering,
      status: this.#status,
      command: this.#options.launch.command,
      args: [...(this.#options.launch.args ?? [])],
      cwd: this.#options.launch.cwd,
      runtimeEnvCount: Object.keys(this.#runtimeEnv).length,
      requestedInitialMessageConfigured: Boolean(this.#options.context.requestedInitialMessage),
      autoRestartEnabled: this.#options.recovery.maxRestartAttempts > 0,
      maxRestartAttempts: this.#options.recovery.maxRestartAttempts,
      restartBackoffMs: this.#options.recovery.restartBackoffMs,
      restartResetWindowMs: this.#options.recovery.restartResetWindowMs,
      restartBudgetUsed: this.#restartBudgetUsed,
      replayHistoryCount: this.#replayHistory.length,
      replayHistoryBytes: this.#replayHistoryBytes,
      threadId: null,
      currentTurnId: null,
      currentTurnState: null,
      eventHighWatermark: 0,
      pendingRequestCount: 0,
      pendingApprovalCount: 0,
      startedAt: this.#startedAt,
      lastLaunchAt: this.#lastLaunchAt,
      lastStdoutAt: this.#lastStdoutAt,
      lastMessageAt: this.#lastMessageAt,
      lastApprovalAt: this.#lastApprovalAt,
      lastCancelAt: this.#lastCancelAt,
      lastHeartbeatAt: this.#lastHeartbeatAt,
      lastUnexpectedExitAt: this.#lastUnexpectedExitAt,
      lastRestartAt: this.#lastRestartAt,
      lastRestartReason: this.#lastRestartReason,
      lastExitCode: this.#lastExitCode,
      lastExitSignal: this.#lastExitSignal,
      terminalStatusOnExit: this.#terminalStatusOnExit,
      restartAttemptsTotal: this.#restartAttemptsTotal,
      restartSuccessTotal: this.#restartSuccessTotal,
      restartFailuresTotal: this.#restartFailuresTotal,
    };
  }

  #buildResolvedCommandEnv() {
    return {
      ...process.env,
      ...this.#options.launch.env,
      ...this.#runtimeEnv,
    };
  }

  #writeToPty(input: string) {
    if (!this.#pty) {
      return;
    }

    this.#pty.write(normalizePtyInput(input));
  }

  #recordReplayInput(payload: string) {
    this.#replayHistory.push(payload);
    this.#replayHistoryBytes += Buffer.byteLength(payload, "utf8");

    while (
      this.#replayHistory.length > MAX_REPLAY_HISTORY_ENTRIES ||
      this.#replayHistoryBytes > MAX_REPLAY_HISTORY_BYTES
    ) {
      const removed = this.#replayHistory.shift();
      if (!removed) {
        break;
      }
      this.#replayHistoryBytes = Math.max(
        0,
        this.#replayHistoryBytes - Buffer.byteLength(removed, "utf8")
      );
    }
  }

  #emitSystemStatusMessage(text: string) {
    this.#options.emit(
      createMessageEvent(
        this.#options.context.runId,
        "system",
        "status",
        text,
        this.#options.now()
      )
    );
  }

  #writeInitialInputs() {
    if (this.#options.context.deferInitialTurn) {
      return;
    }
    this.#writeToPty(`${this.#options.context.initialPrompt}\n`);
    if (this.#options.context.requestedInitialMessage) {
      this.#writeToPty(`${this.#options.context.requestedInitialMessage}\n`);
    }
  }

  #replaySessionInputs() {
    this.#writeInitialInputs();
    for (const payload of this.#replayHistory) {
      this.#writeToPty(payload);
    }
    return this.#replayHistory.length;
  }

  #clearRestartTimer() {
    if (!this.#restartTimer) {
      return;
    }

    clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
  }

  #shouldResetRestartBudget(now: string) {
    if (this.#options.recovery.restartResetWindowMs <= 0 || !this.#lastLaunchAt) {
      return false;
    }

    const launchedAtMs = Date.parse(this.#lastLaunchAt);
    const nowMs = Date.parse(now);

    if (!Number.isFinite(launchedAtMs) || !Number.isFinite(nowMs)) {
      return false;
    }

    return nowMs - launchedAtMs >= this.#options.recovery.restartResetWindowMs;
  }

  #launchSession(options: { recovery: boolean }) {
    const resolvedEnv = this.#buildResolvedCommandEnv();
    const resolvedCommand = resolveExecutablePath(this.#options.launch.command, resolvedEnv);
    const launchedAt = this.#options.now();
    const spawned = pty.spawn(resolvedCommand, this.#options.launch.args ?? [], {
      name: "xterm-color",
      cwd: this.#options.launch.cwd,
      env: resolvedEnv,
      cols: this.#options.launch.cols ?? 120,
      rows: this.#options.launch.rows ?? 40,
    });

    this.#pty = spawned;
    this.#lastLaunchAt = launchedAt;
    this.#terminalStatusOnExit = null;

    spawned.onData((data) => {
      this.#lastStdoutAt = this.#options.now();
      this.#parser.pushStdout(data);
    });

    spawned.onExit(({ exitCode, signal }) => {
      this.#parser.flush();
      void this.#handleExit(exitCode, signal ?? null);
    });

    if (!options.recovery) {
      this.#options.emit(
        bridgeEventSchema.parse({
          type: "run.status.changed",
          runId: this.#options.context.runId,
          status: "RUNNING",
          occurredAt: this.#options.now(),
          reason: "container bridge established the Codex session",
        })
      );
      this.#status = "RUNNING";
      this.#writeInitialInputs();
      return 0;
    }

    this.#recovering = false;
    this.#status = "RUNNING";
    this.#lastRestartAt = this.#options.now();
    this.#restartSuccessTotal += 1;
    const replayedInputsCount = this.#replaySessionInputs();
    this.#emitSystemStatusMessage(
      replayedInputsCount > 0
        ? `Bridge recovered the Codex session and replayed ${replayedInputsCount} prior input(s). Please verify context continuity.`
        : "Bridge recovered the Codex session after an unexpected exit."
    );
    return replayedInputsCount;
  }

  async #handleExit(exitCode: number, signal: number | null) {
    this.#lastExitCode = exitCode;
    this.#lastExitSignal = signal;
    this.#pty = null;

    if (this.#terminalStatusOnExit === "CANCELLED") {
      this.#terminalStatusOnExit = null;
      this.#recovering = false;
      this.#status = "CANCELLED";
      return;
    }

    if (exitCode === 0) {
      this.#recovering = false;
      this.#status = "SUCCEEDED";
      this.#options.emit(
        bridgeEventSchema.parse({
          type: "run.status.changed",
          runId: this.#options.context.runId,
          status: "SUCCEEDED",
          occurredAt: this.#options.now(),
          reason: "Codex CLI exited normally",
        })
      );
      return;
    }

    const unexpectedExitAt = this.#options.now();
    this.#lastUnexpectedExitAt = unexpectedExitAt;
    const exitReason = `Codex CLI exited unexpectedly (exitCode=${exitCode}, signal=${signal})`;

    if (!this.#stopRequested && this.#options.recovery.maxRestartAttempts > 0) {
      if (this.#shouldResetRestartBudget(unexpectedExitAt)) {
        this.#restartBudgetUsed = 0;
      }

      if (this.#restartBudgetUsed < this.#options.recovery.maxRestartAttempts) {
        this.#scheduleRecoveryAttempt(exitReason);
        return;
      }
    }

    this.#recovering = false;
    this.#status = "FAILED";
    this.#emitSystemStatusMessage(
      this.#options.recovery.maxRestartAttempts > 0
        ? `Bridge exhausted automatic recovery for the Codex session. Final reason: ${exitReason}`
        : exitReason
    );
    this.#options.emit(
      bridgeEventSchema.parse({
        type: "run.status.changed",
        runId: this.#options.context.runId,
        status: "FAILED",
        occurredAt: unexpectedExitAt,
        reason: exitReason,
      })
    );
  }

  #scheduleRecoveryAttempt(reason: string) {
    this.#clearRestartTimer();
    this.#recovering = true;
    this.#restartBudgetUsed += 1;
    this.#restartAttemptsTotal += 1;
    this.#lastRestartReason = reason;

    const attempt = this.#restartBudgetUsed;
    const maxAttempts = this.#options.recovery.maxRestartAttempts;
    this.#emitSystemStatusMessage(
      `Codex session exited unexpectedly. Bridge is attempting automatic recovery (${attempt}/${maxAttempts}).`
    );

    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#performRecoveryAttempt(reason);
    }, this.#options.recovery.restartBackoffMs);
    this.#restartTimer.unref?.();
  }

  async #performRecoveryAttempt(reason: string) {
    if (this.#stopRequested || !this.#recovering) {
      return;
    }

    try {
      this.#launchSession({
        recovery: true,
      });
    } catch (error) {
      this.#recovering = false;
      this.#restartFailuresTotal += 1;
      this.#status = "FAILED";
      const failureReason =
        `Bridge failed to recover the Codex session after unexpected exit: ${reason}. ` +
        `Recovery error: ${error instanceof Error ? error.message : String(error)}`;
      this.#emitSystemStatusMessage(failureReason);
      this.#options.emit(
        bridgeEventSchema.parse({
          type: "run.status.changed",
          runId: this.#options.context.runId,
          status: "FAILED",
          occurredAt: this.#options.now(),
          reason: failureReason,
        })
      );
    }
  }
}
