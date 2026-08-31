import { encodeHex } from "@std/encoding/hex";
import { dirname, join, relative } from "@std/path";
import {
  type DevOrchestrationLayout,
  resolveDevConvergeRoleDir,
  resolveDevOrchestrationLayout,
} from "./dev-orchestration.ts";
import { resolveRuntimesDir } from "../paths/layout.ts";

/**
 * Resolve the stamp path from the current process env (or an explicit env bag).
 * Lazily derived so tests can point `TURBOPANEL_RUNTIMES_DIR` at a temp tree
 * without fighting module-load-time path constants.
 */
export function resolveDevConvergeStampFile(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(resolveRuntimesDir(env), "ansible", "dev-converge.stamp");
}

function forceConvergeRequested(): boolean {
  const flag = Deno.env.get("TURBOPANEL_FORCE_CONVERGE")?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
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

async function digestText(material: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  return encodeHex(new Uint8Array(digest));
}

async function collectRoleYamlMaterial(
  layout: DevOrchestrationLayout,
  roleName: string,
): Promise<string[]> {
  const roleDir = resolveDevConvergeRoleDir(layout, roleName);
  const collected: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
        continue;
      }
      if (!entry.isFile) continue;
      if (
        !entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml") &&
        !entry.name.endsWith(".j2")
      ) {
        continue;
      }
      const rel = relative(roleDir, path);
      const body = await Deno.readTextFile(path);
      collected.push(`${roleName}/${rel}\n${body}`);
    }
  }

  await walk(roleDir);
  collected.sort((a, b) => a.localeCompare(b));
  return collected;
}

/** Dev converge extra-vars that change playbook behavior (mirrors devInstanceExtraArgs). */
export function devConvergeEnvMaterial(): string {
  const devUser = Deno.env.get("TURBOPANEL_DEV_USER")?.trim() ?? "";
  const devUid = Deno.env.get("TURBOPANEL_DEV_UID")?.trim() ?? "";
  const devGid = Deno.env.get("TURBOPANEL_DEV_GID")?.trim() ?? "";
  const uiMode = Deno.env.get("TURBOPANEL_UI_MODE") === "static"
    ? "static"
    : "dev";
  const instanceRunMode =
    Deno.env.get("TURBOPANEL_INSTANCE_RUN_MODE") === "compiled"
      ? "compiled"
      : "source";
  const instanceRuntime =
    Deno.env.get("TURBOPANEL_INSTANCE_RUNTIME") === "workers"
      ? "workers"
      : "deno";

  const optionalFlag = (key: string, fallback: boolean): string => {
    const raw = Deno.env.get(key)?.trim().toLowerCase();
    if (!raw) return fallback ? "true" : "false";
    if (raw === "true" || raw === "1" || raw === "yes") return "true";
    if (raw === "false" || raw === "0" || raw === "no") return "false";
    return fallback ? "true" : "false";
  };

  return [
    `dev_user=${devUser}`,
    `dev_uid=${devUid}`,
    `dev_gid=${devGid}`,
    `ui_mode=${uiMode}`,
    `instance_run_mode=${instanceRunMode}`,
    `instance_runtime=${instanceRuntime}`,
    `optional_dbstudio=${optionalFlag("TURBOPANEL_OPTIONAL_DBSTUDIO", false)}`,
    `optional_ui=${optionalFlag("TURBOPANEL_OPTIONAL_UI", true)}`,
    `optional_website=${optionalFlag("TURBOPANEL_OPTIONAL_WEBSITE", true)}`,
    `optional_mailpit=${optionalFlag("TURBOPANEL_OPTIONAL_MAILPIT", true)}`,
    `optional_redis_insight=${
      optionalFlag("TURBOPANEL_OPTIONAL_REDIS_INSIGHT", false)
    }`,
  ].join("\n");
}

/**
 * Fingerprint of the co-located dev converge playbook, its role task/template
 * trees, and dev-only extra-vars. Uses the same dev orchestration root as
 * `runInstanceDevInstall()` (dev checkout overlay + daemon shared roles).
 */
export async function computeDevConvergeStamp(): Promise<string> {
  const layout = await resolveDevOrchestrationLayout();
  const playbook = await Deno.readTextFile(layout.playbookPath);
  const roleChunks: string[] = [];
  for (const roleName of layout.manifest.roles) {
    roleChunks.push(...await collectRoleYamlMaterial(layout, roleName));
  }
  const material = [
    layout.root,
    playbook,
    devConvergeEnvMaterial(),
    ...roleChunks,
  ].join("\n---\n");
  return await digestText(material);
}

export async function readDevConvergeStamp(): Promise<string | null> {
  const stampFile = resolveDevConvergeStampFile();
  if (!(await fileExists(stampFile))) return null;
  const text = await Deno.readTextFile(stampFile);
  const stamp = text.trim();
  return stamp.length > 0 ? stamp : null;
}

export async function writeDevConvergeStamp(stamp: string): Promise<void> {
  const stampFile = resolveDevConvergeStampFile();
  await Deno.mkdir(dirname(stampFile), { recursive: true });
  await Deno.writeTextFile(stampFile, `${stamp}\n`);
}

export async function shouldSkipDevConverge(
  instanceServiceEnabled: boolean,
): Promise<boolean> {
  if (forceConvergeRequested()) return false;
  if (!instanceServiceEnabled) return false;

  const stored = await readDevConvergeStamp();
  if (!stored) return false;

  const current = await computeDevConvergeStamp();
  return stored === current;
}

/** Human-readable reason the dev converge playbook will or will not run. */
export async function describeDevConvergeDecision(
  instanceServiceEnabled: boolean,
): Promise<string> {
  if (forceConvergeRequested()) {
    return "TURBOPANEL_FORCE_CONVERGE is set";
  }
  if (!instanceServiceEnabled) {
    return "turbopanel-instance.service is not enabled";
  }
  const stored = await readDevConvergeStamp();
  if (!stored) {
    return "no dev converge stamp (first converge or stamp missing)";
  }
  const current = await computeDevConvergeStamp();
  if (stored === current) {
    return "dev converge stamp matches (orchestration inputs unchanged)";
  }
  return "dev converge stamp mismatch (orchestration, roles, or dev env changed)";
}

/**
 * When `ifNeeded` is true and the stamp says converge is current, emit the
 * `dev_converge_skipped` JSONL event and return true so callers exit before
 * expensive Ansible/Galaxy setup.
 */
export async function emitDevConvergeSkippedIfNeeded(
  ifNeeded: boolean,
  instanceServiceEnabled: boolean,
  emit: (event: { _event: "dev_converge_skipped"; reason: string }) => void,
): Promise<boolean> {
  if (!ifNeeded) return false;
  const reason = await describeDevConvergeDecision(instanceServiceEnabled);
  if (!(await shouldSkipDevConverge(instanceServiceEnabled))) {
    return false;
  }
  emit({ _event: "dev_converge_skipped", reason });
  return true;
}
