/**
 * Environment variables for native (`serviceKind: node`) apps.
 *
 * A native app is not in the compose document the host runs, so Compose's
 * `environment:` can never reach it. The control plane instead sends the
 * resolved list on `nativeAppServices[].variables`: plain values inline, and
 * secrets as a pointer (`secretKey`) into the daemon-sealed
 * `variableMaterial[]` the deploy already carries. This module turns that into
 * one private file per app that the unit loads with `EnvironmentFile=`.
 *
 * Why a file and not `Environment=` lines: a unit is `0644` and its text is
 * readable by anyone through `systemctl show`, and systemd expands `%` inside
 * it. The file is `0600` and is read by systemd as root before it drops to the
 * app's user.
 *
 * Why two copies: systemd reads the file as root, so the unit must not name a
 * path the daemon account can write (it could swap in a link to any root-only
 * file after `tp-host` checked the unit). The daemon therefore only *stages*
 * the file, `<configDir>/node-apps/envs/<serviceId>.env`, and asks
 * `tp-host app-env-install <serviceId>` to copy it, after checking it, into a
 * folder only root can write (`<configDir>/node-app-env/`). The unit names that
 * copy; the staged file is deleted as soon as the copy is made.
 *
 * The copy is made on **every** deploy, before the unit is installed and
 * started, so a variable change reaches the process with the same restart that
 * picks up a release. An app left with no variables loses its copy only after
 * its unit (now without `EnvironmentFile=`) is in place and running. Values are
 * never logged; only names are.
 */

import { join } from "@std/path";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployVariableMaterial,
} from "../../contracts/commands-contracts.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import { forEachSequential } from "../../util/sequential.ts";
import type { RunFn } from "../ensure-principal.ts";
import type { DecryptSecretsFn } from "../materialize-tls.ts";
import {
  NATIVE_APP_PLATFORM_ENV_NAMES,
  nativeAppEnvStageDir,
  nativeAppEnvStagePath,
} from "./unit.ts";

export const NATIVE_APP_ENV_FILE_MODE = 0o600;
export const NATIVE_APP_ENV_DIR_MODE = 0o700;
/**
 * Largest variables file `tp-host app-env-install` copies (TP_APPENV_MAX in
 * orchestration/scripts/tp-host; a test keeps the two equal). The contract's
 * worst case, 256 variables of 64 KiB, would not fit an environment block
 * anyway; refusing here names the app instead of failing in root's helper.
 */
export const NATIVE_APP_ENV_MAX_BYTES = 1_048_576;
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
 * Stage the app's environment file (temp file + rename, `0600`).
 *
 * The rename keeps `tp-host` from ever reading a half-written file, and the
 * file is created `0600` rather than chmodded afterwards so a secret is never
 * on disk with a wider mode, even briefly.
 */
export async function stageNativeAppEnvFile(
  layout: Pick<LayoutPaths, "configDir">,
  serviceId: string,
  entries: readonly NativeAppEnvEntry[],
): Promise<void> {
  const text = renderNativeAppEnvFile(entries);
  const size = new TextEncoder().encode(text).length;
  if (size > NATIVE_APP_ENV_MAX_BYTES) {
    throw new Error(
      `native app ${serviceId}: its environment variables come to ${size} bytes, over the ${NATIVE_APP_ENV_MAX_BYTES} byte limit`,
    );
  }
  const dir = nativeAppEnvStageDir(layout);
  await Deno.mkdir(dir, { recursive: true, mode: NATIVE_APP_ENV_DIR_MODE });
  await Deno.chmod(dir, NATIVE_APP_ENV_DIR_MODE);
  const path = nativeAppEnvStagePath(layout, serviceId);
  const tmp = join(dir, `.${serviceId}.env.${crypto.randomUUID()}.tmp`);
  try {
    await Deno.writeTextFile(tmp, text, {
      mode: NATIVE_APP_ENV_FILE_MODE,
      createNew: true,
    });
    await Deno.rename(tmp, path);
  } catch (err) {
    await Deno.remove(tmp).catch(() => undefined);
    throw err;
  }
}

/** Remove the staged file. Absent is fine: nothing to clean. */
export async function removeStagedNativeAppEnvFile(
  layout: Pick<LayoutPaths, "configDir">,
  serviceId: string,
): Promise<void> {
  try {
    await Deno.remove(nativeAppEnvStagePath(layout, serviceId));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/** Ask `tp-host` to check the staged file and copy it where only root writes. */
export async function installNativeAppEnvCopy(
  run: RunFn,
  serviceId: string,
): Promise<void> {
  const result = await run(
    "sudo",
    hostSudoArgs(["-n", "app-env-install", serviceId]),
  );
  if (!result.success) {
    throw new Error(
      `native app ${serviceId}: installing its environment file failed: ${
        result.stderr.trim() || "tp-host refused it"
      }`,
    );
  }
}

/**
 * Remove the root-owned copy and any staged file. Absent is fine. A refusal is
 * an error: a secret left on disk for an app that no longer wants it is the
 * thing this is for.
 */
export async function removeNativeAppEnvFile(
  run: RunFn,
  layout: Pick<LayoutPaths, "configDir">,
  serviceId: string,
): Promise<void> {
  await removeStagedNativeAppEnvFile(layout, serviceId);
  const result = await run(
    "sudo",
    hostSudoArgs(["-n", "app-env-remove", serviceId]),
  );
  if (!result.success) {
    throw new Error(
      `native app ${serviceId}: removing its environment file failed: ${
        result.stderr.trim() || "tp-host refused it"
      }`,
    );
  }
}

/**
 * Bring the app's environment file in line with this deploy. Returns whether
 * the unit should load one, and the platform-managed names that were left out
 * (so the transcript can say why a variable did not arrive).
 *
 * With variables: stage, have `tp-host` copy it, delete the staged file (also
 * when the copy fails). Without: nothing is touched on the root side here (see
 * {@link removeNativeAppEnvFile}, which the caller runs once the unit that no
 * longer loads the file is in place); a stale staged file is dropped.
 */
export async function materializeNativeAppVariables(
  layout: Pick<LayoutPaths, "configDir">,
  app: EnvironmentDeployNativeAppService,
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
  run: RunFn,
): Promise<
  { environmentFile: boolean; count: number; platformManaged: string[] }
> {
  const { entries, platformManaged } = await resolveNativeAppVariables(
    app,
    material,
    decryptSecrets,
  );
  if (entries.length === 0) {
    await removeStagedNativeAppEnvFile(layout, app.serviceId);
    return { environmentFile: false, count: 0, platformManaged };
  }
  try {
    await stageNativeAppEnvFile(layout, app.serviceId, entries);
    await installNativeAppEnvCopy(run, app.serviceId);
  } finally {
    await removeStagedNativeAppEnvFile(layout, app.serviceId);
  }
  return { environmentFile: true, count: entries.length, platformManaged };
}
