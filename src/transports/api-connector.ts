import { randomUUID } from "node:crypto";
import type {
  BridgeEvent,
  MaterializeRunCredentialsResponse,
  BridgeRegistration,
  RunArtifact,
  RunRuntimeRecoveryCandidate,
  RunRuntimeRecoveryList,
  RunRuntimeUpdate,
  RunSnapshot,
  RunStatus,
} from "@lingban/contracts";
import { nowIso, toErrorMessage } from "@lingban/shared";

type ApiConnectorOptions = {
  baseUrl: string;
  authToken?: string;
  now?: () => string;
  requestTimeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export class ApiConnector {
  #baseUrl: string;
  #authToken?: string;
  #now: () => string;
  #requestTimeoutMs: number;
  #retryAttempts: number;
  #retryDelayMs: number;

  constructor(options: ApiConnectorOptions) {
    this.#baseUrl = trimTrailingSlash(options.baseUrl);
    this.#authToken = options.authToken;
    this.#now = options.now ?? nowIso;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.#retryAttempts = Math.max(1, options.retryAttempts ?? 3);
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? 200);
  }

  async registerBridge(registration: BridgeRegistration): Promise<unknown> {
    return this.#post("/internal/bridges/register", registration);
  }

  async getRunSnapshot(runId: string): Promise<RunSnapshot> {
    return (await this.#requestJson(`/internal/runs/${encodeURIComponent(runId)}/snapshot`, {
      method: "GET",
    })) as RunSnapshot;
  }

  async materializeRunCredentials(runId: string): Promise<MaterializeRunCredentialsResponse> {
    return (await this.#requestJson(
      `/internal/runs/${encodeURIComponent(runId)}/credentials/materialize`,
      {
        method: "POST",
      }
    )) as MaterializeRunCredentialsResponse;
  }

  async downloadRunSessionPackArchive(runId: string): Promise<{
    content: Uint8Array;
    fileName: string | null;
    source: string | null;
    contentType: string | null;
  }> {
    const response = await this.#request(
      `/internal/runs/${encodeURIComponent(runId)}/session-pack/archive`,
      {
        method: "GET",
      }
    );

    return {
      content: new Uint8Array(await response.arrayBuffer()),
      fileName: response.headers.get("x-lingban-session-pack-file-name"),
      source: response.headers.get("x-lingban-session-pack-source"),
      contentType: response.headers.get("content-type"),
    };
  }

  async getRunRecoveryCandidate(runId: string): Promise<RunRuntimeRecoveryCandidate> {
    return (await this.#requestJson(`/internal/runs/${encodeURIComponent(runId)}/recovery`, {
      method: "GET",
    })) as RunRuntimeRecoveryCandidate;
  }

  async listRunRecoveryCandidates(): Promise<RunRuntimeRecoveryList> {
    return (await this.#requestJson("/internal/runs/recovery", {
      method: "GET",
    })) as RunRuntimeRecoveryList;
  }

  async ingestEvents(runId: string, events: BridgeEvent[]): Promise<unknown> {
    if (events.length === 0) {
      return null;
    }

    return this.#post(`/internal/runs/${encodeURIComponent(runId)}/events`, {
      events,
    });
  }

  async syncRunStatus(
    runId: string,
    status: RunStatus,
    reason?: string | null,
    occurredAt?: string
  ): Promise<unknown> {
    return this.#post(`/internal/runs/${encodeURIComponent(runId)}/status`, {
      status,
      reason: reason ?? null,
      occurredAt: occurredAt ?? this.#now(),
    });
  }

  async syncRunRuntime(runId: string, runtime: RunRuntimeUpdate): Promise<unknown> {
    return this.#post(`/internal/runs/${encodeURIComponent(runId)}/runtime`, runtime);
  }

  async syncArtifacts(runId: string, artifacts: RunArtifact[]): Promise<unknown> {
    if (artifacts.length === 0) {
      return null;
    }

    return this.#post(`/internal/runs/${encodeURIComponent(runId)}/artifacts`, {
      artifacts,
    });
  }

  async postTerminalFailure(runId: string, error: string): Promise<unknown> {
    return this.syncRunStatus(runId, "FAILED", error, this.#now());
  }

  async #post(pathname: string, body: unknown) {
    const traceId = `trace_${randomUUID()}`;
    const idempotencyKey = `cbk_${randomUUID()}`;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#retryAttempts; attempt += 1) {
      try {
        return await this.#postOnce(pathname, body, traceId, idempotencyKey);
      } catch (error) {
        lastError = error;
        if (!this.#shouldRetry(error, attempt)) {
          throw error;
        }

        await this.#sleep(this.#retryDelayMs * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(toErrorMessage(lastError));
  }

  async #requestJson(
    pathname: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      traceId?: string;
      idempotencyKey?: string;
    }
  ) {
    const response = await this.#request(pathname, options);
    const raw = await response.text();
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Failed to parse connector response JSON: ${toErrorMessage(error)}`);
    }
  }

  async #request(
    pathname: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      traceId?: string;
      idempotencyKey?: string;
    }
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error(`request timeout after ${this.#requestTimeoutMs}ms`));
    }, this.#requestTimeoutMs);

    try {
      const response = await fetch(`${this.#baseUrl}${pathname}`, {
        method: options.method,
        headers: {
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(this.#authToken ? { "x-lingban-internal-token": this.#authToken } : {}),
          ...(options.traceId ? { "x-lingban-trace-id": options.traceId } : {}),
          ...(options.idempotencyKey
            ? { "x-lingban-idempotency-key": options.idempotencyKey }
            : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(
          `API connector request failed (${response.status} ${response.statusText}): ${text || "<empty>"}`
        ) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #postOnce(
    pathname: string,
    body: unknown,
    traceId: string,
    idempotencyKey: string
  ) {
    return await this.#requestJson(pathname, {
      method: "POST",
      body,
      traceId,
      idempotencyKey,
    });
  }

  #shouldRetry(error: unknown, attempt: number) {
    if (attempt >= this.#retryAttempts) {
      return false;
    }

    if (error instanceof Error) {
      const status = (error as Error & { status?: number }).status;
      if (typeof status === "number") {
        return status >= 500 || status === 429;
      }

      return true;
    }

    return false;
  }

  async #sleep(delayMs: number) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
