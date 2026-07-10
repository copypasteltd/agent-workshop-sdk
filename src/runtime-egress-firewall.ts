import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const IPV4_CHAIN = "LINGBAN_RUNTIME_EGRESS_V4";
const IPV6_CHAIN = "LINGBAN_RUNTIME_EGRESS_V6";

const firewallTargetSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  reasons: z.array(z.string().trim().min(1)).min(1),
});

export type RuntimeEgressFirewallTarget = z.infer<typeof firewallTargetSchema>;

export type RuntimeEgressFirewallConfig = {
  enabled: boolean;
  allowDns: boolean;
  targets: RuntimeEgressFirewallTarget[];
};

export type RuntimeEgressFirewallResolvedTarget = {
  host: string;
  address: string;
  family: 4 | 6;
  port: number;
  reasons: string[];
};

export type RuntimeEgressFirewallResolver = {
  address: string;
  family: 4 | 6;
};

export type RuntimeEgressFirewallResolvedPlan = {
  enabled: boolean;
  allowDns: boolean;
  targets: RuntimeEgressFirewallResolvedTarget[];
  dnsResolvers: RuntimeEgressFirewallResolver[];
};

export type FirewallCommand = {
  bin: "iptables" | "ip6tables";
  args: string[];
  ignoreError?: boolean;
};

type ResolvePlanDependencies = {
  lookupImpl?: typeof lookup;
  readFileImpl?: typeof fs.readFile;
};

type ApplyFirewallDependencies = ResolvePlanDependencies & {
  runCommandImpl?: (command: FirewallCommand) => Promise<void>;
};

function readBooleanLike(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean-like value: ${value}`);
}

export function loadRuntimeEgressFirewallConfig(
  env: NodeJS.ProcessEnv = process.env
): RuntimeEgressFirewallConfig {
  const enabled = readBooleanLike(
    env.LINGBAN_RUNTIME_EGRESS_FIREWALL_ENABLED,
    false
  );
  const allowDns = readBooleanLike(
    env.LINGBAN_RUNTIME_EGRESS_FIREWALL_ALLOW_DNS,
    true
  );
  const rawTargets = env.LINGBAN_RUNTIME_EGRESS_FIREWALL_TARGETS_JSON?.trim();
  const parsedTargets = rawTargets
    ? z.array(firewallTargetSchema).parse(JSON.parse(rawTargets))
    : [];

  return {
    enabled,
    allowDns,
    targets: parsedTargets.map((target) => ({
      host: target.host.toLowerCase(),
      port: target.port,
      reasons: [...new Set(target.reasons)].sort((left, right) =>
        left.localeCompare(right)
      ),
    })),
  };
}

export function parseResolvConfNameservers(resolvConfText: string) {
  const resolvers = new Map<string, RuntimeEgressFirewallResolver>();

  for (const rawLine of resolvConfText.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const match = line.match(/^nameserver\s+(.+)$/i);
    if (!match) {
      continue;
    }

    const candidate = match[1].trim();
    const family = isIP(candidate);
    if (family !== 4 && family !== 6) {
      continue;
    }

    resolvers.set(candidate, {
      address: candidate,
      family,
    });
  }

  return [...resolvers.values()].sort((left, right) =>
    `${left.family}:${left.address}`.localeCompare(`${right.family}:${right.address}`)
  );
}

async function resolveFirewallHost(
  host: string,
  lookupImpl: typeof lookup
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const family = isIP(host);
  if (family === 4 || family === 6) {
    return [{ address: host, family }];
  }

  const resolved = await lookupImpl(host, {
    all: true,
    verbatim: true,
  });

  return resolved
    .filter(
      (entry): entry is { address: string; family: 4 | 6 } =>
        (entry.family === 4 || entry.family === 6) && entry.address.trim().length > 0
    )
    .sort((left, right) =>
      `${left.family}:${left.address}`.localeCompare(`${right.family}:${right.address}`)
    );
}

export async function resolveRuntimeEgressFirewallPlan(
  config: RuntimeEgressFirewallConfig,
  dependencies: ResolvePlanDependencies = {}
): Promise<RuntimeEgressFirewallResolvedPlan> {
  if (!config.enabled) {
    return {
      enabled: false,
      allowDns: config.allowDns,
      targets: [],
      dnsResolvers: [],
    };
  }

  const lookupImpl = dependencies.lookupImpl ?? lookup;
  const readFileImpl = dependencies.readFileImpl ?? fs.readFile;
  const targets = new Map<string, RuntimeEgressFirewallResolvedTarget>();

  for (const target of config.targets) {
    const resolvedHosts = await resolveFirewallHost(target.host, lookupImpl);
    if (resolvedHosts.length === 0) {
      throw new Error(`Failed to resolve runtime egress firewall host: ${target.host}`);
    }

    for (const resolved of resolvedHosts) {
      const key = `${resolved.family}:${resolved.address}:${target.port}`;
      const existing = targets.get(key);
      if (existing) {
        for (const reason of target.reasons) {
          if (!existing.reasons.includes(reason)) {
            existing.reasons.push(reason);
          }
        }
        existing.reasons.sort((left, right) => left.localeCompare(right));
        continue;
      }

      targets.set(key, {
        host: target.host,
        address: resolved.address,
        family: resolved.family,
        port: target.port,
        reasons: [...target.reasons].sort((left, right) => left.localeCompare(right)),
      });
    }
  }

  const dnsResolvers = config.allowDns
    ? parseResolvConfNameservers(
        await readFileImpl("/etc/resolv.conf", "utf8").catch(() => "")
      )
    : [];

  return {
    enabled: true,
    allowDns: config.allowDns,
    targets: [...targets.values()].sort((left, right) =>
      `${left.family}:${left.address}:${left.port}`.localeCompare(
        `${right.family}:${right.address}:${right.port}`
      )
    ),
    dnsResolvers,
  };
}

function pushFirewallFamilyCommands(
  commands: FirewallCommand[],
  bin: "iptables" | "ip6tables",
  chain: string,
  targets: RuntimeEgressFirewallResolvedTarget[],
  dnsResolvers: RuntimeEgressFirewallResolver[],
  allowDns: boolean
) {
  commands.push({
    bin,
    args: ["-w", "-F", chain],
    ignoreError: true,
  });
  commands.push({
    bin,
    args: ["-w", "-N", chain],
    ignoreError: true,
  });
  commands.push({
    bin,
    args: ["-w", "-F", chain],
  });
  commands.push({
    bin,
    args: ["-w", "-D", "OUTPUT", "-j", chain],
    ignoreError: true,
  });
  commands.push({
    bin,
    args: ["-w", "-I", "OUTPUT", "1", "-j", chain],
  });
  commands.push({
    bin,
    args: ["-w", "-A", chain, "-o", "lo", "-j", "ACCEPT"],
  });
  commands.push({
    bin,
    args: ["-w", "-A", chain, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
  });

  if (allowDns) {
    for (const resolver of dnsResolvers) {
      commands.push({
        bin,
        args: ["-w", "-A", chain, "-p", "udp", "-d", resolver.address, "--dport", "53", "-j", "ACCEPT"],
      });
      commands.push({
        bin,
        args: ["-w", "-A", chain, "-p", "tcp", "-d", resolver.address, "--dport", "53", "-j", "ACCEPT"],
      });
    }
  }

  for (const target of targets) {
    commands.push({
      bin,
      args: [
        "-w",
        "-A",
        chain,
        "-p",
        "tcp",
        "-d",
        target.address,
        "--dport",
        String(target.port),
        "-j",
        "ACCEPT",
      ],
    });
  }

  commands.push({
    bin,
    args: ["-w", "-A", chain, "-j", "REJECT"],
  });
}

export function buildRuntimeEgressFirewallCommandPlan(
  plan: RuntimeEgressFirewallResolvedPlan
) {
  if (!plan.enabled) {
    return [] satisfies FirewallCommand[];
  }

  const commands: FirewallCommand[] = [];
  const ipv4Targets = plan.targets.filter((target) => target.family === 4);
  const ipv6Targets = plan.targets.filter((target) => target.family === 6);
  const ipv4Resolvers = plan.dnsResolvers.filter((resolver) => resolver.family === 4);
  const ipv6Resolvers = plan.dnsResolvers.filter((resolver) => resolver.family === 6);

  pushFirewallFamilyCommands(
    commands,
    "iptables",
    IPV4_CHAIN,
    ipv4Targets,
    ipv4Resolvers,
    plan.allowDns
  );
  pushFirewallFamilyCommands(
    commands,
    "ip6tables",
    IPV6_CHAIN,
    ipv6Targets,
    ipv6Resolvers,
    plan.allowDns
  );

  return commands;
}

async function runFirewallCommand(command: FirewallCommand) {
  try {
    await execFileAsync(command.bin, command.args, {
      encoding: "utf8",
    });
  } catch (error) {
    if (command.ignoreError) {
      return;
    }

    const message =
      error instanceof Error
        ? error.message
        : `Command failed: ${command.bin} ${command.args.join(" ")}`;
    throw new Error(message);
  }
}

export async function applyRuntimeEgressFirewall(
  dependencies: ApplyFirewallDependencies = {}
) {
  const config = loadRuntimeEgressFirewallConfig();
  if (!config.enabled) {
    return null;
  }

  const plan = await resolveRuntimeEgressFirewallPlan(config, dependencies);
  const commands = buildRuntimeEgressFirewallCommandPlan(plan);
  const runCommandImpl = dependencies.runCommandImpl ?? runFirewallCommand;
  for (const command of commands) {
    await runCommandImpl(command);
  }

  return {
    config,
    plan,
    commandsApplied: commands.length,
  };
}

function isDirectExecution() {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
}

async function main() {
  const subcommand = process.argv[2] ?? "apply";
  if (subcommand !== "apply") {
    throw new Error(`Unsupported runtime egress firewall subcommand: ${subcommand}`);
  }

  const result = await applyRuntimeEgressFirewall();
  if (!result) {
    return;
  }

  console.log(
    `[lingban-runtime-egress-firewall] applied ${result.plan.targets.length} target(s), ` +
      `${result.plan.dnsResolvers.length} resolver(s), ${result.commandsApplied} command(s)`
  );
}

if (isDirectExecution()) {
  void main().catch((error) => {
    console.error(
      `[lingban-runtime-egress-firewall] failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
