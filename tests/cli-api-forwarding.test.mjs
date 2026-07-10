import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function startCaptureServer(token) {
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

test("bridge CLI forwards register, status, events, and artifacts through ApiConnector", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lingban-bridge-cli-"));
  const apiToken = "bridge-api-token";
  const captureServer = await startCaptureServer(apiToken);

  try {
    const targetPath = path.join(tempRoot, "target");
    const runtimeDir = path.join(tempRoot, "runtime");
    const outputsPath = path.join(tempRoot, "outputs");
    const contextPath = path.join(runtimeDir, "bridge-context.host.json");
    const controlPort = await allocatePort();

    await mkdir(targetPath, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(outputsPath, { recursive: true });

    await writeFile(
      contextPath,
      JSON.stringify(
        {
          runId: "run_00000099",
          workspaceId: "wsp_00000099",
          targetPath,
          initialPrompt: "请先说明当前任务需要用户补充的必要信息。",
          requestedInitialMessage: null,
          credentialMounts: [],
          mcpBindings: [
            {
              bindingId: "mbd_00000001",
              mcpId: "workspace:seedance-api",
              displayName: "Seedance Workspace Connector",
              source: "workspace-managed",
              transport: "http",
              ref: "https://mcp.workspace.internal/seedance",
              riskLevel: "medium",
              credentialId: null,
              authMode: null,
              authRef: null,
              networkPolicyRef: "np_seedance_workspace",
              approvalRequired: false,
            },
          ],
          mcpNetworkPolicies: [
            {
              policyRef: "np_seedance_workspace",
              workspaceId: "wsp_00000099",
              displayName: "Seedance Workspace Policy",
              description: "allow managed seedance connector",
              status: "active",
              mode: "allowlist",
              allowedProtocols: ["https"],
              allowedHostPatterns: ["mcp.workspace.internal"],
              allowedPorts: [443],
              allowedPathPrefixes: ["/seedance"],
              requireTls: true,
              blockPrivateNetwork: false,
              tags: ["test", "managed"],
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

    const codexScript = [
      "const fs=require('node:fs/promises');",
      "const path=require('node:path');",
      "(async()=>{",
      "const outputsPath=path.join(process.env.TARGET_PATH,'..','outputs');",
      "await fs.mkdir(outputsPath,{recursive:true});",
      "await fs.writeFile(path.join(outputsPath,'report.txt'),'artifact output\\n','utf8');",
      "await fs.appendFile(process.env.LINGBAN_MCP_AUDIT_LOG_PATH,JSON.stringify({mcpId:'workspace:seedance-api',toolName:'render_scene',status:'success',startedAt:'2026-07-09T02:00:00.000Z',finishedAt:'2026-07-09T02:00:01.250Z',inputSummary:'scene=pilot',outputSummary:'asset=shot-01.png',inputBytes:128,outputBytes:512})+'\\n','utf8');",
      "console.log('agent says hi');",
      "setTimeout(()=>process.exit(0),400);",
      "})().catch((error)=>{console.error(error.stack||String(error));process.exit(1);});",
    ].join("");

    const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath], {
        cwd: path.dirname(cliPath),
        env: {
          ...process.env,
          BRIDGE_CONTEXT_PATH: contextPath,
          RUNTIME_DIR: runtimeDir,
          OUTPUTS_PATH: outputsPath,
          BRIDGE_CONTROL_HOST: "127.0.0.1",
          BRIDGE_CONTROL_PORT: String(controlPort),
          LINGBAN_BRIDGE_CONTROL_TOKEN: "control-token",
          LINGBAN_API_BASE_URL: captureServer.baseUrl,
          LINGBAN_INTERNAL_AUTH_TOKEN: apiToken,
          CODEX_BIN: process.execPath,
          CODEX_ARGS_JSON: JSON.stringify(["-e", codexScript]),
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
      }, 10_000);

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

    assert.equal(
      result.exitCode,
      0,
      `bridge CLI exited unexpectedly (exit=${result.exitCode}, signal=${result.signal ?? "null"})\nstdout:\n${result.stdout || "<empty>"}\nstderr:\n${result.stderr || "<empty>"}\nrequests:\n${JSON.stringify(
        captureServer.requests.map((entry) => ({
          url: entry.url,
          status: entry.body?.status,
          eventTypes: Array.isArray(entry.body?.events)
            ? entry.body.events.map((event) => event.type)
            : undefined,
          artifactLabels: Array.isArray(entry.body?.artifacts)
            ? entry.body.artifacts.map((artifact) => artifact.label)
            : undefined,
        })),
        null,
        2
      )}`
    );

    const urls = captureServer.requests.map((entry) => entry.url);
    assert.ok(urls.includes("/internal/bridges/register"));
    assert.ok(urls.includes("/internal/runs/run_00000099/events"));
    assert.ok(urls.includes("/internal/runs/run_00000099/status"));
    assert.ok(urls.includes("/internal/runs/run_00000099/artifacts"));
    assert.equal(
      captureServer.requests.every(
        (entry) => entry.headers["x-lingban-internal-token"] === apiToken
      ),
      true
    );

    const registrationRequest = captureServer.requests.find(
      (entry) => entry.url === "/internal/bridges/register"
    );
    assert.ok(registrationRequest);
    assert.equal(registrationRequest.body.runId, "run_00000099");
    assert.equal(
      typeof registrationRequest.body.control?.baseUrl,
      "string"
    );
    assert.match(registrationRequest.body.control.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(registrationRequest.body.control.authToken, "control-token");

    const statuses = captureServer.requests
      .filter((entry) => entry.url === "/internal/runs/run_00000099/status")
      .map((entry) => entry.body.status);
    assert.ok(statuses.includes("STARTING"));
    assert.ok(statuses.includes("RUNNING"));
    assert.ok(statuses.includes("SUCCEEDED"));

    const eventRequests = captureServer.requests.filter(
      (entry) => entry.url === "/internal/runs/run_00000099/events"
    );
    const forwardedEvents = eventRequests.flatMap((entry) => entry.body.events ?? []);
    assert.ok(
      forwardedEvents.some(
        (event) =>
          event.type === "conversation.message" &&
          typeof event.message?.text === "string" &&
          event.message.text.includes("agent says hi")
      )
    );
    assert.ok(
      forwardedEvents.some(
        (event) =>
          event.type === "mcp.call" &&
          event.call?.mcpId === "workspace:seedance-api" &&
          event.call?.toolName === "render_scene" &&
          event.call?.status === "success"
      )
    );

    const artifactRequests = captureServer.requests.filter(
      (entry) => entry.url === "/internal/runs/run_00000099/artifacts"
    );
    const forwardedArtifacts = artifactRequests.flatMap((entry) => entry.body.artifacts ?? []);
    assert.ok(
      forwardedArtifacts.some(
        (artifact) =>
          artifact.label === "report.txt" &&
          typeof artifact.file?.path === "string" &&
          artifact.file.path.endsWith("report.txt")
      )
    );
  } finally {
    await captureServer.close();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
