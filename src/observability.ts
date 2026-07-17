import type { RunApprovalMode, RunControlCommand } from "@lingban/contracts";

export type CounterMap = Record<string, number>;

export type CodexSessionDiagnostics = {
  protocol: "legacy-pty" | "app-server";
  running: boolean;
  recovering: boolean;
  status: string;
  command: string;
  args: string[];
  cwd: string;
  runtimeEnvCount: number;
  requestedInitialMessageConfigured: boolean;
  autoRestartEnabled: boolean;
  maxRestartAttempts: number;
  restartBackoffMs: number;
  restartResetWindowMs: number;
  restartBudgetUsed: number;
  replayHistoryCount: number;
  replayHistoryBytes: number;
  threadId: string | null;
  currentTurnId: string | null;
  currentTurnState: string | null;
  eventHighWatermark: number;
  pendingRequestCount: number;
  pendingApprovalCount: number;
  approvalMode: RunApprovalMode;
  startedAt: string | null;
  lastLaunchAt: string | null;
  lastStdoutAt: string | null;
  lastMessageAt: string | null;
  lastApprovalAt: string | null;
  lastCancelAt: string | null;
  lastHeartbeatAt: string | null;
  lastUnexpectedExitAt: string | null;
  lastRestartAt: string | null;
  lastRestartReason: string | null;
  lastExitCode: number | null;
  lastExitSignal: number | null;
  terminalStatusOnExit: "CANCELLED" | null;
  restartAttemptsTotal: number;
  restartSuccessTotal: number;
  restartFailuresTotal: number;
};

export type FileWatcherDiagnostics = {
  running: boolean;
  targetPath: string;
  outputsPath: string | null;
  watchTargets: string[];
  syncCount: number;
  fileChangedEventsTotal: number;
  lastSyncAt: string | null;
  lastSyncFileCount: number;
  lastMutationAt: string | null;
  lastChangedPath: string | null;
  lastSyncErrorAt: string | null;
  lastSyncErrorMessage: string | null;
};

export type ArtifactPublisherDiagnostics = {
  outputsPath: string;
  publishedFingerprintsCount: number;
  flushCount: number;
  publishedArtifactsTotal: number;
  lastFlushAt: string | null;
  lastPublishedArtifactsCount: number;
  lastPublishedArtifactPath: string | null;
  lastFlushErrorAt: string | null;
  lastFlushErrorMessage: string | null;
};

export type McpCallAuditWatcherDiagnostics = {
  running: boolean;
  auditLogPath: string;
  processedEventsTotal: number;
  processedFailuresTotal: number;
  lastProcessedAt: string | null;
  lastCallId: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  fileOffsetBytes: number;
  bufferedRemainderBytes: number;
};

export type RunControlServerDiagnostics = {
  commandsTotal: number;
  commandCounts: Record<RunControlCommand["type"], number>;
  commandFailureCounts: Record<RunControlCommand["type"], number>;
  invalidCommandsTotal: number;
  failuresTotal: number;
  lastCommandType: RunControlCommand["type"] | null;
  lastCommandAt: string | null;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  session: CodexSessionDiagnostics;
  fileWatcher: FileWatcherDiagnostics;
  artifactPublisher: ArtifactPublisherDiagnostics;
  mcpCallAuditWatcher: McpCallAuditWatcherDiagnostics;
};

export type ControlHttpRouteDiagnostics = {
  route: string;
  requestsTotal: number;
  clientErrorsTotal: number;
  serverErrorsTotal: number;
  unauthorizedTotal: number;
  lastRequestAt: string | null;
  lastStatusCode: number | null;
};

export type ControlHttpServerDiagnostics = {
  started: boolean;
  startedAt: string | null;
  host: string;
  port: number;
  url: string;
  authRequired: boolean;
  inFlightRequests: number;
  requestsTotal: number;
  unauthorizedRequestsTotal: number;
  clientErrorsTotal: number;
  serverErrorsTotal: number;
  lastRequestAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  routes: ControlHttpRouteDiagnostics[];
};

export type BridgeRuntimeDiagnostics = {
  bridgeId: string;
  runId: string;
  workspaceId: string;
  targetPath: string;
  runtimeDir: string;
  outputsPath: string;
  startedAt: string;
  shuttingDown: boolean;
  shutdownAt: string | null;
  shutdownExitCode: number | null;
  registrationRefreshMs: number;
  controlUrl: string | null;
  controlAuthRequired: boolean;
  externalControlUrl: string | null;
  apiBaseUrl: string | null;
  apiConnectorEnabled: boolean;
  internalAuthConfigured: boolean;
  credentialMountsCount: number;
  mcpBindingsCount: number;
  pendingEventQueueCount: number;
  lastRegistrationAt: string | null;
  lastRegistrationFailureAt: string | null;
  lastRegistrationFailureMessage: string | null;
  lastObservedEventAt: string | null;
  lastObservedEventType: string | null;
  lastForwardedEventAt: string | null;
  lastForwardedEventType: string | null;
  lastForwardedEventFailureAt: string | null;
  lastForwardedEventFailureMessage: string | null;
  metrics: {
    registrationAttemptsTotal: number;
    registrationSuccessTotal: number;
    registrationRefreshSuccessTotal: number;
    registrationFailuresTotal: number;
    observedEventsTotal: number;
    forwardedEventsTotal: number;
    forwardedEventFailuresTotal: number;
    terminalFailureReportsTotal: number;
    observedEventCounts: CounterMap;
    forwardedEventCounts: CounterMap;
  };
  controlServer: RunControlServerDiagnostics;
  controlHttp: ControlHttpServerDiagnostics | null;
};

const runControlCommandTypes = [
  "sendMessage",
  "approve",
  "setApprovalMode",
  "cancel",
  "ping",
  "syncFiles",
  "flushArtifacts",
  "captureBarrier",
] as const satisfies readonly RunControlCommand["type"][];

export function createCommandCounterMap(): Record<RunControlCommand["type"], number> {
  return {
    sendMessage: 0,
    approve: 0,
    setApprovalMode: 0,
    cancel: 0,
    ping: 0,
    syncFiles: 0,
    flushArtifacts: 0,
    captureBarrier: 0,
  };
}

export function incrementCounter(map: CounterMap, key: string, amount = 1) {
  map[key] = (map[key] ?? 0) + amount;
}

function escapeMetricHelp(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeMetricLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function pushMetric(
  lines: string[],
  name: string,
  type: "counter" | "gauge",
  help: string,
  value: number,
  labels?: Record<string, string>
) {
  if (!lines.some((line) => line === `# HELP ${name} ${escapeMetricHelp(help)}`)) {
    lines.push(`# HELP ${name} ${escapeMetricHelp(help)}`);
    lines.push(`# TYPE ${name} ${type}`);
  }

  const serializedLabels = labels
    ? `{${Object.entries(labels)
        .map(([key, labelValue]) => `${key}="${escapeMetricLabelValue(labelValue)}"`)
        .join(",")}}`
    : "";
  lines.push(`${name}${serializedLabels} ${value}`);
}

export function buildBridgeRuntimeMetricsText(input: BridgeRuntimeDiagnostics) {
  const lines: string[] = [];

  pushMetric(
    lines,
    "lingban_bridge_runtime_up",
    "gauge",
    "Whether the bridge runtime is active and not shutting down.",
    input.shuttingDown ? 0 : 1
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_shutting_down",
    "gauge",
    "Whether the bridge runtime is in shutdown flow.",
    input.shuttingDown ? 1 : 0
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_event_queue_pending",
    "gauge",
    "Pending bridge event forwarding operations.",
    input.pendingEventQueueCount
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_registration_attempts_total",
    "counter",
    "Bridge registration attempts to the API.",
    input.metrics.registrationAttemptsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_registration_success_total",
    "counter",
    "Successful initial bridge registrations.",
    input.metrics.registrationSuccessTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_registration_refresh_success_total",
    "counter",
    "Successful bridge registration refreshes.",
    input.metrics.registrationRefreshSuccessTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_registration_failures_total",
    "counter",
    "Failed bridge registration attempts.",
    input.metrics.registrationFailuresTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_events_observed_total",
    "counter",
    "Bridge events emitted by the local runtime.",
    input.metrics.observedEventsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_events_forwarded_total",
    "counter",
    "Bridge events forwarded to the API.",
    input.metrics.forwardedEventsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_event_forward_failures_total",
    "counter",
    "Bridge event forwarding failures.",
    input.metrics.forwardedEventFailuresTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_runtime_terminal_failure_reports_total",
    "counter",
    "Terminal bridge bootstrap failures reported to the API.",
    input.metrics.terminalFailureReportsTotal
  );

  for (const [eventType, count] of Object.entries(input.metrics.observedEventCounts)) {
    pushMetric(
      lines,
      "lingban_bridge_runtime_event_observed_count",
      "counter",
      "Bridge event counts observed locally by event type.",
      count,
      { event_type: eventType }
    );
  }

  for (const [eventType, count] of Object.entries(input.metrics.forwardedEventCounts)) {
    pushMetric(
      lines,
      "lingban_bridge_runtime_event_forwarded_count",
      "counter",
      "Bridge event counts forwarded to the API by event type.",
      count,
      { event_type: eventType }
    );
  }

  pushMetric(
    lines,
    "lingban_bridge_session_running",
    "gauge",
    "Whether the Codex session PTY is running.",
    input.controlServer.session.running ? 1 : 0
  );
  pushMetric(
    lines,
    "lingban_bridge_session_recovering",
    "gauge",
    "Whether the bridge is currently recovering the Codex session.",
    input.controlServer.session.recovering ? 1 : 0
  );
  pushMetric(
    lines,
    "lingban_bridge_session_restart_attempts_total",
    "counter",
    "Automatic Codex session restart attempts.",
    input.controlServer.session.restartAttemptsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_session_restart_success_total",
    "counter",
    "Successful automatic Codex session restarts.",
    input.controlServer.session.restartSuccessTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_session_restart_failures_total",
    "counter",
    "Failed automatic Codex session restart attempts.",
    input.controlServer.session.restartFailuresTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_session_replay_history_entries",
    "gauge",
    "Number of replayable session inputs retained for recovery.",
    input.controlServer.session.replayHistoryCount
  );
  pushMetric(
    lines,
    "lingban_bridge_file_watcher_running",
    "gauge",
    "Whether the bridge file watcher is running.",
    input.controlServer.fileWatcher.running ? 1 : 0
  );
  pushMetric(
    lines,
    "lingban_bridge_file_sync_total",
    "counter",
    "File synchronization operations emitted by the watcher.",
    input.controlServer.fileWatcher.syncCount
  );
  pushMetric(
    lines,
    "lingban_bridge_file_changed_events_total",
    "counter",
    "File changed events emitted by the watcher.",
    input.controlServer.fileWatcher.fileChangedEventsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_artifact_flush_total",
    "counter",
    "Artifact flush operations executed by the publisher.",
    input.controlServer.artifactPublisher.flushCount
  );
  pushMetric(
    lines,
    "lingban_bridge_artifacts_published_total",
    "counter",
    "Artifacts published by the bridge artifact publisher.",
    input.controlServer.artifactPublisher.publishedArtifactsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_mcp_call_events_total",
    "counter",
    "MCP call audit events ingested from the local runtime audit log.",
    input.controlServer.mcpCallAuditWatcher.processedEventsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_mcp_call_ingest_failures_total",
    "counter",
    "MCP call audit lines that failed local parsing or enrichment.",
    input.controlServer.mcpCallAuditWatcher.processedFailuresTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_artifact_fingerprints",
    "gauge",
    "Cached artifact fingerprints retained by the publisher.",
    input.controlServer.artifactPublisher.publishedFingerprintsCount
  );
  pushMetric(
    lines,
    "lingban_bridge_control_commands_total",
    "counter",
    "Run control commands executed by the bridge control server.",
    input.controlServer.commandsTotal
  );
  pushMetric(
    lines,
    "lingban_bridge_control_command_failures_total",
    "counter",
    "Run control command failures executed by the bridge control server.",
    input.controlServer.failuresTotal
  );

  for (const commandType of runControlCommandTypes) {
    pushMetric(
      lines,
      "lingban_bridge_control_command_count",
      "counter",
      "Run control command counts by command type.",
      input.controlServer.commandCounts[commandType],
      { command: commandType }
    );
    pushMetric(
      lines,
      "lingban_bridge_control_command_failure_count",
      "counter",
      "Run control command failure counts by command type.",
      input.controlServer.commandFailureCounts[commandType],
      { command: commandType }
    );
  }

  if (input.controlHttp) {
    pushMetric(
      lines,
      "lingban_bridge_control_http_up",
      "gauge",
      "Whether the bridge control HTTP server has started.",
      input.controlHttp.started ? 1 : 0
    );
    pushMetric(
      lines,
      "lingban_bridge_control_http_inflight_requests",
      "gauge",
      "Current in-flight control HTTP requests.",
      input.controlHttp.inFlightRequests
    );
    pushMetric(
      lines,
      "lingban_bridge_control_http_requests_total",
      "counter",
      "Control HTTP requests observed by the bridge.",
      input.controlHttp.requestsTotal
    );
    pushMetric(
      lines,
      "lingban_bridge_control_http_unauthorized_requests_total",
      "counter",
      "Unauthorized control HTTP requests rejected by the bridge.",
      input.controlHttp.unauthorizedRequestsTotal
    );
    pushMetric(
      lines,
      "lingban_bridge_control_http_client_errors_total",
      "counter",
      "Client-side control HTTP errors returned by the bridge.",
      input.controlHttp.clientErrorsTotal
    );
    pushMetric(
      lines,
      "lingban_bridge_control_http_server_errors_total",
      "counter",
      "Server-side control HTTP errors returned by the bridge.",
      input.controlHttp.serverErrorsTotal
    );

    for (const route of input.controlHttp.routes) {
      pushMetric(
        lines,
        "lingban_bridge_control_http_route_requests_total",
        "counter",
        "Control HTTP requests by route.",
        route.requestsTotal,
        { route: route.route }
      );
      pushMetric(
        lines,
        "lingban_bridge_control_http_route_client_errors_total",
        "counter",
        "Control HTTP client errors by route.",
        route.clientErrorsTotal,
        { route: route.route }
      );
      pushMetric(
        lines,
        "lingban_bridge_control_http_route_server_errors_total",
        "counter",
        "Control HTTP server errors by route.",
        route.serverErrorsTotal,
        { route: route.route }
      );
      pushMetric(
        lines,
        "lingban_bridge_control_http_route_unauthorized_total",
        "counter",
        "Control HTTP unauthorized requests by route.",
        route.unauthorizedTotal,
        { route: route.route }
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
