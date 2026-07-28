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
  PROD_RUNTIME_DIR_DEFAULT,
  resolveLayout,
  resolveRuntimesDir,
} from "../src/paths/layout.ts";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const failures: string[] = [];

/** CI verify extract trees must live in mktemp dirs, never in git. */
async function assertReleaseRootVerifyNotTracked(): Promise<void> {
  const { code, stdout } = await new Deno.Command("git", {
    args: ["ls-files", "release-root-verify-*"],
    cwd: repoRoot,
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

function expect(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    failures.push(`layout ${label}: expected "${expected}", got "${actual}"`);
  }
}

// --- 0. No committed CI verify extract trees --------------------------------
await assertReleaseRootVerifyNotTracked();

// --- 1. Production FHS tree contract ----------------------------------------
const prod = resolveLayout({}, { forceMode: "production" });

expect("mode", prod.mode, "production");
expect("home", prod.home, "/opt/turbopanel");
expect("binDir", prod.binDir, "/opt/turbopanel/bin");
expect("libDir", prod.libDir, "/opt/turbopanel/lib");
expect("runtimeDir", prod.runtimeDir, "/opt/turbopanel/vendor");
expect("runtimesDir", prod.runtimesDir, "/opt/turbopanel/vendor");
expect("shareDir", prod.shareDir, "/opt/turbopanel/share");
expect("uiDir", prod.uiDir, "/opt/turbopanel/share/ui");
expect(
  "orchestrationDir",
  prod.orchestrationDir,
  "/opt/turbopanel/share/orchestration",
);
expect("configDir", prod.configDir, "/etc/turbopanel");
expect("stateDir", prod.stateDir, "/var/lib/turbopanel");
expect("daemonStateDir", prod.daemonStateDir, "/var/lib/turbopanel");
expect("logDir", prod.logDir, "/var/log/turbopanel");
expect("runDir", prod.runDir, "/run/turbopanel");
expect("principalHomeRoot", prod.principalHomeRoot, "/srv/users");
expect(
  "daemonRootDefault",
  prod.daemonRootDefault,
  "/opt/turbopanel/lib/daemon",
);
expect("instanceDir", prod.instanceDir, "/opt/turbopanel/lib/instance");

// Binary + helper entrypoints derived from the resolved bin dir.
expect(
  "daemon binary",
  join(prod.binDir, "turbopaneld"),
  "/opt/turbopanel/bin/turbopaneld",
);
expect(
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

// --- 2. Daemon unit template must derive lock path from runtime_socket_dir ---
const DAEMON_UNIT_TEMPLATE = join(
  repoRoot,
  "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2",
);
const daemonUnitText = await Deno.readTextFile(DAEMON_UNIT_TEMPLATE);
const HARDCODED_DAEMON_LOCK = /\/run\/turbopanel\/daemon\.lock/;
if (HARDCODED_DAEMON_LOCK.test(daemonUnitText)) {
  failures.push(
    "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2 hardcodes /run/turbopanel/daemon.lock; use {{ runtime_socket_dir }}/daemon.lock",
  );
}
if (!/\{\{\s*runtime_socket_dir\s*\}\}\/daemon\.lock/.test(daemonUnitText)) {
  failures.push(
    "orchestration/roles/daemon-launch/templates/turbopaneld.service.j2 must use {{ runtime_socket_dir }}/daemon.lock for flock ExecStart",
  );
}

// --- 3. Forbidden references in production source ---------------------------
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "publish",
  "state",
  "coverage",
]);

/** Untracked/vendored build outputs that must not be scanned. */
function isSkippedPath(rel: string): boolean {
  return rel.includes("geerlingguy.docker");
}

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const abs = join(dir, entry.name);
    const rel = relative(repoRoot, abs);
    if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name) || isSkippedPath(rel)) continue;
      yield* walk(abs);
    } else if (entry.isFile && !isSkippedPath(rel)) {
      yield abs;
    }
  }
}

// Both forbidden-reference checks scan the same curated managed-install roots
// so a hardcoded dev checkout path in main.ts, scripts/run.sh,
// or a production playbook/template cannot slip through CI. Each pattern keeps
// its own allowlist of files that legitimately name the forbidden string.
const PRODUCTION_SCAN_ROOTS = ["src", "scripts", "orchestration", "main.ts"];
const SCAN_EXTENSIONS = /\.(ts|sh|yml|yaml|j2)$/;

// `/opt/turbopanel/platform(/daemon)` is the co-located dev checkout root. The
// centralized layout module owns it as the development-mode default; a handful
// of dev-only scripts and `turbopanel_dev_user`-gated orchestration assets also
// reference it from their dev branches. Everything else in the production
// surface must not name the dev tree. Tests are excluded (they assert both
// dev and prod trees by design).
const PLATFORM_REF = /\/opt\/turbopanel\/platform/;
const PLATFORM_SCAN_ALLOWLIST = new Set([
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

// TurboPanel's `share/ansible` is retired (production ships share/orchestration).
// Do not flag Ansible's system collections path `/usr/share/ansible/…`.
// The release verifiers and this checker legitimately name the retired path in
// order to *reject* it, so they are allowlisted from the scan.
const ANSIBLE_SHARE_REF = /(?<!\/usr\/)share\/ansible(\/|\b)/;
const ANSIBLE_SCAN_ALLOWLIST = new Set([
  "scripts/lib/release-artifacts.sh",
  "scripts/verify-release-root.sh",
  "scripts/check-production-layout.ts",
]);

// Retired vendor trees — every caller must use TURBOPANEL_RUNTIMES_DIR / vendor.
const RETIRED_RUNTIMES_REF = /\/opt\/turbopanel\/runtimes/;
const RETIRED_LIB_RUNTIME_REF = /\/opt\/turbopanel\/lib\/runtime/;
const RETIRED_RUNTIMES_SCAN_ALLOWLIST = new Set([
  "scripts/check-production-layout.ts",
  "src/dev-sync-apply.ts", // comment only: documents legacy path for operators
  "src/orchestration/cloudflared.ts", // comment only
]);

// Unmanaged `/opt/turbopanel/vendor` literals outside approved layout modules.
const RUNTIME_ROOT_LITERAL = /\/opt\/turbopanel\/vendor/;
const RUNTIME_ROOT_SCAN_ALLOWLIST = new Set([
  "src/paths/layout.ts",
  "src/orchestration/paths.test.ts",
  "scripts/check-production-layout.ts",
  "scripts/lib/runtime-paths.sh",
  "scripts/install-daemon-systemd.sh",
  "orchestration/playbooks/daemon-install.yml", // comment only
  "orchestration/roles/deno-runtime/meta/main.yml", // role description
]);

for (const root of PRODUCTION_SCAN_ROOTS) {
  const abs = join(repoRoot, root);
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(abs);
  } catch {
    continue;
  }
  const files = stat.isDirectory ? walk(abs) : (async function* () {
    yield abs;
  })();
  for await (const file of files) {
    if (!SCAN_EXTENSIONS.test(file)) continue;
    const rel = relative(repoRoot, file);
    const text = await Deno.readTextFile(file);
    const lines = text.split("\n");

    if (!file.endsWith(".test.ts") && !PLATFORM_SCAN_ALLOWLIST.has(rel)) {
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

    if (
      !file.endsWith(".test.ts") && !RETIRED_RUNTIMES_SCAN_ALLOWLIST.has(rel)
    ) {
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

    if (!file.endsWith(".test.ts") && !RUNTIME_ROOT_SCAN_ALLOWLIST.has(rel)) {
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
  }
}

// --- 4. resolveRuntimesDir matches production layout -----------------------
if (
  resolveRuntimesDir({}, { forceMode: "production" }) !==
    PROD_RUNTIME_DIR_DEFAULT
) {
  failures.push(
    `resolveRuntimesDir(production) must equal PROD_RUNTIME_DIR_DEFAULT (${PROD_RUNTIME_DIR_DEFAULT})`,
  );
}

// --- 5. Retired production service identity fallbacks ----------------------
const RETIRED_IDENTITY_ALLOWLIST = new Set([
  "orchestration/roles/turbopanel-user/tasks/identity-cutover.yml",
  "scripts/check-production-layout.ts",
]);
const RETIRED_IDENTITY_PATTERNS: Array<{ label: string; re: RegExp }> = [
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

for (const root of PRODUCTION_SCAN_ROOTS) {
  const abs = join(repoRoot, root);
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(abs);
  } catch {
    continue;
  }
  const files = stat.isDirectory ? walk(abs) : (async function* () {
    yield abs;
  })();
  for await (const file of files) {
    if (!SCAN_EXTENSIONS.test(file)) continue;
    const rel = relative(repoRoot, file);
    if (RETIRED_IDENTITY_ALLOWLIST.has(rel)) continue;
    const text = await Deno.readTextFile(file);
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
  }
}

if (failures.length > 0) {
  console.error("Production layout check failed:\n");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  console.error(`\n${failures.length} problem(s) found.`);
  Deno.exit(1);
}

console.log(
  "Production layout check passed: FHS tree + no dev-checkout leaks.",
);
