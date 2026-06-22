import { join } from '@std/path'
import {
  GALAXY_COLLECTIONS_DIR,
  GALAXY_ROLES_DIR,
  ORCHESTRATION_DIR,
  RUNTIMES_DIR,
} from './paths.ts'

/** Default staged path for dev-owned orchestration (see turbopanel-dev staging). */
export const DEFAULT_DEV_ORCHESTRATION_DIR = '/opt/turbopanel/dev-orchestration'

export const DEV_CONVERGE_MANIFEST_FILE = 'dev-converge-manifest.json'

export interface DevConvergeManifest {
  playbook: string
  roles: string[]
  devRoles: string[]
}

export interface DevOrchestrationLayout {
  root: string
  manifest: DevConvergeManifest
  playbookPath: string
  ansibleCfgPath: string
  devRolesDir: string
  daemonRolesDir: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/**
 * Resolve the runtime-consumable dev orchestration root.
 *
 * Co-located development stages turbopanel-dev orchestration assets under
 * `/opt/turbopanel/dev-orchestration` before bootstrap/converge. Override with
 * `TURBOPANEL_DEV_ORCHESTRATION_DIR` for tests or alternate layouts.
 */
export function resolveDevOrchestrationDir(): string {
  const override = Deno.env.get('TURBOPANEL_DEV_ORCHESTRATION_DIR')?.trim()
  return override && override.length > 0 ? override : DEFAULT_DEV_ORCHESTRATION_DIR
}

export async function readDevConvergeManifest(
  root = resolveDevOrchestrationDir(),
): Promise<DevConvergeManifest> {
  const manifestPath = join(root, DEV_CONVERGE_MANIFEST_FILE)
  const raw = await Deno.readTextFile(manifestPath)
  const parsed = JSON.parse(raw) as DevConvergeManifest
  if (
    typeof parsed.playbook !== 'string' ||
    !Array.isArray(parsed.roles) ||
    !Array.isArray(parsed.devRoles)
  ) {
    throw new Error(`Invalid dev converge manifest at ${manifestPath}`)
  }
  return parsed
}

/** Shared layout for dev converge playbooks, stamp hashing, and ansible env. */
export async function resolveDevOrchestrationLayout(): Promise<DevOrchestrationLayout> {
  const root = resolveDevOrchestrationDir()
  const manifest = await readDevConvergeManifest(root)
  return {
    root,
    manifest,
    playbookPath: join(root, manifest.playbook),
    ansibleCfgPath: join(root, 'ansible.cfg'),
    devRolesDir: join(root, 'roles'),
    daemonRolesDir: GALAXY_ROLES_DIR,
  }
}

export async function devOrchestrationReady(): Promise<boolean> {
  const root = resolveDevOrchestrationDir()
  const manifestPath = join(root, DEV_CONVERGE_MANIFEST_FILE)
  const ansibleCfgPath = join(root, 'ansible.cfg')
  if (!(await fileExists(manifestPath)) || !(await fileExists(ansibleCfgPath))) {
    return false
  }
  try {
    const layout = await resolveDevOrchestrationLayout()
    return await fileExists(layout.playbookPath)
  } catch {
    return false
  }
}

/** Resolve a role directory for dev converge stamp hashing. */
export function resolveDevConvergeRoleDir(
  layout: DevOrchestrationLayout,
  roleName: string,
): string {
  if (layout.manifest.devRoles.includes(roleName)) {
    return join(layout.devRolesDir, roleName)
  }
  return join(layout.daemonRolesDir, roleName)
}

/** Ansible env for co-located dev converge playbooks. */
export function devOrchestrationAnsibleEnv(
  layout: DevOrchestrationLayout,
): Record<string, string> {
  return {
    ANSIBLE_CONFIG: layout.ansibleCfgPath,
    ANSIBLE_LOCAL_TEMP: join(RUNTIMES_DIR, 'uv', 'cache', 'ansible-tmp'),
    ANSIBLE_COLLECTIONS_PATH: GALAXY_COLLECTIONS_DIR,
  }
}

/** Fail fast when dev converge is requested but staging did not run. */
export async function requireDevOrchestrationLayout(): Promise<DevOrchestrationLayout> {
  const layout = await resolveDevOrchestrationLayout()
  if (!(await fileExists(layout.playbookPath))) {
    throw new Error(
      `Dev orchestration playbook missing at ${layout.playbookPath} — stage turbopanel-dev orchestration before converge`,
    )
  }
  if (!(await fileExists(layout.ansibleCfgPath))) {
    throw new Error(
      `Dev orchestration ansible.cfg missing at ${layout.ansibleCfgPath}`,
    )
  }
  return layout
}

/** Daemon-only orchestration root (managed servers and daemon converge playbooks). */
export const DAEMON_ORCHESTRATION_DIR = ORCHESTRATION_DIR
