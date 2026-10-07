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
  let out = address.toLowerCase();
  if (out.startsWith("[")) out = out.slice(1);
  if (out.endsWith("]")) out = out.slice(0, -1);
  const zone = out.indexOf("%");
  return zone === -1 ? out : out.slice(0, zone);
}

function wantedAddresses(composeText: string): string[] {
  return readPublishedBindAddressesFromCompose(composeText)
    .map(normaliseAddress)
    .filter((address) => !ANY_ADDRESSES.has(address))
    .sort((a, b) => a.localeCompare(b));
}

function readLocalAddresses(): string[] {
  return Deno.networkInterfaces().map((nic) => nic.address);
}

type Attempt =
  | { kind: "done"; result: ProxySqlBootRepairResult }
  | { kind: "retry"; reason: string };

const SUPERSEDED: Attempt = { kind: "done", result: "superseded" };
const RUNNING: Attempt = { kind: "done", result: "already-running" };

export function repairProxySqlFrontendAtBoot(
  layout: LayoutPaths,
  deps: ProxySqlBootRepairDeps = {},
): Promise<ProxySqlBootRepairResult> {
  return new Repair(layout, deps).run();
}

class Repair {
  private readonly composePath: string;
  private readonly docker: (args: string[]) => Promise<DockerCliResult>;
  private readonly readCompose: (path: string) => Promise<string | null>;
  private readonly info: (message: string) => void;
  private readonly warn: (message: string) => void;
  private wanted: string[] = [];

  constructor(
    layout: LayoutPaths,
    private readonly deps: ProxySqlBootRepairDeps,
  ) {
    this.composePath = proxysqlComposePath(layout);
    this.docker = deps.runDocker ?? ((args) => defaultRunDocker(args));
    this.readCompose = deps.readCompose ?? readComposeFile;
    this.info = deps.info ?? ((m) => logInfo("managed", m));
    this.warn = deps.warn ?? ((m) => logWarn("managed", m));
  }

  private isRunning(): Promise<DockerCliResult> {
    return this.docker([
      "compose",
      "-f",
      this.composePath,
      "ps",
      "--status",
      "running",
      "-q",
    ]);
  }

  async run(): Promise<ProxySqlBootRepairResult> {
    const first = await this.readCompose(this.composePath);
    if (first === null) return "no-compose";
    this.wanted = wantedAddresses(first);

    const sleep = this.deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.deps.now ?? Date.now;
    const budget = this.deps.budgetMs ?? DEFAULT_BUDGET_MS;
    const deadline = now() + budget;
    let delay = FIRST_DELAY_MS;
    let reason = "";
    for (;;) {
      const attempt = await this.attempt();
      if (attempt.kind === "done") return attempt.result;
      reason = attempt.reason;
      if (now() + delay > deadline) break;
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
    this.warn(
      `ProxySQL frontend boot repair gave up after ${
        Math.round(budget / 1000)
      }s: ${reason}`,
    );
    return "gave-up";
  }

  private async attempt(): Promise<Attempt> {
    if (proxySqlReconciledSinceStart()) return this.standDown();
    const ps = await this.isRunning();
    if (!ps.success) {
      return { kind: "retry", reason: ps.stderr.trim() || "docker not ready" };
    }
    if (ps.stdout.trim().length > 0) return RUNNING;
    const present = new Set(
      (this.deps.localAddresses ?? readLocalAddresses)().map(normaliseAddress),
    );
    const missing = this.wanted.filter((address) => !present.has(address));
    if (missing.length > 0) {
      return {
        kind: "retry",
        reason: `waiting for address ${missing.join(", ")}`,
      };
    }
    // Check and up under the reconcile lock, on a fresh read of the file.
    return await withProxySqlLock(() => this.upLocked());
  }

  private standDown(): Attempt {
    this.info("ProxySQL boot repair stood down: reconcile ran");
    return SUPERSEDED;
  }

  private abort(why: string): Attempt {
    this.warn(`ProxySQL boot repair aborted: ${why}`);
    return { kind: "done", result: "aborted" };
  }

  private async upLocked(): Promise<Attempt> {
    if (proxySqlReconciledSinceStart()) return this.standDown();
    const current = await this.readCompose(this.composePath);
    if (current === null) return this.abort("compose file removed");
    if (wantedAddresses(current).join(",") !== this.wanted.join(",")) {
      return this.abort("published addresses changed");
    }
    const again = await this.isRunning();
    if (again.success && again.stdout.trim().length > 0) return RUNNING;
    const up = await this.docker([
      "compose",
      "-f",
      this.composePath,
      "up",
      "-d",
    ]);
    if (!up.success) {
      return { kind: "retry", reason: up.stderr.trim() || "compose up failed" };
    }
    this.info("ProxySQL frontend was not running after boot; started it");
    return { kind: "done", result: "started" };
  }
}
