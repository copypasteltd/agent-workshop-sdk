import { promises as fs } from "node:fs";
import path from "node:path";
import type { BridgeSessionContext } from "@lingban/contracts";

export type SecretValueMap = Record<string, string>;

type SecretLoaderOptions = {
  context: BridgeSessionContext;
  secretValues?: SecretValueMap;
};

export class SecretLoader {
  #options: SecretLoaderOptions;

  constructor(options: SecretLoaderOptions) {
    this.#options = options;
  }

  async materialize() {
    const env: Record<string, string> = {};
    const writtenFiles: string[] = [];
    const secretValues = this.#options.secretValues ?? {};

    for (const mount of this.#options.context.credentialMounts) {
      const value = secretValues[mount.credentialId];

      if (mount.mode === "env") {
        if (value == null) {
          const inherited = process.env[mount.envName];
          if (inherited == null) {
            throw new Error(`Missing secret value for credential ${mount.credentialId}`);
          }
          env[mount.envName] = inherited;
          continue;
        }

        env[mount.envName] = value;
        continue;
      }

      const filePath = path.resolve(mount.mountPath);

      if (value == null) {
        await fs.access(filePath);
        writtenFiles.push(filePath);
        continue;
      }

      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, value, "utf8");
      writtenFiles.push(filePath);
    }

    return {
      env,
      writtenFiles,
    };
  }
}
