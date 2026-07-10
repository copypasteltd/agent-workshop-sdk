import http from "node:http";
import https from "node:https";
import { Duplex, Readable } from "node:stream";
import {
  evaluateMcpNetworkPolicy,
  type RuntimeMcpBindingPolicyIssue,
} from "@lingban/mcp";
import type { BridgeSessionContext, McpBinding, McpNetworkPolicy } from "@lingban/contracts";

type RemoteMcpProxyServerOptions = {
  context: BridgeSessionContext;
  host?: string;
  port?: number;
  now?: () => string;
};

type ResolvedProxyRoute = {
  binding: McpBinding;
  suffixPath: string;
  search: string;
};

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function hasRequestBody(method: string) {
  return method !== "GET" && method !== "HEAD";
}

function joinUrlPath(basePath: string, suffixPath: string) {
  if (!suffixPath || suffixPath === "/") {
    return basePath || "/";
  }

  const normalizedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const normalizedSuffix = suffixPath.startsWith("/") ? suffixPath : `/${suffixPath}`;
  return `${normalizedBase || ""}${normalizedSuffix}` || "/";
}

function sanitizeHeaders(
  headers: http.IncomingHttpHeaders,
  blocked: Set<string>
) {
  const next: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (!rawValue || blocked.has(key)) {
      continue;
    }

    next[key] = Array.isArray(rawValue) ? rawValue.join(", ") : rawValue;
  }

  return next;
}

function writeProxyResponseHeaders(
  response: http.ServerResponse | Duplex,
  headers: Headers | http.IncomingHttpHeaders,
  statusLine?: string
) {
  const entries: Array<[string, string]> = [];

  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        entries.push([key, value]);
      }
    }
  } else {
    for (const [key, rawValue] of Object.entries(headers)) {
      if (!rawValue || HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        continue;
      }

      entries.push([key, Array.isArray(rawValue) ? rawValue.join(", ") : rawValue]);
    }
  }

  if (response instanceof http.ServerResponse) {
    response.writeHead(response.statusCode || 200, Object.fromEntries(entries));
    return;
  }

  const headerText = entries.map(([key, value]) => `${key}: ${value}\r\n`).join("");
  response.write(`${statusLine ?? "HTTP/1.1 200 OK"}\r\n${headerText}\r\n`);
}

function formatProxyIssueStatus(issue: RuntimeMcpBindingPolicyIssue) {
  switch (issue.reasonCode) {
    case "POLICY_REQUIRED":
    case "POLICY_NOT_FOUND":
    case "POLICY_DISABLED":
    case "HOST_NOT_ALLOWED":
    case "PORT_NOT_ALLOWED":
    case "PATH_NOT_ALLOWED":
    case "PROTOCOL_NOT_ALLOWED":
    case "TLS_REQUIRED":
    case "PRIVATE_NETWORK_BLOCKED":
      return 403;
    default:
      return 400;
  }
}

function buildProxyIssue(
  binding: McpBinding,
  message: string,
  reasonCode: RuntimeMcpBindingPolicyIssue["reasonCode"]
): RuntimeMcpBindingPolicyIssue {
  return {
    bindingId: binding.bindingId,
    mcpId: binding.mcpId,
    networkPolicyRef: binding.networkPolicyRef,
    reasonCode,
    message,
  };
}

export function buildRemoteMcpProxyUrl(input: {
  binding: McpBinding;
  httpBaseUrl: string;
  websocketBaseUrl: string;
}) {
  const encodedBindingId = encodeURIComponent(input.binding.bindingId);
  if (input.binding.transport === "websocket") {
    return `${input.websocketBaseUrl}/mcp-proxy/${encodedBindingId}`;
  }

  return `${input.httpBaseUrl}/mcp-proxy/${encodedBindingId}`;
}

export class RemoteMcpProxyServer {
  #server: http.Server;
  #host: string;
  #port: number;
  #now: () => string;
  #bindingById: Map<string, McpBinding>;
  #policyByRef: Map<string, McpNetworkPolicy>;
  #startedAt: string | null = null;
  #requestsTotal = 0;
  #upgradesTotal = 0;
  #blockedTotal = 0;
  #failuresTotal = 0;
  #activeUpgrades = 0;
  #lastRequestAt: string | null = null;
  #lastFailureAt: string | null = null;
  #lastFailureMessage: string | null = null;

  constructor(options: RemoteMcpProxyServerOptions) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#bindingById = new Map(
      options.context.mcpBindings
        .filter((binding) => binding.transport !== "stdio")
        .map((binding) => [binding.bindingId, binding])
    );
    this.#policyByRef = new Map(
      (options.context.mcpNetworkPolicies ?? []).map((policy) => [policy.policyRef, policy])
    );

    this.#server = http.createServer(async (request, response) => {
      this.#requestsTotal += 1;
      this.#lastRequestAt = this.#now();
      const abortController = new AbortController();
      const onAborted = () => abortController.abort();
      const onResponseClosed = () => {
        if (!response.writableEnded) {
          abortController.abort();
        }
      };
      request.once("aborted", onAborted);
      response.once("close", onResponseClosed);

      try {
        const resolved = this.#resolveRoute(request.url ?? "");
        if (!resolved) {
          response.writeHead(404, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ error: "remote MCP proxy route not found" }));
          return;
        }

        if (resolved.binding.transport === "websocket") {
          response.writeHead(426, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ error: "websocket MCP connectors require upgrade" }));
          return;
        }

        const targetUrl = this.#resolveTargetUrl(resolved);
        const issue = this.#validateTarget(resolved.binding, targetUrl);
        if (issue) {
          this.#blockedTotal += 1;
          response.writeHead(formatProxyIssueStatus(issue), {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(JSON.stringify({ error: issue.message, reasonCode: issue.reasonCode }));
          return;
        }

        const upstreamRequestInit = {
          method: request.method ?? "GET",
          headers: sanitizeHeaders(request.headers, HOP_BY_HOP_REQUEST_HEADERS),
          body:
            hasRequestBody(request.method ?? "GET")
              ? (Readable.toWeb(request) as globalThis.ReadableStream<Uint8Array>)
              : undefined,
          duplex: hasRequestBody(request.method ?? "GET") ? "half" : undefined,
          signal: abortController.signal,
          redirect: "manual",
        } as RequestInit & {
          duplex?: "half";
        };

        const upstreamResponse = await fetch(targetUrl, upstreamRequestInit);

        response.statusCode = upstreamResponse.status;
        response.statusMessage = upstreamResponse.statusText;
        writeProxyResponseHeaders(response, upstreamResponse.headers);
        const upstreamBody = upstreamResponse.body;
        if (upstreamBody) {
          await new Promise<void>((resolve, reject) => {
            const body = Readable.fromWeb(upstreamBody as any);
            body.on("error", reject);
            body.on("end", resolve);
            body.pipe(response);
          });
        } else {
          response.end();
        }
      } catch (error) {
        this.#failuresTotal += 1;
        this.#lastFailureAt = this.#now();
        this.#lastFailureMessage = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          response.writeHead(502, {
            "content-type": "application/json; charset=utf-8",
          });
          response.end(
            JSON.stringify({
              error: this.#lastFailureMessage,
            })
          );
        } else {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        request.off("aborted", onAborted);
        response.off("close", onResponseClosed);
      }
    });

    this.#server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket, head);
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

  getDiagnostics() {
    const address = this.#server.address();
    const port = address && typeof address !== "string" ? address.port : this.#port;
    return {
      started: this.#startedAt !== null,
      startedAt: this.#startedAt,
      host: this.#host,
      port,
      httpBaseUrl: this.httpBaseUrl,
      websocketBaseUrl: this.websocketBaseUrl,
      requestsTotal: this.#requestsTotal,
      upgradesTotal: this.#upgradesTotal,
      blockedTotal: this.#blockedTotal,
      failuresTotal: this.#failuresTotal,
      activeUpgrades: this.#activeUpgrades,
      proxiedBindingsCount: this.#bindingById.size,
      lastRequestAt: this.#lastRequestAt,
      lastFailureAt: this.#lastFailureAt,
      lastFailureMessage: this.#lastFailureMessage,
    };
  }

  get httpBaseUrl() {
    const address = this.#server.address();
    const port = address && typeof address !== "string" ? address.port : this.#port;
    return `http://${this.#host}:${port}`;
  }

  get websocketBaseUrl() {
    const address = this.#server.address();
    const port = address && typeof address !== "string" ? address.port : this.#port;
    return `ws://${this.#host}:${port}`;
  }

  buildBindingUrl(binding: McpBinding) {
    return buildRemoteMcpProxyUrl({
      binding,
      httpBaseUrl: this.httpBaseUrl,
      websocketBaseUrl: this.websocketBaseUrl,
    });
  }

  #resolveRoute(rawUrl: string): ResolvedProxyRoute | null {
    const parsed = new URL(rawUrl, "http://proxy.local");
    const match = parsed.pathname.match(/^\/mcp-proxy\/([^/]+)(\/.*)?$/);
    if (!match) {
      return null;
    }

    const binding = this.#bindingById.get(decodeURIComponent(match[1]));
    if (!binding) {
      return null;
    }

    return {
      binding,
      suffixPath: match[2] ?? "",
      search: parsed.search,
    };
  }

  #resolveTargetUrl(route: ResolvedProxyRoute) {
    const targetUrl = new URL(route.binding.ref);
    if (route.suffixPath) {
      targetUrl.pathname = joinUrlPath(targetUrl.pathname, route.suffixPath);
    }
    if (route.search) {
      targetUrl.search = route.search;
    }
    return targetUrl.toString();
  }

  #validateTarget(binding: McpBinding, targetUrl: string) {
    if (!binding.networkPolicyRef) {
      return buildProxyIssue(
        binding,
        `Remote MCP ${binding.mcpId} is missing a runtime network policy`,
        "POLICY_REQUIRED"
      );
    }

    const policy = this.#policyByRef.get(binding.networkPolicyRef);
    if (!policy) {
      return buildProxyIssue(
        binding,
        `Runtime network policy ${binding.networkPolicyRef} was not materialized for MCP ${binding.mcpId}`,
        "POLICY_NOT_FOUND"
      );
    }

    if (policy.status !== "active") {
      return buildProxyIssue(
        binding,
        `Runtime network policy ${policy.policyRef} is ${policy.status} for MCP ${binding.mcpId}`,
        "POLICY_DISABLED"
      );
    }

    const evaluation = evaluateMcpNetworkPolicy({
      policy,
      targetUrl,
    });
    if (!evaluation.allowed) {
      return buildProxyIssue(binding, evaluation.message, evaluation.reasonCode);
    }

    return null;
  }

  async #handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) {
    this.#upgradesTotal += 1;
    this.#lastRequestAt = this.#now();

    try {
      const resolved = this.#resolveRoute(request.url ?? "");
      if (!resolved || resolved.binding.transport !== "websocket") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        return;
      }

      const targetUrl = this.#resolveTargetUrl(resolved);
      const issue = this.#validateTarget(resolved.binding, targetUrl);
      if (issue) {
        this.#blockedTotal += 1;
        socket.end(
          `HTTP/1.1 ${formatProxyIssueStatus(issue)} Forbidden\r\ncontent-type: application/json; charset=utf-8\r\nconnection: close\r\n\r\n${JSON.stringify(
            {
              error: issue.message,
              reasonCode: issue.reasonCode,
            }
          )}`
        );
        return;
      }

      const upstreamUrl = new URL(targetUrl);
      const requestModule = upstreamUrl.protocol === "wss:" ? https : http;
      const upstreamRequest = requestModule.request({
        protocol: upstreamUrl.protocol === "wss:" ? "https:" : "http:",
        hostname: upstreamUrl.hostname,
        port:
          upstreamUrl.port ||
          (upstreamUrl.protocol === "wss:" || upstreamUrl.protocol === "https:" ? "443" : "80"),
        method: request.method ?? "GET",
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        headers: sanitizeHeaders(request.headers, new Set(["host"])),
      });

      upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        this.#activeUpgrades += 1;
        const statusCode = upstreamResponse.statusCode ?? 101;
        const statusMessage = upstreamResponse.statusMessage ?? "Switching Protocols";
        writeProxyResponseHeaders(
          socket,
          upstreamResponse.headers,
          `HTTP/1.1 ${statusCode} ${statusMessage}`
        );

        if (head.length > 0) {
          upstreamSocket.write(head);
        }
        if (upstreamHead.length > 0) {
          socket.write(upstreamHead);
        }

        const closeSockets = () => {
          this.#activeUpgrades = Math.max(0, this.#activeUpgrades - 1);
          upstreamSocket.destroy();
          socket.destroy();
        };

        socket.on("error", () => closeSockets());
        upstreamSocket.on("error", () => closeSockets());
        socket.on("close", () => closeSockets());
        upstreamSocket.on("close", () => closeSockets());

        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });

      upstreamRequest.once("response", (upstreamResponse) => {
        writeProxyResponseHeaders(
          socket,
          upstreamResponse.headers,
          `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} ${upstreamResponse.statusMessage ?? "Bad Gateway"}`
        );
        upstreamResponse.pipe(socket);
      });

      upstreamRequest.once("error", (error) => {
        this.#failuresTotal += 1;
        this.#lastFailureAt = this.#now();
        this.#lastFailureMessage = error.message;
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });

      upstreamRequest.end();
    } catch (error) {
      this.#failuresTotal += 1;
      this.#lastFailureAt = this.#now();
      this.#lastFailureMessage = error instanceof Error ? error.message : String(error);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  }
}
