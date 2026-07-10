import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importRuntimeEgressFirewallModule() {
  const moduleUrl = pathToFileURL(
    path.resolve("dist/runtime-egress-firewall.js")
  ).href;
  return import(moduleUrl);
}

test("loadRuntimeEgressFirewallConfig parses target metadata from environment", async () => {
  const { loadRuntimeEgressFirewallConfig } =
    await importRuntimeEgressFirewallModule();

  const config = loadRuntimeEgressFirewallConfig({
    LINGBAN_RUNTIME_EGRESS_FIREWALL_ENABLED: "true",
    LINGBAN_RUNTIME_EGRESS_FIREWALL_ALLOW_DNS: "false",
    LINGBAN_RUNTIME_EGRESS_FIREWALL_TARGETS_JSON: JSON.stringify([
      {
        host: "host.docker.internal",
        port: 3100,
        reasons: ["runtime-api", "runtime-api"],
      },
    ]),
  });

  assert.equal(config.enabled, true);
  assert.equal(config.allowDns, false);
  assert.deepEqual(config.targets, [
    {
      host: "host.docker.internal",
      port: 3100,
      reasons: ["runtime-api"],
    },
  ]);
});

test("resolveRuntimeEgressFirewallPlan resolves governed targets and DNS resolvers", async () => {
  const { resolveRuntimeEgressFirewallPlan } =
    await importRuntimeEgressFirewallModule();

  const plan = await resolveRuntimeEgressFirewallPlan(
    {
      enabled: true,
      allowDns: true,
      targets: [
        {
          host: "host.docker.internal",
          port: 3100,
          reasons: ["runtime-api"],
        },
        {
          host: "mcp.workspace.internal",
          port: 443,
          reasons: ["mcp-binding:mbd_seedance"],
        },
      ],
    },
    {
      lookupImpl: async (hostname) => {
        if (hostname === "host.docker.internal") {
          return [{ address: "172.17.0.1", family: 4 }];
        }
        if (hostname === "mcp.workspace.internal") {
          return [
            { address: "203.0.113.10", family: 4 },
            { address: "2001:db8::10", family: 6 },
          ];
        }
        return [];
      },
      readFileImpl: async () => "nameserver 10.0.2.3\nnameserver 2001:4860:4860::8888\n",
    }
  );

  assert.equal(plan.enabled, true);
  assert.equal(plan.allowDns, true);
  assert.deepEqual(plan.dnsResolvers, [
    { address: "10.0.2.3", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 },
  ]);
  assert.equal(
    plan.targets.some(
      (target) =>
        target.host === "host.docker.internal" &&
        target.address === "172.17.0.1" &&
        target.port === 3100 &&
        target.family === 4
    ),
    true
  );
  assert.equal(
    plan.targets.some(
      (target) =>
        target.host === "mcp.workspace.internal" &&
        target.address === "2001:db8::10" &&
        target.port === 443 &&
        target.family === 6
    ),
    true
  );
});

test("buildRuntimeEgressFirewallCommandPlan emits iptables and ip6tables rules", async () => {
  const { buildRuntimeEgressFirewallCommandPlan } =
    await importRuntimeEgressFirewallModule();

  const commands = buildRuntimeEgressFirewallCommandPlan({
    enabled: true,
    allowDns: true,
    targets: [
      {
        host: "host.docker.internal",
        address: "172.17.0.1",
        family: 4,
        port: 3100,
        reasons: ["runtime-api"],
      },
      {
        host: "mcp.workspace.internal",
        address: "2001:db8::10",
        family: 6,
        port: 443,
        reasons: ["mcp-binding:mbd_seedance"],
      },
    ],
    dnsResolvers: [
      { address: "10.0.2.3", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ],
  });

  assert.equal(
    commands.some(
      (command) =>
        command.bin === "iptables" &&
        command.args.join(" ") ===
          "-w -A LINGBAN_RUNTIME_EGRESS_V4 -p tcp -d 172.17.0.1 --dport 3100 -j ACCEPT"
    ),
    true
  );
  assert.equal(
    commands.some(
      (command) =>
        command.bin === "ip6tables" &&
        command.args.join(" ") ===
          "-w -A LINGBAN_RUNTIME_EGRESS_V6 -p tcp -d 2001:db8::10 --dport 443 -j ACCEPT"
    ),
    true
  );
  assert.equal(
    commands.some(
      (command) =>
        command.bin === "iptables" &&
        command.args.join(" ") ===
          "-w -A LINGBAN_RUNTIME_EGRESS_V4 -p udp -d 10.0.2.3 --dport 53 -j ACCEPT"
    ),
    true
  );
  assert.equal(
    commands.some(
      (command) =>
        command.bin === "ip6tables" &&
        command.args.join(" ") ===
          "-w -A LINGBAN_RUNTIME_EGRESS_V6 -p tcp -d 2001:4860:4860::8888 --dport 53 -j ACCEPT"
    ),
    true
  );
  assert.equal(
    commands.some(
      (command) =>
        command.bin === "iptables" &&
        command.args.join(" ") === "-w -A LINGBAN_RUNTIME_EGRESS_V4 -j REJECT"
    ),
    true
  );
});
