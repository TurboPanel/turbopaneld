/**
 * Ensure compose `external: true` Docker networks exist before
 * `docker compose up`.
 *
 * Inspect-first and strictly idempotent: an existing network is never
 * touched. Docker cannot re-range a network in place — the only way to
 * change its subnet would be `rm` + `create`, which detaches every running
 * container — so a requested subnet that differs from what the host already
 * has is **logged as drift**, never applied.
 */

import {
  addressInCidrLiteral,
  cidrLiteralContains,
} from "../instance/commands/contracts.ts";
import { logInfo, logWarn } from "../logger.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "./docker-cli.ts";

const DOCKER_NETWORK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DOCKER_MTU_OPT_KEY = "com.docker.network.driver.mtu";
const DOCKER_NETWORK_MTU_MIN = 1280;
const DOCKER_NETWORK_MTU_MAX = 9000;
/** IPv4 / IPv6 address, optionally with a `/prefix` — never a shell token. */
const CIDR_OR_ADDRESS_RE = /^[0-9A-Fa-f:.]+(\/\d{1,3})?$/;

/** Addressing for one external network; every key but `name` is optional. */
export type ExternalDockerNetworkSpec = {
  name: string;
  subnet?: string;
  ipRange?: string;
  gateway?: string;
  mtu?: number;
};

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

function assertValidDockerNetworkName(name: string): void {
  if (!DOCKER_NETWORK_NAME_RE.test(name)) {
    throw new Error(`Invalid docker network name: ${name}`);
  }
}

function assertCidr(name: string, field: string, value: string): void {
  if (!CIDR_OR_ADDRESS_RE.test(value) || !value.includes("/")) {
    throw new Error(`Invalid docker network ${field} for ${name}: ${value}`);
  }
}

function assertAddress(name: string, field: string, value: string): void {
  if (!CIDR_OR_ADDRESS_RE.test(value) || value.includes("/")) {
    throw new Error(`Invalid docker network ${field} for ${name}: ${value}`);
  }
}

/**
 * Docker refuses `--ip-range` / `--gateway` without a `--subnet` and either
 * outside it; the daemon re-checks the same containment the contract parser
 * enforces so a descriptor built any other way still cannot reach the CLI
 * with inconsistent addressing.
 */
function assertInsideSubnet(
  name: string,
  field: "ipRange" | "gateway",
  value: string,
  subnet: string | undefined,
): void {
  const contained = subnet !== undefined &&
    (field === "ipRange"
      ? cidrLiteralContains(subnet, value)
      : addressInCidrLiteral(value, subnet));
  if (!contained) {
    throw new Error(
      `Invalid docker network ${field} for ${name}: ${value} is not inside subnet ${
        subnet ?? "(none)"
      }`,
    );
  }
}

function assertMtu(name: string, value: number): void {
  if (
    !Number.isInteger(value) || value < DOCKER_NETWORK_MTU_MIN ||
    value > DOCKER_NETWORK_MTU_MAX
  ) {
    throw new Error(`Invalid docker network mtu for ${name}: ${value}`);
  }
}

/**
 * `docker network create` argv for a spec. Every optional flag is validated
 * before interpolation and appended only when present, so a bare
 * `{ name }` yields exactly the historical `network create <name>`.
 */
export function buildDockerNetworkCreateArgs(
  spec: ExternalDockerNetworkSpec,
): string[] {
  assertValidDockerNetworkName(spec.name);
  const args = ["network", "create"];
  if (spec.subnet !== undefined) {
    assertCidr(spec.name, "subnet", spec.subnet);
    args.push("--subnet", spec.subnet);
  }
  if (spec.ipRange !== undefined) {
    assertCidr(spec.name, "ipRange", spec.ipRange);
    assertInsideSubnet(spec.name, "ipRange", spec.ipRange, spec.subnet);
    args.push("--ip-range", spec.ipRange);
  }
  if (spec.gateway !== undefined) {
    assertAddress(spec.name, "gateway", spec.gateway);
    assertInsideSubnet(spec.name, "gateway", spec.gateway, spec.subnet);
    args.push("--gateway", spec.gateway);
  }
  if (spec.mtu !== undefined) {
    assertMtu(spec.name, spec.mtu);
    args.push("--opt", `${DOCKER_MTU_OPT_KEY}=${spec.mtu}`);
  }
  args.push(spec.name);
  return args;
}

/**
 * Observed IPAM subnets from `docker network inspect` output. Tolerant of
 * anything unexpected (an empty list just means "unknown" — no warning).
 */
export function parseInspectedSubnets(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const subnets: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const ipam = (entry as { IPAM?: { Config?: unknown } }).IPAM;
    if (!Array.isArray(ipam?.Config)) continue;
    for (const config of ipam.Config) {
      const subnet = (config as { Subnet?: unknown })?.Subnet;
      if (typeof subnet === "string" && subnet.length > 0) subnets.push(subnet);
    }
  }
  return subnets;
}

function warnOnSubnetDrift(
  spec: ExternalDockerNetworkSpec,
  inspect: DockerCliResult,
): void {
  if (spec.subnet === undefined) return;
  const observed = parseInspectedSubnets(inspect.stdout);
  if (observed.length === 0 || observed.includes(spec.subnet)) return;
  logWarn(
    "deploy",
    `external docker network ${spec.name} has subnet ${
      observed.join(", ")
    }, registered ${spec.subnet}; Docker cannot re-range an existing network — leaving it as is`,
  );
}

/**
 * Accepts the historical bare name list or full specs. Existing networks are
 * left untouched (subnet drift is only logged); missing ones are created
 * with whatever addressing the spec carries.
 */
export async function ensureExternalDockerNetworks(
  networks: ReadonlyArray<string | ExternalDockerNetworkSpec>,
  run: RunDockerFn = defaultRunDocker,
): Promise<void> {
  if (networks.length === 0) return;

  for (const entry of networks) {
    const spec: ExternalDockerNetworkSpec = typeof entry === "string"
      ? { name: entry }
      : entry;
    assertValidDockerNetworkName(spec.name);
    const createArgs = buildDockerNetworkCreateArgs(spec);
    const inspect = await run(["network", "inspect", spec.name]);
    if (inspect.success) {
      warnOnSubnetDrift(spec, inspect);
      continue;
    }

    logInfo("deploy", `creating external docker network ${spec.name}`);
    const create = await run(createArgs);
    if (!create.success) {
      throw new Error(
        create.stderr || `Failed to create docker network ${spec.name}`,
      );
    }
  }
}
