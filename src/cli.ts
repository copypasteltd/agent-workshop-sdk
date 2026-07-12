import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadBridgeCliRuntimeConfig } from "@lingban/config";
import {
  bridgeSessionContextSchema,
  type BridgeEvent,
  type BridgeRegistration,
  type BridgeSessionContext,
  type RunStatus,
} from "@lingban/contracts";
import { toErrorMessage } from "@lingban/shared";
import { buildContainerBridge } from "./index.js";
import { buildBridgeRuntimeMetricsText, incrementCounter } from "./observability.js";
import { ApiConnector } from "./transports/api-connector.js";
import { ControlHttpServer } from "./transports/control-http.js";

const TERMINAL_STATUSES = new Set<RunStatus>(["SUCCEEDED", "FAILED", "CANCELLED"]);

async function loadContextFromFile(filePath: string): Promise<BridgeSessionContext> {
  const content = await fs.readFile(filePath, "utf8");
  return bridgeSessionContextSchema.parse(JSON.parse(content) as unknown);
}

function applyRuntimeUmaskFromEnv() {
  const raw = process.env.LINGBAN_RUNTIME_UMASK?.trim();
  if (!raw) {
    return;
  }

  const parsed = Number.parseInt(raw, 8);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0o777) {
    throw new Error(`LINGBAN_RUNTIME_UMASK must be a valid octal mask: ${raw}`);
  }

  process.umask(parsed);
}

function buildBridgeRegistration(input: {
  context: BridgeSessionContext;
  bridgeId: string;
  connectedAt: string;
  controlUrl: string;
  controlToken?: string;
}): BridgeRegistration {
  return {
    bridgeId: input.bridgeId,
    runId: input.context.runId,
    workspaceId: input.context.workspaceId,
    targetPath: input.context.targetPath,
    control: {
      baseUrl: input.controlUrl,
      ...(input.controlToken ? { authToken: input.controlToken } : {}),
    },
    connectedAt: input.connectedAt,
    lastSeenAt: new Date().toISOString(),
    supportedCommands: [
      "sendMessage",
      "approve",
      "cancel",
      "ping",
      "syncFiles",
      "flushArtifacts",
    ],
  };
}

async function forwardBridgeEvent(
  connector: ApiConnector,
  runId: string,
  event: BridgeEvent
) {
  switch (event.type) {
    case "run.status.changed":
      return connector.syncRunStatus(runId, event.status, event.reason ?? null, event.occurredAt);
    case "artifact.ready":
      return connector.syncArtifacts(runId, [event.artifact]);
    default:
      return connector.ingestEvents(runId, [event]);
  }
}

async function loadRuntimeHints(runtimeConfigPath?: string) {
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
  applyRuntimeUmaskFromEnv();
  const cliConfig = loadBridgeCliRuntimeConfig();
  const context = await loadContextFromFile(cliConfig.contextPath);
  const runtimeHints = await loadRuntimeHints(cliConfig.runtimeConfigPath);
  const runtimeDir =
    cliConfig.runtimeDir ??
    runtimeHints?.workspace?.containerPaths?.runtimePath ??
    path.dirname(cliConfig.contextPath);
  const outputsPath =
    cliConfig.outputsPath ??
    runtimeHints?.workspace?.containerPaths?.outputsPath ??
    path.posix.join(path.posix.dirname(context.targetPath), "outputs");
  const apiConnector = cliConfig.apiBaseUrl
    ? new ApiConnector({
        baseUrl: cliConfig.apiBaseUrl,
        authToken: cliConfig.internalAuthToken,
      })
    : null;
  const bridgeId = `brg_${randomUUID()}`;
  const connectedAt = new Date().toISOString();
  const startedAt = connectedAt;

  let shuttingDown = false;
  let shutdownAt: string | null = null;
  let shutdownExitCode: number | null = null;
  let bridge:
    | Awaited<ReturnType<typeof buildContainerBridge>>
    | null = null;
  let controlHttpServer: ControlHttpServer | null = null;
  let registrationRefreshTimer: NodeJS.Timeout | null = null;
  let eventQueue: Promise<void> = Promise.resolve();
  let pendingEventQueueCount = 0;
  let registrationSucceeded = false;
  let lastRegistrationAt: string | null = null;
  let lastRegistrationFailureAt: string | null = null;
  let lastRegistrationFailureMessage: string | null = null;
  let lastObservedEventAt: string | null = null;
  let lastObservedEventType: string | null = null;
  let lastForwardedEventAt: string | null = null;
  let lastForwardedEventType: string | null = null;
  let lastForwardedEventFailureAt: string | null = null;
  let lastForwardedEventFailureMessage: string | null = null;
  const runtimeMetrics = {
    registrationAttemptsTotal: 0,
    registrationSuccessTotal: 0,
    registrationRefreshSuccessTotal: 0,
    registrationFailuresTotal: 0,
    observedEventsTotal: 0,
    forwardedEventsTotal: 0,
    forwardedEventFailuresTotal: 0,
    terminalFailureReportsTotal: 0,
    observedEventCounts: {} as Record<string, number>,
    forwardedEventCounts: {} as Record<string, number>,
  };

  const buildRuntimeDiagnostics = () => ({
    bridgeId,
    runId: context.runId,
    workspaceId: context.workspaceId,
    targetPath: context.targetPath,
    runtimeDir,
    outputsPath,
    startedAt,
    shuttingDown,
    shutdownAt,
    shutdownExitCode,
    registrationRefreshMs: cliConfig.registrationRefreshMs,
    controlUrl: cliConfig.externalControlUrl ?? controlHttpServer?.url ?? null,
    controlAuthRequired: Boolean(cliConfig.externalControlToken ?? cliConfig.controlToken),
    externalControlUrl: cliConfig.externalControlUrl ?? null,
    apiBaseUrl: cliConfig.apiBaseUrl ?? null,
    apiConnectorEnabled: Boolean(apiConnector),
    internalAuthConfigured: Boolean(cliConfig.internalAuthToken),
    credentialMountsCount: context.credentialMounts.length,
    mcpBindingsCount: context.mcpBindings.length,
    pendingEventQueueCount,
    lastRegistrationAt,
    lastRegistrationFailureAt,
    lastRegistrationFailureMessage,
    lastObservedEventAt,
    lastObservedEventType,
    lastForwardedEventAt,
    lastForwardedEventType,
    lastForwardedEventFailureAt,
    lastForwardedEventFailureMessage,
    metrics: {
      registrationAttemptsTotal: runtimeMetrics.registrationAttemptsTotal,
      registrationSuccessTotal: runtimeMetrics.registrationSuccessTotal,
      registrationRefreshSuccessTotal: runtimeMetrics.registrationRefreshSuccessTotal,
      registrationFailuresTotal: runtimeMetrics.registrationFailuresTotal,
      observedEventsTotal: runtimeMetrics.observedEventsTotal,
      forwardedEventsTotal: runtimeMetrics.forwardedEventsTotal,
      forwardedEventFailuresTotal: runtimeMetrics.forwardedEventFailuresTotal,
      terminalFailureReportsTotal: runtimeMetrics.terminalFailureReportsTotal,
      observedEventCounts: {
        ...runtimeMetrics.observedEventCounts,
      },
      forwardedEventCounts: {
        ...runtimeMetrics.forwardedEventCounts,
      },
    },
    controlServer: bridge!.controlServer.getDiagnostics(),
    controlHttp: controlHttpServer?.getDiagnostics() ?? null,
    bridgeRuntime: bridge!.getDiagnostics?.() ?? null,
  });

  const publishEvent = (event: BridgeEvent) => {
    if (!apiConnector) {
      return;
    }

    pendingEventQueueCount += 1;
    eventQueue = eventQueue
      .catch(() => undefined)
      .then(async () => {
        await forwardBridgeEvent(apiConnector, context.runId, event);
        runtimeMetrics.forwardedEventsTotal += 1;
        incrementCounter(runtimeMetrics.forwardedEventCounts, event.type);
        lastForwardedEventAt = new Date().toISOString();
        lastForwardedEventType = event.type;
      })
      .catch((error) => {
        runtimeMetrics.forwardedEventFailuresTotal += 1;
        lastForwardedEventFailureAt = new Date().toISOString();
        lastForwardedEventFailureMessage = toErrorMessage(error);
        console.error(`[lingban-bridge] failed to forward event: ${toErrorMessage(error)}`);
      })
      .finally(() => {
        pendingEventQueueCount = Math.max(0, pendingEventQueueCount - 1);
      });
  };

  const shutdown = async (exitCode: number) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    shutdownAt = new Date().toISOString();
    shutdownExitCode = exitCode;
    if (bridge) {
      await bridge.controlServer.handle({ type: "syncFiles" }).catch(() => undefined);
      await bridge.controlServer.handle({ type: "flushArtifacts" }).catch(() => undefined);
    }
    if (controlHttpServer) {
      await controlHttpServer.stop().catch(() => undefined);
    }
    if (registrationRefreshTimer) {
      clearInterval(registrationRefreshTimer);
      registrationRefreshTimer = null;
    }
    if (bridge) {
      await bridge.stop().catch(() => undefined);
    }
    await eventQueue.catch(() => undefined);
    process.exit(exitCode);
  };

  const handleEvent = (event: BridgeEvent) => {
    runtimeMetrics.observedEventsTotal += 1;
    incrementCounter(runtimeMetrics.observedEventCounts, event.type);
    lastObservedEventAt = new Date().toISOString();
    lastObservedEventType = event.type;
    publishEvent(event);

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
    mcpStdioAllowedPathPrefixes: cliConfig.mcpStdioAllowedPathPrefixes,
    codex: {
      command: cliConfig.codexBin,
      args: cliConfig.codexArgs,
      cwd: context.targetPath,
      restartMaxAttempts: cliConfig.codexRestartMaxAttempts,
      restartBackoffMs: cliConfig.codexRestartBackoffMs,
      restartResetWindowMs: cliConfig.codexRestartResetWindowMs,
    },
  });

  process.on("SIGINT", () => {
    void shutdown(130);
  });
  process.on("SIGTERM", () => {
    void shutdown(143);
  });

  try {
    await bridge.start();
    controlHttpServer = new ControlHttpServer({
      controlServer: bridge.controlServer,
      host: cliConfig.controlHost,
      port: cliConfig.controlPort,
      authToken: cliConfig.controlToken,
      getDiagnostics: buildRuntimeDiagnostics,
      getMetricsText: () => buildBridgeRuntimeMetricsText(buildRuntimeDiagnostics()),
    });
    await controlHttpServer.start();

    if (apiConnector) {
      const registerBridge = async () => {
        runtimeMetrics.registrationAttemptsTotal += 1;

        try {
          await apiConnector.registerBridge(
            buildBridgeRegistration({
              context,
              bridgeId,
              connectedAt,
              controlUrl: cliConfig.externalControlUrl ?? controlHttpServer!.url,
              controlToken: cliConfig.externalControlToken ?? cliConfig.controlToken,
            })
          );
          lastRegistrationAt = new Date().toISOString();
          lastRegistrationFailureAt = null;
          lastRegistrationFailureMessage = null;
          if (registrationSucceeded) {
            runtimeMetrics.registrationRefreshSuccessTotal += 1;
          } else {
            runtimeMetrics.registrationSuccessTotal += 1;
            registrationSucceeded = true;
          }
        } catch (error) {
          runtimeMetrics.registrationFailuresTotal += 1;
          lastRegistrationFailureAt = new Date().toISOString();
          lastRegistrationFailureMessage = toErrorMessage(error);
          throw error;
        }
      };

      await registerBridge();
      registrationRefreshTimer = setInterval(() => {
        void registerBridge().catch((error) => {
          console.error(
            `[lingban-bridge] failed to refresh bridge registration: ${toErrorMessage(error)}`
          );
        });
      }, cliConfig.registrationRefreshMs);
      registrationRefreshTimer.unref?.();
    }

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
  } catch (error) {
    if (apiConnector) {
      await apiConnector
        .postTerminalFailure(context.runId, `bridge bootstrap failed: ${toErrorMessage(error)}`)
        .then(() => {
          runtimeMetrics.terminalFailureReportsTotal += 1;
        })
        .catch(() => undefined);
    }
    if (controlHttpServer) {
      await controlHttpServer.stop().catch(() => undefined);
    }
    if (bridge) {
      await bridge.stop().catch(() => undefined);
    }
    throw error;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
