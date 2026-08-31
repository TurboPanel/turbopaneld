/**
 * Supervise native (`serviceKind: node`) apps with generated systemd units.
 *
 * The shape is deliberately the site one (`../site.ts`):
 * an injectable IO seam so the whole path is testable without a host, render a
 * candidate, compare it against what is installed through a privileged `cmp`,
 * install **only** when the bytes differ, and `daemon-reload` only when a file
 * actually changed. An ordinary redeploy that moves nothing but the `current`
 * symlink therefore writes nothing and reloads nothing — it restarts the unit
 * so the new release is picked up, and that is all.
 *
 * Sequencing per apply, after `applySourceReleases` has resolved `current`:
 *
 * 1. install/refresh every principal's parent slice (only the changed ones);
 * 2. install/refresh every app unit (only the changed ones);
 * 3. `systemctl daemon-reload` — **once**, after every file is on disk, and
 *    only when at least one slice or unit actually changed;
 * 4. per app: `enable --now` (first deploy) / `restart` (release moved);
 * 5. per app: probe `127.0.0.1:<listenPort>` until it answers;
 * 6. on probe failure, repoint `current` back at the previous release and
 *    restart, then fail the command.
 *
 * Steps 1–3 are strictly ordered against each other: writing files first and
 * reloading once afterwards is the only sequence in which systemd is guaranteed
 * to have read *every* file this apply changed. A reload issued the moment a
 * slice changed would happen before the units were installed, and the `restart`
 * in step 4 would then start the app from the unit contents systemd loaded
 * *before* this deploy rewrote them.
 *
 * The rollback is the reason step 6 exists at all: `promoteRelease` already
 * guarantees a failed *build* leaves `current` untouched, but a release that
 * builds and promotes cleanly can still fail to *start*, and leaving a wedged
 * `current` behind would be a silent outage.
 */

import { join } from "@std/path";
import { logInfo, logWarn } from "../../logger.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { runLocalPlaybook } from "../../orchestration/ansible.ts";
import {
  NODE_APP_RUNTIME_APPLY_PLAYBOOK,
  ORCHESTRATION_DIR,
} from "../../orchestration/paths.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPayload,
} from "../../instance/commands/contracts.ts";
import { resolveReleasePaths } from "../release/release-layout.ts";
import type { ReleaseOutputHandler } from "../release/checkout.ts";
import { swapCurrentSymlink } from "../release/promote.ts";
import type { RunFn, RunResult } from "../ensure-principal.ts";
import {
  nativeAppConfigDir,
  nativeAppStagedFilePrefix,
  nativeAppStagedPath,
  nativeAppUnitContent,
  nativeAppUnitName,
  nativeAppUnitPath,
  principalSliceContent,
  principalSlicePath,
  principalSliceStagedPath,
  resolveNativeAppNodeVersion,
  SYSTEMD_UNIT_DIR,
} from "./unit.ts";

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;

/** How long a freshly started app has to answer on its loopback port. */
export const NATIVE_APP_HEALTH_TIMEOUT_MS = 30_000;
const NATIVE_APP_HEALTH_INTERVAL_MS = 500;
/** Per-attempt cap so one hung socket cannot eat the whole health budget. */
const NATIVE_APP_HEALTH_ATTEMPT_MS = 3_000;
/** Journal lines copied into the deploy transcript on a failed health probe. */
const NATIVE_APP_JOURNAL_TAIL = 80;

/** Injectable host command runner — the single privileged seam. */
export type NativeAppRunFn = RunFn;

/** Injectable Ansible runner (vendors the tenant Node release). */
export type NativeAppPlaybookFn = (
  playbookPath: string,
  label: string,
  extraArgs?: string[],
) => Promise<void>;

/** Injectable loopback probe — resolves true once the app answers. */
export type NativeAppProbeFn = (port: number) => Promise<boolean>;

/** Injectable clock/sleep so tests never wait on a real backoff. */
export type NativeAppSleepFn = (ms: number) => Promise<void>;

/**
 * The Git release tree one native app runs out of, resolved by the caller from
 * `sourceMaterial[]` — the same binding shape site uses, so this
 * module never re-derives the compose-service → principal mapping.
 */
export type NativeAppRelease = {
  username: string;
  /** Release `current` pointed at before this deploy, for rollback. */
  previousReleaseId?: string | null;
  /** `x-turbopanel.source.startCommand`, when the author declared one. */
  startCommand?: string;
};

export type NativeAppBindings = ReadonlyMap<string, NativeAppRelease>;

export type ApplyNativeAppsOpts = {
  /** Compose service name → release tree + start command. */
  bindings: NativeAppBindings;
  /** Test seam: privileged host command runner. */
  run?: NativeAppRunFn;
  /** Test seam: Ansible playbook runner (vendor tenant Node). */
  runPlaybook?: NativeAppPlaybookFn;
  /** Test seam: loopback health probe. */
  probe?: NativeAppProbeFn;
  /** Test seam: sleep between probe attempts. */
  sleep?: NativeAppSleepFn;
  /** Test seam: systemd unit directory (defaults to `/etc/systemd/system`). */
  systemdUnitDir?: string;
  /**
   * Deploy transcript. Native start / health / unit journal ride this the
   * same way fetch and build do — without it, a failed probe is only an
   * error summary and the operator never sees why the process exited.
   */
  onOutput?: ReleaseOutputHandler;
};

const decoder = new TextDecoder();

async function runDefault(command: string, args: string[]): Promise<RunResult> {
  const result = await new Deno.Command(command, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout).trim(),
    stderr: decoder.decode(result.stderr).trim(),
  };
}

/**
 * Same "missing playbook is not a deploy failure" rule the site
 * engine install uses: a host whose orchestration assets were not shipped is
 * assumed to have the runtime installed some other way, rather than being
 * refused a deploy it might well be able to serve.
 */
async function runPlaybookDefault(
  playbookPath: string,
  label: string,
  extraArgs: string[] = [],
): Promise<void> {
  try {
    await Deno.stat(playbookPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      logWarn(
        "deploy",
        `${label} playbook missing under ${ORCHESTRATION_DIR}; assuming the tenant Node runtime is installed`,
      );
      return;
    }
    throw err;
  }
  logInfo("deploy", `running ${label} playbook`);
  await runLocalPlaybook(playbookPath, extraArgs);
}

/**
 * Default probe: any completed HTTP response means the process is listening and
 * serving. A 404 or a 500 is still a started app — this gate is "did the
 * release come up", not "is the application logically healthy", and treating an
 * error status as a failed deploy would roll back releases that are working
 * exactly as written.
 */
async function probeDefault(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    NATIVE_APP_HEALTH_ATTEMPT_MS,
  );
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
      redirect: "manual",
    });
    // Drain so the connection is not left half-open between attempts.
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type NativeAppIo = {
  run: NativeAppRunFn;
  runPlaybook: NativeAppPlaybookFn;
  probe: NativeAppProbeFn;
  sleep: NativeAppSleepFn;
  onOutput?: ReleaseOutputHandler;
};

function resolveIo(opts?: Partial<NativeAppIo>): NativeAppIo {
  return {
    run: opts?.run ?? runDefault,
    runPlaybook: opts?.runPlaybook ?? runPlaybookDefault,
    probe: opts?.probe ?? probeDefault,
    sleep: opts?.sleep ?? sleepDefault,
    ...(opts?.onOutput === undefined ? {} : { onOutput: opts.onOutput }),
  };
}

function assertSafeId(value: string, field: string): void {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(`native app ${field} contains unsupported characters`);
  }
}

/** Best-effort unlink of a staging file; a leftover tmp is not a deploy error. */
async function removeStagedFile(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // best-effort
  }
}

/**
 * True when `installedPath` already holds exactly the staged bytes.
 *
 * Compared through the privileged runner rather than `Deno.readTextFile` for
 * the same reason the site path does it: `/etc/systemd/system` is
 * root-owned and the daemon is not root, so a direct read would fail and report
 * "changed" on every single deploy — the churn this exists to prevent. A `cmp`
 * that cannot answer reports **changed**, so the worst case is a redundant
 * install.
 */
async function installedFileMatches(
  io: NativeAppIo,
  stagedPath: string,
  installedPath: string,
): Promise<boolean> {
  const cmp = await io.run("sudo", [
    "-n",
    "cmp",
    "-s",
    "--",
    stagedPath,
    installedPath,
  ]);
  return cmp.success;
}

/**
 * Stage `contents`, diff it against the installed unit, and install only on a
 * real difference. Returns whether the installed file **changed**.
 */
async function installUnitFile(
  io: NativeAppIo,
  params: { stagedPath: string; installedPath: string; contents: string },
): Promise<boolean> {
  await Deno.writeTextFile(params.stagedPath, params.contents, { mode: 0o640 });
  if (await installedFileMatches(io, params.stagedPath, params.installedPath)) {
    return false;
  }
  const install = await io.run("sudo", [
    "-n",
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    params.stagedPath,
    params.installedPath,
  ]);
  if (!install.success) {
    throw new Error(
      install.stderr || `Failed to install unit ${params.installedPath}`,
    );
  }
  return true;
}

async function systemctl(
  io: NativeAppIo,
  args: string[],
): Promise<RunResult> {
  return await io.run("sudo", ["-n", "systemctl", ...args]);
}

/** True when the unit is currently active (a redeploy restarts, not enables). */
async function unitIsActive(io: NativeAppIo, unit: string): Promise<boolean> {
  const result = await systemctl(io, ["is-active", "--quiet", unit]);
  return result.success;
}

/** True when systemd has given up (`is-failed` exits 0). */
async function unitIsFailed(io: NativeAppIo, unit: string): Promise<boolean> {
  const result = await systemctl(io, ["is-failed", "--quiet", unit]);
  return result.success;
}

/**
 * Wait for the app to answer on its loopback port.
 *
 * Polls rather than trusting `systemctl` alone: `Type=simple` reports active
 * the moment the process is forked, long before an HTTP listener exists, so
 * "the unit started" is not evidence the release works. If systemd has already
 * given up (`is-failed`), waiting out the rest of the budget would only hide
 * the journal behind a 30s timeout.
 *
 * Bounded by a **number of attempts** rather than by wall-clock, so the
 * injected `sleep` seam fully controls how long this takes: a test with an
 * instant sleep finishes instantly instead of spinning for the real timeout.
 */
async function waitForNativeApp(
  io: NativeAppIo,
  port: number,
  unit: string,
  timeoutMs = NATIVE_APP_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  const attempts = Math.max(
    1,
    Math.ceil(timeoutMs / NATIVE_APP_HEALTH_INTERVAL_MS),
  );
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await io.probe(port)) return true;
    if (await unitIsFailed(io, unit)) return false;
    if (attempt < attempts - 1) await io.sleep(NATIVE_APP_HEALTH_INTERVAL_MS);
  }
  return false;
}

function emitOutputLines(
  onOutput: ReleaseOutputHandler | undefined,
  stream: "stdout" | "stderr",
  text: string,
): number {
  if (!onOutput) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.replaceAll("\r", "");
    if (trimmed.length === 0) continue;
    onOutput(stream, trimmed);
    count += 1;
  }
  return count;
}

/**
 * Copy the unit's recent journal into the deploy transcript.
 *
 * Captured **before** rollback restarts the previous release, so the dump is
 * the process that just failed the probe — not the one we put back.
 */
async function emitNativeAppJournal(
  io: NativeAppIo,
  unit: string,
): Promise<void> {
  const onOutput = io.onOutput;
  if (!onOutput) return;
  onOutput(
    "stderr",
    `--- ${unit} journal (last ${NATIVE_APP_JOURNAL_TAIL} lines) ---`,
  );
  const result = await io.run("sudo", [
    "-n",
    "journalctl",
    `--unit=${unit}`,
    "-n",
    String(NATIVE_APP_JOURNAL_TAIL),
    "--no-pager",
    "--output=short-iso",
  ]);
  const text = result.stdout.trim() || result.stderr.trim();
  let lineCount = 0;
  if (text.length > 0) {
    lineCount = emitOutputLines(onOutput, "stderr", text);
  }
  if (lineCount === 0) {
    onOutput("stderr", "(no journal output for this unit)");
  }
}

/**
 * Repoint `current` at the release it pointed at before this deploy and restart
 * the unit.
 *
 * Best-effort by design: the deploy is failing either way, and an error here
 * must not mask the health failure that caused it.
 */
async function rollbackNativeApp(
  io: NativeAppIo,
  layout: LayoutPaths,
  params: {
    app: EnvironmentDeployNativeAppService;
    username: string;
    previousReleaseId: string;
  },
): Promise<boolean> {
  try {
    const paths = resolveReleasePaths(layout, {
      username: params.username,
      serviceId: params.app.serviceId,
      releaseId: params.previousReleaseId,
    });
    await swapCurrentSymlink(paths);
    const restart = await systemctl(io, [
      "restart",
      nativeAppUnitName(params.app.serviceId),
    ]);
    return restart.success;
  } catch (err) {
    logWarn(
      "deploy",
      `native app rollback failed service=${params.app.serviceId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * One app whose unit file is already installed, waiting for the single
 * `daemon-reload` before it is started.
 */
type PreparedNativeApp = {
  app: EnvironmentDeployNativeAppService;
  binding: NativeAppRelease;
  unit: string;
};

/**
 * Render and install one app's unit file. **Nothing is started here** — the
 * single `daemon-reload` has to see every file this apply changed before any
 * `restart` reads a unit back, so starting is a separate pass.
 *
 * Returns whether the installed unit changed.
 */
async function installNativeAppUnit(
  io: NativeAppIo,
  layout: LayoutPaths,
  params: {
    environmentId: string;
    app: EnvironmentDeployNativeAppService;
    binding: NativeAppRelease;
    systemdUnitDir: string;
  },
): Promise<boolean> {
  const { app, binding } = params;
  return await installUnitFile(io, {
    stagedPath: nativeAppStagedPath(
      layout,
      params.environmentId,
      app.serviceId,
    ),
    installedPath: nativeAppUnitPath(app.serviceId, params.systemdUnitDir),
    contents: nativeAppUnitContent({
      layout,
      app,
      username: binding.username,
      environmentId: params.environmentId,
      ...(binding.startCommand === undefined
        ? {}
        : { startCommand: binding.startCommand }),
    }),
  });
}

/**
 * Stop and disable one prepared app the operator turned off.
 *
 * The unit file stays installed (Phase 1 already wrote it) and the release
 * stays promoted, so re-enabling is a start, not a re-render. No probe and no
 * rollback: a unit that is *supposed* to be down answering nothing is the
 * desired state, not a failed deploy. `disable --now` on an already-stopped
 * unit is a no-op, which keeps repeat deploys of a disabled app quiet.
 */
async function disableNativeApp(
  io: NativeAppIo,
  prepared: PreparedNativeApp,
): Promise<void> {
  const { app, unit } = prepared;
  io.onOutput?.(
    "stdout",
    `systemctl disable --now ${unit} (disabled by operator)`,
  );
  const result = await systemctl(io, ["disable", "--now", unit]);
  if (!result.success) {
    throw new Error(
      result.stderr || `Failed to disable native app unit ${unit}`,
    );
  }
  logInfo(
    "deploy",
    `native app disabled by operator service=${app.serviceId}`,
  );
}

/**
 * Start (or restart) one prepared app and wait for it to answer, rolling
 * `current` back when it never does.
 */
async function startNativeApp(
  io: NativeAppIo,
  layout: LayoutPaths,
  prepared: PreparedNativeApp,
): Promise<void> {
  const { app, binding, unit } = prepared;

  // `enable --now` on first deploy, `restart` afterwards: an already-enabled
  // unit re-enabled is a no-op, but an already-running one needs a restart to
  // pick up the release `current` now points at.
  const active = await unitIsActive(io, unit);
  const action = active ? "restart" : "enable --now";
  io.onOutput?.(
    "stdout",
    `systemctl ${action} ${unit} (waiting for 127.0.0.1:${app.listenPort})`,
  );
  const result = active
    ? await systemctl(io, ["restart", unit])
    : await systemctl(io, ["enable", "--now", unit]);
  if (!result.success) {
    await emitNativeAppJournal(io, unit);
    throw new Error(
      result.stderr || `Failed to start native app unit ${unit}`,
    );
  }

  if (await waitForNativeApp(io, app.listenPort, unit)) {
    io.onOutput?.(
      "stdout",
      `${app.composeServiceName} answered on 127.0.0.1:${app.listenPort}`,
    );
    return;
  }

  io.onOutput?.(
    "stderr",
    `${app.composeServiceName} did not answer on 127.0.0.1:${app.listenPort} within ${
      NATIVE_APP_HEALTH_TIMEOUT_MS / 1000
    }s`,
  );
  await emitNativeAppJournal(io, unit);

  const previous = binding.previousReleaseId;
  const rolledBack = previous
    ? await rollbackNativeApp(io, layout, {
      app,
      username: binding.username,
      previousReleaseId: previous,
    })
    : false;
  throw new Error(
    `native app ${app.composeServiceName} did not answer on 127.0.0.1:${app.listenPort} within ${
      NATIVE_APP_HEALTH_TIMEOUT_MS / 1000
    }s${
      rolledBack
        ? ` — rolled back to release ${previous}`
        : " — no previous release to roll back to"
    }`,
  );
}

/**
 * Install/refresh the per-principal slice for every account in this apply.
 * Returns true when any slice file changed.
 */
async function applyPrincipalSlices(
  io: NativeAppIo,
  layout: LayoutPaths,
  apps: readonly EnvironmentDeployNativeAppService[],
  bindings: NativeAppBindings,
  systemdUnitDir: string,
): Promise<boolean> {
  const limitsByUsername = new Map<
    string,
    EnvironmentDeployNativeAppService["accountLimits"]
  >();
  for (const app of apps) {
    const binding = bindings.get(app.composeServiceName);
    if (!binding) continue;
    // First non-empty wins: the instance repeats the same account ceiling on
    // every app of a principal, so any of them is authoritative.
    if (limitsByUsername.get(binding.username) === undefined) {
      limitsByUsername.set(binding.username, app.accountLimits);
    }
  }

  let changed = false;
  for (const [username, limits] of limitsByUsername) {
    const installed = await installUnitFile(io, {
      stagedPath: principalSliceStagedPath(layout, username),
      installedPath: principalSlicePath(username, systemdUnitDir),
      contents: principalSliceContent({
        username,
        ...(limits === undefined ? {} : { limits }),
      }),
    });
    if (installed) changed = true;
  }
  return changed;
}

/**
 * Every distinct Node series this apply needs, sorted so the playbook argument
 * is stable across deploys (an unstable argument would show up as churn in the
 * transcript for a deploy that changed nothing).
 *
 * An app with no `nodeVersion` contributes `DEFAULT_NATIVE_APP_NODE_VERSION`,
 * so the default series is vendored exactly like an explicitly pinned one
 * instead of being a separate special case on the host.
 */
export function nativeAppNodeVersions(
  apps: readonly EnvironmentDeployNativeAppService[],
): string[] {
  const versions = new Set<string>();
  for (const app of apps) versions.add(resolveNativeAppNodeVersion(app));
  return [...versions].sort((a, b) => a.localeCompare(b));
}

/**
 * Vendor the tenant Node runtimes on first use, the same way hosting Caddy and
 * the web engines are installed on demand rather than up front.
 *
 * The requested series are passed **into** the playbook rather than pinned in
 * its defaults: `nodeVersion` is a per-app contract, so two apps on different
 * series have to end up on two different vendored trees
 * (`vendor/node-app/<series>/current`) or the hint would be decorative.
 */
async function ensureNativeAppRuntime(
  io: NativeAppIo,
  apps: readonly EnvironmentDeployNativeAppService[],
): Promise<void> {
  const versions = nativeAppNodeVersions(apps);
  await io.runPlaybook(
    NODE_APP_RUNTIME_APPLY_PLAYBOOK,
    `node-app-runtime-apply (vendor tenant Node ${versions.join(", ")})`,
    ["-e", JSON.stringify({ node_app_versions: versions })],
  );
}

/**
 * Apply every native app in one deploy.
 *
 * Apps with no binding are skipped loudly rather than failed, matching the
 * release engine: without an owning principal there is no home to run out of,
 * and inventing one on the host is not this layer's call.
 */
export async function applyNativeAppServices(
  layout: LayoutPaths,
  environmentId: string,
  apps: readonly EnvironmentDeployNativeAppService[],
  opts: ApplyNativeAppsOpts,
): Promise<{ applied: string[] }> {
  if (apps.length === 0) return { applied: [] };
  assertSafeId(environmentId, "environmentId");
  for (const app of apps) {
    assertSafeId(app.serviceId, "serviceId");
  }

  const io = resolveIo(opts);
  await ensureNativeAppRuntime(io, apps);
  await Deno.mkdir(nativeAppConfigDir(layout), {
    recursive: true,
    mode: 0o750,
  });

  const systemdUnitDir = opts.systemdUnitDir ?? SYSTEMD_UNIT_DIR;

  // Phase 1 — write every changed file. `filesChanged` is latched across both
  // slices and units on purpose: a deploy that changes an account ceiling *and*
  // a unit must reload once, after both are on disk, not once per kind.
  let filesChanged = await applyPrincipalSlices(
    io,
    layout,
    apps,
    opts.bindings,
    systemdUnitDir,
  );

  const prepared: PreparedNativeApp[] = [];
  for (const app of apps) {
    const binding = opts.bindings.get(app.composeServiceName);
    if (!binding) {
      logWarn(
        "deploy",
        `native app skipped for ${app.composeServiceName}: no project principal assigned`,
      );
      continue;
    }
    const unitChanged = await installNativeAppUnit(io, layout, {
      environmentId,
      app,
      binding,
      systemdUnitDir,
    });
    if (unitChanged) filesChanged = true;
    prepared.push({
      app,
      binding,
      unit: nativeAppUnitName(app.serviceId),
    });
  }

  // Phase 2 — one `daemon-reload`, after every file is installed and before any
  // unit is started, so no `restart` below can read a stale unit definition.
  if (filesChanged) {
    const result = await systemctl(io, ["daemon-reload"]);
    if (!result.success) {
      throw new Error(result.stderr || "systemctl daemon-reload failed");
    }
  }

  // Phase 3 — start / restart and health-probe each app; an operator-disabled
  // app is stopped and disabled instead, and still counts as applied.
  const applied: string[] = [];
  for (const entry of prepared) {
    if (entry.app.enabled === false) {
      await disableNativeApp(io, entry);
    } else {
      await startNativeApp(io, layout, entry);
    }
    applied.push(entry.app.composeServiceName);
  }

  logInfo(
    "deploy",
    `native apps applied env=${environmentId} services=${
      applied.join(",") || "none"
    } daemon-reload=${filesChanged ? "yes" : "no (units unchanged)"}`,
  );
  return { applied };
}

/** Service ids this environment currently has a staged unit for. */
export async function listEnvironmentNativeAppServiceIds(
  layout: Pick<LayoutPaths, "configDir">,
  environmentId: string,
): Promise<string[]> {
  const prefix = nativeAppStagedFilePrefix(environmentId);
  const dir = nativeAppConfigDir(layout);
  const ids: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      if (!entry.name.startsWith(prefix)) continue;
      if (!entry.name.endsWith(".service")) continue;
      ids.push(entry.name.slice(prefix.length, -".service".length));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

export type NativeAppLifecycleAction = "start" | "stop" | "restart";

/**
 * Apply a non-destructive lifecycle action to this environment's app units.
 *
 * Best-effort per unit, matching `applyIngressLifecycle`: a compose lifecycle
 * command must not fail because one leftover unit refuses to stop.
 */
export async function applyNativeAppLifecycle(
  layout: Pick<LayoutPaths, "configDir">,
  environmentId: string,
  action: NativeAppLifecycleAction,
  deps?: { run?: NativeAppRunFn },
): Promise<string[]> {
  const io = resolveIo(deps);
  const serviceIds = await listEnvironmentNativeAppServiceIds(
    layout,
    environmentId,
  );
  const touched: string[] = [];
  for (const serviceId of serviceIds) {
    const unit = nativeAppUnitName(serviceId);
    const result = await systemctl(io, [action, unit]);
    if (!result.success) {
      logWarn(
        "deploy",
        `native app lifecycle ${action} failed unit=${unit}: ${result.stderr}`,
      );
      continue;
    }
    touched.push(unit);
  }
  return touched;
}

/**
 * Tear down every app unit for an environment: disable + stop, remove the unit
 * file, then one `daemon-reload`.
 *
 * The per-principal **slice** is deliberately left in place — it is shared by
 * every environment that account owns, so removing it here would drop the
 * account ceiling for apps that are still running. An unreferenced slice costs
 * nothing.
 */
export async function removeNativeAppServices(
  layout: Pick<LayoutPaths, "configDir">,
  environmentId: string,
  deps?: { run?: NativeAppRunFn; systemdUnitDir?: string },
): Promise<number> {
  const io = resolveIo(deps);
  const serviceIds = await listEnvironmentNativeAppServiceIds(
    layout,
    environmentId,
  );
  if (serviceIds.length === 0) return 0;

  let removed = 0;
  for (const serviceId of serviceIds) {
    const unit = nativeAppUnitName(serviceId);
    const disable = await systemctl(io, ["disable", "--now", unit]);
    if (!disable.success) {
      logWarn(
        "deploy",
        `native app disable failed unit=${unit}: ${disable.stderr}`,
      );
    }
    const rm = await io.run("sudo", [
      "-n",
      "rm",
      "-f",
      "--",
      nativeAppUnitPath(serviceId, deps?.systemdUnitDir),
    ]);
    if (!rm.success) {
      logWarn(
        "deploy",
        `native app unit removal failed unit=${unit}: ${rm.stderr}`,
      );
      continue;
    }
    await removeStagedFile(
      join(
        nativeAppConfigDir(layout),
        `${nativeAppStagedFilePrefix(environmentId)}${serviceId}.service`,
      ),
    );
    removed += 1;
  }

  if (removed > 0) {
    const reload = await systemctl(io, ["daemon-reload"]);
    if (!reload.success) {
      logWarn(
        "deploy",
        `systemctl daemon-reload after native app removal failed: ${reload.stderr}`,
      );
    }
  }
  return removed;
}

/**
 * Compose service name → its release tree + start command, for every native app
 * in this payload.
 *
 * Built from `sourceMaterial[]` on **every** deploy (not only when a release was
 * freshly promoted) for the same reason the site bindings are: a
 * redeploy that does not move the source still has to render a unit pointing at
 * `current`.
 */
export function nativeAppBindingsFromPayload(
  payload: EnvironmentDeployPayload,
  previousReleaseByService?: ReadonlyMap<string, string | null>,
): Map<string, NativeAppRelease> {
  const bindings = new Map<string, NativeAppRelease>();
  for (const entry of payload.sourceMaterial ?? []) {
    const principal = entry.principal;
    if (!principal) continue;
    const previous = previousReleaseByService?.get(entry.composeServiceName) ??
      null;
    bindings.set(entry.composeServiceName, {
      username: principal.username,
      previousReleaseId: previous,
      ...(entry.build.startCommand === undefined
        ? {}
        : { startCommand: entry.build.startCommand }),
    });
  }
  return bindings;
}
