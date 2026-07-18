import { join } from "@std/path";
import { readEnv, resolveDevRoot } from "../paths/layout.ts";
import { ANSIBLE_HOME, ANSIBLE_LOCAL_TMP, GALAXY_ROLES_DIR } from "./paths.ts";

/** Dev overlay playbook + roles live under `<dev checkout>/orchestration`. */
export const DEV_ORCHESTRATION_SUBDIR = join("dev", "orchestration");

export const DEV_CONVERGE_MANIFEST_FILE = "dev-converge-manifest.json";

export interface DevConvergeManifest {
  playbook: string;
  roles: string[];
  devRoles: string[];
}

export interface DevOrchestrationLayout {
  root: string;
  manifest: DevConvergeManifest;
  playbookPath: string;
  ansibleCfgPath: string;
  devRolesDir: string;
  daemonRolesDir: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

function devOrchestrationEnv(
  env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    TURBOPANEL_DEV_ROOT: env.TURBOPANEL_DEV_ROOT ??
      readEnv("TURBOPANEL_DEV_ROOT"),
    HOME: env.HOME ?? readEnv("HOME"),
  };
}

/**
 * Resolve the co-located dev orchestration root.
 *
 * Defaults to `<dev checkout>/orchestration` (`<devRoot>/dev/orchestration`) —
 * the dev-owned overlay playbook, `ansible.cfg`, converge manifest, and
 * dev-only roles. Production roles still resolve from the daemon checkout's
 * shared `orchestration/roles` via {@link devOrchestrationAnsibleEnv}. Override
 * with `TURBOPANEL_DEV_ORCHESTRATION_DIR` for tests or alternate layouts.
 */
export function resolveDevOrchestrationDir(
  env: Record<string, string | undefined> = {},
): string {
  const override = env.TURBOPANEL_DEV_ORCHESTRATION_DIR?.trim() ??
    readEnv("TURBOPANEL_DEV_ORCHESTRATION_DIR")?.trim();
  if (override && override.length > 0) {
    let end = override.length;
    while (end > 0 && (override.codePointAt(end - 1) ?? 0) === 47) {
      end--;
    }
    return end === 0 ? "/" : override.slice(0, end);
  }
  const devRoot = resolveDevRoot(devOrchestrationEnv(env));
  return join(devRoot, DEV_ORCHESTRATION_SUBDIR);
}

export async function readDevConvergeManifest(
  root = resolveDevOrchestrationDir(),
): Promise<DevConvergeManifest> {
  const manifestPath = join(root, DEV_CONVERGE_MANIFEST_FILE);
  const raw = await Deno.readTextFile(manifestPath);
  const parsed = JSON.parse(raw) as DevConvergeManifest;
  if (
    typeof parsed.playbook !== "string" ||
    !Array.isArray(parsed.roles) ||
    !Array.isArray(parsed.devRoles)
  ) {
    throw new TypeError(`Invalid dev converge manifest at ${manifestPath}`);
  }
  return parsed;
}

/** Shared layout for dev converge playbooks, stamp hashing, and ansible env. */
export async function resolveDevOrchestrationLayout(
  env: Record<string, string | undefined> = {},
): Promise<DevOrchestrationLayout> {
  const root = resolveDevOrchestrationDir(env);
  const manifest = await readDevConvergeManifest(root);
  return {
    root,
    manifest,
    playbookPath: join(root, manifest.playbook),
    ansibleCfgPath: join(root, "ansible.cfg"),
    devRolesDir: join(root, "roles"),
    daemonRolesDir: GALAXY_ROLES_DIR,
  };
}

export async function devOrchestrationReady(
  env: Record<string, string | undefined> = {},
): Promise<boolean> {
  const root = resolveDevOrchestrationDir(env);
  const manifestPath = join(root, DEV_CONVERGE_MANIFEST_FILE);
  const ansibleCfgPath = join(root, "ansible.cfg");
  if (
    !(await fileExists(manifestPath)) || !(await fileExists(ansibleCfgPath))
  ) {
    return false;
  }
  try {
    const layout = await resolveDevOrchestrationLayout(env);
    return await fileExists(layout.playbookPath);
  } catch {
    return false;
  }
}

/**
 * Resolve a role's source directory for dev converge stamp hashing.
 *
 * Mirrors the `ANSIBLE_ROLES_PATH` overlay precedence in
 * {@link devOrchestrationAnsibleEnv}: manifest `devRoles` come from the dev
 * overlay (`<root>/roles/<name>`); every other role resolves to the daemon home
 * checkout's shared production roles (`GALAXY_ROLES_DIR/<name>`). Keep the two
 * in sync so the stamp hash covers the exact files Ansible will run.
 */
export function resolveDevConvergeRoleDir(
  layout: DevOrchestrationLayout,
  roleName: string,
): string {
  if (layout.manifest.devRoles.includes(roleName)) {
    return join(layout.devRolesDir, roleName);
  }
  return join(layout.daemonRolesDir, roleName);
}

/**
 * Ansible env for co-located dev converge playbooks.
 *
 * `ANSIBLE_ROLES_PATH` overlays the dev-owned roles ahead of the daemon's shared
 * production roles: Ansible resolves each role name left-to-right, so a dev
 * overlay role (`instance-dev-prereqs`, `dev-permissions`, `dev-host-access`)
 * wins, and every other role in the manifest falls through to the daemon home
 * checkout's `orchestration/roles`. This overrides the relative `roles_path` in
 * the dev overlay `ansible.cfg`. Keep the ordering in step with the manifest's
 * `devRoles`/`roles` split and {@link resolveDevConvergeRoleDir}.
 */
export function devOrchestrationAnsibleEnv(
  layout: DevOrchestrationLayout,
): Record<string, string> {
  return {
    ANSIBLE_CONFIG: layout.ansibleCfgPath,
    ANSIBLE_HOME,
    ANSIBLE_LOCAL_TEMP: ANSIBLE_LOCAL_TMP,
    ANSIBLE_ROLES_PATH: `${layout.devRolesDir}:${layout.daemonRolesDir}`,
  };
}

/** Fail fast when dev converge is requested but the overlay tree is missing. */
export async function requireDevOrchestrationLayout(
  env: Record<string, string | undefined> = {},
): Promise<DevOrchestrationLayout> {
  const layout = await resolveDevOrchestrationLayout(env);
  if (!(await fileExists(layout.playbookPath))) {
    throw new Error(
      `Dev orchestration playbook missing at ${layout.playbookPath} — ensure ${DEV_ORCHESTRATION_SUBDIR} exists in the dev checkout`,
    );
  }
  if (!(await fileExists(layout.ansibleCfgPath))) {
    throw new Error(
      `Dev orchestration ansible.cfg missing at ${layout.ansibleCfgPath}`,
    );
  }
  return layout;
}

/** Daemon-only orchestration root (managed servers and daemon converge playbooks). */
export { ORCHESTRATION_DIR as DAEMON_ORCHESTRATION_DIR } from "./paths.ts";
