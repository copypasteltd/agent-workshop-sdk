import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AppServerSession } from "../dist/bridge/app-server-session.js";

async function waitFor(predicate, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for App Server event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createContext(root, runId, workspaceId) {
  return {
    runId,
    workspaceId,
    requestedByUserId: null,
    taskVersionId: null,
    sessionVersionId: null,
    entrySurface: null,
    workspaceContextKey: null,
    serviceId: null,
    approvalMode: "manual",
    targetPath: root,
    initialPrompt: "collect required information",
    requestedInitialMessage: null,
    credentialMounts: [],
    mcpBindings: [],
    mcpNetworkPolicies: [],
  };
}

test("AppServerSession preserves raw events and supports multiple turns on one thread", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-v1" } });
  if (message.method === "thread/start") {
    if (message.params?.sandbox !== "workspace-write") {
      send({ id: message.id, error: { code: -32602, message: "workspace-write sandbox is required" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thr_test" } } });
  }
  if (message.method === "turn/start") {
    const policy = message.params?.sandboxPolicy;
    if (policy?.type !== "workspaceWrite" || policy?.networkAccess !== true || !policy?.writableRoots?.includes(${JSON.stringify(root)})) {
      send({ id: message.id, error: { code: -32602, message: "network-enabled workspace policy is required" } });
      return;
    }
    turn += 1;
    const turnId = "turn_" + turn;
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: "turn/started", params: { threadId: "thr_test", turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thr_test", turnId, item: { id: "item_" + turn, type: "agentMessage", text: "answer " + turn } } });
    send({ method: "turn/completed", params: { threadId: "thr_test", turn: { id: turnId, status: "completed" } } });
  }
});

`, "utf8");

  const events = [];
  const session = new AppServerSession({
    context: createContext(root, "run_app_server_test", "wsp_app_server_test"),
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: (event) => events.push(event),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });

  try {
    await session.start();
    await waitFor(() => events.some((event) => event.type === "conversation.message" && event.message.text === "answer 1"));
    await session.sendMessage({ text: "continue", attachments: [], slotValues: [] });
    await waitFor(() => events.some((event) => event.type === "conversation.message" && event.message.text === "answer 2"));

    const diagnostics = session.getDiagnostics();
    assert.equal(diagnostics.protocol, "app-server");
    assert.equal(diagnostics.threadId, "thr_test");
    assert.equal(diagnostics.currentTurnId, "turn_2");
    assert.equal(diagnostics.currentTurnState, "completed");
    assert.ok(diagnostics.eventHighWatermark >= 8);
    assert.equal(events.some((event) => event.type === "run.status.changed" && event.status === "SUCCEEDED"), false);
    assert.equal(events.filter((event) => event.type === "agent.runtime.event").length >= 8, true);
    assert.equal(
      events.some((event) => event.type === "agent.runtime.event" && event.eventType === "turn/started" && event.turnId === "turn_1"),
      true
    );
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("AppServerSession resolves local image references into target-relative attachments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-images-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-images" } });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_images" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_images" } } });
    send({ method: "item/completed", params: { threadId: "thr_images", turnId: "turn_images", item: {
      id: "item_images",
      type: "agentMessage",
      text: "Generated images:\\n![cover](./outputs/cover.png)\\n" + ${JSON.stringify("`./outputs/detail.webp`")} + "\\n![blocked](../outside.png)"
    } } });
    send({ method: "turn/completed", params: { threadId: "thr_images", turn: { id: "turn_images", status: "completed" } } });
  }
});
`, "utf8");

  const events = [];
  const session = new AppServerSession({
    context: createContext(root, "run_app_server_images", "wsp_app_server_images"),
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: (event) => events.push(event),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });

  try {
    await session.start();
    await waitFor(() => events.some((event) => event.type === "conversation.message"));
    const event = events.find((item) => item.type === "conversation.message");
    assert.deepEqual(event.message.attachments, [
      { path: "outputs/cover.png", label: "cover", slotKey: null },
      { path: "outputs/detail.webp", label: "detail.webp", slotKey: null },
    ]);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("AppServerSession answers structured input and steers an active turn", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-input-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-v2" } });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_input" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_input" } } });
    send({ method: "turn/started", params: { threadId: "thr_input", turn: { id: "turn_input", status: "inProgress" } } });
    send({ id: 91, method: "item/tool/requestUserInput", params: {
      threadId: "thr_input",
      turnId: "turn_input",
      questions: [{
        id: "tax_year",
        header: "Tax year",
        question: "Which tax year should be processed?",
        options: [{ label: "2025", description: "Calendar year 2025" }]
      }]
    } });
  }
  if (message.id === 91 && message.result) {
    const answer = message.result.answers.tax_year.answers[0];
    send({ method: "serverRequest/resolved", params: { threadId: "thr_input", requestId: 91 } });
    send({ method: "item/completed", params: { threadId: "thr_input", turnId: "turn_input", item: { id: "item_answer", type: "agentMessage", text: "selected " + answer } } });
  }
  if (message.method === "turn/steer") {
    const valid = message.params.expectedTurnId === "turn_input" && message.params.input[0].text === "focus on deductions";
    send({ id: message.id, result: { turnId: "turn_input" } });
    send({ method: "item/completed", params: { threadId: "thr_input", turnId: "turn_input", item: { id: "item_steer", type: "agentMessage", text: valid ? "steer accepted" : "steer invalid" } } });
    send({ method: "turn/completed", params: { threadId: "thr_input", turn: { id: "turn_input", status: "completed" } } });
  }
});
`, "utf8");

  const events = [];
  const session = new AppServerSession({
    context: createContext(root, "run_app_server_input", "wsp_app_server_input"),
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: (event) => events.push(event),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });

  try {
    await session.start();
    await waitFor(() => events.some((event) => event.type === "agent.thread.state" && event.thread.connectionState === "waiting_input"));
    assert.equal(events.some((event) => event.type === "conversation.message" && event.message.kind === "prompt" && event.message.text.includes("Which tax year")), true);

    await session.sendMessage({ text: "2025", attachments: [], slotValues: [{ slotKey: "tax_year", valueText: "2025" }] });
    await waitFor(() => events.some((event) => event.type === "conversation.message" && event.message.text === "selected 2025"));
    await session.sendMessage({ text: "focus on deductions", attachments: [], slotValues: [] });
    await waitFor(() => events.some((event) => event.type === "conversation.message" && event.message.text === "steer accepted"));
    await waitFor(() => session.getDiagnostics().currentTurnState === "completed");

    const diagnostics = session.getDiagnostics();
    assert.equal(diagnostics.currentTurnState, "completed");
    assert.equal(events.some((event) => event.type === "agent.thread.state" && event.thread.protocolVersion === "test-v2"), true);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("AppServerSession defers a blank Source Run turn until the first Creator message", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-deferred-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-deferred" } });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_deferred" } } });
  if (message.method === "turn/start") {
    const text = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: "turn_deferred" } } });
    send({ method: "turn/started", params: { threadId: "thr_deferred", turn: { id: "turn_deferred", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thr_deferred", turnId: "turn_deferred", item: { id: "item_deferred", type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId: "thr_deferred", turn: { id: "turn_deferred", status: "completed" } } });
  }
});

`, "utf8");

  const events = [];
  const context = {
    ...createContext(root, "run_source_deferred", "wsp_source_deferred"),
    deferInitialTurn: true,
  };
  const session = new AppServerSession({
    context,
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: (event) => events.push(event),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });

  try {
    await session.start();
    await waitFor(() => events.some((event) => event.type === "run.status.changed" && event.status === "RUNNING"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(events.some((event) => event.type === "agent.runtime.event" && event.eventType === "turn/started"), false);

    await session.sendMessage({ text: "record this workflow", attachments: [], slotValues: [] });
    await waitFor(() => events.some((event) => event.type === "conversation.message" && event.message.role === "agent"));
    const response = events.find((event) => event.type === "conversation.message" && event.message.role === "agent");
    assert.match(response.message.text, /collect required information/);
    assert.match(response.message.text, /record this workflow/);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("AppServerSession automatically accepts approval requests in auto_all mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-auto-approval-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-auto-approval" } });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_auto" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_auto" } } });
    send({ method: "turn/started", params: { threadId: "thr_auto", turn: { id: "turn_auto", status: "inProgress" } } });
    send({ id: 77, method: "item/tool/requestApproval", params: { threadId: "thr_auto", turnId: "turn_auto", itemId: "tool_1", reason: "Allow workspace write" } });
  }
  if (message.id === 77 && message.result?.decision === "accept") {
    send({ method: "item/completed", params: { threadId: "thr_auto", turnId: "turn_auto", item: { id: "item_auto", type: "agentMessage", text: "approval accepted" } } });
    send({ method: "turn/completed", params: { threadId: "thr_auto", turn: { id: "turn_auto", status: "completed" } } });
  }
});
`, "utf8");

  const events = [];
  const session = new AppServerSession({
    context: {
      ...createContext(root, "run_auto_approval", "wsp_auto_approval"),
      approvalMode: "auto_all",
    },
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: (event) => events.push(event),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });

  try {
    await session.start();
    await waitFor(() => events.some(
      (event) => event.type === "conversation.message" && event.message.text === "approval accepted"
    ));
    const approval = events.find((event) => event.type === "approval.requested")?.approval;
    assert.equal(approval?.state, "approved");
    assert.equal(approval?.decisionMode, "auto_all");
    assert.equal(session.getDiagnostics().approvalMode, "auto_all");
    assert.equal(session.getDiagnostics().pendingApprovalCount, 0);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("AppServerSession drains pending requests when auto_all is enabled dynamically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-dynamic-approval-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-dynamic-approval" } });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_dynamic" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_dynamic" } } });
    send({ method: "turn/started", params: { threadId: "thr_dynamic", turn: { id: "turn_dynamic", status: "inProgress" } } });
    send({ id: 88, method: "item/tool/requestApproval", params: { itemId: "tool_dynamic", reason: "Allow command" } });
  }
  if (message.id === 88 && message.result?.decision === "accept") {
    send({ method: "item/completed", params: { threadId: "thr_dynamic", turnId: "turn_dynamic", item: { id: "item_dynamic", type: "agentMessage", text: "dynamic approval accepted" } } });
  }
});

`, "utf8");

  const events = [];
  const session = new AppServerSession({
    context: createContext(root, "run_dynamic_approval", "wsp_dynamic_approval"),
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: (event) => events.push(event),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });

  try {
    await session.start();
    await waitFor(() => session.getDiagnostics().pendingApprovalCount === 1);
    session.setApprovalMode("auto_all");
    await waitFor(() => events.some(
      (event) => event.type === "conversation.message" && event.message.text === "dynamic approval accepted"
    ));
    const approvals = events.filter((event) => event.type === "approval.requested");
    assert.equal(approvals.at(-1)?.approval.state, "approved");
    assert.equal(session.getDiagnostics().approvalMode, "auto_all");
    assert.equal(session.getDiagnostics().pendingApprovalCount, 0);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("AppServerSession injects MCP config and emits redacted native MCP observations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lingban-app-server-mcp-"));
  const fixturePath = path.join(root, "fake-app-server.mjs");
  await writeFile(fixturePath, `
import readline from "node:readline";
const reader = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
reader.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "test-mcp" } });
  if (message.method === "thread/start") {
    const server = message.params?.config?.mcp_servers?.mbd_browser_playwright;
    if (server?.command !== "/usr/local/bin/lingban-playwright-mcp" || server?.default_tools_approval_mode !== "prompt") {
      send({ id: message.id, error: { code: -32602, message: "native MCP config is required" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thr_mcp" } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_mcp" } } });
    send({ method: "turn/started", params: { threadId: "thr_mcp", turn: { id: "turn_mcp", status: "inProgress" } } });
    send({ id: 90, method: "mcpServer/elicitation/request", params: {
      threadId: "thr_mcp",
      turnId: "turn_mcp",
      serverName: "mbd_browser_playwright",
      mode: "form",
      message: "Allow the Playwright MCP server to navigate?",
      requestedSchema: { type: "object", properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", tool_description: "Navigate to a URL" }
    } });
  }
  if (message.id === 90 && message.result?.action === "accept") {
    send({ method: "item/completed", params: { threadId: "thr_mcp", turnId: "turn_mcp", item: {
      id: "mcp_call_1",
      type: "mcpToolCall",
      server: "mbd_browser_playwright",
      tool: "browser_navigate",
      arguments: { url: "https://example.test", apiKey: "sk-sensitive-value" },
      status: "completed",
      durationMs: 125,
      result: { content: [{ type: "text", text: "Bearer private-token" }], structuredContent: { token: "private-token" } },
      error: null
    } } });
    send({ method: "item/completed", params: { threadId: "thr_mcp", turnId: "turn_mcp", item: { id: "item_mcp_done", type: "agentMessage", text: "MCP completed" } } });
    send({ method: "turn/completed", params: { threadId: "thr_mcp", turn: { id: "turn_mcp", status: "completed" } } });
  }
});
`, "utf8");

  const context = {
    ...createContext(root, "run_app_server_mcp", "wsp_app_server_mcp"),
    approvalMode: "auto_all",
    mcpBindings: [{
      bindingId: "mbd_browser_playwright",
      mcpId: "mcp.browser.playwright",
      displayName: "Playwright Browser",
      source: "first-party",
      transport: "stdio",
      ref: "/usr/local/bin/lingban-playwright-mcp",
      riskLevel: "high",
      credentialId: null,
      authMode: null,
      authRef: null,
      networkPolicyRef: null,
      approvalRequired: true,
    }],
  };
  const observations = [];
  const session = new AppServerSession({
    context,
    launch: { command: process.execPath, args: [fixturePath], cwd: root },
    emit: () => undefined,
    observeMcpCall: (observation) => observations.push(observation),
    requestTimeoutMs: 10_000,
    includeDefaultAppServerArgs: false,
  });
  session.setThreadConfig({
    mcp_servers: {
      mbd_browser_playwright: {
        command: "/usr/local/bin/lingban-playwright-mcp",
        enabled: true,
        required: true,
        default_tools_approval_mode: "prompt",
      },
    },
  });

  try {
    await session.start();
    await waitFor(() => observations.length === 1);
    assert.equal(observations[0].mcpId, "mcp.browser.playwright");
    assert.equal(observations[0].bindingId, "mbd_browser_playwright");
    assert.equal(observations[0].toolName, "browser_navigate");
    assert.equal(observations[0].status, "success");
    assert.equal(observations[0].durationMs, 125);
    assert.match(observations[0].inputSummary, /\[REDACTED\]/);
    assert.doesNotMatch(observations[0].inputSummary, /sk-sensitive-value/);
    assert.match(observations[0].outputSummary, /\[REDACTED\]/);
    assert.doesNotMatch(observations[0].outputSummary, /private-token/);
  } finally {
    await session.stop();
    await rm(root, { recursive: true, force: true });
  }
});
