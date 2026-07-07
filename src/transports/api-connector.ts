import type { BridgeEvent, BridgeRegistration } from "@lingban/contracts";

type ApiConnectorOptions = {
  baseUrl: string;
  authToken?: string;
  now?: () => string;
};

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class ApiConnector {
  #baseUrl: string;
  #authToken?: string;
  #now: () => string;

  constructor(options: ApiConnectorOptions) {
    this.#baseUrl = trimTrailingSlash(options.baseUrl);
    this.#authToken = options.authToken;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async registerBridge(registration: BridgeRegistration) {
    return this.#post("/internal/bridges/register", registration);
  }

  async ingestEvents(runId: string, events: BridgeEvent[]) {
    if (events.length === 0) {
      return null;
    }

    return this.#post(`/internal/runs/${encodeURIComponent(runId)}/events`, {
      events,
    });
  }

  async postTerminalFailure(runId: string, error: string) {
    return this.ingestEvents(runId, [
      {
        type: "run.failed",
        runId,
        occurredAt: this.#now(),
        error,
      },
    ]);
  }

  async #post(pathname: string, body: unknown) {
    const response = await fetch(`${this.#baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#authToken ? { "x-lingban-internal-token": this.#authToken } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `API connector request failed (${response.status} ${response.statusText}): ${text || "<empty>"}`
      );
    }

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
}
