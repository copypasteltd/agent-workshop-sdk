import { runControlCommandSchema, type BridgeEvent, type RunControlCommand } from "@lingban/contracts";
import type { ArtifactPublisher } from "./artifact-publisher.js";
import type { CodexSession } from "./codex-session.js";
import type { FileWatcher } from "./file-watcher.js";

type RunControlServerOptions = {
  session: CodexSession;
  fileWatcher: FileWatcher;
  artifactPublisher: ArtifactPublisher;
  emit: (event: BridgeEvent) => void;
};

export class RunControlServer {
  #options: RunControlServerOptions;

  constructor(options: RunControlServerOptions) {
    this.#options = options;
  }

  async handle(command: RunControlCommand | unknown) {
    const parsed = runControlCommandSchema.parse(command);

    switch (parsed.type) {
      case "sendMessage":
        this.#options.session.sendMessage(parsed.payload);
        return { ok: true, command: parsed.type };
      case "approve":
        this.#options.session.approve(parsed.payload);
        return { ok: true, command: parsed.type };
      case "cancel":
        this.#options.session.cancel(parsed.reason);
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
    }
  }
}

export function createRunControlServer(options: RunControlServerOptions) {
  return new RunControlServer(options);
}
