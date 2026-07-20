import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

async function importMcpMaterializerModule() {
  return import(new URL("../dist/bridge/mcp-materializer.js", import.meta.url));
}

async function createStdioFixture(root, fileName, content = "export default {};\n") {
  const toolsRoot = path.join(root, "tools");
  await fs.mkdir(toolsRoot, { recursive: true });
  const filePath = path.join(toolsRoot, fileName);
  await fs.writeFile(filePath, content, "utf8");
  return {
    filePath,
    toolsRoot,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

test("McpMaterializer rejects remote MCP bindings when runtime policies are missing", async () => {
  const { McpMaterializer } = await importMcpMaterializerModule();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lingban-mcp-materializer-"));

  try {
    const materializer = new McpMaterializer({
      runtimeDir,
      context: {
        runId: "run_mcp_materializer_missing_policy",
        workspaceId: "wsp_mcp_materializer",
        targetPath: "/workspace/target",
        initialPrompt: "hello",
        requestedInitialMessage: null,
        credentialMounts: [],
        mcpBindings: [
          {
            bindingId: "mbd_figma_missing_policy",
            mcpId: "third-party:figma-mcp",
            displayName: "Figma MCP",
            source: "third-party",
            transport: "sse",
            ref: "https://third-party-mcp.example.org/figma/sse",
            riskLevel: "high",
            credentialId: null,
            authMode: null,
            authRef: null,
            networkPolicyRef: "np_figma_external",
            approvalRequired: true,
          },
        ],
        mcpNetworkPolicies: [],
      },
    });

    await assert.rejects(
      materializer.materialize(),
      /Runtime MCP policy validation failed:/
    );
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("McpMaterializer materializes remote MCP bindings when runtime policies are present", async () => {
  const { McpMaterializer } = await importMcpMaterializerModule();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lingban-mcp-materializer-"));

  try {
    const materializer = new McpMaterializer({
      runtimeDir,
      context: {
        runId: "run_mcp_materializer_ok",
        workspaceId: "wsp_mcp_materializer",
        targetPath: "/workspace/target",
        initialPrompt: "hello",
        requestedInitialMessage: null,
        credentialMounts: [],
        mcpBindings: [
          {
            bindingId: "mbd_seedance_policy_ok",
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
            workspaceId: "wsp_mcp_materializer",
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
            tags: ["runtime", "managed"],
            createdAt: "2026-07-10T10:00:00.000Z",
            updatedAt: "2026-07-10T10:00:00.000Z",
          },
        ],
      },
    });

    const result = await materializer.materialize();
    assert.equal(result.config.servers.mbd_seedance_policy_ok.type, "remote-managed");
    assert.equal(result.config.servers.mbd_seedance_policy_ok.url, "https://mcp.workspace.internal/seedance");
    assert.deepEqual(result.codexThreadConfig.mcp_servers.mbd_seedance_policy_ok, {
      enabled: true,
      required: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
      default_tools_approval_mode: "auto",
      url: "https://mcp.workspace.internal/seedance",
    });
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("McpMaterializer rewrites remote MCP bindings to local proxy URLs when proxy bases are provided", async () => {
  const { McpMaterializer } = await importMcpMaterializerModule();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lingban-mcp-materializer-"));

  try {
    const materializer = new McpMaterializer({
      runtimeDir,
      remoteProxyBaseUrl: "http://127.0.0.1:41080",
      remoteProxyWebsocketBaseUrl: "ws://127.0.0.1:41080",
      context: {
        runId: "run_mcp_materializer_proxy",
        workspaceId: "wsp_mcp_materializer",
        targetPath: "/workspace/target",
        initialPrompt: "hello",
        requestedInitialMessage: null,
        credentialMounts: [],
        mcpBindings: [
          {
            bindingId: "mbd_seedance_policy_proxy",
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
          {
            bindingId: "mbd_asset_ws_proxy",
            mcpId: "third-party:asset-library",
            displayName: "Asset Library",
            source: "third-party",
            transport: "websocket",
            ref: "wss://asset-library.example.org/mcp",
            riskLevel: "high",
            credentialId: null,
            authMode: null,
            authRef: null,
            networkPolicyRef: "np_asset_library",
            approvalRequired: true,
          },
        ],
        mcpNetworkPolicies: [
          {
            policyRef: "np_seedance_workspace",
            workspaceId: "wsp_mcp_materializer",
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
            tags: ["runtime", "managed"],
            createdAt: "2026-07-10T10:00:00.000Z",
            updatedAt: "2026-07-10T10:00:00.000Z",
          },
          {
            policyRef: "np_asset_library",
            workspaceId: "wsp_mcp_materializer",
            displayName: "Asset Library Policy",
            description: "allow asset library websocket connector",
            status: "active",
            mode: "allowlist",
            allowedProtocols: ["wss"],
            allowedHostPatterns: ["asset-library.example.org"],
            allowedPorts: [443],
            allowedPathPrefixes: ["/mcp"],
            requireTls: true,
            blockPrivateNetwork: true,
            tags: ["runtime", "third-party"],
            createdAt: "2026-07-10T10:00:00.000Z",
            updatedAt: "2026-07-10T10:00:00.000Z",
          },
        ],
      },
    });

    const result = await materializer.materialize();
    assert.equal(
      result.config.servers.mbd_seedance_policy_proxy.url,
      "http://127.0.0.1:41080/mcp-proxy/mbd_seedance_policy_proxy"
    );
    assert.equal(
      result.config.servers.mbd_asset_ws_proxy.url,
      "ws://127.0.0.1:41080/mcp-proxy/mbd_asset_ws_proxy"
    );
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("McpMaterializer materializes stdio MCP bindings when the ref matches the configured allowlist", async () => {
  const { McpMaterializer } = await importMcpMaterializerModule();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lingban-mcp-materializer-"));

  try {
    const stdioFixture = await createStdioFixture(
      runtimeDir,
      "allowed-stdio-mcp.mjs",
      "export const tools = ['ok'];\n"
    );
    const materializer = new McpMaterializer({
      runtimeDir,
      stdioAllowedPathPrefixes: [stdioFixture.toolsRoot],
      context: {
        runId: "run_mcp_materializer_stdio_ok",
        workspaceId: "wsp_mcp_materializer",
        targetPath: runtimeDir,
        initialPrompt: "hello",
        requestedInitialMessage: null,
        approvalMode: "auto_all",
        credentialMounts: [],
        mcpBindings: [
          {
            bindingId: "mbd_stdio_allowed",
            mcpId: "workspace:stdio-allowed",
            displayName: "Allowed Local MCP",
            source: "workspace-managed",
            transport: "stdio",
            ref: stdioFixture.filePath,
            stdioPolicy: {
              refSha256: stdioFixture.sha256,
            },
            riskLevel: "medium",
            credentialId: null,
            authMode: null,
            authRef: null,
            networkPolicyRef: null,
            approvalRequired: true,
          },
        ],
        mcpNetworkPolicies: [],
      },
    });

    const result = await materializer.materialize();
    assert.equal(result.config.servers.mbd_stdio_allowed.type, "local-process");
    assert.equal(result.config.servers.mbd_stdio_allowed.command, "node");
    assert.deepEqual(result.config.servers.mbd_stdio_allowed.args, [
      stdioFixture.filePath,
    ]);
    assert.deepEqual(result.codexThreadConfig.mcp_servers.mbd_stdio_allowed, {
      enabled: true,
      required: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
      default_tools_approval_mode: "auto",
      command: "node",
      args: [stdioFixture.filePath],
    });
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("McpMaterializer rejects stdio MCP bindings outside the configured allowlist", async () => {
  const { McpMaterializer } = await importMcpMaterializerModule();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lingban-mcp-materializer-"));

  try {
    const materializer = new McpMaterializer({
      runtimeDir,
      stdioAllowedPathPrefixes: ["/workspace/target/tools"],
      context: {
        runId: "run_mcp_materializer_stdio_blocked",
        workspaceId: "wsp_mcp_materializer",
        targetPath: runtimeDir,
        initialPrompt: "hello",
        requestedInitialMessage: null,
        credentialMounts: [],
        mcpBindings: [
          {
            bindingId: "mbd_stdio_disallowed",
            mcpId: "workspace:stdio-disallowed",
            displayName: "Disallowed Local MCP",
            source: "workspace-managed",
            transport: "stdio",
            ref: "/workspace/runtime/tools/disallowed-stdio-mcp.mjs",
            riskLevel: "medium",
            credentialId: null,
            authMode: null,
            authRef: null,
            networkPolicyRef: null,
            approvalRequired: false,
          },
        ],
        mcpNetworkPolicies: [],
      },
    });

    await assert.rejects(
      materializer.materialize(),
      /STDIO_PATH_NOT_ALLOWED/
    );
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

test("McpMaterializer rejects stdio MCP bindings when the executable digest does not match", async () => {
  const { McpMaterializer } = await importMcpMaterializerModule();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "lingban-mcp-materializer-"));

  try {
    const stdioFixture = await createStdioFixture(
      runtimeDir,
      "digest-mismatch-stdio-mcp.mjs",
      "export const tools = ['digest-mismatch'];\n"
    );
    const materializer = new McpMaterializer({
      runtimeDir,
      stdioAllowedPathPrefixes: [stdioFixture.toolsRoot],
      context: {
        runId: "run_mcp_materializer_stdio_digest_mismatch",
        workspaceId: "wsp_mcp_materializer",
        targetPath: runtimeDir,
        initialPrompt: "hello",
        requestedInitialMessage: null,
        credentialMounts: [],
        mcpBindings: [
          {
            bindingId: "mbd_stdio_digest_mismatch",
            mcpId: "workspace:stdio-digest-mismatch",
            displayName: "Digest Mismatch Local MCP",
            source: "workspace-managed",
            transport: "stdio",
            ref: stdioFixture.filePath,
            stdioPolicy: {
              refSha256: "f".repeat(64),
            },
            riskLevel: "medium",
            credentialId: null,
            authMode: null,
            authRef: null,
            networkPolicyRef: null,
            approvalRequired: false,
          },
        ],
        mcpNetworkPolicies: [],
      },
    });

    await assert.rejects(
      materializer.materialize(),
      /Runtime MCP stdio integrity validation failed:.*STDIO_DIGEST_MISMATCH/
    );
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
