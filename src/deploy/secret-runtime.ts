/**
 * Host secret files for Compose standalone `secrets:` (tmpfs `/run`).
 */

import { dirname, join } from "@std/path";
import { parse, stringify } from "yaml";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import type { EnvironmentDeploySecretPlanEntry } from "../instance/commands/contracts.ts";
import type { EnvironmentDeployVariableMaterial } from "../instance/commands/contracts.ts";

export const SECRET_FILE_MODE = 0o600;
export const SECRET_DIR_MODE = 0o700;
const DECRYPT_BATCH_SIZE = 100;

export function secretHostDirectory(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
): string {
  return join(
    layout.runDir,
    "deployments",
    projectId,
    environmentId,
    "secrets",
  );
}

export function secretHostPath(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  relativePath: string,
): string {
  return join(
    secretHostDirectory(layout, projectId, environmentId),
    relativePath,
  );
}

export async function removeSecretTree(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
): Promise<void> {
  try {
    await Deno.remove(secretHostDirectory(layout, projectId, environmentId), {
      recursive: true,
    });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

export async function plannedSecretsMissing(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  plan: readonly { relativePath: string }[],
): Promise<boolean> {
  for (const entry of plan) {
    try {
      const stat = await Deno.stat(
        secretHostPath(layout, projectId, environmentId, entry.relativePath),
      );
      if (!stat.isFile) return true;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return true;
      throw err;
    }
  }
  return false;
}

async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true, mode: SECRET_DIR_MODE });
  try {
    await Deno.chmod(dir, SECRET_DIR_MODE);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, content, { mode });
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
  await Deno.chmod(path, mode);
}

export async function writeSecretFiles(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  files: ReadonlyArray<{ relativePath: string; plaintext: string }>,
): Promise<void> {
  const dir = secretHostDirectory(layout, projectId, environmentId);
  await Deno.mkdir(dir, { recursive: true, mode: SECRET_DIR_MODE });
  try {
    await Deno.chmod(dir, SECRET_DIR_MODE);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  for (const file of files) {
    if (
      file.relativePath.includes("/") ||
      file.relativePath.includes("\\") ||
      file.relativePath.includes("..")
    ) {
      throw new Error(`unsafe secret relativePath: ${file.relativePath}`);
    }
    await writeFileAtomic(
      secretHostPath(layout, projectId, environmentId, file.relativePath),
      file.plaintext,
      SECRET_FILE_MODE,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rewriteComposeSecretFilePaths(
  yaml: string,
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  plan: readonly EnvironmentDeploySecretPlanEntry[],
): string {
  if (plan.length === 0) return yaml;
  const doc = parse(yaml) as unknown;
  if (!isRecord(doc) || !isRecord(doc.secrets)) return yaml;
  const secrets = { ...doc.secrets };
  for (const entry of plan) {
    const existing = secrets[entry.source];
    const next = isRecord(existing) ? { ...existing } : {};
    next.file = secretHostPath(
      layout,
      projectId,
      environmentId,
      entry.relativePath,
    );
    secrets[entry.source] = next;
  }
  return stringify({ ...doc, secrets }, { lineWidth: 0 });
}

function plaintextKey(
  entry: EnvironmentDeployVariableMaterial,
): string {
  return `${entry.composeServiceName ?? ""}::${entry.key}`;
}

async function decryptEnvelopes(
  decryptSecrets: DecryptSecretsFn,
  envelopes: readonly string[],
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (let i = 0; i < envelopes.length; i += DECRYPT_BATCH_SIZE) {
    const chunk = envelopes.slice(i, i + DECRYPT_BATCH_SIZE);
    const plaintexts = await decryptSecrets(chunk);
    if (plaintexts.length !== chunk.length) {
      throw new Error("secrets/decrypt returned unexpected length");
    }
    out.push(...plaintexts);
  }
  return out;
}

/**
 * Decrypt variable material and write `/run` secret files. Does not merge
 * plaintext into compose YAML.
 */
export async function materializeSecretFiles(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  plan: readonly EnvironmentDeploySecretPlanEntry[],
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn,
  options?: { requireAll?: boolean },
): Promise<void> {
  if (plan.length === 0) return;
  const requireAll = options?.requireAll !== false;
  if (material.length === 0) {
    if (requireAll) {
      throw new Error("secret plan present but variableMaterial is empty");
    }
    return;
  }
  const plaintexts = await decryptEnvelopes(
    decryptSecrets,
    material.map((entry) => entry.valueEnvelope),
  );
  const byKey = new Map<string, string>();
  for (let i = 0; i < material.length; i += 1) {
    const entry = material[i]!;
    const plaintext = plaintexts[i];
    if (plaintext === null || plaintext === undefined) {
      if (requireAll) {
        throw new Error(`Failed to decrypt secret variable ${entry.key}`);
      }
      continue;
    }
    byKey.set(plaintextKey(entry), plaintext);
  }
  const files: Array<{ relativePath: string; plaintext: string }> = [];
  for (const entry of plan) {
    const plaintext = byKey.get(`${entry.composeServiceName}::${entry.key}`);
    if (plaintext === undefined) {
      if (requireAll) {
        throw new Error(`No decrypted material for secret ${entry.key}`);
      }
      continue;
    }
    files.push({ relativePath: entry.relativePath, plaintext });
  }
  if (files.length === 0) return;
  await writeSecretFiles(layout, projectId, environmentId, files);
}
