import { bridgeSessionContextSchema, type BridgeEvent, type BridgeSessionContext } from "@lingban/contracts";
import path from "node:path";
import { ArtifactPublisher } from "./bridge/artifact-publisher.js";
import { CodexSession } from "./bridge/codex-session.js";
import { FileWatcher } from "./bridge/file-watcher.js";
import { McpMaterializer } from "./bridge/mcp-materializer.js";
import { createRunControlServer } from "./bridge/run-control-server.js";
import { SecretLoader, type SecretValueMap } from "./bridge/secret-loader.js";

export type ContainerBridgeOptions = {
  context?: BridgeSessionContext;
  workspaceRoot?: string;
  runtimeDir?: string;
  outputsPath?: string;
  secretValues?: SecretValueMap;
  emitEvent?: (event: BridgeEvent) => void;
  codex?: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
};

function resolveContext(options?: ContainerBridgeOptions) {
  if (options?.context) {
    return bridgeSessionContextSchema.parse(options.context);
  }

  return bridgeSessionContextSchema.parse({
    runId: process.env.RUN_ID ?? "run_bootstrap",
    workspaceId: process.env.WORKSPACE_ID ?? "wsp_bootstrap",
    targetPath: process.env.TARGET_PATH ?? "/workspace/target",
    initialPrompt:
      process.env.INITIAL_PROMPT ??
      "请先说明当前任务需要用户补充的必要信息、授权和材料。",
    requestedInitialMessage: null,
    credentialMounts: [],
    mcpBindings: [],
  });
}

export async function buildContainerBridge(options: ContainerBridgeOptions = {}) {
  const context = resolveContext(options);
  const workspaceRoot = options.workspaceRoot ?? path.dirname(context.targetPath);
  const runtimeDir = options.runtimeDir ?? path.join(workspaceRoot, "runtime");
  const outputsPath = options.outputsPath ?? path.join(workspaceRoot, "outputs");
  const emitEvent = options.emitEvent ?? (() => undefined);

  const fileWatcher = new FileWatcher({
    runId: context.runId,
    targetPath: context.targetPath,
    outputsPath,
    emit: emitEvent,
  });

  const artifactPublisher = new ArtifactPublisher({
    runId: context.runId,
    outputsPath,
    emit: emitEvent,
  });

  const codexSession = new CodexSession({
    context,
    emit: emitEvent,
    launch: {
      command: options.codex?.command ?? process.env.CODEX_BIN ?? "codex",
      args: options.codex?.args ?? [],
      cwd: options.codex?.cwd ?? context.targetPath,
      env: {
        RUN_ID: context.runId,
        WORKSPACE_ID: context.workspaceId,
        TARGET_PATH: context.targetPath,
        ...options.codex?.env,
      },
    },
  });

  const controlServer = createRunControlServer({
    session: codexSession,
    fileWatcher,
    artifactPublisher,
    emit: emitEvent,
  });

  return {
    name: "container-bridge",
    context,
    controlServer,
    async start() {
      const materializer = new McpMaterializer({
        context,
        runtimeDir,
      });
      const secretLoader = new SecretLoader({
        context,
        secretValues: options.secretValues,
      });

      const [mcp, secrets] = await Promise.all([
        materializer.materialize(),
        secretLoader.materialize(),
      ]);

      codexSession.setRuntimeEnv(secrets.env);
      await fileWatcher.start();
      codexSession.start();

      return {
        context,
        mcp,
        secrets,
      };
    },
    async stop() {
      codexSession.stop();
      await fileWatcher.stop();
    },
    async listFiles() {
      return fileWatcher.listFiles();
    },
    async flushArtifacts() {
      return artifactPublisher.flush();
    },
  };
}
