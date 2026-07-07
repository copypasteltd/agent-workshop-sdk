import http from "node:http";
import { runControlCommandSchema, type RunControlCommand } from "@lingban/contracts";
import type { RunControlServer } from "../bridge/run-control-server.js";

type ControlHttpServerOptions = {
  controlServer: RunControlServer;
  host?: string;
  port: number;
};

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
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

  constructor(options: ControlHttpServerOptions) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port;
    this.#server = http.createServer(async (request, response) => {
      try {
        if (!request.url || !request.method) {
          sendJson(response, 400, { error: "missing request metadata" });
          return;
        }

        if (request.method === "GET" && request.url === "/health") {
          sendJson(response, 200, { status: "ok" });
          return;
        }

        if (request.method === "POST" && request.url === "/control") {
          const body = await readRequestBody(request);
          const parsed = runControlCommandSchema.parse(JSON.parse(body) as RunControlCommand);
          const result = await options.controlServer.handle(parsed);
          sendJson(response, 200, result);
          return;
        }

        sendJson(response, 404, { error: "not found" });
      } catch (error) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
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
    return `http://${this.#host}:${this.#port}`;
  }
}
