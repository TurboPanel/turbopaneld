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
import {
  proxySqlReconciledSinceStart,
  withProxySqlLock,
} from "./proxysql-lock.ts";

export type ProxySqlBootRepairResult =
  | "no-compose"
  | "already-running"
  | "started"
  | "gave-up"
  | "superseded"
  | "aborted";

export type ProxySqlBootRepairDeps = {
  runDocker?: (args: string[]) => Promise<DockerCliResult>;
  readCompose?: (path: string) => Promise<string | null>;
  localAddresses?: () => string[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Total time to wait for addresses and Docker, default 5 minutes. */
  budgetMs?: number;
  /** Log sinks; default to the daemon logger. */
  info?: (message: string) => void;
  warn?: (message: string) => void;
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

function normaliseAddress(address: string): string {
  return address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
}

function wantedAddresses(composeText: string): string[] {
  return readPublishedBindAddressesFromCompose(composeText)
    .map(normaliseAddress)
    .filter((address) => !ANY_ADDRESSES.has(address))
    .sort();
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
  const info = deps.info ?? ((m: string) => logInfo("managed", m));
  const warn = deps.warn ?? ((m: string) => logWarn("managed", m));

  const readCompose = deps.readCompose ?? readComposeFile;
  const first = await readCompose(composePath);
  if (first === null) return "no-compose";
  const wanted = wantedAddresses(first);

  const deadline = now() + budget;
  let delay = FIRST_DELAY_MS;
  let lastReason = "";
  for (;;) {
    if (proxySqlReconciledSinceStart()) {
      info("ProxySQL boot repair stood down: reconcile ran");
      return "superseded";
    }
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
      const present = new Set(
        (deps.localAddresses ?? readLocalAddresses)().map(normaliseAddress),
      );
      const missing = wanted.filter((address) => !present.has(address));
      if (missing.length === 0) {
        // Check and up under the reconcile lock, on a fresh read of the file.
        const outcome = await withProxySqlLock(
          async (): Promise<ProxySqlBootRepairResult | string> => {
            if (proxySqlReconciledSinceStart()) return "superseded";
            const current = await readCompose(composePath);
            if (current === null) return "aborted:compose file removed";
            if (wantedAddresses(current).join(",") !== wanted.join(",")) {
              return "aborted:published addresses changed";
            }
            const again = await run([
              "compose",
              "-f",
              composePath,
              "ps",
              "--status",
              "running",
              "-q",
            ]);
            if (again.success && again.stdout.trim().length > 0) {
              return "already-running";
            }
            const up = await run(["compose", "-f", composePath, "up", "-d"]);
            if (up.success) return "started";
            return `retry:${up.stderr.trim() || "compose up failed"}`;
          },
        );
        if (outcome === "started") {
          info("ProxySQL frontend was not running after boot; started it");
          return "started";
        }
        if (outcome === "already-running") return "already-running";
        if (outcome === "superseded") {
          info("ProxySQL boot repair stood down: reconcile ran");
          return "superseded";
        }
        if (outcome.startsWith("aborted:")) {
          warn(`ProxySQL boot repair aborted: ${outcome.slice(8)}`);
          return "aborted";
        }
        lastReason = outcome.slice(6);
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
  warn(
    `ProxySQL frontend boot repair gave up after ${
      Math.round(budget / 1000)
    }s: ${lastReason}`,
  );
  return "gave-up";
}
