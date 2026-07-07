import { promises as fs } from "node:fs";
import path from "node:path";
import { bridgeSessionContextSchema, type BridgeEvent, type BridgeSessionContext, type RunStatus } from "@lingban/contracts";
import { buildContainerBridge } from "./index.js";

const TERMINAL_STATUSES = new Set<RunStatus>(["SUCCEEDED", "FAILED", "CANCELLED"]);

async function loadContextFromFile(filePath: string): Promise<BridgeSessionContext> {
  const content = await fs.readFile(filePath, "utf8");
  return bridgeSessionContextSchema.parse(JSON.parse(content) as unknown);
}

async function loadRuntimeHints() {
  const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH;
  if (!runtimeConfigPath) {
    return null;
  }

  try {
    const content = await fs.readFile(runtimeConfigPath, "utf8");
    return JSON.parse(content) as {
      workspace?: {
        containerPaths?: {
          outputsPath?: string;
          runtimePath?: string;
        };
      };
    };
  } catch {
    return null;
  }
}

async function main() {
  const contextPath = process.env.BRIDGE_CONTEXT_PATH ?? process.argv[2];
  if (!contextPath) {
    throw new Error("BRIDGE_CONTEXT_PATH is required");
  }

  const context = await loadContextFromFile(contextPath);
  const runtimeHints = await loadRuntimeHints();
  const runtimeDir =
    process.env.RUNTIME_DIR ??
    runtimeHints?.workspace?.containerPaths?.runtimePath ??
    path.dirname(contextPath);
  const outputsPath =
    process.env.OUTPUTS_PATH ??
    runtimeHints?.workspace?.containerPaths?.outputsPath ??
    path.posix.join(path.posix.dirname(context.targetPath), "outputs");

  let shuttingDown = false;
  let bridge:
    | Awaited<ReturnType<typeof buildContainerBridge>>
    | null = null;

  const shutdown = async (exitCode: number) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (bridge) {
      await bridge.stop().catch(() => undefined);
    }
    process.exitCode = exitCode;
  };

  const handleEvent = (event: BridgeEvent) => {
    if (event.type === "run.failed") {
      void shutdown(1);
      return;
    }

    if (event.type === "run.status.changed" && TERMINAL_STATUSES.has(event.status)) {
      void shutdown(event.status === "SUCCEEDED" ? 0 : 1);
    }
  };

  bridge = await buildContainerBridge({
    context,
    runtimeDir,
    outputsPath,
    emitEvent: handleEvent,
    codex: {
      command: process.env.CODEX_BIN,
      args: process.env.CODEX_ARGS_JSON ? JSON.parse(process.env.CODEX_ARGS_JSON) : undefined,
      cwd: context.targetPath,
    },
  });

  process.on("SIGINT", () => {
    void shutdown(130);
  });
  process.on("SIGTERM", () => {
    void shutdown(143);
  });

  await bridge.start();
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (shuttingDown) {
        resolve();
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
