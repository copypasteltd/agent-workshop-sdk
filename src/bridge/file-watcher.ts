import chokidar, { type FSWatcher } from "chokidar";
import { promises as fs } from "node:fs";
import path from "node:path";
import { bridgeEventSchema, runFileEntrySchema, type BridgeEvent, type RunFileEntry } from "@lingban/contracts";
import type { FileWatcherDiagnostics } from "../observability.js";

type FileWatcherOptions = {
  runId: string;
  targetPath: string;
  outputsPath?: string | null;
  emit: (event: BridgeEvent) => void;
  now?: () => string;
};

function toPosix(value: string) {
  return value.replace(/\\/g, "/");
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`;
}

function inferFileKind(absolutePath: string) {
  const normalized = toPosix(absolutePath).toLowerCase();

  if (normalized.includes("/receipts/")) {
    return "receipt" as const;
  }

  if (normalized.includes("/archive/")) {
    return "archive" as const;
  }

  if (normalized.endsWith(".log") || normalized.includes("/logs/")) {
    return "log" as const;
  }

  if (/\.(png|jpg|jpeg|gif|webp|svg|pdf)$/i.test(normalized)) {
    return "screenshot" as const;
  }

  return "output" as const;
}

async function buildRunFileEntry(absolutePath: string): Promise<RunFileEntry> {
  const stats = await fs.stat(absolutePath);
  const normalized = toPosix(absolutePath);
  const isDirectory = stats.isDirectory();

  return runFileEntrySchema.parse({
    path: isDirectory ? ensureTrailingSlash(normalized) : normalized,
    name: path.basename(absolutePath),
    kind: inferFileKind(absolutePath),
    sizeBytes: isDirectory ? null : stats.size,
    updatedAt: stats.mtime.toISOString(),
  });
}

async function walk(rootPath: string): Promise<RunFileEntry[]> {
  const entries: RunFileEntry[] = [];

  async function visit(currentPath: string) {
    const stat = await fs.stat(currentPath);
    if (stat.isDirectory()) {
      entries.push(await buildRunFileEntry(currentPath));
      const children = await fs.readdir(currentPath, { withFileTypes: true });

      for (const child of children) {
        await visit(path.join(currentPath, child.name));
      }

      return;
    }

    entries.push(await buildRunFileEntry(currentPath));
  }

  await visit(rootPath);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export class FileWatcher {
  #options: Required<Omit<FileWatcherOptions, "outputsPath">> & { outputsPath: string | null };
  #watcher: FSWatcher | null = null;
  #watchTargets: string[] = [];
  #syncCount = 0;
  #fileChangedEventsTotal = 0;
  #lastSyncAt: string | null = null;
  #lastSyncFileCount = 0;
  #lastMutationAt: string | null = null;
  #lastChangedPath: string | null = null;
  #lastSyncErrorAt: string | null = null;
  #lastSyncErrorMessage: string | null = null;

  constructor(options: FileWatcherOptions) {
    this.#options = {
      ...options,
      outputsPath: options.outputsPath ?? null,
      now: options.now ?? (() => new Date().toISOString()),
    };
  }

  async start() {
    await fs.mkdir(this.#options.targetPath, { recursive: true });

    if (this.#options.outputsPath) {
      await fs.mkdir(this.#options.outputsPath, { recursive: true });
    }

    const watchTargets = [this.#options.targetPath];
    if (this.#options.outputsPath) {
      watchTargets.push(this.#options.outputsPath);
    }
    this.#watchTargets = [...watchTargets];

    this.#watcher = chokidar.watch(watchTargets, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 20,
      },
    });

    const onMutation = async (absolutePath: string) => {
      this.#lastMutationAt = this.#options.now();
      if (this.#isUnderTarget(absolutePath)) {
        await this.emitFileChanged(absolutePath);
      }

      await this.sync();
    };

    this.#watcher.on("add", onMutation);
    this.#watcher.on("change", onMutation);
    this.#watcher.on("addDir", onMutation);
    this.#watcher.on("unlink", async () => {
      await this.sync();
    });
    this.#watcher.on("unlinkDir", async () => {
      await this.sync();
    });

    await this.sync();
  }

  async stop() {
    if (this.#watcher) {
      await this.#watcher.close();
      this.#watcher = null;
    }
  }

  async listFiles() {
    return walk(this.#options.targetPath);
  }

  async sync() {
    try {
      const files = await this.listFiles();
      this.#syncCount += 1;
      this.#lastSyncAt = this.#options.now();
      this.#lastSyncFileCount = files.length;
      this.#lastSyncErrorAt = null;
      this.#lastSyncErrorMessage = null;
      this.#options.emit(
        bridgeEventSchema.parse({
          type: "files.synced",
          runId: this.#options.runId,
          files,
          occurredAt: this.#lastSyncAt,
        })
      );
      return files;
    } catch (error) {
      this.#lastSyncErrorAt = this.#options.now();
      this.#lastSyncErrorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async emitFileChanged(absolutePath: string) {
    const entry = await buildRunFileEntry(absolutePath);
    this.#fileChangedEventsTotal += 1;
    this.#lastChangedPath = entry.path;
    this.#options.emit(
      bridgeEventSchema.parse({
        type: "file.changed",
        runId: this.#options.runId,
        file: entry,
        occurredAt: this.#options.now(),
      })
    );
  }

  #isUnderTarget(absolutePath: string) {
    const relative = path.relative(this.#options.targetPath, absolutePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  getDiagnostics(): FileWatcherDiagnostics {
    return {
      running: this.#watcher !== null,
      targetPath: this.#options.targetPath,
      outputsPath: this.#options.outputsPath,
      watchTargets: [...this.#watchTargets],
      syncCount: this.#syncCount,
      fileChangedEventsTotal: this.#fileChangedEventsTotal,
      lastSyncAt: this.#lastSyncAt,
      lastSyncFileCount: this.#lastSyncFileCount,
      lastMutationAt: this.#lastMutationAt,
      lastChangedPath: this.#lastChangedPath,
      lastSyncErrorAt: this.#lastSyncErrorAt,
      lastSyncErrorMessage: this.#lastSyncErrorMessage,
    };
  }
}

export { buildRunFileEntry, walk as listRunFilesUnderRoot };
