import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import {
  bridgeEventSchema,
  runApprovalSchema,
  runConversationMessageSchema,
  type AgentRuntimeConnectionState,
  type AgentTurnState,
  type ApproveRunInput,
  type BridgeEvent,
  type BridgeSessionContext,
  type McpCallObservation,
  type RunApproval,
  type RunApprovalMode,
  type SendRunMessageInput,
} from "@lingban/contracts";
import type { CodexSessionDiagnostics } from "../observability.js";
import type { AgentSession } from "./agent-session.js";
import { extractAgentMediaAttachments } from "./agent-message-images.js";

type JsonRpcId = string | number;
type JsonRecord = Record<string, unknown>;

type AppServerSessionOptions = {
  context: BridgeSessionContext;
  launch: {
    command: string;
    args?: string[];
    cwd: string;
    env?: Record<string, string>;
  };
  emit: (event: BridgeEvent) => void;
  now?: () => string;
  requestTimeoutMs?: number;
  includeDefaultAppServerArgs?: boolean;
  observeMcpCall?: (observation: McpCallObservation) => void;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type UserInputQuestion = {
  id: string;
  header: string | null;
  question: string;
  options: Array<{ label: string; description: string | null }>;
};

type PendingUserInputRequest = {
  requestId: JsonRpcId;
  questions: UserInputQuestion[];
  responseKind: "codex-user-input" | "mcp-elicitation-form" | "mcp-elicitation-url";
};

type PendingApprovalRequest = {
  requestId: JsonRpcId;
  approval: RunApproval;
  responseKind: "decision" | "mcp-elicitation";
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function resolveExecutablePath(command: string) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  return command;
}

function formatUserMessage(input: SendRunMessageInput) {
  const lines = [input.text];
  for (const attachment of input.attachments) {
    lines.push(`Attachment: ${attachment.label} (${attachment.path})`);
  }
  return lines.join("\n");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseUserInputQuestions(message: JsonRecord): UserInputQuestion[] {
  const params = isRecord(message.params) ? message.params : null;
  if (!Array.isArray(params?.questions)) return [];
  return params.questions.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = readString(value.id);
    const question = readString(value.question);
    if (!id || !question) return [];
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => {
          if (!isRecord(option)) return [];
          const label = readString(option.label);
          if (!label) return [];
          return [{ label, description: readString(option.description) }];
        })
      : [];
    return [{ id, header: readString(value.header), question, options }];
  });
}

function formatUserInputQuestions(questions: UserInputQuestion[]) {
  return questions.map((question, index) => {
    const heading = question.header ? `${index + 1}. ${question.header}` : `${index + 1}.`;
    const options = question.options.length
      ? `\n${question.options.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n")}`
      : "";
    return `${heading} ${question.question}${options}`;
  }).join("\n\n");
}

function buildUserInputAnswers(request: PendingUserInputRequest, input: SendRunMessageInput) {
  const explicit = new Map(input.slotValues.map((value) => [value.slotKey, value.valueText]));
  const lines = input.text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const answers = Object.fromEntries(request.questions.map((question, index) => {
    const explicitAnswer = explicit.get(question.id);
    const fallback = request.questions.length === 1
      ? input.text
      : lines[index] ?? (index === 0 ? input.text : "");
    return [question.id, explicitAnswer ?? fallback];
  }));

  if (request.responseKind === "mcp-elicitation-url") {
    return { action: "accept" };
  }
  if (request.responseKind === "mcp-elicitation-form") {
    return { action: "accept", content: answers };
  }
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([key, value]) => [key, { answers: [value].filter(Boolean) }])
    ),
  };
}

function parseMcpElicitationQuestions(message: JsonRecord): {
  questions: UserInputQuestion[];
  responseKind: PendingUserInputRequest["responseKind"];
} {
  const params = isRecord(message.params) ? message.params : {};
  const mode = readString(params.mode);
  const prompt = readString(params.message) ?? "The MCP server requires additional information.";
  if (mode === "url") {
    const url = readString(params.url);
    return {
      responseKind: "mcp-elicitation-url",
      questions: [{
        id: "confirmation",
        header: "MCP authorization",
        question: [prompt, url].filter(Boolean).join("\n"),
        options: [],
      }],
    };
  }

  const requestedSchema = isRecord(params.requestedSchema) ? params.requestedSchema : {};
  const properties = isRecord(requestedSchema.properties) ? requestedSchema.properties : {};
  const questions = Object.entries(properties).flatMap(([id, rawProperty]) => {
    if (!isRecord(rawProperty)) return [];
    const values = Array.isArray(rawProperty.enum)
      ? rawProperty.enum.filter((value): value is string => typeof value === "string")
      : [];
    return [{
      id,
      header: readString(rawProperty.title),
      question: readString(rawProperty.description) ?? `${prompt}\n${id}`,
      options: values.map((value) => ({ label: value, description: null })),
    }];
  });

  return {
    responseKind: "mcp-elicitation-form",
    questions: questions.length
      ? questions
      : [{ id: "value", header: null, question: prompt, options: [] }],
  };
}

function extractThreadId(message: JsonRecord) {
  const params = isRecord(message.params) ? message.params : null;
  const result = isRecord(message.result) ? message.result : null;
  const thread = isRecord(params?.thread) ? params.thread : isRecord(result?.thread) ? result.thread : null;
  return readString(thread?.id) ?? readString(params?.threadId) ?? readString(result?.threadId);
}

function extractTurnId(message: JsonRecord) {
  const params = isRecord(message.params) ? message.params : null;
  const result = isRecord(message.result) ? message.result : null;
  const turn = isRecord(params?.turn) ? params.turn : isRecord(result?.turn) ? result.turn : null;
  return readString(turn?.id) ?? readString(params?.turnId) ?? readString(result?.turnId);
}

function extractItem(message: JsonRecord) {
  const params = isRecord(message.params) ? message.params : null;
  return isRecord(params?.item) ? params.item : null;
}

function extractAgentText(item: JsonRecord | null) {
  if (!item) return null;
  const type = readString(item.type);
  if (type !== "agentMessage" && type !== "assistantMessage" && type !== "assistant_message") {
    return null;
  }
  const directText = readString(item.text);
  if (directText) return directText;
  if (!Array.isArray(item.content)) return null;
  const text = item.content
    .map((part) => (isRecord(part) ? readString(part.text) : null))
    .filter((part): part is string => Boolean(part))
    .join("\n");
  return text || null;
}

const sensitiveKeyPattern = /api[-_]?key|authorization|bearer|cookie|password|secret|token/i;
const sensitiveValuePattern = /(Bearer\s+)[^\s"']+|\bsk-[A-Za-z0-9_-]{8,}\b/gi;

function redactAuditValue(value: unknown, key: string | null = null): unknown {
  if (key && sensitiveKeyPattern.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value.replace(sensitiveValuePattern, (_match, bearerPrefix) =>
      bearerPrefix ? `${bearerPrefix}[REDACTED]` : "[REDACTED]"
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactAuditValue(entryValue, entryKey),
    ])
  );
}

function serializeAuditValue(value: unknown) {
  if (value == null) return null;
  const redacted = redactAuditValue(value);
  const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  if (!serialized.trim()) return null;
  return serialized.length > 4_000 ? `${serialized.slice(0, 3_997)}...` : serialized;
}

function byteLength(value: unknown) {
  if (value == null) return null;
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

function extractMcpCallObservation(
  item: JsonRecord | null,
  context: BridgeSessionContext,
  finishedAt: string
): McpCallObservation | null {
  if (!item || readString(item.type) !== "mcpToolCall") return null;
  const bindingRef = readString(item.server);
  const toolName = readString(item.tool);
  if (!bindingRef || !toolName) return null;
  const binding = context.mcpBindings.find(
    (candidate) => candidate.bindingId === bindingRef || candidate.mcpId === bindingRef
  );
  if (!binding) return null;

  const durationMs = typeof item.durationMs === "number" && item.durationMs >= 0
    ? Math.round(item.durationMs)
    : null;
  const finishedTimestamp = new Date(finishedAt).getTime();
  const startedAt = durationMs == null || !Number.isFinite(finishedTimestamp)
    ? finishedAt
    : new Date(finishedTimestamp - durationMs).toISOString();
  const error = isRecord(item.error) ? item.error : null;
  const status = readString(item.status);

  return {
    callId: readString(item.id) ?? undefined,
    mcpId: binding.mcpId,
    bindingId: binding.bindingId,
    toolName,
    requestId: readString(item.id),
    status: status === "failed" ? "error" : status === "completed" ? "success" : "cancelled",
    startedAt,
    finishedAt,
    durationMs,
    inputSummary: serializeAuditValue(item.arguments),
    outputSummary: serializeAuditValue(item.result),
    errorMessage: serializeAuditValue(error?.message),
    inputBytes: byteLength(item.arguments),
    outputBytes: byteLength(item.result),
  };
}

export class AppServerSession implements AgentSession {
  #options: Required<Pick<AppServerSessionOptions, "context" | "launch" | "emit">> & {
    now: () => string;
    requestTimeoutMs: number;
    includeDefaultAppServerArgs: boolean;
    observeMcpCall?: (observation: McpCallObservation) => void;
  };
  #process: ChildProcessWithoutNullStreams | null = null;
  #runtimeEnv: Record<string, string> = {};
  #threadConfig: JsonRecord = {};
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #nextRequestId = 1;
  #pendingRequests = new Map<JsonRpcId, PendingRequest>();
  #approvalRequests = new Map<string, PendingApprovalRequest>();
  #decidedApprovals = new Map<string, boolean>();
  #approvalMode: RunApprovalMode;
  #userInputRequests = new Map<string, PendingUserInputRequest>();
  #sequence = 0;
  #threadId: string | null = null;
  #protocolVersion: string | null = null;
  #turnId: string | null = null;
  #turnState: AgentTurnState | null = null;
  #connectionState: AgentRuntimeConnectionState = "stopped";
  #startedAt: string | null = null;
  #lastLaunchAt: string | null = null;
  #lastStdoutAt: string | null = null;
  #lastMessageAt: string | null = null;
  #lastApprovalAt: string | null = null;
  #lastCancelAt: string | null = null;
  #lastHeartbeatAt: string | null = null;
  #lastUnexpectedExitAt: string | null = null;
  #lastExitCode: number | null = null;
  #lastExitSignal: number | null = null;
  #stopping = false;
  #deferredInitialPromptPending = false;

  constructor(options: AppServerSessionOptions) {
    this.#options = {
      context: options.context,
      launch: options.launch,
      emit: options.emit,
      now: options.now ?? (() => new Date().toISOString()),
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      includeDefaultAppServerArgs: options.includeDefaultAppServerArgs ?? true,
      observeMcpCall: options.observeMcpCall,
    };
    this.#sequence = Date.now() * 1_000 + Math.floor(Math.random() * 1_000);
    this.#approvalMode = options.context.approvalMode;
    this.#deferredInitialPromptPending = options.context.deferInitialTurn;
  }

  setRuntimeEnv(env: Record<string, string>) {
    this.#runtimeEnv = { ...this.#runtimeEnv, ...env };
  }

  setThreadConfig(config: Record<string, unknown>) {
    this.#threadConfig = { ...this.#threadConfig, ...config };
  }

  async start() {
    if (this.#process) return;
    this.#stopping = false;
    this.#startedAt = this.#startedAt ?? this.#options.now();
    this.#lastLaunchAt = this.#options.now();
    this.#setConnectionState("starting");
    this.#emitRunStatus("STARTING", "container bridge is starting Codex App Server");

    const args = [
      ...(this.#options.includeDefaultAppServerArgs ? ["app-server", "--listen", "stdio://"] : []),
      ...(this.#options.launch.args ?? []),
    ];
    const child = spawn(resolveExecutablePath(this.#options.launch.command), args, {
      cwd: this.#options.launch.cwd,
      env: { ...process.env, ...this.#options.launch.env, ...this.#runtimeEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#pushStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.#pushStderr(chunk));
    child.on("error", (error) => this.#handleProcessError(error));
    child.on("exit", (code, signal) => this.#handleExit(code, signal));

    this.#setConnectionState("initializing");
    const initializeResult = await this.#request("initialize", {
      clientInfo: { name: "lingban-container-bridge", title: "Lingban Agent Workshop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    if (isRecord(initializeResult)) this.#protocolVersion = readString(initializeResult.protocolVersion);
    this.#notify("initialized", {});
    const threadResult = await this.#request("thread/start", {
      cwd: this.#options.launch.cwd,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      experimentalRawEvents: true,
      config: this.#threadConfig,
    });
    if (isRecord(threadResult)) {
      this.#threadId = extractThreadId({ result: threadResult }) ?? this.#threadId;
    }
    if (!this.#threadId) throw new Error("Codex App Server thread/start returned no thread id");
    this.#setConnectionState("ready");
    this.#emitRunStatus("RUNNING", "container bridge established the Codex App Server thread");

    const initialText = [
      this.#options.context.initialPrompt,
      this.#options.context.requestedInitialMessage,
    ].filter((value): value is string => Boolean(value)).join("\n\n");
    if (initialText && !this.#options.context.deferInitialTurn) await this.#startTurn(initialText);
  }

  async sendMessage(input: SendRunMessageInput) {
    if (!this.#process || !this.#threadId) throw new Error("Codex App Server thread is not ready");
    this.#lastMessageAt = this.#options.now();
    const pendingInput = this.#userInputRequests.values().next().value as PendingUserInputRequest | undefined;
    if (pendingInput) {
      this.#userInputRequests.delete(String(pendingInput.requestId));
      this.#respond(pendingInput.requestId, buildUserInputAnswers(pendingInput, input));
      this.#setConnectionState(this.#turnState === "in_progress" ? "turn_running" : "ready");
      return;
    }
    if (this.#turnState === "in_progress") {
      if (!this.#turnId) throw new Error("Codex App Server active turn id is unavailable");
      await this.#request("turn/steer", {
        threadId: this.#threadId,
        expectedTurnId: this.#turnId,
        clientUserMessageId: `msg_${randomUUID()}`,
        input: [{ type: "text", text: formatUserMessage(input) }],
      });
      return;
    }
    const userText = formatUserMessage(input);
    const turnText = this.#deferredInitialPromptPending
      ? [this.#options.context.initialPrompt, userText].filter(Boolean).join("\n\n")
      : userText;
    this.#deferredInitialPromptPending = false;
    await this.#startTurn(turnText);
  }

  async approve(input: ApproveRunInput) {
    const approvalId = input.approvalId ?? this.#approvalRequests.keys().next().value;
    if (!approvalId) throw new Error("No pending Codex App Server approval request");
    const pending = this.#approvalRequests.get(approvalId);
    if (!pending) {
      if (this.#decidedApprovals.get(approvalId) === input.approved) return;
      throw new Error(`Unknown Codex App Server approval: ${approvalId}`);
    }
    this.#decideApproval(approvalId, pending, input.approved, false, input.note ?? null);
  }

  setApprovalMode(approvalMode: RunApprovalMode) {
    this.#approvalMode = approvalMode;
    if (approvalMode !== "auto_all") return;

    for (const [approvalId, pending] of [...this.#approvalRequests.entries()]) {
      this.#decideApproval(
        approvalId,
        pending,
        true,
        true,
        "Automatically approved by the instance approval policy."
      );
    }
  }

  async cancel(reason?: string) {
    if (!this.#process) return;
    this.#lastCancelAt = this.#options.now();
    this.#stopping = true;
    this.#setConnectionState("stopping");
    if (this.#threadId && this.#turnId && this.#turnState === "in_progress") {
      await this.#request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId }).catch(() => undefined);
    }
    this.#emitRunStatus("CANCELLED", reason ?? "received cancel command");
    this.#process.kill();
  }

  heartbeat() {
    this.#lastHeartbeatAt = this.#options.now();
    return bridgeEventSchema.parse({
      type: "heartbeat",
      runId: this.#options.context.runId,
      occurredAt: this.#lastHeartbeatAt,
    });
  }

  async stop() {
    if (!this.#process) return;
    const child = this.#process;
    this.#stopping = true;
    this.#setConnectionState("stopping");
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex App Server stopped"));
    }
    this.#pendingRequests.clear();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      }),
    ]);
    this.#process = null;
    this.#setConnectionState("stopped");
  }

  getDiagnostics(): CodexSessionDiagnostics {
    return {
      protocol: "app-server",
      running: this.#process !== null,
      recovering: false,
      status: this.#connectionState,
      command: this.#options.launch.command,
      args: [
        ...(this.#options.includeDefaultAppServerArgs ? ["app-server", "--listen", "stdio://"] : []),
        ...(this.#options.launch.args ?? []),
      ],
      cwd: this.#options.launch.cwd,
      runtimeEnvCount: Object.keys(this.#runtimeEnv).length,
      requestedInitialMessageConfigured: Boolean(this.#options.context.requestedInitialMessage),
      autoRestartEnabled: false,
      maxRestartAttempts: 0,
      restartBackoffMs: 0,
      restartResetWindowMs: 0,
      restartBudgetUsed: 0,
      replayHistoryCount: 0,
      replayHistoryBytes: 0,
      threadId: this.#threadId,
      currentTurnId: this.#turnId,
      currentTurnState: this.#turnState,
      eventHighWatermark: this.#sequence,
      pendingRequestCount: this.#pendingRequests.size,
      pendingApprovalCount: this.#approvalRequests.size,
      approvalMode: this.#approvalMode,
      startedAt: this.#startedAt,
      lastLaunchAt: this.#lastLaunchAt,
      lastStdoutAt: this.#lastStdoutAt,
      lastMessageAt: this.#lastMessageAt,
      lastApprovalAt: this.#lastApprovalAt,
      lastCancelAt: this.#lastCancelAt,
      lastHeartbeatAt: this.#lastHeartbeatAt,
      lastUnexpectedExitAt: this.#lastUnexpectedExitAt,
      lastRestartAt: null,
      lastRestartReason: null,
      lastExitCode: this.#lastExitCode,
      lastExitSignal: this.#lastExitSignal,
      terminalStatusOnExit: null,
      restartAttemptsTotal: 0,
      restartSuccessTotal: 0,
      restartFailuresTotal: 0,
    };
  }

  async #startTurn(text: string) {
    if (!this.#threadId) throw new Error("Codex App Server thread is unavailable");
    this.#turnState = "pending";
    this.#setConnectionState("turn_running");
    const result = await this.#request("turn/start", {
      threadId: this.#threadId,
      input: [{ type: "text", text }],
      cwd: this.#options.launch.cwd,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [this.#options.launch.cwd],
        networkAccess: true,
      },
    });
    if (isRecord(result)) {
      this.#turnId = extractTurnId({ result }) ?? this.#turnId;
    }
    this.#emitThreadState();
  }

  #request(method: string, params: JsonRecord) {
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.#options.requestTimeoutMs);
      timer.unref?.();
      this.#pendingRequests.set(id, { method, resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #notify(method: string, params: JsonRecord) {
    this.#write({ method, params });
  }

  #respond(id: JsonRpcId, result: JsonRecord) {
    this.#write({ id, result });
  }

  #write(message: JsonRecord) {
    if (!this.#process?.stdin.writable) throw new Error("Codex App Server stdin is unavailable");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #pushStdout(chunk: string) {
    this.#lastStdoutAt = this.#options.now();
    this.#stdoutBuffer += chunk;
    const lines = this.#stdoutBuffer.split(/\r?\n/);
    this.#stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.#handleLine(line);
  }

  #pushStderr(chunk: string) {
    this.#stderrBuffer = (this.#stderrBuffer + chunk).slice(-32_768);
  }

  #handleLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#emitRawEvent("protocol/parseError", { rawLine: line }, null);
      return;
    }
    if (!isRecord(message)) {
      this.#emitRawEvent("protocol/invalidMessage", message, null);
      return;
    }

    const sourceRequestId = message.id == null ? null : String(message.id);
    const method = readString(message.method);
    const discoveredThreadId = extractThreadId(message);
    if (discoveredThreadId) this.#threadId = discoveredThreadId;
    const discoveredTurnId = extractTurnId(message);
    if (discoveredTurnId) this.#turnId = discoveredTurnId;
    this.#emitRawEvent(method ?? (message.error ? "response/error" : "response/result"), message, sourceRequestId);

    if (message.id != null && !method && this.#pendingRequests.has(message.id as JsonRpcId)) {
      const pending = this.#pendingRequests.get(message.id as JsonRpcId)!;
      this.#pendingRequests.delete(message.id as JsonRpcId);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`Codex App Server ${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
    }

    if (method === "turn/started") {
      this.#turnState = "in_progress";
      this.#setConnectionState("turn_running");
    } else if (method === "turn/completed") {
      const params = isRecord(message.params) ? message.params : null;
      const turn = isRecord(params?.turn) ? params.turn : null;
      const status = readString(turn?.status);
      this.#turnState = status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
      this.#userInputRequests.clear();
      this.#setConnectionState("ready");
    } else if (method === "item/completed") {
      const item = extractItem(message);
      const text = extractAgentText(item);
      if (text) this.#emitAgentMessage(text, readString(item?.id));
      const observation = extractMcpCallObservation(
        item,
        this.#options.context,
        this.#options.now()
      );
      if (observation) this.#options.observeMcpCall?.(observation);
    } else if (method === "mcpServer/elicitation/request") {
      this.#emitMcpElicitationRequest(message);
    } else if (method?.includes("requestApproval") || method === "item/tool/requestApproval") {
      this.#emitApprovalRequest(message);
    } else if (method === "item/tool/requestUserInput") {
      this.#emitUserInputRequest(message);
    } else if (method === "serverRequest/resolved") {
      const params = isRecord(message.params) ? message.params : null;
      const requestId = params?.requestId;
      if (requestId != null) this.#userInputRequests.delete(String(requestId));
    }
  }

  #emitRawEvent(eventType: string, payload: unknown, sourceRequestId: string | null) {
    this.#sequence += 1;
    const serialized = JSON.stringify(payload);
    this.#options.emit(bridgeEventSchema.parse({
      type: "agent.runtime.event",
      runId: this.#options.context.runId,
      sequence: this.#sequence,
      eventType,
      occurredAt: this.#options.now(),
      threadId: this.#threadId,
      turnId: this.#turnId,
      itemId: isRecord(payload) ? readString(extractItem(payload)?.id) : null,
      sourceRequestId,
      payload,
      payloadSha256: sha256(serialized),
    }));
  }

  #emitAgentMessage(text: string, itemId: string | null, kind: "text" | "prompt" = "text") {
    const attachments = extractAgentMediaAttachments(text, {
      targetPath: this.#options.context.targetPath,
      cwd: this.#options.launch.cwd,
    });
    this.#options.emit(bridgeEventSchema.parse({
      type: "conversation.message",
      message: runConversationMessageSchema.parse({
        messageId: `msg_${randomUUID()}`,
        runId: this.#options.context.runId,
        role: "agent",
        kind,
        text,
        attachments,
        sequence: this.#sequence,
        threadId: this.#threadId,
        turnId: this.#turnId,
        itemId,
        createdAt: this.#options.now(),
      }),
    }));
  }

  #emitApprovalRequest(
    message: JsonRecord,
    overrides: {
      kind?: RunApproval["kind"];
      prompt?: string;
      relatedResourceRef?: string | null;
      responseKind?: PendingApprovalRequest["responseKind"];
    } = {}
  ) {
    if (message.id == null) return;
    const approvalId = `apr_${randomUUID()}`;
    const params = isRecord(message.params) ? message.params : {};
    const prompt = readString(params.reason) ?? readString(params.prompt) ?? `Codex requests approval for ${readString(message.method) ?? "an action"}.`;
    const requestedAt = this.#options.now();
    const pending = {
      requestId: message.id as JsonRpcId,
      responseKind: overrides.responseKind ?? "decision",
      approval: runApprovalSchema.parse({
        approvalId,
        runId: this.#options.context.runId,
        kind: overrides.kind ?? "general",
        relatedResourceRef: overrides.relatedResourceRef ?? readString(params.itemId),
        prompt: overrides.prompt ?? prompt,
        state: "pending",
        requestedAt,
        decidedAt: null,
        decisionMode: null,
        decidedByUserId: null,
        note: null,
      }),
    } satisfies PendingApprovalRequest;

    if (this.#approvalMode === "auto_all") {
      this.#decideApproval(
        approvalId,
        pending,
        true,
        true,
        "Automatically approved by the instance approval policy."
      );
      return;
    }

    this.#approvalRequests.set(approvalId, pending);
    this.#setConnectionState("waiting_approval");
    this.#options.emit(bridgeEventSchema.parse({
      type: "approval.requested",
      approval: pending.approval,
    }));
  }

  #decideApproval(
    approvalId: string,
    pending: PendingApprovalRequest,
    approved: boolean,
    emitDecision: boolean,
    note: string | null
  ) {
    this.#approvalRequests.delete(approvalId);
    this.#decidedApprovals.set(approvalId, approved);
    this.#lastApprovalAt = this.#options.now();
    this.#respond(
      pending.requestId,
      pending.responseKind === "mcp-elicitation"
        ? approved
          ? { action: "accept", content: {} }
          : { action: "decline" }
        : { decision: approved ? "accept" : "decline" }
    );

    if (emitDecision) {
      this.#options.emit(bridgeEventSchema.parse({
        type: "approval.requested",
        approval: runApprovalSchema.parse({
          ...pending.approval,
          state: approved ? "approved" : "rejected",
          decidedAt: this.#lastApprovalAt,
          decisionMode: "auto_all",
          decidedByUserId: null,
          note,
        }),
      }));
    }

    this.#setConnectionState(this.#turnState === "in_progress" ? "turn_running" : "ready");
  }

  #emitUserInputRequest(message: JsonRecord) {
    if (message.id == null) return;
    const questions = parseUserInputQuestions(message);
    if (!questions.length) {
      this.#respond(message.id as JsonRpcId, { answers: {} });
      return;
    }
    const request: PendingUserInputRequest = {
      requestId: message.id as JsonRpcId,
      questions,
      responseKind: "codex-user-input",
    };
    this.#userInputRequests.set(String(request.requestId), request);
    this.#setConnectionState("waiting_input");
    this.#emitAgentMessage(formatUserInputQuestions(questions), null, "prompt");
  }

  #emitMcpElicitationRequest(message: JsonRecord) {
    if (message.id == null) return;
    const params = isRecord(message.params) ? message.params : {};
    const metadata = isRecord(params._meta) ? params._meta : {};
    if (readString(metadata.codex_approval_kind) === "mcp_tool_call") {
      const serverName = readString(params.serverName);
      const toolDescription = readString(metadata.tool_description);
      this.#emitApprovalRequest(message, {
        kind: "mcp-access",
        responseKind: "mcp-elicitation",
        relatedResourceRef: serverName,
        prompt: readString(params.message) ??
          `Allow ${serverName ?? "the MCP server"} to execute${toolDescription ? ` ${toolDescription}` : " this tool"}?`,
      });
      return;
    }

    const parsed = parseMcpElicitationQuestions(message);
    const request: PendingUserInputRequest = {
      requestId: message.id as JsonRpcId,
      questions: parsed.questions,
      responseKind: parsed.responseKind,
    };
    this.#userInputRequests.set(String(request.requestId), request);
    this.#setConnectionState("waiting_input");
    this.#emitAgentMessage(formatUserInputQuestions(request.questions), null, "prompt");
  }

  #setConnectionState(state: AgentRuntimeConnectionState) {
    this.#connectionState = state;
    this.#emitThreadState();
  }

  #emitThreadState() {
    this.#options.emit(bridgeEventSchema.parse({
      type: "agent.thread.state",
      runId: this.#options.context.runId,
      thread: {
        protocol: "app-server",
        threadId: this.#threadId,
        currentTurnId: this.#turnId,
        currentTurnState: this.#turnState,
        connectionState: this.#connectionState,
        eventHighWatermark: this.#sequence,
        codexVersion: null,
        protocolVersion: this.#protocolVersion,
        lastEventAt: this.#options.now(),
      },
      occurredAt: this.#options.now(),
    }));
  }

  #emitRunStatus(status: "STARTING" | "RUNNING" | "FAILED" | "CANCELLED", reason: string) {
    this.#options.emit(bridgeEventSchema.parse({
      type: "run.status.changed",
      runId: this.#options.context.runId,
      status,
      occurredAt: this.#options.now(),
      reason,
    }));
  }

  #handleProcessError(error: Error) {
    if (this.#stopping) return;
    this.#lastUnexpectedExitAt = this.#options.now();
    this.#connectionState = "failed";
    this.#emitRunStatus("FAILED", `Codex App Server process error: ${error.message}`);
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null) {
    this.#lastExitCode = code;
    this.#lastExitSignal = signal ? 1 : null;
    this.#process = null;
    for (const pending of this.#pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex App Server exited during ${pending.method}`));
    }
    this.#pendingRequests.clear();
    if (this.#stopping) {
      this.#connectionState = "stopped";
      return;
    }
    this.#lastUnexpectedExitAt = this.#options.now();
    this.#connectionState = "failed";
    this.#emitThreadState();
    this.#emitRunStatus("FAILED", `Codex App Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`);
  }
}
