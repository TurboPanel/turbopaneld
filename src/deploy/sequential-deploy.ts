/**
 * Sequential deploy engine: stop the old version, run migrations when the
 * deploy declares any, start the new version, gate on health, and roll back to
 * the previous deploy when that is safe.
 *
 * Only `environment.deploy` payloads carrying `deployStrategy: "sequential"`
 * come here; every other deploy keeps the in-place path in
 * `commands/deploy-environment.ts` untouched.
 *
 * Order (owner decisions 2026-10-01):
 * 1. `prepare` (networks, image build and pull). A failure here throws a plain
 *    error: nothing has been stopped yet, so the old version is still serving.
 *    A cancel lands here too (`commit` throws `DeployCancelledError`); after
 *    `commit` it answers "too late".
 * 2. Stop the application services of the previous deploy that this deploy
 *    changes. Services named in `keepRunning` (databases and other stateful
 *    services) stay up so migrations have something to talk to, and so does a
 *    service whose effective config, image and generated files are all
 *    unchanged: stopping it would only cost a restart (see
 *    {@link unchangedServices}). A deploy that migrates (`preDeployCommand`
 *    hooks or `migrations: breaking`) still stops every application service.
 * 3. Pre-deploy hooks (the migrations). From the moment a `preDeployCommand`
 *    starts the schema may have changed, so the deploy is past the point of no
 *    return, as it is when the environment declares `migrations: breaking`.
 * 4. `up -d`, then the health gate.
 * 5. A failure before step 3 restores `previous/` and starts the old version
 *    again (`rolled_back`). A failure after it stops where it is
 *    (`needs_attention`): old code is never started on a changed schema. A
 *    rollback that itself fails, or has nothing to restore, is also
 *    `needs_attention`.
 *
 * The failure is reported as an error whose message starts with the outcome
 * (`rolled_back: ...` / `needs_attention: ...`); that prefix is the contract
 * the control plane parses, since the command outcome carries only a string.
 */

import { forEachSequential } from "../util/sequential.ts";
import type { HealthGateResult } from "./health-gate.ts";

export type SequentialOutcome = "rolled_back" | "needs_attention";

/** A sequential deploy that did not finish; `outcome` says what state it left. */
export class SequentialDeployError extends Error {
  readonly outcome: SequentialOutcome;
  readonly reason: string;
  constructor(outcome: SequentialOutcome, reason: string) {
    super(`${outcome}: ${reason}`);
    this.name = "SequentialDeployError";
    this.outcome = outcome;
    this.reason = reason;
  }
}

type DockerResult = { success: boolean; stderr: string };

export type SequentialDeploySteps = {
  /** Networks, build and pull. Throws a plain error when the deploy cannot start. */
  prepare: () => Promise<void>;
  /** `docker compose …` argv (without the leading `docker`), buffered. */
  run: (args: string[]) => Promise<DockerResult & { stdout: string }>;
  /** Same, streamed into the deploy log. */
  runStreamed: (args: string[]) => Promise<DockerResult>;
  /** Run the pre-deploy hooks; throws when one fails. */
  runPreDeployHooks: () => Promise<void>;
  /** Poll the project until healthy. */
  gate: (composePaths: readonly string[]) => Promise<HealthGateResult>;
  /** Restore `previous/` as the live deployment; `null` when it is missing. */
  restorePrevious: () => Promise<string[] | null>;
  /**
   * Called once `prepare` is done and before anything is stopped: the point of
   * no return for a cancel. Throws when a cancel already landed, in which case
   * nothing has been stopped and the old version is still serving.
   */
  commit?: () => void;
  /** Compose argv prefix (`compose -p <project> -f …`) for a chain. */
  composeArgs: (composePaths: readonly string[]) => string[];
  /** Redact secrets from text before it reaches a summary or log. */
  redact: (text: string) => string;
  log: (line: string) => void;
  setPhase: (phase: "build" | "pre-deploy" | "compose-up" | "health") => void;
};

export type SequentialDeployInput = {
  /** Live compose chain of this deploy (already published). */
  composePaths: readonly string[];
  /** Compose chain of the deploy being replaced, or `null` on a first deploy. */
  previousComposePaths: readonly string[] | null;
  /** Compose services that keep running while the application is stopped. */
  keepRunning: readonly string[];
  /** The deploy has hooks to run before `up` (pre-deploy commands or builds). */
  hasHooks: boolean;
  /** At least one hook runs a `preDeployCommand`, i.e. may migrate. */
  hooksMigrate: boolean;
  /** The environment declares a breaking migration for this deploy. */
  breakingMigration: boolean;
  /**
   * Per compose service, when its generated secret or config files last
   * changed (ms). Compose's config hash does not cover file contents, so a
   * service whose containers started before that moment is stopped.
   */
  fileTimes?: ReadonlyMap<string, number>;
  steps: SequentialDeploySteps;
};

function fail(outcome: SequentialOutcome, reason: string): never {
  throw new SequentialDeployError(outcome, reason);
}

/** `service hash` lines of `docker compose config --hash "*"`; `null` when unreadable. */
async function configHashes(
  input: SequentialDeployInput,
): Promise<Map<string, string> | null> {
  const { steps } = input;
  const result = await steps.run([
    ...steps.composeArgs(input.composePaths),
    "config",
    "--hash",
    "*",
  ]);
  if (!result.success) return null;
  const hashes = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2) hashes.set(parts[0], parts[1]);
  }
  return hashes;
}

const INSPECT_FORMAT =
  '{{index .Config.Labels "com.docker.compose.config-hash"}} {{.Image}} {{.Config.Image}} {{.State.StartedAt}}';

/**
 * Whether every running container of the service already matches this deploy:
 * the config hash Compose stamped on it equals the new one (what Compose
 * itself checks before it recreates), it still runs the image its reference
 * resolves to now, and it started after its generated files last changed.
 * Anything missing or unreadable answers `false`.
 */
async function containersMatch(
  input: SequentialDeployInput,
  service: string,
  hash: string,
): Promise<boolean> {
  const { steps } = input;
  const ids = await steps.run([
    ...steps.composeArgs(input.composePaths),
    "ps",
    "-a",
    "-q",
    service,
  ]);
  const containers = ids.stdout.split("\n").map((id) => id.trim()).filter(
    Boolean,
  );
  if (!ids.success || containers.length === 0) return false;
  const used = await steps.run([
    "inspect",
    "--format",
    INSPECT_FORMAT,
    ...containers,
  ]);
  const lines = used.stdout.split("\n").filter((line) => line.trim() !== "");
  if (!used.success || lines.length !== containers.length) return false;
  const filesAt = input.fileTimes?.get(service) ?? 0;
  let match = true;
  await forEachSequential(lines, async (line) => {
    if (!match) return;
    const [labelHash, imageId, reference, startedAt] = line.trim().split(
      /\s+/,
    );
    const started = Date.parse(startedAt ?? "");
    if (
      labelHash !== hash || !imageId || !reference || Number.isNaN(started) ||
      started < filesAt
    ) {
      match = false;
      return;
    }
    const resolved = await steps.run([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      reference,
    ]);
    if (!resolved.success || resolved.stdout.trim() !== imageId) match = false;
  });
  return match;
}

/**
 * Services this deploy leaves exactly as they are. Compose recreates a
 * container whose stamped config hash differs from the service's new one, so
 * those are the changed ones (an env value, tag or compose entry that moved).
 * On top of that a service counts as changed when its image was re-pulled or
 * a generated secret or config file changed after its containers started.
 * Anything that cannot be compared is treated as changed and stopped. Changes
 * to top-level networks or volumes are not seen here: they are left to
 * Compose, as before.
 */
export async function unchangedServices(
  input: SequentialDeployInput,
  candidates: readonly string[],
): Promise<Set<string>> {
  const hashes = await configHashes(input);
  const same = new Set<string>();
  if (hashes === null) return same;
  await forEachSequential(candidates, async (name) => {
    const hash = hashes.get(name);
    if (hash !== undefined && await containersMatch(input, name, hash)) {
      same.add(name);
    }
  });
  return same;
}

/** Services to stop: those the previous compose defines, minus the kept and unchanged ones. */
async function servicesToStop(
  input: SequentialDeployInput,
  previous: readonly string[],
): Promise<string[]> {
  const { steps } = input;
  const listed = await steps.run([
    ...steps.composeArgs(previous),
    "config",
    "--services",
  ]);
  if (!listed.success) {
    throw new Error(
      steps.redact(listed.stderr) || "could not list the running services",
    );
  }
  const keep = new Set(input.keepRunning);
  const candidates = listed.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !keep.has(name));
  // A migration locks tables its services use: stop them all, as ever.
  const migrates = input.hooksMigrate || input.breakingMigration;
  const unchanged = migrates
    ? new Set<string>()
    : await unchangedServices(input, candidates);
  if (unchanged.size > 0) {
    steps.log(
      `leaving unchanged services running (${[...unchanged].join(", ")})`,
    );
  }
  return candidates.filter((name) => !unchanged.has(name));
}

async function stopPrevious(input: SequentialDeployInput): Promise<void> {
  const { steps, previousComposePaths: previous } = input;
  if (previous === null) return;
  const names = await servicesToStop(input, previous);
  if (names.length === 0) return;
  steps.log(`stopping the previous version (${names.join(", ")})`);
  const stop = await steps.runStreamed([
    ...steps.composeArgs(previous),
    "stop",
    ...names,
  ]);
  if (!stop.success) {
    throw new Error(steps.redact(stop.stderr) || "docker compose stop failed");
  }
}

async function startAndGate(
  steps: SequentialDeploySteps,
  composePaths: readonly string[],
): Promise<string | null> {
  steps.setPhase("compose-up");
  const up = await steps.runStreamed([
    ...steps.composeArgs(composePaths),
    "up",
    "-d",
    "--remove-orphans",
  ]);
  if (!up.success) {
    return steps.redact(up.stderr) || "docker compose up failed";
  }
  steps.setPhase("health");
  const gate = await steps.gate(composePaths);
  return gate.ok ? null : steps.redact(gate.detail);
}

function errorReason(err: unknown, steps: SequentialDeploySteps): string {
  const text = err instanceof Error ? err.message : "unexpected failure";
  return steps.redact(text);
}

/**
 * Bring the previous version back. Only reached while no migration has run.
 * Always throws: `rolled_back` when the old version is serving again,
 * `needs_attention` when it could not be restored or did not come up.
 */
async function rollBack(
  input: SequentialDeployInput,
  reason: string,
): Promise<never> {
  const { steps } = input;
  if (input.previousComposePaths === null) {
    // A first deploy has nothing to go back to and nothing was stopped.
    throw new Error(`${reason} (first deploy: nothing to roll back to)`);
  }
  steps.log(`rolling back: ${reason}`);
  let restored: string[] | null;
  try {
    restored = await steps.restorePrevious();
  } catch (err) {
    return fail(
      "needs_attention",
      `${reason}; restoring the previous version failed: ${
        errorReason(err, steps)
      }`,
    );
  }
  if (restored === null) {
    return fail(
      "needs_attention",
      `${reason}; the previous version's files are missing, so it was not restarted`,
    );
  }
  const failure = await startAndGate(steps, restored);
  if (failure !== null) {
    return fail(
      "needs_attention",
      `${reason}; the previous version did not come back healthy: ${failure}`,
    );
  }
  return fail(
    "rolled_back",
    `${reason}; the previous version is running again`,
  );
}

function afterMigration(reason: string): never {
  return fail(
    "needs_attention",
    `${reason}; a migration already ran, so the previous version was not restarted`,
  );
}

/** Run the pre-deploy hooks; the failure text, or `null` when they all passed. */
async function runHooks(input: SequentialDeployInput): Promise<string | null> {
  const { steps } = input;
  steps.setPhase("pre-deploy");
  try {
    await steps.runPreDeployHooks();
    return null;
  } catch (err) {
    return `the pre-deploy step failed: ${errorReason(err, steps)}`;
  }
}

/**
 * Run the whole sequence. Resolves when the new version is healthy; otherwise
 * throws a plain `Error` (nothing changed or a first deploy) or a
 * {@link SequentialDeployError}.
 */
export async function runSequentialDeploy(
  input: SequentialDeployInput,
): Promise<void> {
  const { steps } = input;
  steps.setPhase("build");
  await steps.prepare();
  steps.commit?.();

  try {
    await stopPrevious(input);
  } catch (err) {
    return await rollBack(input, errorReason(err, steps));
  }

  // Past the point of no return once a migration may have run: a command in a
  // pre-deploy hook (even one that then failed) or a declared breaking one.
  const migrated = input.hooksMigrate || input.breakingMigration;
  if (input.hasHooks) {
    const hookFailure = await runHooks(input);
    if (hookFailure !== null) {
      return input.hooksMigrate
        ? afterMigration(hookFailure)
        : await rollBack(input, hookFailure);
    }
  }

  const failure = await startAndGate(steps, input.composePaths);
  if (failure === null) return;
  if (migrated) afterMigration(failure);
  return await rollBack(input, failure);
}
