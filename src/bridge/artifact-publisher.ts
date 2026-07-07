import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bridgeEventSchema, runArtifactSchema, type BridgeEvent } from "@lingban/contracts";
import { buildRunFileEntry, listRunFilesUnderRoot } from "./file-watcher.js";

type ArtifactPublisherOptions = {
  runId: string;
  outputsPath: string;
  emit: (event: BridgeEvent) => void;
};

export class ArtifactPublisher {
  #options: ArtifactPublisherOptions;
  #publishedFingerprints = new Set<string>();

  constructor(options: ArtifactPublisherOptions) {
    this.#options = options;
  }

  async flush() {
    await fs.mkdir(this.#options.outputsPath, { recursive: true });
    const entries = await listRunFilesUnderRoot(this.#options.outputsPath);
    const artifacts = [];

    for (const entry of entries) {
      if (entry.path.endsWith("/")) {
        continue;
      }

      const absolutePath = path.resolve(entry.path);
      const stats = await fs.stat(absolutePath);
      const fingerprint = `${entry.path}:${stats.size}:${stats.mtimeMs}`;

      if (this.#publishedFingerprints.has(fingerprint)) {
        continue;
      }

      this.#publishedFingerprints.add(fingerprint);
      const file = await buildRunFileEntry(absolutePath);
      const artifact = runArtifactSchema.parse({
        artifactId: `art_${randomUUID()}`,
        runId: this.#options.runId,
        label: file.name,
        file,
        status: "ready",
        downloadUrl: null,
      });

      this.#options.emit(
        bridgeEventSchema.parse({
          type: "artifact.ready",
          artifact,
        })
      );
      artifacts.push(artifact);
    }

    return artifacts;
  }
}
