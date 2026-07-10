import chokidar, { type FSWatcher } from "chokidar";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  bridgeEventSchema,
  mcpCallObservationSchema,
  type BridgeEvent,
  type BridgeSessionContext,
  type McpCallObservation,
  type McpCallRecord,
} from "@lingban/contracts";
import type { McpCallAuditWatcherDiagnostics } from "../observability.js";

type McpCallAuditWatcherOptions = {
  context: BridgeSessionContext;
  auditLogPath: string;
  emit: (event: BridgeEvent) => void;
  now?: () => string;
};

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildCallId(observation: McpCallObservation) {
  return observation.callId?.trim() || `mcpcall_${randomUUID()}`;
}

export class McpCallAuditWatcher {
  #options: Required<McpCallAuditWatcherOptions>;
  #watcher: FSWatcher | null = null;
  #offset = 0;
  #remainder = "";
  #pollChain: Promise<void> = Promise.resolve();
  #processedEventsTotal = 0;
  #processedFailuresTotal = 0;
  #lastProcessedAt: string | null = null;
  #lastCallId: string | null = null;
  #lastErrorAt: string | null = null;
  #lastErrorMessage: string | null = null;

  constructor(options: McpCallAuditWatcherOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  async start() {
    await fs.mkdir(path.dirname(this.#options.auditLogPath), { recursive: true });
    await fs.writeFile(this.#options.auditLogPath, "", {
      encoding: "utf8",
      flag: "a",
    });

    this.#watcher = chokidar.watch(this.#options.auditLogPath, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 20,
      },
    });

    const triggerPoll = () => {
      this.#pollChain = this.#pollChain
        .catch(() => undefined)
        .then(async () => {
          await this.#poll();
        });
    };

    this.#watcher.on("add", triggerPoll);
    this.#watcher.on("change", triggerPoll);
    triggerPoll();
  }

  async stop() {
    await this.#pollChain.catch(() => undefined);
    if (this.#watcher) {
      await this.#watcher.close();
      this.#watcher = null;
    }
  }

  async #poll() {
    const handle = await fs.open(this.#options.auditLogPath, "r");

    try {
      const stat = await handle.stat();
      if (stat.size < this.#offset) {
        this.#offset = 0;
        this.#remainder = "";
      }

      if (stat.size === this.#offset) {
        return;
      }

      const bytesToRead = stat.size - this.#offset;
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, this.#offset);
      this.#offset += bytesRead;

      const payload = `${this.#remainder}${buffer.subarray(0, bytesRead).toString("utf8")}`;
      const lines = payload.split(/\r?\n/);
      this.#remainder = lines.pop() ?? "";

      for (const rawLine of lines.map((line) => line.trim()).filter(Boolean)) {
        try {
          this.#emitObservation(rawLine);
        } catch (error) {
          this.#processedFailuresTotal += 1;
          this.#lastErrorAt = this.#options.now();
          this.#lastErrorMessage = toErrorMessage(error);
          console.error(
            `[lingban-bridge] failed to ingest MCP audit line: ${this.#lastErrorMessage}`
          );
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  #emitObservation(rawLine: string) {
    const parsed = mcpCallObservationSchema.parse(JSON.parse(rawLine) as unknown);
    const callId = buildCallId(parsed);
    const binding =
      (parsed.bindingId
        ? this.#options.context.mcpBindings.find((item) => item.bindingId === parsed.bindingId)
        : null) ??
      this.#options.context.mcpBindings.find((item) => item.mcpId === parsed.mcpId);

    if (!binding) {
      throw new Error(`No MCP binding found for audit event: ${parsed.mcpId}`);
    }

    const occurredAt = parsed.finishedAt;
    const recordedAt = this.#options.now();
    const durationMs =
      parsed.durationMs ??
      Math.max(0, new Date(parsed.finishedAt).getTime() - new Date(parsed.startedAt).getTime());

    const record: McpCallRecord = {
      ...parsed,
      callId,
      bindingId: binding.bindingId,
      runId: this.#options.context.runId,
      workspaceId: this.#options.context.workspaceId,
      requestedByUserId: this.#options.context.requestedByUserId,
      workspaceContextKey: this.#options.context.workspaceContextKey,
      serviceId: this.#options.context.serviceId,
      taskVersionId: this.#options.context.taskVersionId,
      sessionVersionId: this.#options.context.sessionVersionId,
      entrySurface: this.#options.context.entrySurface,
      displayName: binding.displayName,
      source: binding.source,
      transport: binding.transport,
      ref: binding.ref,
      riskLevel: binding.riskLevel,
      networkPolicyRef: binding.networkPolicyRef,
      approvalRequired: binding.approvalRequired,
      durationMs,
      occurredAt,
      recordedAt,
    };

    this.#processedEventsTotal += 1;
    this.#lastProcessedAt = recordedAt;
    this.#lastCallId = callId;
    this.#lastErrorAt = null;
    this.#lastErrorMessage = null;

    this.#options.emit(
      bridgeEventSchema.parse({
        type: "mcp.call",
        call: record,
      })
    );
  }

  getDiagnostics(): McpCallAuditWatcherDiagnostics {
    return {
      running: this.#watcher !== null,
      auditLogPath: this.#options.auditLogPath,
      processedEventsTotal: this.#processedEventsTotal,
      processedFailuresTotal: this.#processedFailuresTotal,
      lastProcessedAt: this.#lastProcessedAt,
      lastCallId: this.#lastCallId,
      lastErrorAt: this.#lastErrorAt,
      lastErrorMessage: this.#lastErrorMessage,
      fileOffsetBytes: this.#offset,
      bufferedRemainderBytes: Buffer.byteLength(this.#remainder, "utf8"),
    };
  }
}
