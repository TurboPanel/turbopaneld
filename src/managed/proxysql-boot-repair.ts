/**
 * Boot repair for the shared ProxySQL frontend.
 *
 * After a hard reboot dockerd restarts the frontend (`restart: unless-stopped`)
 * before the host's datacenter address is on its interface. Docker then fails
 * the host publish ("cannot assign requested address"), does not retry, and
 * leaves the container without its port bindings (not running, or running with
 * none). Nothing else brings it back until the control plane next sends
 * `managed.ingress.reconcile`.
 *
 * On every daemon start this checks, for up to 10 minutes (backoff capped at
 * 15 s), that the container is running and docker shows a host binding for
 * every client mapping the on-disk compose file publishes. If not, it waits
 * for each specific bind address to exist locally, then runs
 * `compose up -d --force-recreate` on that same file. It rewrites nothing, so
 * it never widens or changes exposure. Wildcard binds never wait. It is a
 * no-op when there is no compose file or the bindings are in place.
 */

import {
  frontendBindingsHealth,
  type Mapping,
  mappingKey,
  normaliseAddress,
  specificAddresses,
  wantedMappings,
} from "./proxysql-bindings.ts";
import { readPublishedClientMappingsFromCompose } from "./proxysql.ts";
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
  /** Total time to wait for addresses and Docker, default 10 minutes. */
  budgetMs?: number;
  /** Log sinks; default to the daemon logger. */
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

const DEFAULT_BUDGET_MS = 10 * 60_000;
const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15_000;

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
  private wanted: Mapping[] = [];

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

  private isHealthy() {
    return frontendBindingsHealth(this.docker, this.composePath, this.wanted);
  }

  async run(): Promise<ProxySqlBootRepairResult> {
    const first = await this.readCompose(this.composePath);
    if (first === null) return "no-compose";
    this.wanted = wantedMappings(readPublishedClientMappingsFromCompose(first));

    const budget = this.deps.budgetMs ?? DEFAULT_BUDGET_MS;
    const deadline = (this.deps.now ?? Date.now)() + budget;
    const end = await this.poll(deadline, FIRST_DELAY_MS);
    if (end.kind === "done") return end.result;
    const reason = end.reason;
    this.warn(
      `ProxySQL frontend boot repair gave up after ${
        Math.round(budget / 1000)
      }s: ${reason}`,
    );
    return "gave-up";
  }

  /** Resolves to a final attempt, or to the last retry once out of budget. */
  private async poll(
    deadline: number,
    delay: number,
  ): Promise<Attempt> {
    const attempt = await this.attempt();
    if (attempt.kind === "done") return attempt;
    if ((this.deps.now ?? Date.now)() + delay > deadline) return attempt;
    await (this.deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(delay);
    return this.poll(deadline, Math.min(delay * 2, MAX_DELAY_MS));
  }

  private async attempt(): Promise<Attempt> {
    if (proxySqlReconciledSinceStart()) return this.standDown();
    const health = await this.isHealthy();
    if (!health.ok) return { kind: "retry", reason: health.reason };
    if (health.healthy) return RUNNING;
    const present = new Set(
      (this.deps.localAddresses ?? readLocalAddresses)().map(normaliseAddress),
    );
    const missing = specificAddresses(this.wanted).filter((address) =>
      !present.has(address)
    );
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
    if (
      mappingKey(
        wantedMappings(readPublishedClientMappingsFromCompose(current)),
      ) !== mappingKey(this.wanted)
    ) {
      return this.abort("published addresses changed");
    }
    const again = await this.isHealthy();
    if (again.ok && again.healthy) return RUNNING;
    // Recreate: a container that failed its publish bind keeps no bindings
    // across a plain `up -d`.
    const up = await this.docker([
      "compose",
      "-f",
      this.composePath,
      "up",
      "-d",
      "--force-recreate",
    ]);
    if (!up.success) {
      return { kind: "retry", reason: up.stderr.trim() || "compose up failed" };
    }
    this.info(
      "ProxySQL frontend had no running listener bindings after boot; recreated it",
    );
    return { kind: "done", result: "started" };
  }
}
