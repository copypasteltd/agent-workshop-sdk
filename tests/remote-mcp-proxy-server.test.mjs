import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importRemoteMcpProxyServer() {
  const moduleUrl = pathToFileURL(
    path.resolve("dist/bridge/remote-mcp-proxy-server.js")
  ).href;
  return import(moduleUrl);
}

async function startHttpServer(handler) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString("utf8");
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
    port: address.port,
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

function createProxyContext(binding, policy = null) {
  return {
    runId: "run_proxy_test",
    workspaceId: "wsp_proxy_test",
    targetPath: "/workspace/target",
    initialPrompt: "hello",
    requestedInitialMessage: null,
    credentialMounts: [],
    mcpBindings: [binding],
    mcpNetworkPolicies: policy ? [policy] : [],
  };
}

test("RemoteMcpProxyServer forwards HTTP requests to the governed remote MCP target", async () => {
  const { RemoteMcpProxyServer } = await importRemoteMcpProxyServer();
  const upstream = await startHttpServer(async (entry, response) => {
    assert.equal(entry.method, "POST");
    assert.equal(entry.url, "/mcp");
    assert.equal(entry.headers.authorization, "Bearer proxy-test");
    assert.equal(entry.body, JSON.stringify({ ping: true }));

    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-upstream-source": "governed-http",
    });
    response.end(JSON.stringify({ ok: true }));
  });

  const binding = {
    bindingId: "mbd_proxy_http",
    mcpId: "workspace:proxy-http",
    displayName: "Proxy HTTP MCP",
    source: "workspace-managed",
    transport: "http",
    ref: `${upstream.baseUrl}/mcp`,
    riskLevel: "medium",
    credentialId: null,
    authMode: null,
    authRef: null,
    networkPolicyRef: "np_proxy_http",
    approvalRequired: false,
  };
  const policy = {
    policyRef: "np_proxy_http",
    workspaceId: "wsp_proxy_test",
    displayName: "Proxy HTTP Policy",
    description: "allow local governed test target",
    status: "active",
    mode: "allowlist",
    allowedProtocols: ["http"],
    allowedHostPatterns: ["127.0.0.1"],
    allowedPorts: [upstream.port],
    allowedPathPrefixes: ["/mcp"],
    requireTls: false,
    blockPrivateNetwork: false,
    tags: ["test"],
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
  };

  const proxy = new RemoteMcpProxyServer({
    context: createProxyContext(binding, policy),
  });

  try {
    await proxy.start();
    const response = await fetch(proxy.buildBindingUrl(binding), {
      method: "POST",
      headers: {
        authorization: "Bearer proxy-test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ping: true }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream-source"), "governed-http");
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(upstream.requests.length, 1);
    assert.equal(proxy.getDiagnostics().requestsTotal, 1);
    assert.equal(proxy.getDiagnostics().blockedTotal, 0);
  } finally {
    await proxy.stop();
    await upstream.close();
  }
});

test("RemoteMcpProxyServer streams SSE responses from the governed remote MCP target", async () => {
  const { RemoteMcpProxyServer } = await importRemoteMcpProxyServer();
  const upstream = await startHttpServer(async (_entry, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write("data: first\n\n");
    response.write("data: second\n\n");
    response.end();
  });

  const binding = {
    bindingId: "mbd_proxy_sse",
    mcpId: "workspace:proxy-sse",
    displayName: "Proxy SSE MCP",
    source: "workspace-managed",
    transport: "sse",
    ref: `${upstream.baseUrl}/events`,
    riskLevel: "medium",
    credentialId: null,
    authMode: null,
    authRef: null,
    networkPolicyRef: "np_proxy_sse",
    approvalRequired: false,
  };
  const policy = {
    policyRef: "np_proxy_sse",
    workspaceId: "wsp_proxy_test",
    displayName: "Proxy SSE Policy",
    description: "allow local governed SSE target",
    status: "active",
    mode: "allowlist",
    allowedProtocols: ["http"],
    allowedHostPatterns: ["127.0.0.1"],
    allowedPorts: [upstream.port],
    allowedPathPrefixes: ["/events"],
    requireTls: false,
    blockPrivateNetwork: false,
    tags: ["test"],
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
  };

  const proxy = new RemoteMcpProxyServer({
    context: createProxyContext(binding, policy),
  });

  try {
    await proxy.start();
    const response = await fetch(proxy.buildBindingUrl(binding));
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/
    );
    const body = await response.text();
    assert.match(body, /data: first/);
    assert.match(body, /data: second/);
    assert.equal(proxy.getDiagnostics().requestsTotal, 1);
  } finally {
    await proxy.stop();
    await upstream.close();
  }
});

test("RemoteMcpProxyServer blocks remote requests when no runtime network policy is present", async () => {
  const { RemoteMcpProxyServer } = await importRemoteMcpProxyServer();
  const binding = {
    bindingId: "mbd_proxy_blocked",
    mcpId: "third-party:blocked-http",
    displayName: "Blocked HTTP MCP",
    source: "third-party",
    transport: "http",
    ref: "https://third-party-mcp.example.org/blocked",
    riskLevel: "high",
    credentialId: null,
    authMode: null,
    authRef: null,
    networkPolicyRef: null,
    approvalRequired: true,
  };

  const proxy = new RemoteMcpProxyServer({
    context: createProxyContext(binding, null),
  });

  try {
    await proxy.start();
    const response = await fetch(proxy.buildBindingUrl(binding));
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.reasonCode, "POLICY_REQUIRED");
    assert.equal(proxy.getDiagnostics().blockedTotal, 1);
  } finally {
    await proxy.stop();
  }
});
