import { promises as fs } from "node:fs";
import path from "node:path";
import type { BridgeSessionContext } from "@lingban/contracts";

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
};

function buildServerDefinition(binding: BridgeSessionContext["mcpBindings"][number]): MaterializedMcpServer {
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

  return {
    type: binding.source === "third-party" ? "remote-unmanaged" : "remote-managed",
    url: binding.ref,
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

    const config = {
      servers: Object.fromEntries(
        this.#options.context.mcpBindings.map((binding) => [
          binding.bindingId,
          buildServerDefinition(binding),
        ])
      ),
    };

    const bindings = {
      runId: this.#options.context.runId,
      bindings: this.#options.context.mcpBindings,
    };

    const configPath = path.join(this.#options.runtimeDir, "mcp-config.json");
    const bindingsPath = path.join(this.#options.runtimeDir, "mcp-bindings.json");

    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    await fs.writeFile(bindingsPath, JSON.stringify(bindings, null, 2), "utf8");

    return {
      configPath,
      bindingsPath,
      config,
      bindings,
    };
  }
}
