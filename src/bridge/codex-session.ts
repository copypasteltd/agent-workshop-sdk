import * as pty from "node-pty";
import {
  bridgeEventSchema,
  type ApproveRunInput,
  type BridgeEvent,
  type BridgeSessionContext,
  type SendRunMessageInput,
} from "@lingban/contracts";
import { EventParser } from "./event-parser.js";

type CodexLaunchOptions = {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
};

type CodexSessionOptions = {
  context: BridgeSessionContext;
  launch: CodexLaunchOptions;
  emit: (event: BridgeEvent) => void;
  now?: () => string;
};

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

export class CodexSession {
  #options: Required<Omit<CodexSessionOptions, "now">> & { now: () => string };
  #pty: pty.IPty | null = null;
  #parser: EventParser;
  #runtimeEnv: Record<string, string> = {};
  #terminalStatusOnExit: "CANCELLED" | null = null;

  constructor(options: CodexSessionOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date().toISOString()),
    };
    this.#parser = new EventParser({
      runId: options.context.runId,
      emit: options.emit,
      now: this.#options.now,
    });
  }

  start() {
    if (this.#pty) {
      return;
    }

    this.#terminalStatusOnExit = null;

    this.#options.emit(
      bridgeEventSchema.parse({
        type: "run.status.changed",
        runId: this.#options.context.runId,
        status: "STARTING",
        occurredAt: this.#options.now(),
        reason: "container bridge is starting Codex CLI",
      })
    );

    this.#pty = pty.spawn(this.#options.launch.command, this.#options.launch.args ?? [], {
      name: "xterm-color",
      cwd: this.#options.launch.cwd,
      env: {
        ...process.env,
        ...this.#options.launch.env,
        ...this.#runtimeEnv,
      },
      cols: this.#options.launch.cols ?? 120,
      rows: this.#options.launch.rows ?? 40,
    });

    this.#pty.onData((data) => {
      this.#parser.pushStdout(data);
    });

    this.#pty.onExit(({ exitCode, signal }) => {
      this.#parser.flush();
      if (this.#terminalStatusOnExit === "CANCELLED") {
        this.#terminalStatusOnExit = null;
        this.#pty = null;
        return;
      }

      const finalStatus = exitCode === 0 ? "SUCCEEDED" : "FAILED";
      this.#options.emit(
        bridgeEventSchema.parse({
          type: "run.status.changed",
          runId: this.#options.context.runId,
          status: finalStatus,
          occurredAt: this.#options.now(),
          reason:
            exitCode === 0
              ? "Codex CLI exited normally"
              : `Codex CLI exited unexpectedly (exitCode=${exitCode}, signal=${signal})`,
        })
      );
      this.#pty = null;
    });

    this.#options.emit(
      bridgeEventSchema.parse({
        type: "run.status.changed",
        runId: this.#options.context.runId,
        status: "RUNNING",
        occurredAt: this.#options.now(),
        reason: "container bridge established the Codex session",
      })
    );

    this.#pty.write(`${this.#options.context.initialPrompt}\n`);
    if (this.#options.context.requestedInitialMessage) {
      this.#pty.write(`${this.#options.context.requestedInitialMessage}\n`);
    }
  }

  setRuntimeEnv(env: Record<string, string>) {
    this.#runtimeEnv = {
      ...this.#runtimeEnv,
      ...env,
    };
  }

  sendMessage(input: SendRunMessageInput) {
    if (!this.#pty) {
      throw new Error("Codex session is not running");
    }

    this.#pty.write(formatUserMessage(input));
  }

  approve(input: ApproveRunInput) {
    if (!this.#pty) {
      throw new Error("Codex session is not running");
    }

    this.#pty.write(formatApproval(input));
  }

  cancel(reason?: string) {
    if (!this.#pty) {
      return;
    }

    this.#terminalStatusOnExit = "CANCELLED";

    if (reason) {
      this.#pty.write(`This run has been cancelled. Reason: ${reason}\n`);
    }

    this.#pty.kill();
    this.#options.emit(
      bridgeEventSchema.parse({
        type: "run.status.changed",
        runId: this.#options.context.runId,
        status: "CANCELLED",
        occurredAt: this.#options.now(),
        reason: reason ?? "received cancel command",
      })
    );
    this.#pty = null;
  }

  heartbeat() {
    return bridgeEventSchema.parse({
      type: "heartbeat",
      runId: this.#options.context.runId,
      occurredAt: this.#options.now(),
    });
  }

  stop() {
    this.cancel("Bridge is shutting down the current Codex session");
  }
}
