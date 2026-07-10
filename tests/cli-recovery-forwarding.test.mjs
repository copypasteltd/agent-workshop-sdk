import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

async function startCaptureServer() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: rawBody ? JSON.parse(rawBody) : null,
    });

    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify({ ok: true }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
    server.once("error", reject);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  return {
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
      });
    },
  };
}

async function allocatePort() {
  const probe = http.createServer();

  await new Promise((resolve, reject) => {
    probe.listen(0, "127.0.0.1", () => resolve(undefined));
    probe.once("error", reject);
  });

  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  await new Promise((resolve, reject) => {
    probe.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });

  return port;
}

async function waitFor(check, options = {}) {
  const { timeoutMs = 10_000, intervalMs = 50, label = "condition" } = options;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function flattenForwardedEvents(requests, runId) {
  return requests
    .filter((entry) => entry.url === `/internal/runs/${runId}/events`)
    .flatMap((entry) => entry.body?.events ?? []);
}

function collectStatuses(requests, runId) {
  return requests
    .filter((entry) => entry.url === `/internal/runs/${runId}/status`)
    .map((entry) => entry.body?.status);
}

async function postControl(baseUrl, authToken, body) {
  const response = await fetch(`${baseUrl}/control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lingban-control-token": authToken,
    },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function getDiagnostics(baseUrl, authToken) {
  const response = await fetch(`${baseUrl}/diagnostics`, {
    headers: {
      "x-lingban-control-token": authToken,
    },
  });

  if (response.status !== 200) {
    assert.fail(await response.text());
  }
  return response.json();
}

async function importConfigModule() {
  const modulePath = fileURLToPath(
    new URL("../../../packages/config/dist/index.js", import.meta.url)
  );
  return import(pathToFileURL(modulePath).href);
}

function normalizeTranscript(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

test("bridge CLI recovers the Codex session and replays queued operator input", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lingban-bridge-recovery-"));
  const captureServer = await startCaptureServer();
  const apiToken = "bridge-api-token";
  const controlToken = "control-token";
  const runId = "run_recovery_0001";
  const workspaceId = "wsp_recovery_0001";

  try {
    const targetPath = path.join(tempRoot, "target");
    const runtimeDir = path.join(tempRoot, "runtime");
    const outputsPath = path.join(tempRoot, "outputs");
    const contextPath = path.join(runtimeDir, "bridge-context.host.json");
    const scriptPath = path.join(tempRoot, "codex-recovery-script.cjs");
    const statePath = path.join(tempRoot, "recovery-state.json");
    const controlPort = await allocatePort();
    const controlBaseUrl = `http://127.0.0.1:${controlPort}`;

    await mkdir(targetPath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(outputsPath, { recursive: true });

    await writeFile(
      contextPath,
      JSON.stringify(
        {
          runId,
          workspaceId,
          targetPath,
          initialPrompt: "Please describe any missing inputs before continuing.",
          requestedInitialMessage: "The operator is ready. Ask for the next required details.",
          credentialMounts: [],
          mcpBindings: [
            {
              bindingId: "mbd_recovery_0001",
              mcpId: "workspace:test-recovery",
              displayName: "Recovery Test MCP",
              source: "workspace-managed",
              transport: "http",
              ref: "https://mcp.workspace.internal/recovery-test",
              riskLevel: "medium",
              credentialId: null,
              authMode: null,
              authRef: null,
              networkPolicyRef: "np_recovery_test",
              approvalRequired: false,
            },
          ],
          mcpNetworkPolicies: [
            {
              policyRef: "np_recovery_test",
              workspaceId,
              displayName: "Recovery Test Policy",
              description: "allow recovery connector",
              status: "active",
              mode: "allowlist",
              allowedProtocols: ["https"],
              allowedHostPatterns: ["mcp.workspace.internal"],
              allowedPorts: [443],
              allowedPathPrefixes: ["/recovery-test"],
              requireTls: true,
              blockPrivateNetwork: false,
              tags: ["test", "recovery"],
              createdAt: "2026-07-10T10:00:00.000Z",
              updatedAt: "2026-07-10T10:00:00.000Z",
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    await writeFile(
      scriptPath,
      [
        "const fs = require('node:fs/promises');",
        "const path = require('node:path');",
        "",
        "(async () => {",
        "  const statePath = process.env.LINGBAN_TEST_STATE_PATH;",
        "  const outputsPath = path.join(process.env.TARGET_PATH, '..', 'outputs');",
        "  await fs.mkdir(outputsPath, { recursive: true });",
        "",
        "  let launchCount = 0;",
        "  try {",
        "    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));",
        "    launchCount = state.launchCount ?? 0;",
        "  } catch {}",
        "  launchCount += 1;",
        "  await fs.writeFile(statePath, JSON.stringify({ launchCount }, null, 2), 'utf8');",
        "  console.log(`codex launch ${launchCount}`);",
        "",
        "  if (launchCount === 1) {",
        "    setTimeout(() => process.exit(17), 500);",
        "    return;",
        "  }",
        "",
        "  process.stdin.setEncoding('utf8');",
        "  process.stdin.resume();",
        "",
        "  let transcript = '';",
        "  let flushTimer = null;",
        "",
        "  const finalize = async () => {",
        "    if (flushTimer) {",
        "      clearTimeout(flushTimer);",
        "      flushTimer = null;",
        "    }",
        "    await fs.writeFile(path.join(outputsPath, 'recovered-transcript.txt'), transcript, 'utf8');",
        "    await fs.appendFile(",
        "      process.env.LINGBAN_MCP_AUDIT_LOG_PATH,",
        "      JSON.stringify({",
        "        mcpId: 'workspace:test-recovery',",
        "        toolName: 'resume_session',",
        "        status: 'success',",
        "        startedAt: '2026-07-09T03:00:00.000Z',",
        "        finishedAt: '2026-07-09T03:00:00.300Z',",
        "        inputSummary: 'replayed buffered inputs',",
        "        outputSummary: 'transcript captured',",
        "        inputBytes: Buffer.byteLength(transcript, 'utf8'),",
        "        outputBytes: Buffer.byteLength(transcript, 'utf8')",
        "      }) + '\\\\n',",
        "      'utf8'",
        "    );",
        "    console.log('codex recovery complete');",
        "    setTimeout(() => process.exit(0), 250);",
        "  };",
        "",
        "  const scheduleFinalize = () => {",
        "    if (flushTimer) {",
        "      clearTimeout(flushTimer);",
        "    }",
        "    flushTimer = setTimeout(() => {",
        "      finalize().catch((error) => {",
        "        console.error(error.stack || String(error));",
        "        process.exit(1);",
        "      });",
        "    }, 350);",
        "  };",
        "",
        "  process.stdin.on('data', (chunk) => {",
        "    transcript += chunk;",
        "    scheduleFinalize();",
        "  });",
        "",
        "  scheduleFinalize();",
        "})().catch((error) => {",
        "  console.error(error.stack || String(error));",
        "  process.exit(1);",
        "});",
      ].join("\n"),
      "utf8"
    );

    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const resultPromise = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath], {
        cwd: path.dirname(cliPath),
        env: {
          ...process.env,
          BRIDGE_CONTEXT_PATH: contextPath,
          RUNTIME_DIR: runtimeDir,
          OUTPUTS_PATH: outputsPath,
          BRIDGE_CONTROL_HOST: "127.0.0.1",
          BRIDGE_CONTROL_PORT: String(controlPort),
          LINGBAN_BRIDGE_CONTROL_TOKEN: controlToken,
          LINGBAN_API_BASE_URL: captureServer.baseUrl,
          LINGBAN_INTERNAL_AUTH_TOKEN: apiToken,
          LINGBAN_BRIDGE_CODEX_RESTART_MAX_ATTEMPTS: "2",
          LINGBAN_BRIDGE_CODEX_RESTART_BACKOFF_MS: "800",
          LINGBAN_BRIDGE_CODEX_RESTART_RESET_WINDOW_MS: "0",
          LINGBAN_TEST_STATE_PATH: statePath,
          CODEX_BIN: process.execPath,
          CODEX_ARGS_JSON: JSON.stringify([scriptPath]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({
          exitCode: null,
          signal: "SIGKILL",
          stdout,
          stderr: `${stderr}\n<killed after timeout>`,
        });
      }, 15_000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => {
        clearTimeout(timeout);
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
        });
      });
    });

    await waitFor(
      async () => {
        try {
          const response = await fetch(`${controlBaseUrl}/health`);
          return response.status === 200;
        } catch {
          return false;
        }
      },
      {
        label: "bridge control health endpoint",
      }
    );

    await postControl(controlBaseUrl, controlToken, {
      type: "sendMessage",
      payload: {
        text: "Input A: summarize the materials that are still missing.",
        attachments: [],
      },
    });

    await waitFor(
      () =>
        flattenForwardedEvents(captureServer.requests, runId).find(
          (event) =>
            event.type === "conversation.message" &&
            event.message?.role === "system" &&
            event.message?.kind === "status" &&
            event.message?.text.includes("attempting automatic recovery")
        ),
      {
        label: "automatic recovery event",
      }
    );

    const diagnosticsDuringRecovery = await getDiagnostics(controlBaseUrl, controlToken);
    assert.equal(diagnosticsDuringRecovery.controlServer.session.recovering, true);
    assert.equal(diagnosticsDuringRecovery.controlServer.session.restartAttemptsTotal, 1);
    assert.equal(diagnosticsDuringRecovery.controlServer.session.restartBudgetUsed, 1);
    assert.equal(diagnosticsDuringRecovery.controlServer.session.replayHistoryCount, 1);

    await postControl(controlBaseUrl, controlToken, {
      type: "sendMessage",
      payload: {
        text: "Input B: the operator also uploaded invoice batch 2026-Q3.",
        attachments: [],
      },
    });
    await postControl(controlBaseUrl, controlToken, {
      type: "approve",
      payload: {
        approved: true,
        note: "Operator approved recovery continuation.",
      },
    });

    await waitFor(
      () =>
        flattenForwardedEvents(captureServer.requests, runId).find(
          (event) =>
            event.type === "conversation.message" &&
            event.message?.role === "system" &&
            event.message?.kind === "status" &&
            event.message?.text.includes("replayed 3 prior input(s)")
        ),
      {
        label: "recovery replay confirmation",
      }
    );

    const result = await resultPromise;
    assert.equal(
      result.exitCode,
      0,
      `bridge CLI exited unexpectedly (exit=${result.exitCode}, signal=${result.signal ?? "null"})\nstdout:\n${result.stdout || "<empty>"}\nstderr:\n${result.stderr || "<empty>"}\nrequests:\n${JSON.stringify(
        captureServer.requests.map((entry) => ({
          url: entry.url,
          body: entry.body,
        })),
        null,
        2
      )}`
    );

    const statuses = collectStatuses(captureServer.requests, runId);
    assert.ok(statuses.includes("STARTING"));
    assert.ok(statuses.includes("RUNNING"));
    assert.ok(statuses.includes("SUCCEEDED"));
    assert.equal(statuses.includes("FAILED"), false);

    const forwardedEvents = flattenForwardedEvents(captureServer.requests, runId);
    assert.ok(
      forwardedEvents.some(
        (event) =>
          event.type === "conversation.message" &&
          typeof event.message?.text === "string" &&
          event.message.text.includes("codex recovery complete")
      )
    );
    const transcript = normalizeTranscript(
      await readFile(path.join(outputsPath, "recovered-transcript.txt"), "utf8")
    );
    assert.match(transcript, /Please describe any missing inputs before continuing\./);
    assert.match(transcript, /The operator is ready\. Ask for the next required details\./);
    assert.match(transcript, /Input A: summarize the materials that are still missing\./);
    assert.match(transcript, /Input B: the operator also uploaded invoice batch 2026-Q3\./);
    assert.match(transcript, /Approval granted\. Continue execution\./);
    assert.match(transcript, /Operator approved recovery continuation\./);

    const artifactRequests = captureServer.requests.filter(
      (entry) => entry.url === `/internal/runs/${runId}/artifacts`
    );
    const forwardedArtifacts = artifactRequests.flatMap((entry) => entry.body?.artifacts ?? []);
    assert.ok(
      forwardedArtifacts.some(
        (artifact) =>
          artifact.label === "recovered-transcript.txt" &&
          typeof artifact.file?.path === "string" &&
          artifact.file.path.endsWith("recovered-transcript.txt")
      )
    );
  } finally {
    await captureServer.close();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("loadBridgeCliRuntimeConfig accepts zero-valued recovery settings", async () => {
  const { loadBridgeCliRuntimeConfig } = await importConfigModule();

  const config = loadBridgeCliRuntimeConfig(
    {
      BRIDGE_CONTEXT_PATH: "C:/tmp/bridge-context.json",
      LINGBAN_BRIDGE_CODEX_RESTART_MAX_ATTEMPTS: "0",
      LINGBAN_BRIDGE_CODEX_RESTART_BACKOFF_MS: "0",
      LINGBAN_BRIDGE_CODEX_RESTART_RESET_WINDOW_MS: "0",
    },
    []
  );

  assert.equal(config.contextPath, "C:/tmp/bridge-context.json");
  assert.equal(config.codexRestartMaxAttempts, 0);
  assert.equal(config.codexRestartBackoffMs, 0);
  assert.equal(config.codexRestartResetWindowMs, 0);
});
