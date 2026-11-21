/**
 * SMB share logins as a cifs credentials file (`network-shares-v1`).
 *
 * The control plane never puts a share password in compose text. It sends the
 * login as sealed `variableMaterial` and names it in `networkShareCredentials`;
 * the daemon decrypts it, writes one `0600` file per share volume in its own
 * folder in the persistent state dir
 * (`<stateDir>/deployments/<project>/<env>/smb`) and adds
 * `credentials=<that file>` to the volume's `o`. The file lives on disk, not
 * on the `/run` tmpfs, because Docker restarts containers after a reboot and
 * the mount reads it again. The folder is removed on stop and every deploy
 * rewrites it, removing files of volumes that left the payload.
 *
 * The file belongs to the daemon account (the daemon has no way to hand a file
 * to root); mode `0600` in a `0700` folder keeps every other host account out,
 * and the Docker daemon (root) reads it when the volume mounts.
 */

import { join } from "@std/path";
import { parse, stringify } from "yaml";
import type {
  EnvironmentDeployNetworkShareCredential,
  EnvironmentDeployVariableMaterial,
} from "../contracts/commands-contracts.ts";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import { splitMountOptions } from "./network-shares.ts";
import {
  decryptEnvelopes,
  indexDecryptedMaterial,
  plaintextKey,
  removeFileTree,
  writeFileAtomic,
} from "./secret-runtime.ts";

const CREDENTIALS_FILE_MODE = 0o600;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function shareCredentialsDirectory(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
): string {
  return join(layout.stateDir, "deployments", projectId, environmentId, "smb");
}

export function removeShareCredentialsTree(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
): Promise<void> {
  return removeFileTree(
    shareCredentialsDirectory(layout, projectId, environmentId),
  );
}

/** A value on one line with no control characters (no extra line can slip in). */
function assertLineSafe(value: string, what: string): void {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new Error(`share credential ${what} contains a control character`);
    }
  }
  if (value.length === 0) throw new Error(`share credential ${what} is empty`);
}

/** The file body: `username=`, `password=` and (when set) `domain=` lines. */
export function renderShareCredentials(
  login: { username: string; password: string; domain?: string },
): string {
  assertLineSafe(login.username, "username");
  assertLineSafe(login.password, "password");
  const lines = [`username=${login.username}`, `password=${login.password}`];
  if (login.domain !== undefined) {
    assertLineSafe(login.domain, "domain");
    lines.push(`domain=${login.domain}`);
  }
  return `${lines.join("\n")}\n`;
}

function materialKey(
  entry: EnvironmentDeployNetworkShareCredential,
  key: string,
): string {
  return `${entry.composeServiceName ?? ""}::${key}`;
}

/**
 * Decrypt the logins and write one file per share volume; files of volumes that
 * left the payload are removed. A missing key, a missing value, a duplicate volume or a
 * volume name that is not a plain name refuses the deploy before anything is
 * written. Returns volume name to file path.
 */
export async function materializeShareCredentials(
  layout: { stateDir: string },
  projectId: string,
  environmentId: string,
  entries: readonly EnvironmentDeployNetworkShareCredential[],
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<Map<string, string>> {
  const dir = shareCredentialsDirectory(layout, projectId, environmentId);
  const paths = new Map<string, string>();
  if (entries.length === 0) {
    await removeFileTree(dir);
    return paths;
  }
  if (dir.includes(",")) {
    throw new Error("the share credentials folder path contains a comma");
  }

  const volumes = new Set<string>();
  const wanted = new Set<string>();
  for (const entry of entries) {
    if (!VOLUME_NAME.test(entry.volume)) {
      throw new Error("a networkShareCredentials volume name is not valid");
    }
    if (volumes.has(entry.volume)) {
      throw new Error(
        `networkShareCredentials names volume ${entry.volume} twice`,
      );
    }
    volumes.add(entry.volume);
    wanted.add(materialKey(entry, entry.passwordKey));
    if (entry.usernameKey !== undefined) {
      wanted.add(materialKey(entry, entry.usernameKey));
    }
  }
  const needed: EnvironmentDeployVariableMaterial[] = [];
  const seen = new Set<string>();
  for (const item of material) {
    const id = plaintextKey(item);
    if (wanted.has(id) && !seen.has(id)) {
      seen.add(id);
      needed.push(item);
    }
  }
  if (!decryptSecrets) {
    throw new Error(
      "Network share credentials need secrets but secrets decrypt is unavailable",
    );
  }
  const plaintexts = await decryptEnvelopes(
    decryptSecrets,
    needed.map((item) => item.valueEnvelope),
  );
  const values = indexDecryptedMaterial(needed, plaintexts, true);

  const rendered: Array<[string, string]> = [];
  for (const entry of entries) {
    const password = values.get(materialKey(entry, entry.passwordKey));
    const username = entry.usernameKey !== undefined
      ? values.get(materialKey(entry, entry.usernameKey))
      : entry.username;
    if (password === undefined || username === undefined) {
      throw new Error(
        `no sealed login for the share volume ${entry.volume}`,
      );
    }
    rendered.push([
      entry.volume,
      renderShareCredentials({ username, password, domain: entry.domain }),
    ]);
  }
  for (const [volume, content] of rendered) {
    const path = join(dir, `${volume}.cred`);
    await writeFileAtomic(path, content, CREDENTIALS_FILE_MODE);
    paths.set(volume, path);
  }
  await removeStaleShareCredentials(dir, new Set(paths.values()));
  return paths;
}

/** A login that left the payload must not stay on disk. */
async function removeStaleShareCredentials(
  dir: string,
  keep: ReadonlySet<string>,
): Promise<void> {
  for await (const item of Deno.readDir(dir)) {
    const path = join(dir, item.name);
    if (!keep.has(path)) await Deno.remove(path, { recursive: true });
  }
}

/**
 * Give each named volume `credentials=<file>` in its `o` (replacing any
 * `credentials=` the author wrote). A named volume that is absent from the
 * compose file, or has no `driver_opts`, refuses the deploy: a login with no
 * share to belong to is an error, not something to ignore.
 */
export function applyShareCredentialsToCompose(
  yaml: string,
  paths: ReadonlyMap<string, string>,
): string {
  if (paths.size === 0) return yaml;
  const doc = parse(yaml) as unknown;
  if (!isRecord(doc) || !isRecord(doc.volumes)) {
    throw new Error("networkShareCredentials names volumes the compose lacks");
  }
  const volumes = { ...doc.volumes };
  for (const [name, path] of paths) {
    const spec = volumes[name];
    if (!isRecord(spec) || !isRecord(spec.driver_opts)) {
      throw new Error(
        `networkShareCredentials names volume ${name}, which is not a share volume`,
      );
    }
    const opts = { ...spec.driver_opts };
    const kept = typeof opts.o === "string"
      ? splitMountOptions(opts.o).filter((token) =>
        !/^\s*credentials\s*=/i.test(token) && token.trim() !== ""
      )
      : [];
    opts.o = [...kept, `credentials=${path}`].join(",");
    volumes[name] = { ...spec, driver_opts: opts };
  }
  return stringify({ ...doc, volumes }, { lineWidth: 0 });
}
