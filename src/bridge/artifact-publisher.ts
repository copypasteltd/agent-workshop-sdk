import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bridgeEventSchema, runArtifactSchema, type BridgeEvent } from "@lingban/contracts";
import { buildRunFileEntry, listRunFilesUnderRoot } from "./file-watcher.js";
import type { ArtifactPublisherDiagnostics } from "../observability.js";

type ArtifactPublisherOptions = {
  runId: string;
  outputsPath: string;
  emit: (event: BridgeEvent) => void;
};

export class ArtifactPublisher {
  #options: ArtifactPublisherOptions;
  #publishedFingerprints = new Set<string>();
  #flushCount = 0;
  #publishedArtifactsTotal = 0;
  #lastFlushAt: string | null = null;
  #lastPublishedArtifactsCount = 0;
  #lastPublishedArtifactPath: string | null = null;
  #lastFlushErrorAt: string | null = null;
  #lastFlushErrorMessage: string | null = null;

  constructor(options: ArtifactPublisherOptions) {
    this.#options = options;
  }

  async flush() {
    try {
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

      this.#flushCount += 1;
      this.#publishedArtifactsTotal += artifacts.length;
      this.#lastFlushAt = new Date().toISOString();
      this.#lastPublishedArtifactsCount = artifacts.length;
      this.#lastPublishedArtifactPath =
        artifacts.length > 0 ? artifacts[artifacts.length - 1]!.file.path : null;
      this.#lastFlushErrorAt = null;
      this.#lastFlushErrorMessage = null;
      return artifacts;
    } catch (error) {
      this.#lastFlushErrorAt = new Date().toISOString();
      this.#lastFlushErrorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getDiagnostics(): ArtifactPublisherDiagnostics {
    return {
      outputsPath: this.#options.outputsPath,
      publishedFingerprintsCount: this.#publishedFingerprints.size,
      flushCount: this.#flushCount,
      publishedArtifactsTotal: this.#publishedArtifactsTotal,
      lastFlushAt: this.#lastFlushAt,
      lastPublishedArtifactsCount: this.#lastPublishedArtifactsCount,
      lastPublishedArtifactPath: this.#lastPublishedArtifactPath,
      lastFlushErrorAt: this.#lastFlushErrorAt,
      lastFlushErrorMessage: this.#lastFlushErrorMessage,
    };
  }
}
