import {
  bridgeEventSchema,
  runConversationMessageSchema,
  type BridgeEvent,
  type MessageKind,
  type MessageRole,
} from "@lingban/contracts";
import { randomUUID } from "node:crypto";

type EventParserOptions = {
  runId: string;
  emit: (event: BridgeEvent) => void;
  now?: () => string;
};

function stripAnsi(value: string) {
  return value
    .replace(
      /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g,
      ""
    )
    .replace(/\d;[^\u0007]*\u0007/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
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

export class EventParser {
  #stdoutBuffer = "";
  #stderrBuffer = "";
  #options: Required<EventParserOptions>;

  constructor(options: EventParserOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  pushStdout(chunk: string) {
    this.#stdoutBuffer += chunk;
    this.#drain("stdout");
  }

  pushStderr(chunk: string) {
    this.#stderrBuffer += chunk;
    this.#drain("stderr");
  }

  flush() {
    this.#flushBuffer("stdout");
    this.#flushBuffer("stderr");
  }

  #drain(channel: "stdout" | "stderr") {
    const buffer = channel === "stdout" ? this.#stdoutBuffer : this.#stderrBuffer;
    const parts = buffer.split(/\r?\n/);
    const rest = parts.pop() ?? "";

    for (const line of parts) {
      this.#emitLine(channel, line);
    }

    if (channel === "stdout") {
      this.#stdoutBuffer = rest;
    } else {
      this.#stderrBuffer = rest;
    }
  }

  #flushBuffer(channel: "stdout" | "stderr") {
    const buffer = channel === "stdout" ? this.#stdoutBuffer : this.#stderrBuffer;
    const trimmed = buffer.trim();

    if (trimmed) {
      this.#emitLine(channel, trimmed);
    }

    if (channel === "stdout") {
      this.#stdoutBuffer = "";
    } else {
      this.#stderrBuffer = "";
    }
  }

  #emitLine(channel: "stdout" | "stderr", rawLine: string) {
    const line = stripAnsi(rawLine).trim();

    if (!line) {
      return;
    }

    const createdAt = this.#options.now();
    const event =
      channel === "stdout"
        ? createMessageEvent(this.#options.runId, "agent", "text", line, createdAt)
        : createMessageEvent(this.#options.runId, "system", "status", line, createdAt);

    this.#options.emit(event);
  }
}
