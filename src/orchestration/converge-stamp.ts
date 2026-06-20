import { encodeHex } from '@std/encoding/hex'
import { join, relative } from '@std/path'
import {
  GALAXY_ROLES_DIR,
  INSTANCE_DEV_INSTALL_PLAYBOOK,
  RUNTIMES_DIR,
} from './paths.ts'

export const DEV_CONVERGE_STAMP_FILE = join(
  RUNTIMES_DIR,
  'ansible',
  'dev-converge.stamp',
)

/** Roles invoked by orchestration/playbooks/instance-dev-install.yml (order preserved for stability). */
const INSTANCE_DEV_INSTALL_ROLES = [
  'turbopanel-user',
  'runtime-sockets',
  'daemon-logs',
  'daemon-prereqs',
  'docker',
  'postgres',
  'redis',
  'rabbitmq',
  'instance-user',
  'instance-dev-prereqs',
  'node-runtime',
  'deno-runtime',
  'caddy',
  'dev-permissions',
  'dev-host-access',
  'instance-repo',
  'ui-repo',
  'website-repo',
  'ui-build',
  'instance-build',
  'instance-certs',
  'instance-launch',
] as const

function forceConvergeRequested(): boolean {
  const flag = Deno.env.get('TURBOPANEL_FORCE_CONVERGE')?.trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
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

async function digestText(material: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return encodeHex(new Uint8Array(digest))
}

async function collectRoleYamlMaterial(roleName: string): Promise<string[]> {
  const roleDir = join(GALAXY_ROLES_DIR, roleName)
  const collected: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries: Deno.DirEntry[] = []
    try {
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry)
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return
      throw err
    }

    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory) {
        await walk(path)
        continue
      }
      if (!entry.isFile) continue
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml') && !entry.name.endsWith('.j2')) {
        continue
      }
      const rel = relative(roleDir, path)
      const body = await Deno.readTextFile(path)
      collected.push(`${roleName}/${rel}\n${body}`)
    }
  }

  await walk(roleDir)
  collected.sort()
  return collected
}

/** Dev converge extra-vars that change playbook behavior (mirrors devInstanceExtraArgs). */
export function devConvergeEnvMaterial(): string {
  const devUser = Deno.env.get('TURBOPANEL_DEV_USER')?.trim() ?? ''
  const devUid = Deno.env.get('TURBOPANEL_DEV_UID')?.trim() ?? ''
  const devGid = Deno.env.get('TURBOPANEL_DEV_GID')?.trim() ?? ''
  const uiMode = Deno.env.get('TURBOPANEL_UI_MODE') === 'static' ? 'static' : 'dev'
  const instanceRunMode =
    Deno.env.get('TURBOPANEL_INSTANCE_RUN_MODE') === 'compiled' ? 'compiled' : 'source'
  const instanceRuntime =
    Deno.env.get('TURBOPANEL_INSTANCE_RUNTIME') === 'workers' ? 'workers' : 'deno'

  return [
    `dev_user=${devUser}`,
    `dev_uid=${devUid}`,
    `dev_gid=${devGid}`,
    `ui_mode=${uiMode}`,
    `instance_run_mode=${instanceRunMode}`,
    `instance_runtime=${instanceRuntime}`,
  ].join('\n')
}

/**
 * Fingerprint of the co-located dev converge playbook, its role task/template
 * trees, and dev-only extra-vars. Used to skip redundant full converges on
 * daemon restart when nothing material changed.
 */
export async function computeDevConvergeStamp(): Promise<string> {
  const playbook = await Deno.readTextFile(INSTANCE_DEV_INSTALL_PLAYBOOK)
  const roleChunks: string[] = []
  for (const roleName of INSTANCE_DEV_INSTALL_ROLES) {
    roleChunks.push(...await collectRoleYamlMaterial(roleName))
  }
  const material = [playbook, devConvergeEnvMaterial(), ...roleChunks].join('\n---\n')
  return await digestText(material)
}

export async function readDevConvergeStamp(): Promise<string | null> {
  if (!(await fileExists(DEV_CONVERGE_STAMP_FILE))) return null
  const text = await Deno.readTextFile(DEV_CONVERGE_STAMP_FILE)
  const stamp = text.trim()
  return stamp.length > 0 ? stamp : null
}

export async function writeDevConvergeStamp(stamp: string): Promise<void> {
  await Deno.mkdir(join(RUNTIMES_DIR, 'ansible'), { recursive: true })
  await Deno.writeTextFile(DEV_CONVERGE_STAMP_FILE, `${stamp}\n`)
}

export async function shouldSkipDevConverge(
  instanceServiceEnabled: boolean,
): Promise<boolean> {
  if (forceConvergeRequested()) return false
  if (!instanceServiceEnabled) return false

  const stored = await readDevConvergeStamp()
  if (!stored) return false

  const current = await computeDevConvergeStamp()
  return stored === current
}