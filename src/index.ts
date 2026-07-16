import { bridgeSessionContextSchema, type BridgeEvent, type BridgeSessionContext } from "@lingban/contracts";
import path from "node:path";
import { ArtifactPublisher } from "./bridge/artifact-publisher.js";
import { CodexSession } from "./bridge/codex-session.js";
import { AppServerSession } from "./bridge/app-server-session.js";
import type { AgentSession } from "./bridge/agent-session.js";
import { FileWatcher } from "./bridge/file-watcher.js";
import { McpCallAuditWatcher } from "./bridge/mcp-call-audit-watcher.js";
import { McpMaterializer } from "./bridge/mcp-materializer.js";
import { RemoteMcpProxyServer } from "./bridge/remote-mcp-proxy-server.js";
import { createRunControlServer } from "./bridge/run-control-server.js";
import { SecretLoader, type SecretValueMap } from "./bridge/secret-loader.js";

export type ContainerBridgeOptions = {
  context?: BridgeSessionContext;
  workspaceRoot?: string;
  runtimeDir?: string;
  outputsPath?: string;
  secretValues?: SecretValueMap;
  emitEvent?: (event: BridgeEvent) => void;
  mcpStdioAllowedPathPrefixes?: string[];
  codex?: {
    protocol?: "legacy-pty" | "app-server";
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    restartMaxAttempts?: number;
    restartBackoffMs?: number;
    restartResetWindowMs?: number;
    appServerRequestTimeoutMs?: number;
  };
};

function resolveContext(options?: ContainerBridgeOptions) {
  if (options?.context) {
    return bridgeSessionContextSchema.parse(options.context);
  }

  return bridgeSessionContextSchema.parse({
    runId: process.env.RUN_ID ?? "run_bootstrap",
    workspaceId: process.env.WORKSPACE_ID ?? "wsp_bootstrap",
    requestedByUserId: null,
    taskVersionId: null,
    sessionVersionId: null,
    entrySurface: null,
    workspaceContextKey: null,
    serviceId: null,
    targetPath: process.env.TARGET_PATH ?? "/workspace/target",
    initialPrompt:
      process.env.INITIAL_PROMPT ??
      "请先说明当前任务需要用户补充的必要信息、授权和材料。",
    requestedInitialMessage: null,
    credentialMounts: [],
    mcpBindings: [],
    mcpNetworkPolicies: [],
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
  const remoteMcpProxyServer = new RemoteMcpProxyServer({
    context,
  });
  const mcpCallAuditWatcher = new McpCallAuditWatcher({
    context,
    auditLogPath: path.join(runtimeDir, "mcp-calls.ndjson"),
    emit: emitEvent,
  });

  const protocol = options.codex?.protocol ?? "app-server";
  const launch = {
    command: options.codex?.command ?? process.env.CODEX_BIN ?? "codex",
    args: options.codex?.args ?? [],
    cwd: options.codex?.cwd ?? context.targetPath,
    env: {
      RUN_ID: context.runId,
      WORKSPACE_ID: context.workspaceId,
      TARGET_PATH: context.targetPath,
      OUTPUTS_PATH: outputsPath,
      RUNTIME_DIR: runtimeDir,
      ...options.codex?.env,
    },
  };
  const codexSession: AgentSession = protocol === "app-server"
    ? new AppServerSession({
        context,
        emit: emitEvent,
        launch,
        requestTimeoutMs: options.codex?.appServerRequestTimeoutMs,
      })
    : new CodexSession({
        context,
        emit: emitEvent,
        launch,
        recovery: {
          maxRestartAttempts: options.codex?.restartMaxAttempts,
          restartBackoffMs: options.codex?.restartBackoffMs,
          restartResetWindowMs: options.codex?.restartResetWindowMs,
        },
      });

  const controlServer = createRunControlServer({
    session: codexSession,
    fileWatcher,
    artifactPublisher,
    mcpCallAuditWatcher,
    emit: emitEvent,
  });

  return {
    name: "container-bridge",
    context,
    controlServer,
    async start() {
      const secretLoader = new SecretLoader({
        context,
        secretValues: options.secretValues,
      });
      await remoteMcpProxyServer.start();
      const mcpMaterializer = new McpMaterializer({
        context,
        runtimeDir,
        stdioAllowedPathPrefixes: options.mcpStdioAllowedPathPrefixes,
        remoteProxyBaseUrl: remoteMcpProxyServer.httpBaseUrl,
        remoteProxyWebsocketBaseUrl: remoteMcpProxyServer.websocketBaseUrl,
      });

      let mcp;
      let secrets;
      try {
        [mcp, secrets] = await Promise.all([
          mcpMaterializer.materialize(),
          secretLoader.materialize(),
        ]);
      } catch (error) {
        await remoteMcpProxyServer.stop().catch(() => undefined);
        throw error;
      }

      codexSession.setRuntimeEnv({
        ...secrets.env,
        LINGBAN_MCP_CONFIG_PATH: mcp.configPath,
        LINGBAN_MCP_BINDINGS_PATH: mcp.bindingsPath,
        LINGBAN_MCP_AUDIT_LOG_PATH: mcp.auditLogPath,
        LINGBAN_MCP_AUDIT_FORMAT: "jsonl-v1",
      });
      await fileWatcher.start();
      await mcpCallAuditWatcher.start();
      await codexSession.start();

      return {
        context,
        mcp,
        secrets,
      };
    },
    async stop() {
      await codexSession.stop();
      await mcpCallAuditWatcher.stop();
      await fileWatcher.stop();
      await remoteMcpProxyServer.stop().catch(() => undefined);
    },
    async listFiles() {
      return fileWatcher.listFiles();
    },
    async flushArtifacts() {
      return artifactPublisher.flush();
    },
    getDiagnostics() {
      return {
        protocol,
        remoteMcpProxy: remoteMcpProxyServer.getDiagnostics(),
      };
    },
  };
}

export { ApiConnector } from "./transports/api-connector.js";
