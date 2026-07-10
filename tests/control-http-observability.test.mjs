import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importControlHttpServer() {
  const moduleUrl = pathToFileURL(path.resolve("dist/transports/control-http.js")).href;
  return import(moduleUrl);
}

test("ControlHttpServer exposes protected diagnostics and metrics with request accounting", async () => {
  const { ControlHttpServer } = await importControlHttpServer();
  const handledCommands = [];

  const server = new ControlHttpServer({
    controlServer: {
      async handle(command) {
        handledCommands.push(command);
        return {
          ok: true,
          command: command.type,
        };
      },
    },
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    now: () => "2026-07-09T10:00:00.000Z",
    getDiagnostics: () => ({
      bridgeId: "brg_observe",
      runId: "run_00000123",
      metrics: {
        observedEventsTotal: 2,
      },
    }),
    getMetricsText: () =>
      [
        "# HELP lingban_bridge_runtime_events_observed_total Test runtime metric.",
        "# TYPE lingban_bridge_runtime_events_observed_total counter",
        "lingban_bridge_runtime_events_observed_total 2",
      ].join("\n"),
  });

  await server.start();

  try {
    assert.doesNotMatch(server.url, /:0$/);

    const healthResponse = await fetch(`${server.url}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal(
      healthResponse.headers.get("content-type"),
      "application/json; charset=utf-8"
    );

    const unauthorizedDiagnostics = await fetch(`${server.url}/diagnostics`);
    assert.equal(unauthorizedDiagnostics.status, 401);

    const pingResponse = await fetch(`${server.url}/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lingban-control-token": "secret-token",
      },
      body: JSON.stringify({
        type: "ping",
      }),
    });
    assert.equal(pingResponse.status, 200);
    assert.deepEqual(await pingResponse.json(), {
      ok: true,
      command: "ping",
    });

    const invalidControlResponse = await fetch(`${server.url}/control`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lingban-control-token": "secret-token",
      },
      body: "{invalid json",
    });
    assert.equal(invalidControlResponse.status, 400);

    const diagnosticsResponse = await fetch(`${server.url}/diagnostics`, {
      headers: {
        "x-lingban-control-token": "secret-token",
      },
    });
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.bridgeId, "brg_observe");
    assert.equal(diagnostics.runId, "run_00000123");
    assert.equal(diagnostics.metrics.observedEventsTotal, 2);
    assert.equal(diagnostics.controlHttp.authRequired, true);
    assert.equal(diagnostics.controlHttp.unauthorizedRequestsTotal, 1);
    assert.ok(diagnostics.controlHttp.requestsTotal >= 4);
    assert.ok(
      diagnostics.controlHttp.routes.some(
        (route) => route.route === "control" && route.clientErrorsTotal >= 1
      )
    );

    const metricsResponse = await fetch(`${server.url}/metrics`, {
      headers: {
        "x-lingban-control-token": "secret-token",
      },
    });
    assert.equal(metricsResponse.status, 200);
    assert.equal(
      metricsResponse.headers.get("content-type"),
      "text/plain; version=0.0.4; charset=utf-8"
    );
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /lingban_bridge_runtime_events_observed_total 2/);

    const serverDiagnostics = server.getDiagnostics();
    assert.equal(serverDiagnostics.authRequired, true);
    assert.ok(serverDiagnostics.requestsTotal >= 5);
    assert.ok(serverDiagnostics.routes.some((route) => route.route === "metrics"));
    assert.deepEqual(handledCommands.map((command) => command.type), ["ping"]);
  } finally {
    await server.stop();
  }
});
