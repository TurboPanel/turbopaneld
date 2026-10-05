/**
 * Environment variables for native (`serviceKind: node`) apps.
 *
 * A native app is not in the compose document the host runs, so Compose's
 * `environment:` can never reach it. The control plane instead sends the
 * resolved list on `nativeAppServices[].variables`: plain values inline, and
 * secrets as a pointer (`secretKey`) into the daemon-sealed
 * `variableMaterial[]` the deploy already carries. This module turns that into
 * one private file per app, `<configDir>/node-apps/envs/<serviceId>.env`,
 * which the unit loads with `EnvironmentFile=`.
 *
 * Why a file and not `Environment=` lines: a unit is `0644` and its text is
 * readable by anyone through `systemctl show`, and systemd expands `%` inside
 * it. The file is `0600` in a `0700` directory and is read by systemd as root
 * before it drops to the app's user.
 *
 * The file is written on **every** deploy (and removed when the app has no
 * variables left), before the unit is installed and started, so a variable
 * change reaches the process with the same restart that picks up a release.
 * Values are never logged; only names are.
 */

import { join } from "@std/path";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployVariableMaterial,
} from "../../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import {
  NATIVE_APP_PLATFORM_ENV_NAMES,
  nativeAppEnvDir,
  nativeAppEnvPath,
} from "./unit.ts";

export const NATIVE_APP_ENV_FILE_MODE = 0o600;
export const NATIVE_APP_ENV_DIR_MODE = 0o700;
const DECRYPT_BATCH_SIZE = 100;

export type NativeAppEnvEntry = { name: string; value: string };

export type ResolvedNativeAppVariables = {
  /** What the process will see, sorted by name. */
  entries: NativeAppEnvEntry[];
  /** Names left out because the unit sets them itself. */
  platformManaged: string[];
};

function materialKey(
  composeServiceName: string | null,
  key: string,
): string {
  return `${composeServiceName ?? ""}::${key}`;
}

/** Sealed envelopes this app needs, by `${composeServiceName}::${key}`. */
function secretEnvelopes(
  app: EnvironmentDeployNativeAppService,
  material: readonly EnvironmentDeployVariableMaterial[],
): Map<string, string> {
  const wanted = new Set(
    (app.variables ?? []).flatMap((entry) =>
      entry.secretKey === undefined
        ? []
        : [materialKey(app.composeServiceName, entry.secretKey)]
    ),
  );
  const envelopes = new Map<string, string>();
  for (const entry of material) {
    const key = materialKey(entry.composeServiceName, entry.key);
    if (wanted.has(key)) envelopes.set(key, entry.valueEnvelope);
  }
  return envelopes;
}

async function decryptInBatches(
  decryptSecrets: DecryptSecretsFn,
  envelopes: readonly string[],
): Promise<(string | null)[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < envelopes.length; i += DECRYPT_BATCH_SIZE) {
    chunks.push(envelopes.slice(i, i + DECRYPT_BATCH_SIZE));
  }
  const out: (string | null)[] = [];
  // One batch at a time: that is what the batch size is for.
  await forEachSequential(chunks, async (chunk) => {
    const plaintexts = await decryptSecrets(chunk);
    if (plaintexts.length !== chunk.length) {
      throw new Error("secrets/decrypt returned unexpected length");
    }
    out.push(...plaintexts);
  });
  return out;
}

/**
 * Decrypt the secrets this app references and merge them with its plain
 * values. A referenced secret with no sealed material, or one that will not
 * decrypt, fails the deploy: starting the app without a credential it was told
 * it has is worse than not starting it, and the error names the variable, never
 * its value.
 */
export async function resolveNativeAppVariables(
  app: EnvironmentDeployNativeAppService,
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<ResolvedNativeAppVariables> {
  const platformManaged: string[] = [];
  const wanted = (app.variables ?? []).filter((entry) => {
    if (!NATIVE_APP_PLATFORM_ENV_NAMES.has(entry.name)) return true;
    platformManaged.push(entry.name);
    return false;
  });

  const sealed = secretEnvelopes(app, material);
  const secretNames: string[] = [];
  const envelopes: string[] = [];
  for (const entry of wanted) {
    if (entry.secretKey === undefined) continue;
    const envelope = sealed.get(
      materialKey(app.composeServiceName, entry.secretKey),
    );
    if (envelope === undefined) {
      throw new Error(
        `native app ${app.composeServiceName}: no sealed value for secret variable ${entry.name}`,
      );
    }
    secretNames.push(entry.name);
    envelopes.push(envelope);
  }
  if (envelopes.length > 0 && !decryptSecrets) {
    throw new Error(
      "Native app secret variables present but decrypt is unavailable",
    );
  }
  const plaintexts = decryptSecrets
    ? await decryptInBatches(decryptSecrets, envelopes)
    : [];
  const secretValues = new Map<string, string>();
  secretNames.forEach((name, index) => {
    const plaintext = plaintexts[index];
    if (plaintext === null || plaintext === undefined) {
      throw new Error(
        `native app ${app.composeServiceName}: failed to decrypt secret variable ${name}`,
      );
    }
    secretValues.set(name, plaintext);
  });

  const entries = wanted.map((entry) => ({
    name: entry.name,
    value: entry.value ?? secretValues.get(entry.name) ?? "",
  }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { entries, platformManaged };
}

/**
 * One `NAME=value` line, in the quoting systemd's env-file parser reads back
 * exactly: single quotes keep everything literal (no `$`, no backslash
 * escapes), which is every value except one that itself holds a `'`; that one
 * goes in double quotes with the four characters systemd treats specially
 * there (`\`, `"`, `` ` ``, `$`) backslash-escaped.
 */
export function renderNativeAppEnvLine(entry: NativeAppEnvEntry): string {
  if (!entry.value.includes("'")) return `${entry.name}='${entry.value}'`;
  const escaped = entry.value.replaceAll(/[\\"`$]/g, String.raw`\$&`);
  return `${entry.name}="${escaped}"`;
}

export function renderNativeAppEnvFile(
  entries: readonly NativeAppEnvEntry[],
): string {
  return [
    "# Managed by TurboPanel — rewritten on every deploy; edits are overwritten.",
    ...entries.map(renderNativeAppEnvLine),
    "",
  ].join("\n");
}

/**
 * Write the app's environment file (temp file + rename, `0600`).
 *
 * The rename keeps systemd from ever reading a half-written file when a
 * restart races a deploy, and the file is created `0600` rather than chmodded
 * afterwards so a secret is never on disk with a wider mode, even briefly.
 */
export async function writeNativeAppEnvFile(
  layout: Pick<LayoutPaths, "configDir">,
  serviceId: string,
  entries: readonly NativeAppEnvEntry[],
): Promise<void> {
  const dir = nativeAppEnvDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: NATIVE_APP_ENV_DIR_MODE });
  await Deno.chmod(dir, NATIVE_APP_ENV_DIR_MODE);
  const path = nativeAppEnvPath(layout, serviceId);
  const tmp = join(dir, `.${serviceId}.env.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, renderNativeAppEnvFile(entries), {
      mode: NATIVE_APP_ENV_FILE_MODE,
      createNew: true,
    });
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => undefined);
    throw err;
  }
}

/** Remove the app's environment file. Absent is fine: nothing to clean. */
export async function removeNativeAppEnvFile(
  layout: Pick<LayoutPaths, "configDir">,
  serviceId: string,
): Promise<void> {
  try {
    await Deno.remove(nativeAppEnvPath(layout, serviceId));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Bring the app's environment file in line with this deploy. Returns whether
 * the unit should load one, and the platform-managed names that were left out
 * (so the transcript can say why a variable did not arrive).
 */
export async function materializeNativeAppVariables(
  layout: Pick<LayoutPaths, "configDir">,
  app: EnvironmentDeployNativeAppService,
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<
  { environmentFile: boolean; count: number; platformManaged: string[] }
> {
  const { entries, platformManaged } = await resolveNativeAppVariables(
    app,
    material,
    decryptSecrets,
  );
  if (entries.length === 0) {
    await removeNativeAppEnvFile(layout, app.serviceId);
    return { environmentFile: false, count: 0, platformManaged };
  }
  await writeNativeAppEnvFile(layout, app.serviceId, entries);
  return { environmentFile: true, count: entries.length, platformManaged };
}
