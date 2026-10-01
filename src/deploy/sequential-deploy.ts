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
 * 2. Stop the application services of the previous deploy. Services named in
 *    `keepRunning` (databases and other stateful services) stay up so
 *    migrations have something to talk to.
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
  steps: SequentialDeploySteps;
};

function fail(outcome: SequentialOutcome, reason: string): never {
  throw new SequentialDeployError(outcome, reason);
}

/** Services to stop: those the previous compose defines, minus the kept ones. */
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
  return listed.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !keep.has(name));
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
  const text = err instanceof Error ? err.message : String(err);
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
