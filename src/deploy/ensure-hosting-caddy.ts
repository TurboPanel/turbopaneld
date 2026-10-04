/**
 * Ensure the hosting Caddy binary and its account exist.
 *
 * Called from environment.deploy (not daemon-converge). Managed hosts often
 * have no Caddy until the first deploy that needs hostname ingress. The
 * `caddy-setup` playbook (root) vendors the binary and provisions
 * {@link HOSTING_CADDY_USER} with read access to what Caddy loads; it runs
 * whenever either is missing, so a host that already has the binary from an
 * older release still gets the account.
 */

import { encodeHex } from "@std/encoding/hex";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { dirname, join } from "@std/path";
import { logInfo, logWarn } from "../util/logger.ts";
import { createSymlink } from "../permissions/scoped-writes.ts";
import { runCaddySetup as defaultRunCaddySetup } from "../orchestration/ansible.ts";
import { type LayoutPaths, PROD_LIB_DIR_DEFAULT } from "../paths/layout.ts";

/**
 * The account the hosting Caddy runs as. It is not in group `tp`, and its
 * unit's only privilege is `CAP_NET_BIND_SERVICE`. Keep in step with
 * `hosting_caddy_user` in orchestration/roles/hosting-caddy/defaults/main.yml
 * and `HOSTING_CADDY_USER` in tp-host, which pins the unit to it.
 */
export const HOSTING_CADDY_USER = "tpedge";

/**
 * Version of the ingress guard ruleset the caddy-setup playbook installs at
 * {@link INGRESS_GUARD_RULES_PATH} (`turbopanel-ingress-guard.service`): only root
 * and {@link HOSTING_CADDY_USER} may connect to the shared Traefik's PROXY
 * protocol entrypoints. Keep in step with `hosting_ingress_guard_version` in
 * orchestration/roles/hosting-caddy/defaults/main.yml; bump both when the
 * template changes so every host re-runs the playbook on its next deploy.
 */
export const INGRESS_GUARD_VERSION = "v2";

/** The guard ruleset's first-lines marker (`# turbopanel-ingress-guard v2`). */
export const INGRESS_GUARD_MARKER =
  `# turbopanel-ingress-guard ${INGRESS_GUARD_VERSION}\n`;

/**
 * Where the playbook installs the guard ruleset (root-owned, daemon-readable):
 * `<turbopanel_install_root>/lib`, which tp-orchestrate pins to the install
 * root in every layout, so not `layout.libDir` (a dev layout's is under home).
 */
export const INGRESS_GUARD_RULES_PATH = join(
  PROD_LIB_DIR_DEFAULT,
  "ingress-guard.nft",
);

/** The systemd unit that loads {@link INGRESS_GUARD_RULES_PATH}. */
export const INGRESS_GUARD_UNIT = "turbopanel-ingress-guard.service";

/** Keep in step with orchestration/roles/caddy/defaults/main.yml */
export const HOSTING_CADDY_VERSION = "2.11.4";
const HOSTING_CADDY_TAG = `v${HOSTING_CADDY_VERSION}`;

/** Upstream SHA-256 of linux release tarballs (ansible_architecture → digest). */
export const HOSTING_CADDY_SHA256: Record<"amd64" | "arm64", string> = {
  amd64: "527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9",
  arm64: "52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904",
};

export async function verifyHostingCaddyTarballSha256(
  arch: "arm64" | "amd64",
  tarballPath: string,
): Promise<void> {
  const expected = HOSTING_CADDY_SHA256[arch];
  const data = await Deno.readFile(tarballPath);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = encodeHex(new Uint8Array(digest));
  if (hex !== expected) {
    throw new Error(
      `Caddy tarball SHA-256 mismatch for ${arch} (expected ${expected}, got ${hex})`,
    );
  }
}

const decoder = new TextDecoder();

function caddyBinaryPath(runtimesDir: string): string {
  return join(runtimesDir, "caddy", "current", "caddy");
}

async function caddyBinaryPresent(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function resolveCaddyArchDefault(): "arm64" | "amd64" {
  const arch = Deno.build.arch;
  if (arch === "aarch64") return "arm64";
  if (arch === "x86_64") return "amd64";
  throw new Error(`Unsupported CPU architecture for hosting Caddy: ${arch}`);
}

async function runDefault(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<{ success: boolean; stderr: string }> {
  const result = await new Deno.Command(command, {
    args,
    cwd: opts.cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: result.success,
    stderr: decoder.decode(result.stderr).trim(),
  };
}

/** Optional test seams for {@link ensureHostingCaddy}. */
export type EnsureHostingCaddyDeps = {
  runCaddySetup?: () => Promise<void>;
  runCommand?: (
    command: string,
    args: string[],
    opts?: { cwd?: string },
  ) => Promise<{ success: boolean; stderr: string }>;
  resolveArch?: () => "arm64" | "amd64";
  /** Whether the hosting Caddy account exists (`getent passwd`). */
  accountExists?: () => Promise<boolean>;
  /** Whether the current ingress guard ruleset is installed. */
  ingressGuardCurrent?: () => Promise<boolean>;
  /** Whether {@link INGRESS_GUARD_UNIT} is active (`systemctl is-active`). */
  ingressGuardActive?: () => Promise<boolean>;
  verifyTarballSha256?: (
    arch: "arm64" | "amd64",
    tarballPath: string,
  ) => Promise<void>;
  /** Replaces {@link grantHostingCaddyRead} in {@link ensureHostingCaddyRuntime}. */
  grantHostingRead?: (hostingDir: string) => Promise<void>;
};

/**
 * Give the hosting Caddy read access to everything under the hosting config
 * directory, as the daemon (which owns it), with no privilege. The role's
 * default ACL on the leaf only reaches what is created after the role ran, so
 * anything written earlier (the Caddyfile on an updated host, `sites/` and its
 * snippets on a fresh one) has no entry for {@link HOSTING_CADDY_USER} until
 * this adds it. It adds an access entry on every file and folder and a default
 * entry on every folder, so files created later inherit it. `-P` never follows
 * a symlink, and only the daemon's own files are touched (a file root wrote
 * keeps its owner and is left to the default entry). Nothing widens beyond
 * {@link HOSTING_CADDY_USER}: no group or other bits change.
 */
export async function grantHostingCaddyRead(
  hostingDir: string,
  runCommand: NonNullable<EnsureHostingCaddyDeps["runCommand"]> = runDefault,
  user: string = HOSTING_CADDY_USER,
): Promise<void> {
  const entry = `u:${user}:rX`;
  const attempt = async (command: string, args: string[]) => {
    try {
      const result = await runCommand(command, args);
      if (!result.success) {
        logWarn(
          "deploy",
          `hosting Caddy read access not fully applied (${command}): ${result.stderr}`,
        );
      }
    } catch (err) {
      logWarn(
        "deploy",
        `hosting Caddy read access not applied (${command}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  await attempt("setfacl", ["-R", "-P", "-m", entry, "--", hostingDir]);
  // Default entries apply to folders only; find keeps files out of it.
  await attempt("find", [
    hostingDir,
    "-type",
    "d",
    "-exec",
    "setfacl",
    "-d",
    "-m",
    entry,
    "--",
    "{}",
    "+",
  ]);
}

/**
 * Direct download into the vendor tree (no Ansible). Used when the caddy-setup
 * playbook is missing on older managed orchestration trees, or Ansible fails.
 */
async function downloadHostingCaddy(
  runtimesDir: string,
  deps: Required<
    Pick<
      EnsureHostingCaddyDeps,
      "runCommand" | "resolveArch" | "verifyTarballSha256"
    >
  >,
): Promise<void> {
  const arch = deps.resolveArch();
  const versionDir = join(runtimesDir, "caddy", HOSTING_CADDY_VERSION);
  const binPath = join(versionDir, "caddy");
  const currentLink = join(runtimesDir, "caddy", "current");
  const asset = `caddy_${HOSTING_CADDY_VERSION}_linux_${arch}.tar.gz`;
  const url =
    `https://github.com/caddyserver/caddy/releases/download/${HOSTING_CADDY_TAG}/${asset}`;

  const tmp = await Deno.makeTempDir({ prefix: "tp-caddy-" });
  try {
    const tarball = join(tmp, asset);
    logInfo("deploy", `downloading hosting Caddy ${HOSTING_CADDY_VERSION}`);
    const curl = await deps.runCommand("/usr/bin/curl", [
      "-fsSL",
      "-o",
      tarball,
      url,
    ]);
    if (!curl.success) {
      throw new Error(`curl failed: ${curl.stderr || "download error"}`);
    }
    await deps.verifyTarballSha256(arch, tarball);
    const tar = await deps.runCommand("/usr/bin/tar", [
      "-xzf",
      tarball,
      "-C",
      tmp,
      "caddy",
    ]);
    if (!tar.success) {
      throw new Error(`tar failed: ${tar.stderr || "extract error"}`);
    }

    await Deno.mkdir(versionDir, { recursive: true, mode: 0o750 });
    await Deno.copyFile(join(tmp, "caddy"), binPath);
    await Deno.chmod(binPath, 0o750);

    // Refresh current symlink (force).
    try {
      await Deno.remove(currentLink);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    await createSymlink(versionDir, currentLink);

    // Best-effort root ownership on managed hosts; the group stays the daemon
    // account's (it downloaded the file), so the 0750 binary still runs. May
    // fail without sudo — then the daemon user keeps owning it, which also
    // runs.
    const chown = await deps.runCommand(
      "sudo",
      hostSudoArgs([
        "-n",
        "chown",
        "root",
        binPath,
      ]),
    );
    if (!chown.success) {
      logWarn(
        "deploy",
        `hosting Caddy chown skipped: ${
          chown.stderr || "no passwordless sudo"
        }`,
      );
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }

  // Ensure parent vendor/caddy exists with sane mode after symlink dance.
  await Deno.mkdir(dirname(currentLink), { recursive: true }).catch(() => {});
}

let accountCheckOverride: (() => Promise<boolean>) | undefined;

/**
 * Test-only: replace the `getent passwd` account check for callers that reach
 * {@link ensureHostingCaddy} without deps (the deploy handler). Returns a
 * restore function.
 */
export function setHostingCaddyAccountCheckForTest(
  fn?: () => Promise<boolean>,
): () => void {
  const previous = accountCheckOverride;
  accountCheckOverride = fn;
  return () => {
    accountCheckOverride = previous;
  };
}

let ingressGuardCheckOverride: (() => Promise<boolean>) | undefined;

/**
 * Test-only: replace the ingress guard checks (ruleset version and unit state)
 * for callers that reach {@link ensureHostingCaddy} without deps. Returns a
 * restore function.
 */
export function setIngressGuardCheckForTest(
  fn?: () => Promise<boolean>,
): () => void {
  const previous = ingressGuardCheckOverride;
  ingressGuardCheckOverride = fn;
  return () => {
    ingressGuardCheckOverride = previous;
  };
}

/** True when the ruleset at `path` carries {@link INGRESS_GUARD_MARKER}. */
export async function ingressGuardInstalled(
  path: string = INGRESS_GUARD_RULES_PATH,
): Promise<boolean> {
  if (ingressGuardCheckOverride) return await ingressGuardCheckOverride();
  try {
    const rules = await Deno.readTextFile(path);
    return rules.includes(INGRESS_GUARD_MARKER);
  } catch {
    return false;
  }
}

/** True when {@link INGRESS_GUARD_UNIT} is active (its table is loaded). */
async function ingressGuardUnitActive(): Promise<boolean> {
  if (ingressGuardCheckOverride) return await ingressGuardCheckOverride();
  try {
    const result = await runDefault("systemctl", [
      "is-active",
      "--quiet",
      INGRESS_GUARD_UNIT,
    ]);
    return result.success;
  } catch {
    return false;
  }
}

async function hostingCaddyAccountExists(): Promise<boolean> {
  if (accountCheckOverride) return await accountCheckOverride();
  const result = await runDefault("getent", ["passwd", HOSTING_CADDY_USER]);
  return result.success;
}

/**
 * Ensure `<runtimesDir>/caddy/current/caddy` and the hosting Caddy account
 * exist for hosting ingress.
 */
export async function ensureHostingCaddy(
  layout: LayoutPaths,
  deps?: EnsureHostingCaddyDeps,
): Promise<string> {
  const runSetup = deps?.runCaddySetup ?? defaultRunCaddySetup;
  const runCommand = deps?.runCommand ?? runDefault;
  const resolveArch = deps?.resolveArch ?? resolveCaddyArchDefault;
  const verifyTarballSha256 = deps?.verifyTarballSha256 ??
    verifyHostingCaddyTarballSha256;
  const accountExists = deps?.accountExists ?? hostingCaddyAccountExists;
  const guardCurrent = deps?.ingressGuardCurrent ??
    (() => ingressGuardInstalled());
  const guardActive = deps?.ingressGuardActive ?? ingressGuardUnitActive;

  const caddy = caddyBinaryPath(layout.runtimesDir);
  if (
    await caddyBinaryPresent(caddy) && await accountExists() &&
    await guardCurrent() && await guardActive()
  ) {
    return caddy;
  }

  try {
    await runSetup();
  } catch (err) {
    logWarn(
      "deploy",
      `caddy-setup playbook failed, trying direct download: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!(await caddyBinaryPresent(caddy))) {
    await downloadHostingCaddy(layout.runtimesDir, {
      runCommand,
      resolveArch,
      verifyTarballSha256,
    });
  }

  if (!(await caddyBinaryPresent(caddy))) {
    throw new Error(`Hosting Caddy runtime is missing: ${caddy}`);
  }
  // Only the playbook can create the account; a direct download cannot.
  if (!(await accountExists())) {
    throw new Error(
      `Hosting Caddy account ${HOSTING_CADDY_USER} is missing: the caddy-setup playbook did not complete`,
    );
  }
  // Fail closed: without the guard any local user can reach the shared
  // Traefik's PROXY protocol entrypoints and claim any client address in every
  // tenant's app. Only the playbook installs and starts it.
  if (!(await guardCurrent())) {
    throw new Error(
      `Ingress guard ${INGRESS_GUARD_VERSION} is not installed at ${INGRESS_GUARD_RULES_PATH}: the caddy-setup playbook did not complete`,
    );
  }
  if (!(await guardActive())) {
    throw new Error(
      `Ingress guard ${INGRESS_GUARD_UNIT} is not active: local users could reach the shared Traefik entrypoints`,
    );
  }
  return caddy;
}
