import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertRuntimeMcpBindingStdioIntegrity,
  assertRuntimeMcpBindings,
} from "@lingban/mcp";
import type { BridgeSessionContext } from "@lingban/contracts";
import { buildRemoteMcpProxyUrl } from "./remote-mcp-proxy-server.js";

type MaterializedMcpServer =
  | {
      type: "local-process";
      command: string;
      args?: string[];
      auth_env?: string;
      auth_file?: string;
    }
  | {
      type: "remote-managed" | "remote-unmanaged";
      url: string;
      auth_env?: string;
      auth_file?: string;
    };

type CodexMcpServer = {
  enabled: true;
  required: true;
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  default_tools_approval_mode: "auto" | "prompt";
} & (
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      env_vars?: string[];
    }
  | {
      url: string;
      bearer_token_env_var?: string;
    }
);

type McpMaterializerOptions = {
  context: BridgeSessionContext;
  runtimeDir: string;
  stdioAllowedPathPrefixes?: string[];
  remoteProxyBaseUrl?: string;
  remoteProxyWebsocketBaseUrl?: string;
};

function buildServerDefinition(
  binding: BridgeSessionContext["mcpBindings"][number],
  options: Pick<
    McpMaterializerOptions,
    "remoteProxyBaseUrl" | "remoteProxyWebsocketBaseUrl"
  >
): MaterializedMcpServer {
  const auth =
    binding.authMode === "env"
      ? { auth_env: binding.authRef ?? undefined }
      : binding.authMode === "file"
        ? { auth_file: binding.authRef ?? undefined }
        : {};

  if (binding.transport === "stdio") {
    if (binding.ref.endsWith(".js") || binding.ref.endsWith(".mjs") || binding.ref.endsWith(".cjs")) {
      return {
        type: "local-process",
        command: "node",
        args: [binding.ref],
        ...auth,
      };
    }

    return {
      type: "local-process",
      command: binding.ref,
      ...auth,
    };
  }

  const proxiedUrl =
    options.remoteProxyBaseUrl && options.remoteProxyWebsocketBaseUrl
      ? buildRemoteMcpProxyUrl({
          binding,
          httpBaseUrl: options.remoteProxyBaseUrl,
          websocketBaseUrl: options.remoteProxyWebsocketBaseUrl,
        })
      : binding.ref;

  return {
    type: binding.source === "third-party" ? "remote-unmanaged" : "remote-managed",
    url: proxiedUrl,
    ...auth,
  };
}

function buildCodexServerDefinition(
  binding: BridgeSessionContext["mcpBindings"][number],
  materialized: MaterializedMcpServer,
  approvalMode: BridgeSessionContext["approvalMode"]
): CodexMcpServer {
  const governance = {
    enabled: true as const,
    required: true as const,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
    default_tools_approval_mode:
      approvalMode === "auto_all" || !binding.approvalRequired
        ? "auto" as const
        : "prompt" as const,
  };

  if (materialized.type === "local-process") {
    return {
      ...governance,
      command: materialized.command,
      ...(materialized.args?.length ? { args: materialized.args } : {}),
      ...(binding.authMode === "env" && binding.authRef
        ? { env_vars: [binding.authRef] }
        : {}),
      ...(binding.authMode === "file" && binding.authRef
        ? { env: { LINGBAN_MCP_AUTH_FILE: binding.authRef } }
        : {}),
    };
  }

  return {
    ...governance,
    url: materialized.url,
    ...(binding.authMode === "env" && binding.authRef
      ? { bearer_token_env_var: binding.authRef }
      : {}),
  };
}

export class McpMaterializer {
  #options: McpMaterializerOptions;

  constructor(options: McpMaterializerOptions) {
    this.#options = options;
  }

  async materialize() {
    await fs.mkdir(this.#options.runtimeDir, { recursive: true });
    assertRuntimeMcpBindings({
      bindings: this.#options.context.mcpBindings,
      policies: this.#options.context.mcpNetworkPolicies ?? [],
      stdioAllowedPathPrefixes: this.#options.stdioAllowedPathPrefixes ?? [],
    });
    await assertRuntimeMcpBindingStdioIntegrity({
      bindings: this.#options.context.mcpBindings,
    });

    const materializedServers = this.#options.context.mcpBindings.map((binding) => {
      const server = buildServerDefinition(binding, this.#options);
      return { binding, server };
    });
    const config = {
      servers: Object.fromEntries(
        materializedServers.map(({ binding, server }) => [binding.bindingId, server])
      ),
    };
    const codexThreadConfig = {
      mcp_servers: Object.fromEntries(
        materializedServers.map(({ binding, server }) => [
          binding.bindingId,
          buildCodexServerDefinition(binding, server, this.#options.context.approvalMode),
        ])
      ),
    };

    const bindings = {
      runId: this.#options.context.runId,
      bindings: this.#options.context.mcpBindings,
    };

    const configPath = path.join(this.#options.runtimeDir, "mcp-config.json");
    const bindingsPath = path.join(this.#options.runtimeDir, "mcp-bindings.json");
    const auditLogPath = path.join(this.#options.runtimeDir, "mcp-calls.ndjson");

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    await fs.writeFile(bindingsPath, JSON.stringify(bindings, null, 2), "utf8");
    await fs.writeFile(auditLogPath, "", {
      encoding: "utf8",
      flag: "a",
    });

    return {
      configPath,
      bindingsPath,
      auditLogPath,
      config,
      codexThreadConfig,
      bindings,
    };
  }
}
