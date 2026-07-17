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
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thr_test" } } });
  if (message.method === "turn/start") {
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
