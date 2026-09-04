/**
 * Pure renderers for the native-app systemd units and per-principal slices.
 *
 * Nothing here touches the host: `apply-native-apps.ts` owns every write, and
 * keeps the same "render candidate → diff → install only when the bytes changed
 * → reload only what changed" discipline the site vhost path uses.
 * Keeping the rendering pure is what makes that discipline testable — a promote
 * that only moved `current` must produce byte-identical unit text, because
 * `WorkingDirectory` points at the stable `current` symlink rather than at a
 * release directory.
 */

import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  principalHomePath,
  siteCurrentSymlink,
  siteSharedDir,
} from "../../paths/layout.ts";
import {
  resolveNativeAppRuntimeStartCommand,
} from "../node-package-manager.ts";
import { principalUnixGroupName } from "../ensure-principal.ts";
import { runtimeGroup } from "../../runtime/registry.ts";
import type {
  EnvironmentDeployNativeAppRestartPolicy,
  EnvironmentDeployNativeAppService,
} from "../../instance/commands/contracts.ts";

/**
 * Unit-name prefix. Follows the existing `turbopanel-*` convention
 * (`turbopanel-nginx`, `turbopanel-apache`, …) so a generated tenant unit can
 * never collide with a distro unit, and so `systemctl list-units 'turbopanel-*'`
 * still shows the whole platform.
 */
export const NATIVE_APP_UNIT_PREFIX = "turbopanel-app-";

/**
 * Real systemd unit directory — units are installed here through `sudo`.
 *
 * Every path helper takes it as a defaulted argument rather than hard-coding
 * it, so host-free tests can install into a temp tree without an env override
 * that would also exist in production.
 */
export const SYSTEMD_UNIT_DIR = "/etc/systemd/system";

/** Daemon-owned staging directory for rendered candidates. */
export const NATIVE_APP_CONFIG_DIRNAME = "node-apps";

/**
 * Node series a native app runs on when the payload declared no `nodeVersion`.
 *
 * A **series**, not a patch pin, for the same reason the wire contract accepts
 * one: the daemon does not choose which patch release a tenant gets, the
 * vendoring role resolves the newest release inside the series and moves the
 * per-series `current` symlink at it. Declaring a patch here would make every
 * upstream security release a daemon change.
 */
export const DEFAULT_NATIVE_APP_NODE_VERSION = "24";

/**
 * Root of the **tenant** Node tree, kept apart from the instance's own Node.
 *
 * `vendor/node/current` is the panel's own toolchain (the `node-runtime`
 * Ansible role); tenants get `vendor/node-app/` so bumping what tenants execute
 * can never move the panel's Node, and a panel upgrade can never silently
 * restart every tenant app on a new runtime. Inside it the layout is the
 * planned per-version one — `<series>/current` — so two apps pinning different
 * series resolve to genuinely different binaries.
 */
export function nativeAppRuntimeRoot(
  layout: Pick<LayoutPaths, "runtimesDir">,
): string {
  return join(layout.runtimesDir, "node-app");
}

/**
 * Unix group that grants read + traverse on one vendored tenant Node series.
 *
 * Per **series** (`tpnode24`), not one group for the whole tree: a group here
 * means "may execute this runtime series", and the series is what the operator
 * grants. `<vendor>/node-app/<series>/` is `root:<group> 0750`, and
 * `/opt/turbopanel` + `vendor/` stay `tp:tp 0750` with traverse-only ACLs, so a
 * principal can reach its own series without listing either parent or seeing
 * another series it was not granted.
 *
 * Membership is reconciled by `ensurePrincipalManagedGroups` during principal
 * materialization — which runs before any unit is installed, because systemd
 * resolves supplementary groups at `execve` and a unit started too early dies
 * `203/EXEC`.
 */
export function nativeAppRuntimeGroup(nodeVersion: string): string | undefined {
  return runtimeGroup("node", nodeVersion);
}

/** The series one app runs on: its own pin, else {@link DEFAULT_NATIVE_APP_NODE_VERSION}. */
export function resolveNativeAppNodeVersion(
  app: Pick<EnvironmentDeployNativeAppService, "nodeVersion">,
): string {
  const declared = app.nodeVersion?.trim();
  return declared && declared.length > 0
    ? declared
    : DEFAULT_NATIVE_APP_NODE_VERSION;
}

/**
 * `<runtimesDir>/node-app/<series>/current/bin/node`.
 *
 * The `current` segment is per **series**, so the unit text stays byte-identical
 * across patch bumps of that series — the same reason `WorkingDirectory` points
 * at the release `current` symlink rather than a release directory.
 */
export function nativeAppNodeBinary(
  layout: Pick<LayoutPaths, "runtimesDir">,
  nodeVersion: string = DEFAULT_NATIVE_APP_NODE_VERSION,
): string {
  return join(nativeAppNodeBinDir(layout, nodeVersion), "node");
}

/** `<runtimesDir>/node-app/<series>/current/bin` — leads native-app unit `PATH`. */
export function nativeAppNodeBinDir(
  layout: Pick<LayoutPaths, "runtimesDir">,
  nodeVersion: string = DEFAULT_NATIVE_APP_NODE_VERSION,
): string {
  return join(
    nativeAppRuntimeRoot(layout),
    nodeVersion,
    "current",
    "bin",
  );
}

const NATIVE_RUNTIME_PATH_TAIL = "/usr/bin:/bin";

/** `/etc/systemd/system/turbopanel-app-<serviceId>.service`. */
export function nativeAppUnitName(serviceId: string): string {
  return `${NATIVE_APP_UNIT_PREFIX}${serviceId}.service`;
}

export function nativeAppUnitPath(
  serviceId: string,
  unitDir: string = SYSTEMD_UNIT_DIR,
): string {
  return join(unitDir, nativeAppUnitName(serviceId));
}

/** `turbopanel-<username>.slice` — one parent slice per tenant account. */
export function principalSliceName(username: string): string {
  return `turbopanel-${username}.slice`;
}

export function principalSlicePath(
  username: string,
  unitDir: string = SYSTEMD_UNIT_DIR,
): string {
  return join(unitDir, principalSliceName(username));
}

/**
 * Staged candidate paths under `<configDir>/node-apps/`.
 *
 * The staged name carries the environment id (`tp-<environmentId>-…`) for the
 * same reason site files do: the directory listing *is* the
 * per-environment index, so `environment.lifecycle` and `environment.stop` can
 * find this environment's units without a second bookkeeping file that could
 * drift from reality.
 */
export function nativeAppConfigDir(
  layout: Pick<LayoutPaths, "configDir">,
): string {
  return join(layout.configDir, NATIVE_APP_CONFIG_DIRNAME);
}

export function nativeAppStagedFilePrefix(environmentId: string): string {
  return `tp-${environmentId}-`;
}

export function nativeAppStagedPath(
  layout: Pick<LayoutPaths, "configDir">,
  environmentId: string,
  serviceId: string,
): string {
  return join(
    nativeAppConfigDir(layout),
    `${nativeAppStagedFilePrefix(environmentId)}${serviceId}.service`,
  );
}

export function principalSliceStagedPath(
  layout: Pick<LayoutPaths, "configDir">,
  username: string,
): string {
  return join(nativeAppConfigDir(layout), `slice-${username}.slice`);
}

/**
 * Default entrypoint, relative to the release root.
 *
 * One value for every runtime family on purpose: a Next.js standalone build is
 * *staged so that* its `server.js` lands at the release root (see
 * `../release/build.ts`), which is exactly where a plain Node app's `server.js`
 * already is. An operator who needs anything else sets
 * `x-turbopanel.source.startCommand`.
 */
export const DEFAULT_START_SCRIPT = "server.js";

/**
 * Resolve the `ExecStart` line.
 *
 * An explicit `startCommand` is run through `/bin/sh -c` so an operator can
 * write the same string they would type in a shell (`node dist/main.js --flag`);
 * the default path execs the vendored Node directly, with no shell in between.
 */
export function resolveExecStart(params: {
  nodeBinary: string;
  startCommand?: string;
  /** Replaces {@link DEFAULT_START_SCRIPT}; an explicit `startCommand` wins. */
  startupFile?: string;
}): string {
  if (params.startCommand && params.startCommand.trim().length > 0) {
    const command = resolveNativeAppRuntimeStartCommand(
      params.startCommand.trim(),
      params.nodeBinary,
    );
    return `/bin/sh -c ${quoteSystemdArgument(command)}`;
  }
  const script = params.startupFile?.trim() || DEFAULT_START_SCRIPT;
  return `${params.nodeBinary} ${script}`;
}

/** systemd's escape for a `'` embedded in a single-quoted argument. */
const SYSTEMD_ESCAPED_QUOTE = String.raw`'\''`;

/**
 * systemd's own quoting: single quotes, with an embedded `'` written as
 * `'\''`. Used only for the `sh -c` payload — every other field this module
 * emits is a path or a number validated upstream.
 */
export function quoteSystemdArgument(value: string): string {
  return `'${value.replaceAll("'", SYSTEMD_ESCAPED_QUOTE)}'`;
}

/** `CPUQuota=` wants a percentage: 1.5 CPUs → `150%`. */
export function formatCpuQuota(cpus: number): string {
  return `${Math.max(1, Math.round(cpus * 100))}%`;
}

/** systemd accepts a plain byte count for `MemoryMax=` / `MemoryHigh=`. */
export function formatMemoryBytes(bytes: number): string {
  return String(Math.max(1, Math.round(bytes)));
}

/**
 * What the unit says about supervision when the document said nothing.
 *
 * `on-failure` with a two-second backoff is the behaviour every native app has
 * had since the lane existed, so an absent `restart_policy` has to keep
 * producing exactly these two lines — otherwise adding the field would rewrite
 * every existing unit and restart every tenant app on the next deploy.
 */
export const DEFAULT_NATIVE_APP_RESTART = "on-failure";
export const DEFAULT_NATIVE_APP_RESTART_SEC = "2";

/**
 * Compose `restart_policy.condition` → systemd `Restart=`.
 *
 * The one place the two vocabularies meet. `any` is systemd's `always` (restart
 * whatever the exit status), `none` is `no`, and `on-failure` happens to spell
 * the same in both — which is exactly why the mapping is written out rather
 * than assumed: two of the three names differ, and a passthrough would silently
 * emit `Restart=any`, a directive systemd rejects.
 */
export function systemdRestartDirective(
  condition: NonNullable<
    EnvironmentDeployNativeAppRestartPolicy["condition"]
  >,
): string {
  if (condition === "none") return "no";
  if (condition === "any") return "always";
  return "on-failure";
}

/**
 * `[Service]` supervision lines for one app.
 *
 * `delay` and `window` ride the wire in the Compose spelling (`5s`, `1m30s`),
 * which is also a valid systemd time span, so they are emitted as written —
 * `parseNativeAppRestartPolicy` in the command contract is what guarantees the
 * shape, and re-normalizing here would only give the two sides a way to
 * disagree.
 */
function restartLines(
  policy: EnvironmentDeployNativeAppRestartPolicy | undefined,
): string[] {
  const condition = policy?.condition;
  const lines = [
    `Restart=${
      condition === undefined
        ? DEFAULT_NATIVE_APP_RESTART
        : systemdRestartDirective(condition)
    }`,
    `RestartSec=${policy?.delay ?? DEFAULT_NATIVE_APP_RESTART_SEC}`,
  ];
  return lines;
}

/**
 * `[Unit]` rate-limit lines for one app.
 *
 * `StartLimitBurst` / `StartLimitIntervalSec` are `[Unit]` directives even
 * though they govern restarts, so they cannot be emitted beside `Restart=`.
 */
function startLimitLines(
  policy: EnvironmentDeployNativeAppRestartPolicy | undefined,
): string[] {
  const lines: string[] = [];
  if (policy?.maxAttempts !== undefined) {
    lines.push(
      `StartLimitBurst=${Math.max(1, Math.round(policy.maxAttempts))}`,
    );
  }
  if (policy?.window !== undefined) {
    lines.push(`StartLimitIntervalSec=${policy.window}`);
  }
  return lines;
}

/**
 * Authored `deploy.labels`, recorded on the unit as one `X-TurboPanel-Labels`
 * line.
 *
 * Service metadata carries no behaviour, so the only thing that matters is that
 * it survives the trip and can be read back: `systemctl show -p ...` on the
 * native lane answers what `docker inspect` answers on the container one. One
 * JSON object rather than a directive per label because a Compose label key is
 * free-form (`com.example.team`) while a systemd directive name is not, and
 * because `JSON.stringify` escapes every control character — a label value
 * containing a newline cannot break out into a directive of its own.
 *
 * Keys are sorted so the rendered text is a function of the label set alone;
 * the whole install path is a byte-diff, and a mapping that reordered itself
 * would rewrite and reload units that did not change.
 */
export function serviceLabelsLine(
  labels: Record<string, string> | undefined,
): string | null {
  if (!labels) return null;
  const keys = Object.keys(labels).sort((a, b) => {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  });
  if (keys.length === 0) return null;
  const ordered: Record<string, string> = {};
  for (const key of keys) ordered[key] = labels[key];
  return `X-TurboPanel-Labels=${JSON.stringify(ordered)}`;
}

export type NativeAppUnitOpts = {
  layout: Pick<LayoutPaths, "runtimesDir" | "principalHomeRoot">;
  app: EnvironmentDeployNativeAppService;
  username: string;
  environmentId: string;
  /** Resolved from `sourceMaterial[].build.startCommand`, when the author set one. */
  startCommand?: string;
};

/**
 * Render one app unit.
 *
 * The hardening set is the point of running containerless: the process gets no
 * new privileges, a private `/tmp`, a read-only system tree, no kernel tunables
 * or modules, no cgroup writes, no setuid/setgid bits, and an **empty**
 * capability bounding set. The only writable path handed back is the site's
 * `shared/` directory — the release tree itself is root-owned `0550`, so the app
 * cannot rewrite the code it is running even if it is compromised.
 *
 * `WorkingDirectory` is the `current` symlink, never a release directory: that
 * is what keeps this text byte-identical across promotes, so a deploy that only
 * moved `current` performs no install, no `daemon-reload`, and no unit rewrite —
 * only a restart.
 *
 * Supervision comes from the authored `deploy.restart_policy` when the payload
 * carries one, translated here and nowhere else ({@link restartLines},
 * {@link startLimitLines}); a payload without one renders the historical
 * `Restart=on-failure` / `RestartSec=2` verbatim, so adding the field rewrote
 * no existing unit. Authored `deploy.labels` are recorded as a single
 * `X-TurboPanel-Labels` line ({@link serviceLabelsLine}) — metadata a
 * `systemctl show` can answer with, never behaviour.
 */
export function nativeAppUnitContent(opts: NativeAppUnitOpts): string {
  const { app, username } = opts;
  const home = principalHomePath(opts.layout, username);
  const workingDir = siteCurrentSymlink(home, app.serviceId);
  const sharedDir = siteSharedDir(home, app.serviceId);
  const group = principalUnixGroupName(username);
  const nodeVersion = resolveNativeAppNodeVersion(app);
  const nodeBinDir = nativeAppNodeBinDir(opts.layout, nodeVersion);
  const execStart = resolveExecStart({
    nodeBinary: nativeAppNodeBinary(opts.layout, nodeVersion),
    ...(opts.startCommand === undefined
      ? {}
      : { startCommand: opts.startCommand }),
    ...(app.startupFile === undefined ? {} : { startupFile: app.startupFile }),
  });

  const labelsLine = serviceLabelsLine(app.serviceLabels);

  const lines = [
    "# Managed by TurboPanel — regenerated on deploy; edits are overwritten.",
    "[Unit]",
    `Description=TurboPanel app ${app.composeServiceName} (${app.serviceId})`,
    `X-TurboPanel-Environment=${opts.environmentId}`,
    ...(labelsLine === null ? [] : [labelsLine]),
    "After=network-online.target",
    "Wants=network-online.target",
    // `StartLimitBurst` / `StartLimitIntervalSec` govern restarts but are
    // `[Unit]` directives, so the retry budget lands here while `Restart=` and
    // `RestartSec=` land below.
    ...startLimitLines(app.restartPolicy),
    "",
    "[Service]",
    "Type=simple",
    `User=${username}`,
    `Group=${group}`,
    `Slice=${principalSliceName(username)}`,
    `WorkingDirectory=${workingDir}`,
    `Environment=PATH=${nodeBinDir}:${NATIVE_RUNTIME_PATH_TAIL}`,
    `Environment=NODE_ENV=${app.appMode ?? "production"}`,
    `Environment=PORT=${app.listenPort}`,
    `Environment=HOST=127.0.0.1`,
    `Environment=HOME=${home}`,
    // Writable under ReadWritePaths=shared — Corepack falls back here when a
    // custom start command still invokes pnpm/yarn at runtime.
    `Environment=XDG_CACHE_HOME=${sharedDir}/.cache`,
    `Environment=COREPACK_HOME=${sharedDir}/.corepack`,
    `Environment=COREPACK_ENABLE_DOWNLOAD_PROMPT=0`,
    `ExecStart=${execStart}`,
    ...restartLines(app.restartPolicy),
    // Hardening. Containerless is not container isolation; this is the set that
    // makes the difference honest rather than nominal.
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictSUIDSGID=yes",
    "RestrictRealtime=yes",
    "LockPersonality=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    `ReadWritePaths=${sharedDir}`,
  ];

  if (app.resources?.cpus !== undefined) {
    lines.push(`CPUQuota=${formatCpuQuota(app.resources.cpus)}`);
  }
  if (app.resources?.memoryBytes !== undefined) {
    lines.push(`MemoryMax=${formatMemoryBytes(app.resources.memoryBytes)}`);
  }

  lines.push(
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  );
  return lines.join("\n");
}

export type PrincipalSliceOpts = {
  username: string;
  limits?: EnvironmentDeployNativeAppService["accountLimits"];
};

/**
 * Render the per-principal parent slice.
 *
 * Every app unit of an account sets `Slice=` to this one, so the account total
 * is enforced above the per-app quotas rather than beside them: three apps at
 * `CPUQuota=200%` each still cannot exceed the account's own `CPUQuota`.
 *
 * A slice with no limits is still written — it is the grouping every unit
 * references, and `systemd-cgls` showing one tenant's processes together is
 * worth the file on its own.
 */
export function principalSliceContent(opts: PrincipalSliceOpts): string {
  const lines = [
    "# Managed by TurboPanel — regenerated on deploy; edits are overwritten.",
    "[Unit]",
    `Description=TurboPanel tenant slice for ${opts.username}`,
    "Before=slices.target",
    "",
    "[Slice]",
  ];
  if (opts.limits?.cpus !== undefined) {
    lines.push(`CPUQuota=${formatCpuQuota(opts.limits.cpus)}`);
  }
  if (opts.limits?.memoryBytes !== undefined) {
    lines.push(
      `MemoryHigh=${formatMemoryBytes(opts.limits.memoryBytes)}`,
      `MemoryMax=${formatMemoryBytes(opts.limits.memoryBytes)}`,
    );
  }
  if (opts.limits?.tasksMax !== undefined) {
    lines.push(`TasksMax=${Math.max(1, Math.round(opts.limits.tasksMax))}`);
  }
  lines.push("");
  return lines.join("\n");
}
