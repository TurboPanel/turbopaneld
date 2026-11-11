/**
 * Generated config files for Compose `configs:` (tmpfs `/run`).
 *
 * The control plane sends each file as ordered parts (literal text, or the
 * name of a secret key) and the values for those keys sealed in
 * `variableMaterial[]`. The daemon decrypts the values through the same seam
 * as secret files, so every value joins the command's redaction deny-set, and
 * joins the parts into one file. Plaintext exists only in that file on the
 * `/run` tmpfs, in a daemon-only `0700` folder; `deployment.json` keeps the
 * parts (no values) so a reboot can rebuild it. Error text names the file and
 * the key, never content.
 */

import { join } from "@std/path";
import type {
  EnvironmentDeployConfigFile,
  EnvironmentDeployConfigFilePart,
  EnvironmentDeployVariableMaterial,
} from "../contracts/commands-contracts.ts";
import { forEachSequential } from "../util/sequential.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import {
  decryptEnvelopes,
  indexDecryptedMaterial,
  plaintextKey,
  plannedFilesMissingIn,
  pruneStaleFilesIn,
  removeFileTree,
  rewriteComposeFileSources,
  SECRET_FILE_MODE,
  writeFileAtomic,
} from "./secret-runtime.ts";

export function configHostDirectory(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
): string {
  return join(
    layout.runDir,
    "deployments",
    projectId,
    environmentId,
    "configs",
  );
}

export function removeConfigTree(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
): Promise<void> {
  return removeFileTree(configHostDirectory(layout, projectId, environmentId));
}

export function pruneStaleConfigFiles(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  files: readonly { relativePath: string }[],
): Promise<string[]> {
  return pruneStaleFilesIn(
    configHostDirectory(layout, projectId, environmentId),
    files,
  );
}

export function plannedConfigFilesMissing(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  files: readonly { relativePath: string }[],
): Promise<boolean> {
  return plannedFilesMissingIn(
    configHostDirectory(layout, projectId, environmentId),
    files,
  );
}

export function rewriteComposeConfigFilePaths(
  yaml: string,
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  files: readonly { source: string; relativePath: string }[],
): string {
  return rewriteComposeFileSources(
    yaml,
    "configs",
    configHostDirectory(layout, projectId, environmentId),
    files,
  );
}

/** The secret keys one file names, without repeats. */
function secretKeysOf(
  parts: readonly EnvironmentDeployConfigFilePart[],
): string[] {
  const keys = new Set<string>();
  for (const part of parts) {
    if ("secretKey" in part) keys.add(part.secretKey);
  }
  return [...keys];
}

/**
 * Join the parts in order. A key with no value throws an error naming the
 * file and key; values are inserted as they are and never scanned again.
 */
export function renderConfigFile(
  file: Pick<
    EnvironmentDeployConfigFile,
    "composeServiceName" | "relativePath" | "parts"
  >,
  plaintextByKey: ReadonlyMap<string, string>,
): string {
  let out = "";
  for (const part of file.parts) {
    if ("text" in part) {
      out += part.text;
      continue;
    }
    const value = plaintextByKey.get(
      `${file.composeServiceName}::${part.secretKey}`,
    );
    if (value === undefined) {
      throw new Error(
        `generated file ${file.relativePath}: no value for secret ${part.secretKey}`,
      );
    }
    out += value;
  }
  return out;
}

/** The target (and its `.tmp`) may only be absent or a regular file. */
async function assertRegularOrAbsent(path: string, name: string) {
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile) {
      throw new Error(`generated file ${name}: refusing a non-regular file`);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    relativePath.includes("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("..") ||
    relativePath.length === 0
  ) {
    throw new Error(`unsafe generated file relativePath: ${relativePath}`);
  }
}

/** Material entries the given files name, one per (service, key). */
function neededMaterial(
  files: readonly EnvironmentDeployConfigFile[],
  material: readonly EnvironmentDeployVariableMaterial[],
): EnvironmentDeployVariableMaterial[] {
  const wanted = new Set<string>();
  for (const file of files) {
    for (const key of secretKeysOf(file.parts)) {
      wanted.add(`${file.composeServiceName}::${key}`);
    }
  }
  const seen = new Set<string>();
  const out: EnvironmentDeployVariableMaterial[] = [];
  for (const entry of material) {
    const id = plaintextKey(entry);
    if (!wanted.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
  }
  return out;
}

/**
 * Decrypt the material the files name and write each file (`0444`, in a
 * `0700` daemon-owned folder). A file with only text needs no decryption and
 * no material. With `requireAll` (a deploy) a missing value refuses the whole
 * deploy before anything is written; without it (rehydrate) a file lacking
 * any value is skipped, never written with a gap, and the missing-file guard
 * then blocks `up`.
 */
export async function materializeConfigFiles(
  layout: { runDir: string },
  projectId: string,
  environmentId: string,
  files: readonly EnvironmentDeployConfigFile[],
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
  options?: { requireAll?: boolean },
): Promise<void> {
  if (files.length === 0) return;
  const requireAll = options?.requireAll !== false;
  for (const file of files) assertSafeRelativePath(file.relativePath);

  const needed = neededMaterial(files, material);
  let values = new Map<string, string>();
  if (needed.length > 0) {
    if (!decryptSecrets) {
      throw new Error(
        "Generated config files need secrets but secrets decrypt is unavailable",
      );
    }
    const plaintexts = await decryptEnvelopes(
      decryptSecrets,
      needed.map((entry) => entry.valueEnvelope),
    );
    values = indexDecryptedMaterial(needed, plaintexts, requireAll);
  }

  const rendered: Array<{ relativePath: string; content: string }> = [];
  for (const file of files) {
    const complete = secretKeysOf(file.parts).every((key) =>
      values.has(`${file.composeServiceName}::${key}`)
    );
    if (!complete && !requireAll) continue;
    rendered.push({
      relativePath: file.relativePath,
      content: renderConfigFile(file, values),
    });
  }

  const dir = configHostDirectory(layout, projectId, environmentId);
  await forEachSequential(rendered, async (file) => {
    const path = join(dir, file.relativePath);
    await assertRegularOrAbsent(path, file.relativePath);
    await assertRegularOrAbsent(`${path}.tmp`, file.relativePath);
    await writeFileAtomic(path, file.content, SECRET_FILE_MODE);
  });
}
