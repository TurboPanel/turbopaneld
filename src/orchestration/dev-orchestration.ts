import { join } from "@std/path";
import {
  GALAXY_COLLECTIONS_DIR,
  GALAXY_ROLES_DIR,
  ORCHESTRATION_DIR,
  RUNTIMES_DIR,
} from "./paths.ts";

/**
 * Default staged path for dev-owned orchestration.
 *
 * The turbopanel-dev console stages its `orchestration/` overlay here before the
 * dev converge. In co-located dev the daemon runs as the single dev user, so the
 * staged tree is dev-user-owned (world-readable dirs/files either way); the
 * daemon reads the overlay playbook + dev roles from here and layers the daemon's
 * shared production roles on top via {@link devOrchestrationAnsibleEnv}.
 */
export const DEFAULT_DEV_ORCHESTRATION_DIR =
  "/opt/turbopanel/dev-orchestration";

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

/**
 * Resolve the runtime-consumable dev orchestration root.
 *
 * Co-located development stages the turbopanel-dev `orchestration/` overlay under
 * `/opt/turbopanel/dev-orchestration` before bootstrap/converge. The staged tree
 * is owned by the single dev user (the daemon runs as that user in dev) and holds
 * the dev playbook, `ansible.cfg`, the dev converge manifest, and the dev-only
 * overlay roles. Override with `TURBOPANEL_DEV_ORCHESTRATION_DIR` for tests or
 * alternate layouts.
 */
export function resolveDevOrchestrationDir(): string {
  const override = Deno.env.get("TURBOPANEL_DEV_ORCHESTRATION_DIR")?.trim();
  return override && override.length > 0
    ? override
    : DEFAULT_DEV_ORCHESTRATION_DIR;
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
    throw new Error(`Invalid dev converge manifest at ${manifestPath}`);
  }
  return parsed;
}

/** Shared layout for dev converge playbooks, stamp hashing, and ansible env. */
export async function resolveDevOrchestrationLayout(): Promise<
  DevOrchestrationLayout
> {
  const root = resolveDevOrchestrationDir();
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

export async function devOrchestrationReady(): Promise<boolean> {
  const root = resolveDevOrchestrationDir();
  const manifestPath = join(root, DEV_CONVERGE_MANIFEST_FILE);
  const ansibleCfgPath = join(root, "ansible.cfg");
  if (
    !(await fileExists(manifestPath)) || !(await fileExists(ansibleCfgPath))
  ) {
    return false;
  }
  try {
    const layout = await resolveDevOrchestrationLayout();
    return await fileExists(layout.playbookPath);
  } catch {
    return false;
  }
}

/**
 * Resolve a role's source directory for dev converge stamp hashing.
 *
 * Mirrors the `ANSIBLE_ROLES_PATH` overlay precedence in
 * {@link devOrchestrationAnsibleEnv}: manifest `devRoles` come from the staged
 * dev overlay (`<root>/roles/<name>`); every other role resolves to the daemon
 * home checkout's shared production roles (`GALAXY_ROLES_DIR/<name>`). Keep the
 * two in sync so the stamp hash covers the exact files Ansible will run.
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
 * `ANSIBLE_ROLES_PATH` overlays the staged dev-owned roles ahead of the daemon's
 * shared production roles: Ansible resolves each role name left-to-right, so a
 * dev overlay role (`instance-dev-prereqs`, `dev-permissions`, `dev-host-access`)
 * wins, and every other role in the manifest falls through to the daemon home
 * checkout's `orchestration/roles`. This overrides the relative `roles_path` in
 * the staged `ansible.cfg` (which cannot name the daemon checkout — its path is
 * no longer fixed). Keep the ordering in step with the manifest's
 * `devRoles`/`roles` split and {@link resolveDevConvergeRoleDir}.
 */
export function devOrchestrationAnsibleEnv(
  layout: DevOrchestrationLayout,
): Record<string, string> {
  return {
    ANSIBLE_CONFIG: layout.ansibleCfgPath,
    ANSIBLE_LOCAL_TEMP: join(RUNTIMES_DIR, "uv", "cache", "ansible-tmp"),
    ANSIBLE_COLLECTIONS_PATH: GALAXY_COLLECTIONS_DIR,
    ANSIBLE_ROLES_PATH: `${layout.devRolesDir}:${layout.daemonRolesDir}`,
  };
}

/** Fail fast when dev converge is requested but staging did not run. */
export async function requireDevOrchestrationLayout(): Promise<
  DevOrchestrationLayout
> {
  const layout = await resolveDevOrchestrationLayout();
  if (!(await fileExists(layout.playbookPath))) {
    throw new Error(
      `Dev orchestration playbook missing at ${layout.playbookPath} — stage turbopanel-dev orchestration before converge`,
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
export const DAEMON_ORCHESTRATION_DIR = ORCHESTRATION_DIR;
