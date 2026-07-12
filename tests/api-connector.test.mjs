import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importApiConnector() {
  const moduleUrl = pathToFileURL(path.resolve("dist/transports/api-connector.js")).href;
  return import(moduleUrl);
}

async function startJsonServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : null;
    const entry = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body,
    };
    requests.push(entry);
    await handler(entry, response, requests.length);
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

test("ApiConnector retries transient failures and forwards internal auth header", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";

  const server = await startJsonServer(async (entry, response, attempt) => {
    assert.equal(entry.method, "POST");
    assert.equal(entry.url, "/internal/runs/run_00000001/status");
    assert.equal(entry.headers["x-lingban-internal-token"], token);
    assert.equal(typeof entry.headers["x-lingban-trace-id"], "string");
    assert.equal(typeof entry.headers["x-lingban-idempotency-key"], "string");
    assert.deepEqual(entry.body, {
      status: "RUNNING",
      reason: "runtime recovered",
      occurredAt: "2026-07-08T10:00:00.000Z",
    });

    if (attempt < 3) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("retry later");
      return;
    }

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, attempt }));
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      retryAttempts: 3,
      retryDelayMs: 10,
      requestTimeoutMs: 1_000,
    });

    const result = await connector.syncRunStatus(
      "run_00000001",
      "RUNNING",
      "runtime recovered",
      "2026-07-08T10:00:00.000Z"
    );

    assert.deepEqual(result, { ok: true, attempt: 3 });
    assert.equal(server.requests.length, 3);
    assert.equal(
      new Set(server.requests.map((entry) => entry.headers["x-lingban-trace-id"])).size,
      1
    );
    assert.equal(
      new Set(server.requests.map((entry) => entry.headers["x-lingban-idempotency-key"])).size,
      1
    );
  } finally {
    await server.close();
  }
});

test("ApiConnector can fetch run snapshots through the internal API", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";

  const server = await startJsonServer(async (entry, response) => {
    assert.equal(entry.method, "GET");
    assert.equal(entry.url, "/internal/runs/run_00000042/snapshot");
    assert.equal(entry.headers["x-lingban-internal-token"], token);

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        run: {
          runId: "run_00000042",
          workspaceId: "wsp_00000042",
          taskVersionId: "tsv_00000042",
          sessionVersionId: "sev_00000042",
          title: "Snapshot test",
          targetPath: "/workspace/target",
          entrySurface: "dashboard",
          status: "RUNNING",
          statusReason: "processing",
          createdAt: "2026-07-08T10:00:00.000Z",
          updatedAt: "2026-07-08T10:01:00.000Z",
        },
        input: {
          workspaceId: "wsp_00000042",
          taskVersionId: "tsv_00000042",
          sessionVersionId: "sev_00000042",
          title: "Snapshot test",
          targetPath: "/workspace/target",
          entrySurface: "dashboard",
          initialMessage: null,
          bindings: {
            firstPartyMcpIds: [],
            externalConnectorRefs: [],
            credentialIds: [],
          },
        },
        startJob: {
          run: {
            runId: "run_00000042",
            workspaceId: "wsp_00000042",
            taskVersionId: "tsv_00000042",
            sessionVersionId: "sev_00000042",
            title: "Snapshot test",
            targetPath: "/workspace/target",
            entrySurface: "dashboard",
            status: "RUNNING",
            statusReason: "processing",
            createdAt: "2026-07-08T10:00:00.000Z",
            updatedAt: "2026-07-08T10:01:00.000Z",
          },
          initialPrompt: "hello",
          requestedInitialMessage: null,
          bindings: {
            firstPartyMcpIds: [],
            externalConnectorRefs: [],
            credentialIds: [],
          },
        },
        messages: [],
        files: [],
        artifacts: [],
        approvals: [],
      })
    );
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      requestTimeoutMs: 1_000,
    });

    const snapshot = await connector.getRunSnapshot("run_00000042");
    assert.equal(snapshot.run.runId, "run_00000042");
    assert.equal(snapshot.run.status, "RUNNING");
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("ApiConnector can sync runtime metadata through the internal API", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";

  const server = await startJsonServer(async (entry, response) => {
    assert.equal(entry.method, "POST");
    assert.equal(entry.url, "/internal/runs/run_00000052/runtime");
    assert.equal(entry.headers["x-lingban-internal-token"], token);
    assert.deepEqual(entry.body, {
      launchMode: "docker",
      containerName: "lingban-run-run_00000052",
      startedAt: "2026-07-08T10:00:00.000Z",
      readyAt: "2026-07-08T10:00:02.000Z",
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
    });

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      requestTimeoutMs: 1_000,
    });

    const result = await connector.syncRunRuntime("run_00000052", {
      launchMode: "docker",
      containerName: "lingban-run-run_00000052",
      startedAt: "2026-07-08T10:00:00.000Z",
      readyAt: "2026-07-08T10:00:02.000Z",
      finishedAt: null,
      exitCode: null,
      exitSignal: null,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("ApiConnector can materialize run credentials through the internal API", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";

  const server = await startJsonServer(async (entry, response) => {
    assert.equal(entry.method, "POST");
    assert.equal(entry.url, "/internal/runs/run_00000077/credentials/materialize");
    assert.equal(entry.headers["x-lingban-internal-token"], token);

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        lease: {
          leaseId: "lse_00000001",
          runId: "run_00000077",
          workspaceId: "wsp_00000077",
          requestedByUserId: "usr_00000077",
          brokerKind: "local-envelope",
          credentialIds: ["cred_00000077"],
          secretVersionByCredentialId: {
            cred_00000077: 2,
          },
          issuedAt: "2026-07-10T10:00:00.000Z",
          expiresAt: "2026-07-10T10:05:00.000Z",
        },
        secrets: {
          cred_00000077: "secret-value-77",
        },
      })
    );
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      requestTimeoutMs: 1_000,
    });

    const response = await connector.materializeRunCredentials("run_00000077");
    assert.equal(response.lease.leaseId, "lse_00000001");
    assert.equal(response.secrets.cred_00000077, "secret-value-77");
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("ApiConnector can download session-pack archives through the internal API", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";
  const archiveBytes = Buffer.from("session-pack-archive-test");

  const server = await startJsonServer(async (entry, response) => {
    assert.equal(entry.method, "GET");
    assert.equal(entry.url, "/internal/runs/run_00000078/session-pack/archive");
    assert.equal(entry.headers["x-lingban-internal-token"], token);

    response.writeHead(200, {
      "content-type": "application/gzip",
      "x-lingban-session-pack-source": "imported",
      "x-lingban-session-pack-file-name": "sev_00000078.session-pack.json.gz",
    });
    response.end(archiveBytes);
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      requestTimeoutMs: 1_000,
    });

    const response = await connector.downloadRunSessionPackArchive("run_00000078");
    assert.equal(response.fileName, "sev_00000078.session-pack.json.gz");
    assert.equal(response.source, "imported");
    assert.equal(response.contentType, "application/gzip");
    assert.equal(Buffer.compare(Buffer.from(response.content), archiveBytes), 0);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test("ApiConnector can fetch runtime recovery candidates through the internal API", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";

  const server = await startJsonServer(async (entry, response) => {
    assert.equal(entry.method, "GET");
    assert.equal(entry.url, "/internal/runs/run_00000088/recovery");
    assert.equal(entry.headers["x-lingban-internal-token"], token);

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        snapshot: {
          run: {
            runId: "run_00000088",
            workspaceId: "wsp_00000088",
            taskVersionId: "tsv_00000088",
            sessionVersionId: "sev_00000088",
            title: "Recovery candidate test",
            targetPath: "/workspace/target",
            entrySurface: "dashboard",
            status: "RUNNING",
            statusReason: null,
            createdAt: "2026-07-09T01:00:00.000Z",
            updatedAt: "2026-07-09T01:01:00.000Z",
          },
          runtime: {},
          messages: [],
          files: [],
          artifacts: [],
          approvals: [],
        },
        bridge: {
          registered: false,
          controllerAttached: false,
          connectedAt: null,
        },
        action: "mark-orphan-failed",
        reason: "runtime has no active bridge registration",
        startJob: null,
      })
    );
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      requestTimeoutMs: 1_000,
    });

    const candidate = await connector.getRunRecoveryCandidate("run_00000088");
    assert.equal(candidate.snapshot.run.runId, "run_00000088");
    assert.equal(candidate.action, "mark-orphan-failed");
    assert.equal(candidate.bridge.registered, false);
  } finally {
    await server.close();
  }
});

test("ApiConnector can list runtime recovery candidates through the internal API", async () => {
  const { ApiConnector } = await importApiConnector();
  const token = "internal-test-token";

  const server = await startJsonServer(async (entry, response) => {
    assert.equal(entry.method, "GET");
    assert.equal(entry.url, "/internal/runs/recovery");
    assert.equal(entry.headers["x-lingban-internal-token"], token);

    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        candidates: [
          {
            snapshot: {
              run: {
                runId: "run_00000089",
                workspaceId: "wsp_00000089",
                taskVersionId: "tsv_00000089",
                sessionVersionId: "sev_00000089",
                title: "Recovery list test",
                targetPath: "/workspace/target",
                entrySurface: "dashboard",
                status: "CREATED",
                statusReason: null,
                createdAt: "2026-07-09T01:00:00.000Z",
                updatedAt: "2026-07-09T01:00:30.000Z",
              },
              runtime: {},
              messages: [],
              files: [],
              artifacts: [],
              approvals: [],
            },
            bridge: {
              registered: false,
              controllerAttached: false,
              connectedAt: null,
            },
            action: "enqueue-start",
            reason: "created run should be re-enqueued",
            startJob: {
              run: {
                runId: "run_00000089",
                workspaceId: "wsp_00000089",
                taskVersionId: "tsv_00000089",
                sessionVersionId: "sev_00000089",
                title: "Recovery list test",
                targetPath: "/workspace/target",
                entrySurface: "dashboard",
                status: "CREATED",
                statusReason: null,
                createdAt: "2026-07-09T01:00:00.000Z",
                updatedAt: "2026-07-09T01:00:30.000Z",
              },
              initialPrompt: "Start run_00000089",
              requestedInitialMessage: null,
              bindings: {
                firstPartyMcpIds: [],
                externalConnectorRefs: [],
                credentialIds: [],
              },
              credentialMounts: [],
              mcpBindings: [],
            },
          },
        ],
      })
    );
  });

  try {
    const connector = new ApiConnector({
      baseUrl: server.baseUrl,
      authToken: token,
      requestTimeoutMs: 1_000,
    });

    const recovery = await connector.listRunRecoveryCandidates();
    assert.equal(recovery.candidates.length, 1);
    assert.equal(recovery.candidates[0].action, "enqueue-start");
    assert.equal(recovery.candidates[0].startJob.run.runId, "run_00000089");
  } finally {
    await server.close();
  }
});
