#!/usr/bin/env -S deno run --allow-read
/**
 * Production layout contract check (CI guard).
 *
 * Two guarantees, both cheap enough to run on every change:
 *
 *  1. The FHS production tree resolves to the canonical absolute paths
 *     (`bin/turbopaneld`, optional `bin/turbopaneld.js`,
 *     `share/orchestration`, `share/ui`, `vendor`, `/etc/turbopanel`,
 *     `/var/lib/turbopanel`, `/var/log/turbopanel`, `/run/turbopanel`).
 *
 *  2. The daemon systemd unit template derives daemon.lock from
 *     `runtime_socket_dir` (no hardcoded `/run/turbopanel/daemon.lock`).
 *
 *  3. No production-surface file (the same curated roots as the `share/ansible`
 *     scan — `src`, `scripts`, `orchestration`, `main.ts`) hardcodes the
 *     co-located dev checkout (`/opt/turbopanel/platform`,
 *     `/opt/turbopanel/platform/daemon`) or the old `share/ansible` asset path.
 *     The centralized layout module (`src/paths/layout.ts`) defines the
 *     dev-checkout root as the *development-mode* default; a small allowlist of
 *     dev-only scripts and `turbopanel_dev_user`-gated orchestration assets may
 *     also reference it. Tests are excluded from the dev-checkout scan.
 *     `daemon-launch/defaults/main.yml` is included in this scan (no allowlist).
 *
 * Run: `deno task check:layout` (or `deno run --allow-read --allow-run=git scripts/check-production-layout.ts`).
 */
import { join, relative } from "@std/path";
import {
  type LayoutPaths,
  PROD_RUNTIME_DIR_DEFAULT,
  resolveLayout,
  resolveRuntimesDir,
} from "../src/paths/layout.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

export function recordLayoutMismatch(
  failures: string[],
  label: string,
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    failures.push(`layout ${label}: expected "${expected}", got "${actual}"`);
  }
}

/** CI verify extract trees must live in mktemp dirs, never in git. */
export async function assertReleaseRootVerifyNotTracked(
  failures: string[],
  root = repoRoot,
): Promise<void> {
  const { code, stdout } = await new Deno.Command("git", {
    args: ["ls-files", "release-root-verify-*"],
    cwd: root,
    stdout: "piped",
    stderr: "null",
  }).output();
  if (code !== 0) return;
  const tracked = new TextDecoder().decode(stdout).trim();
  if (!tracked) return;
  const sample = tracked.split("\n").slice(0, 5).join("\n    ");
  const more = tracked.split("\n").length > 5 ? "\n    …" : "";
  failures.push(
    `release-root-verify-* must not be tracked (extract to mktemp in CI, gitignore locally):\n    ${sample}${more}`,
  );
}

export function assertProductionLayout(
  failures: string[],
  prod: LayoutPaths,
): void {
  recordLayoutMismatch(failures, "mode", prod.mode, "production");
  recordLayoutMismatch(failures, "home", prod.home, "/opt/turbopanel");
  recordLayoutMismatch(failures, "binDir", prod.binDir, "/opt/turbopanel/bin");
  recordLayoutMismatch(failures, "libDir", prod.libDir, "/opt/turbopanel/lib");
  recordLayoutMismatch(
    failures,
    "runtimeDir",
    prod.runtimeDir,
    "/opt/turbopanel/vendor",
  );
  recordLayoutMismatch(
    failures,
    "runtimesDir",
    prod.runtimesDir,
    "/opt/turbopanel/vendor",
  );
  recordLayoutMismatch(
    failures,
    "shareDir",
    prod.shareDir,
    "/opt/turbopanel/share",
  );
  recordLayoutMismatch(
    failures,
    "uiDir",
    prod.uiDir,
    "/opt/turbopanel/share/ui",
  );
  recordLayoutMismatch(
    failures,
    "orchestrationDir",
    prod.orchestrationDir,
    "/opt/turbopanel/share/orchestration",
  );
  recordLayoutMismatch(
    failures,
    "configDir",
    prod.configDir,
    "/etc/turbopanel",
  );
  recordLayoutMismatch(
    failures,
    "stateDir",
    prod.stateDir,
    "/var/lib/turbopanel",
  );
  recordLayoutMismatch(
    failures,
    "daemonStateDir",
    prod.daemonStateDir,
    "/var/lib/turbopanel",
  );
  recordLayoutMismatch(failures, "logDir", prod.logDir, "/var/log/turbopanel");
  recordLayoutMismatch(failures, "runDir", prod.runDir, "/run/turbopanel");
  recordLayoutMismatch(
    failures,
    "principalHomeRoot",
    prod.principalHomeRoot,
    "/srv/users",
  );
  recordLayoutMismatch(
    failures,
    "daemonRootDefault",
    prod.daemonRootDefault,
    "/opt/turbopanel/lib/daemon",
  );
  recordLayoutMismatch(
    failures,
    "instanceDir",
    prod.instanceDir,
    "/opt/turbopanel/lib/instance",
  );

  recordLayoutMismatch(
    failures,
    "daemon binary",
    join(prod.binDir, "turbopaneld"),
    "/opt/turbopanel/bin/turbopaneld",
  );
  recordLayoutMismatch(
    failures,
    "js fallback",
    join(prod.binDir, "turbopaneld.js"),
    "/opt/turbopanel/bin/turbopaneld.js",
  );

  if (prod.orchestrationDir.includes("/platform/")) {
    failures.push(
      `production orchestrationDir leaked the dev checkout: ${prod.orchestrationDir}`,
    );
  }

  if (prod.instanceDir.includes("/platform/")) {
    failures.push(
      `production instanceDir leaked the dev checkout: ${prod.instanceDir}`,
    );
  }

  if (prod.daemonRootDefault.includes("/platform/")) {
    failures.push(
      `production daemonRootDefault leaked the dev checkout: ${prod.daemonRootDefault}`,
    );
  }
}

const HARDCODED_DAEMON_LOCK = /\/run\/turbopanel\/daemon\.lock/;
const RUNTIME_SOCKET_DIR_LOCK =
  /\{\{\s*runtime_socket_dir\s*\}\}\/daemon\.lock/;

export function assertDaemonUnitLock(
  failures: string[],
  daemonUnitText: string,
): void {
  if (HARDCODED_DAEMON_LOCK.test(daemonUnitText)) {
    failures.push(
      "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2 hardcodes /run/turbopanel/daemon.lock; use {{ runtime_socket_dir }}/daemon.lock",
    );
  }
  if (!RUNTIME_SOCKET_DIR_LOCK.test(daemonUnitText)) {
    failures.push(
      "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2 must use {{ runtime_socket_dir }}/daemon.lock for flock ExecStart",
    );
  }
}

export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "publish",
  "state",
  "coverage",
]);

/** Untracked/vendored build outputs that must not be scanned. */
export function isSkippedPath(rel: string): boolean {
  // Galaxy docker: geerlingguy.docker/ or geerlingguy/docker/
  return /(^|\/)roles\/geerlingguy([./]|$)/.test(rel);
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name) || isSkippedPath(rel)) continue;
      yield* walk(abs, root);
    } else if (entry.isFile && !isSkippedPath(rel)) {
      yield abs;
    }
  }
}

export const PRODUCTION_SCAN_ROOTS = [
  "src",
  "scripts",
  "orchestration",
  "main.ts",
];
export const SCAN_EXTENSIONS = /\.(ts|sh|yml|yaml|j2)$/;

export const PLATFORM_REF = /\/opt\/turbopanel\/platform/;
export const PLATFORM_SCAN_ALLOWLIST = new Set([
  "src/paths/layout.ts",
  "scripts/check-production-layout.ts",
  "scripts/run-orchestration-action.ts",
  "orchestration/roles/instance-launch/defaults/main.yml",
  "orchestration/roles/postgres/defaults/main.yml",
  "orchestration/roles/postgres/meta/main.yml",
  "orchestration/roles/postgres/tasks/main.yml",
  "orchestration/roles/rabbitmq/defaults/main.yml",
  "orchestration/roles/rabbitmq/meta/main.yml",
  "orchestration/roles/rabbitmq/tasks/main.yml",
  "orchestration/roles/redis/defaults/main.yml",
  "orchestration/roles/mailpit/defaults/main.yml",
]);

export const ANSIBLE_SHARE_REF = /(?<!\/usr\/)share\/ansible(\/|\b)/;
export const ANSIBLE_SCAN_ALLOWLIST = new Set([
  "scripts/lib/release-artifacts.sh",
  "scripts/verify-release-root.sh",
  "scripts/check-production-layout.ts",
]);

export const RETIRED_RUNTIMES_REF = /\/opt\/turbopanel\/runtimes/;
export const RETIRED_LIB_RUNTIME_REF = /\/opt\/turbopanel\/lib\/runtime/;
export const RETIRED_RUNTIMES_SCAN_ALLOWLIST = new Set([
  "scripts/check-production-layout.ts",
  "src/dev-sync-apply.ts", // comment only: documents legacy path for operators
  "src/orchestration/cloudflared.ts", // comment only
]);

export const RUNTIME_ROOT_LITERAL = /\/opt\/turbopanel\/vendor/;
export const RUNTIME_ROOT_SCAN_ALLOWLIST = new Set([
  "src/paths/layout.ts",
  "src/orchestration/paths.test.ts",
  "scripts/check-production-layout.ts",
  "scripts/lib/runtime-paths.sh",
  "scripts/install-daemon-systemd.sh",
  "orchestration/playbooks/daemon-install.yml", // comment only
  "orchestration/roles/deno-runtime/meta/main.yml", // role description
]);

export function collectForbiddenReferenceFailures(
  rel: string,
  text: string,
  isTestFile = rel.endsWith(".test.ts"),
): string[] {
  const failures: string[] = [];
  const lines = text.split("\n");

  if (!isTestFile && !PLATFORM_SCAN_ALLOWLIST.has(rel)) {
    lines.forEach((line, i) => {
      if (PLATFORM_REF.test(line)) {
        failures.push(
          `${rel}:${
            i + 1
          } references the dev checkout /opt/turbopanel/platform in production source`,
        );
      }
    });
  }

  if (!ANSIBLE_SCAN_ALLOWLIST.has(rel)) {
    lines.forEach((line, i) => {
      if (ANSIBLE_SHARE_REF.test(line)) {
        failures.push(
          `${rel}:${
            i + 1
          } references retired share/ansible (use share/orchestration)`,
        );
      }
    });
  }

  if (!isTestFile && !RETIRED_RUNTIMES_SCAN_ALLOWLIST.has(rel)) {
    lines.forEach((line, i) => {
      if (RETIRED_RUNTIMES_REF.test(line)) {
        failures.push(
          `${rel}:${
            i + 1
          } references retired /opt/turbopanel/runtimes (use vendor contract)`,
        );
      }
      if (RETIRED_LIB_RUNTIME_REF.test(line)) {
        failures.push(
          `${rel}:${
            i + 1
          } references retired /opt/turbopanel/lib/runtime (use vendor contract)`,
        );
      }
    });
  }

  if (!isTestFile && !RUNTIME_ROOT_SCAN_ALLOWLIST.has(rel)) {
    lines.forEach((line, i) => {
      if (RUNTIME_ROOT_LITERAL.test(line)) {
        failures.push(
          `${rel}:${
            i + 1
          } hardcodes /opt/turbopanel/vendor outside approved layout modules`,
        );
      }
    });
  }

  return failures;
}

export const RETIRED_IDENTITY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  {
    label: "turbopaneli service identity fallback",
    re: /\belse\s+['"]turbopaneli['"]|\bdefault\(\s*['"]turbopaneli['"]\s*\)/,
  },
  {
    label: "turbopanelc service identity fallback",
    re: /\belse\s+['"]turbopanelc['"]|\bdefault\(\s*['"]turbopanelc['"]\s*\)/,
  },
  {
    label: "turbopanel service identity fallback",
    re: /\belse\s+['"]turbopanel['"]|\bdefault\(\s*['"]turbopanel['"]\s*\)/,
  },
];

export function collectRetiredIdentityFailures(
  rel: string,
  text: string,
): string[] {
  const failures: string[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const { label, re } of RETIRED_IDENTITY_PATTERNS) {
      if (re.test(line)) {
        failures.push(
          `${rel}:${i + 1} uses retired ${label} (use tp/tpctrl/tpcache)`,
        );
      }
    }
  });
  return failures;
}

export function assertRuntimesDirContract(failures: string[]): void {
  if (
    resolveRuntimesDir({}, { forceMode: "production" }) !==
      PROD_RUNTIME_DIR_DEFAULT
  ) {
    failures.push(
      `resolveRuntimesDir(production) must equal PROD_RUNTIME_DIR_DEFAULT (${PROD_RUNTIME_DIR_DEFAULT})`,
    );
  }
}

export function reportLayoutFailures(
  failures: string[],
  io: {
    error?: (message: string) => void;
    log?: (message: string) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  const error = io.error ?? ((message: string) => {
    console.error(message);
  });
  const log = io.log ?? ((message: string) => {
    console.log(message);
  });
  const exit = io.exit ?? ((code: number) => {
    Deno.exit(code);
  });
  if (failures.length > 0) {
    error("Production layout check failed:\n");
    for (const failure of failures) {
      error(`  ✗ ${failure}`);
    }
    error(`\n${failures.length} problem(s) found.`);
    exit(1);
    return;
  }
  log("Production layout check passed: FHS tree + no dev-checkout leaks.");
}

export async function runProductionLayoutCheck(
  root = repoRoot,
): Promise<string[]> {
  const failures: string[] = [];

  await assertReleaseRootVerifyNotTracked(failures, root);

  const prod = resolveLayout({}, { forceMode: "production" });
  assertProductionLayout(failures, prod);

  const daemonUnitPath = join(
    root,
    "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2",
  );
  const daemonUnitText = await Deno.readTextFile(daemonUnitPath);
  assertDaemonUnitLock(failures, daemonUnitText);

  for (const scanRoot of PRODUCTION_SCAN_ROOTS) {
    const abs = join(root, scanRoot);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(abs);
    } catch {
      continue;
    }
    const files = stat.isDirectory ? walk(abs, root) : (async function* () {
      yield abs;
    })();
    for await (const file of files) {
      if (!SCAN_EXTENSIONS.test(file)) continue;
      const rel = relative(root, file);
      const text = await Deno.readTextFile(file);
      failures.push(
        ...collectForbiddenReferenceFailures(rel, text),
        ...collectRetiredIdentityFailures(rel, text),
      );
    }
  }

  assertRuntimesDirContract(failures);
  return failures;
}

if (import.meta.main) {
  reportLayoutFailures(await runProductionLayoutCheck());
}
