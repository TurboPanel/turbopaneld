/**
 * Boot repair for the shared ProxySQL frontend.
 *
 * After a hard reboot dockerd restarts the frontend (`restart: unless-stopped`)
 * before the host's datacenter address is on its interface. Docker then fails
 * the host publish ("cannot assign requested address"), does not retry, and
 * leaves the container stopped with no port bindings. Nothing else brings it
 * back until the control plane next sends `managed.ingress.reconcile`.
 *
 * On every daemon start this waits (bounded) for each address the on-disk
 * compose file publishes on, then runs `compose up -d` on that same file. It
 * rewrites nothing, so it never widens or changes exposure. It is a no-op when
 * there is no compose file or the container is already running.
 */

import { readPublishedBindAddressesFromCompose } from "./proxysql.ts";
import { proxysqlComposePath } from "./engine-paths.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { runDocker as defaultRunDocker } from "../deploy/docker-cli.ts";
import { logInfo, logWarn } from "../util/logger.ts";

export type ProxySqlBootRepairResult =
  | "no-compose"
  | "already-running"
  | "started"
  | "gave-up";

export type ProxySqlBootRepairDeps = {
  runDocker?: (args: string[]) => Promise<DockerCliResult>;
  readCompose?: (path: string) => Promise<string | null>;
  localAddresses?: () => string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Total time to wait for addresses and Docker, default 5 minutes. */
  budgetMs?: number;
};

const DEFAULT_BUDGET_MS = 5 * 60_000;
const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15_000;
const ANY_ADDRESSES = new Set(["0.0.0.0", "::", "[::]"]);

async function readComposeFile(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

function readLocalAddresses(): string[] {
  return Deno.networkInterfaces().map((nic) => nic.address);
}

export async function repairProxySqlFrontendAtBoot(
  layout: LayoutPaths,
  deps: ProxySqlBootRepairDeps = {},
): Promise<ProxySqlBootRepairResult> {
  const run = deps.runDocker ?? ((args) => defaultRunDocker(args));
  const sleep = deps.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const budget = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const composePath = proxysqlComposePath(layout);

  const composeText = await (deps.readCompose ?? readComposeFile)(composePath);
  if (composeText === null) return "no-compose";
  const wanted = readPublishedBindAddressesFromCompose(composeText).filter(
    (address) => !ANY_ADDRESSES.has(address),
  );

  const deadline = now() + budget;
  let delay = FIRST_DELAY_MS;
  let lastReason = "";
  for (;;) {
    const ps = await run([
      "compose",
      "-f",
      composePath,
      "ps",
      "--status",
      "running",
      "-q",
    ]);
    if (ps.success) {
      if (ps.stdout.trim().length > 0) return "already-running";
      const present = new Set((deps.localAddresses ?? readLocalAddresses)());
      const missing = wanted.filter((address) => !present.has(address));
      if (missing.length === 0) {
        const up = await run(["compose", "-f", composePath, "up", "-d"]);
        if (up.success) {
          logInfo(
            "managed",
            "ProxySQL frontend was not running after boot; started it",
          );
          return "started";
        }
        lastReason = up.stderr.trim() || "compose up failed";
      } else {
        lastReason = `waiting for address ${missing.join(", ")}`;
      }
    } else {
      lastReason = ps.stderr.trim() || "docker not ready";
    }
    if (now() + delay > deadline) break;
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  }
  logWarn(
    "managed",
    `ProxySQL frontend boot repair gave up after ${
      Math.round(budget / 1000)
    }s: ${lastReason}`,
  );
  return "gave-up";
}
