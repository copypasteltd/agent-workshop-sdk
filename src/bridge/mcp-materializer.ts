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

    const config = {
      servers: Object.fromEntries(
        this.#options.context.mcpBindings.map((binding) => [
          binding.bindingId,
          buildServerDefinition(binding, this.#options),
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
      bindings,
    };
  }
}
