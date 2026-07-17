import { runControlCommandSchema, type BridgeEvent, type RunControlCommand } from "@lingban/contracts";
import type { ArtifactPublisher } from "./artifact-publisher.js";
import type { AgentSession } from "./agent-session.js";
import type { FileWatcher } from "./file-watcher.js";
import type { McpCallAuditWatcher } from "./mcp-call-audit-watcher.js";
import {
  createCommandCounterMap,
  type RunControlServerDiagnostics,
} from "../observability.js";

type RunControlServerOptions = {
  session: AgentSession;
  fileWatcher: FileWatcher;
  artifactPublisher: ArtifactPublisher;
  mcpCallAuditWatcher: McpCallAuditWatcher;
  emit: (event: BridgeEvent) => void;
  now?: () => string;
};

export class RunControlServer {
  #options: RunControlServerOptions;
  #commandCounts = createCommandCounterMap();
  #commandFailureCounts = createCommandCounterMap();
  #commandsTotal = 0;
  #invalidCommandsTotal = 0;
  #failuresTotal = 0;
  #lastCommandType: RunControlCommand["type"] | null = null;
  #lastCommandAt: string | null = null;
  #lastFailureAt: string | null = null;
  #lastFailureMessage: string | null = null;

  constructor(options: RunControlServerOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  async handle(command: RunControlCommand | unknown) {
    let parsed: RunControlCommand;

    try {
      parsed = runControlCommandSchema.parse(command);
    } catch (error) {
      this.#invalidCommandsTotal += 1;
      this.#failuresTotal += 1;
      this.#lastFailureAt = this.#options.now?.() ?? new Date().toISOString();
      this.#lastFailureMessage = error instanceof Error ? error.message : String(error);
      throw error;
    }

    this.#commandsTotal += 1;
    this.#commandCounts[parsed.type] += 1;
    this.#lastCommandType = parsed.type;
    this.#lastCommandAt = this.#options.now?.() ?? new Date().toISOString();

    try {
      switch (parsed.type) {
        case "sendMessage":
          await this.#options.session.sendMessage(parsed.payload);
          return { ok: true, command: parsed.type };
        case "approve":
          await this.#options.session.approve(parsed.payload);
          return { ok: true, command: parsed.type };
        case "setApprovalMode":
          await this.#options.session.setApprovalMode(parsed.payload.approvalMode);
          return { ok: true, command: parsed.type };
        case "cancel":
          await this.#options.session.cancel(parsed.reason);
          return { ok: true, command: parsed.type };
        case "ping": {
          const heartbeat = this.#options.session.heartbeat();
          this.#options.emit(heartbeat);
          return { ok: true, command: parsed.type, event: heartbeat };
        }
        case "syncFiles": {
          const files = await this.#options.fileWatcher.sync();
          return { ok: true, command: parsed.type, files };
        }
        case "flushArtifacts": {
          const artifacts = await this.#options.artifactPublisher.flush();
          return { ok: true, command: parsed.type, artifacts };
        }
        case "captureBarrier": {
          const session = this.#options.session.getDiagnostics();
          if (session.protocol !== "app-server" || !session.threadId) {
            throw new Error("Capture barrier requires an initialized Codex App Server thread");
          }
          if (session.currentTurnState === "in_progress" || session.currentTurnState === "pending") {
            throw new Error("Capture barrier requires a completed turn");
          }
          return {
            ok: true,
            command: parsed.type,
            boundary: {
              threadId: session.threadId,
              throughTurnId: session.currentTurnId,
              eventHighWatermark: session.eventHighWatermark,
              barrierReachedAt: this.#options.now?.() ?? new Date().toISOString(),
            },
          };
        }
      }
    } catch (error) {
      this.#failuresTotal += 1;
      this.#commandFailureCounts[parsed.type] += 1;
      this.#lastFailureAt = this.#options.now?.() ?? new Date().toISOString();
      this.#lastFailureMessage = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getDiagnostics(): RunControlServerDiagnostics {
    return {
      commandsTotal: this.#commandsTotal,
      commandCounts: {
        ...this.#commandCounts,
      },
      commandFailureCounts: {
        ...this.#commandFailureCounts,
      },
      invalidCommandsTotal: this.#invalidCommandsTotal,
      failuresTotal: this.#failuresTotal,
      lastCommandType: this.#lastCommandType,
      lastCommandAt: this.#lastCommandAt,
      lastFailureAt: this.#lastFailureAt,
      lastFailureMessage: this.#lastFailureMessage,
      session: this.#options.session.getDiagnostics(),
      fileWatcher: this.#options.fileWatcher.getDiagnostics(),
      artifactPublisher: this.#options.artifactPublisher.getDiagnostics(),
      mcpCallAuditWatcher: this.#options.mcpCallAuditWatcher.getDiagnostics(),
    };
  }
}

export function createRunControlServer(options: RunControlServerOptions) {
  return new RunControlServer(options);
}
