import http from "node:http";
import { ZodError } from "zod";
import { runControlCommandSchema, type RunControlCommand } from "@lingban/contracts";
import type { RunControlServer } from "../bridge/run-control-server.js";
import type { ControlHttpRouteDiagnostics, ControlHttpServerDiagnostics } from "../observability.js";

type ControlHttpServerOptions = {
  controlServer: RunControlServer;
  host?: string;
  port: number;
  authToken?: string;
  getDiagnostics?: () => unknown | Promise<unknown>;
  getMetricsText?: () => string | Promise<string>;
  now?: () => string;
};

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendText(
  response: http.ServerResponse,
  statusCode: number,
  payload: string,
  contentType = "text/plain; charset=utf-8"
) {
  response.writeHead(statusCode, {
    "content-type": contentType,
  });
  response.end(payload);
}

async function readRequestBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export class ControlHttpServer {
  #server: http.Server;
  #host: string;
  #port: number;
  #authToken?: string;
  #getDiagnostics?: () => unknown | Promise<unknown>;
  #getMetricsText?: () => string | Promise<string>;
  #now: () => string;
  #startedAt: string | null = null;
  #inFlightRequests = 0;
  #requestsTotal = 0;
  #unauthorizedRequestsTotal = 0;
  #clientErrorsTotal = 0;
  #serverErrorsTotal = 0;
  #lastRequestAt: string | null = null;
  #lastErrorAt: string | null = null;
  #lastErrorMessage: string | null = null;
  #routeState = new Map<string, Omit<ControlHttpRouteDiagnostics, "route">>();

  constructor(options: ControlHttpServerOptions) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port;
    this.#authToken = options.authToken;
    this.#getDiagnostics = options.getDiagnostics;
    this.#getMetricsText = options.getMetricsText;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#server = http.createServer(async (request, response) => {
      const route = this.#resolveRoute(request);
      const respondJson = (statusCode: number, payload: unknown) => {
        this.#recordResponse(route, statusCode);
        sendJson(response, statusCode, payload);
      };
      const respondText = (
        statusCode: number,
        payload: string,
        contentType = "text/plain; charset=utf-8"
      ) => {
        this.#recordResponse(route, statusCode);
        sendText(response, statusCode, payload, contentType);
      };

      this.#inFlightRequests += 1;
      try {
        if (!request.url || !request.method) {
          respondJson(400, { error: "missing request metadata" });
          return;
        }

        if (request.method === "GET" && request.url === "/health") {
          respondJson(200, { status: "ok" });
          return;
        }

        if (request.method === "GET" && request.url === "/diagnostics") {
          if (!this.#isAuthorized(request)) {
            respondJson(401, { error: "invalid control token" });
            return;
          }

          const payload = await this.#buildDiagnosticsPayload();
          respondJson(200, payload);
          return;
        }

        if (request.method === "GET" && request.url === "/metrics") {
          if (!this.#isAuthorized(request)) {
            respondJson(401, { error: "invalid control token" });
            return;
          }

          const payload = await this.#buildMetricsPayload();
          respondText(payload.statusCode, payload.body, payload.contentType);
          return;
        }

        if (request.method === "POST" && request.url === "/control") {
          if (!this.#isAuthorized(request)) {
            respondJson(401, { error: "invalid control token" });
            return;
          }

          const body = await readRequestBody(request);
          const parsed = runControlCommandSchema.parse(JSON.parse(body) as RunControlCommand);
          const result = await options.controlServer.handle(parsed);
          respondJson(200, result);
          return;
        }

        respondJson(404, { error: "not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof SyntaxError || error instanceof ZodError) {
          respondJson(400, { error: message });
          return;
        }

        respondJson(500, { error: message });
      } finally {
        this.#inFlightRequests = Math.max(0, this.#inFlightRequests - 1);
      }
    });
  }

  async start() {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        this.#startedAt = this.#now();
        resolve();
      };

      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, this.#host);
    });
  }

  async stop() {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  get url() {
    const address = this.#server.address();
    if (address && typeof address !== "string") {
      return `http://${this.#host}:${address.port}`;
    }

    return `http://${this.#host}:${this.#port}`;
  }

  getDiagnostics(): ControlHttpServerDiagnostics {
    const address = this.#server.address();
    const boundPort = address && typeof address !== "string" ? address.port : this.#port;

    return {
      started: this.#startedAt !== null,
      startedAt: this.#startedAt,
      host: this.#host,
      port: boundPort,
      url: this.url,
      authRequired: Boolean(this.#authToken),
      inFlightRequests: this.#inFlightRequests,
      requestsTotal: this.#requestsTotal,
      unauthorizedRequestsTotal: this.#unauthorizedRequestsTotal,
      clientErrorsTotal: this.#clientErrorsTotal,
      serverErrorsTotal: this.#serverErrorsTotal,
      lastRequestAt: this.#lastRequestAt,
      lastErrorAt: this.#lastErrorAt,
      lastErrorMessage: this.#lastErrorMessage,
      routes: Array.from(this.#routeState.entries())
        .map(([route, state]) => ({
          route,
          ...state,
        }))
        .sort((left, right) => left.route.localeCompare(right.route)),
    };
  }

  #resolveRoute(request: http.IncomingMessage) {
    const pathname = request.url?.split("?", 1)[0] ?? "";
    if (request.method === "GET" && pathname === "/health") {
      return "health";
    }
    if (request.method === "GET" && pathname === "/diagnostics") {
      return "diagnostics";
    }
    if (request.method === "GET" && pathname === "/metrics") {
      return "metrics";
    }
    if (request.method === "POST" && pathname === "/control") {
      return "control";
    }
    return "unknown";
  }

  #isAuthorized(request: http.IncomingMessage) {
    const headerValue = request.headers["x-lingban-control-token"];
    const providedToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return !this.#authToken || providedToken === this.#authToken;
  }

  #recordResponse(route: string, statusCode: number) {
    const now = this.#now();
    this.#requestsTotal += 1;
    this.#lastRequestAt = now;
    const state = this.#routeState.get(route) ?? {
      requestsTotal: 0,
      clientErrorsTotal: 0,
      serverErrorsTotal: 0,
      unauthorizedTotal: 0,
      lastRequestAt: null,
      lastStatusCode: null,
    };

    state.requestsTotal += 1;
    state.lastRequestAt = now;
    state.lastStatusCode = statusCode;

    if (statusCode === 401) {
      this.#unauthorizedRequestsTotal += 1;
      state.unauthorizedTotal += 1;
    }

    if (statusCode >= 400 && statusCode < 500) {
      this.#clientErrorsTotal += 1;
    }

    if (statusCode >= 500) {
      this.#serverErrorsTotal += 1;
      state.serverErrorsTotal += 1;
      this.#lastErrorAt = now;
      this.#lastErrorMessage = `HTTP ${statusCode} on ${route}`;
    } else if (statusCode >= 400) {
      state.clientErrorsTotal += 1;
      this.#lastErrorAt = now;
      this.#lastErrorMessage = `HTTP ${statusCode} on ${route}`;
    }

    this.#routeState.set(route, state);
  }

  async #buildDiagnosticsPayload() {
    if (!this.#getDiagnostics) {
      return {
        controlHttp: this.getDiagnostics(),
      };
    }

    const payload = await this.#getDiagnostics();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return {
        ...(payload as Record<string, unknown>),
        controlHttp: this.getDiagnostics(),
      };
    }

    return {
      runtime: payload ?? null,
      controlHttp: this.getDiagnostics(),
    };
  }

  async #buildMetricsPayload(): Promise<{
    statusCode: number;
    contentType: string;
    body: string;
  }> {
    if (this.#getMetricsText) {
      return {
        statusCode: 200,
        contentType: "text/plain; version=0.0.4; charset=utf-8",
        body: await this.#getMetricsText(),
      };
    }

    const diagnostics = this.getDiagnostics();
    const lines = [
      "# HELP lingban_bridge_control_http_requests_total Control HTTP requests observed by the bridge.",
      "# TYPE lingban_bridge_control_http_requests_total counter",
      `lingban_bridge_control_http_requests_total ${diagnostics.requestsTotal}`,
      "# HELP lingban_bridge_control_http_unauthorized_requests_total Unauthorized control HTTP requests rejected by the bridge.",
      "# TYPE lingban_bridge_control_http_unauthorized_requests_total counter",
      `lingban_bridge_control_http_unauthorized_requests_total ${diagnostics.unauthorizedRequestsTotal}`,
      "# HELP lingban_bridge_control_http_inflight_requests Current in-flight control HTTP requests.",
      "# TYPE lingban_bridge_control_http_inflight_requests gauge",
      `lingban_bridge_control_http_inflight_requests ${diagnostics.inFlightRequests}`,
    ];

    for (const route of diagnostics.routes) {
      lines.push(
        `lingban_bridge_control_http_route_requests_total{route="${route.route}"} ${route.requestsTotal}`
      );
    }

    return {
      statusCode: 200,
      contentType: "text/plain; version=0.0.4; charset=utf-8",
      body: `${lines.join("\n")}\n`,
    };
  }
}
