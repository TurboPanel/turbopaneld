/**
 * SMB share logins for `cifs` / `smb3` volumes (`network-shares-v1`).
 *
 * Docker's local volume driver calls mount(2) itself, not `mount.cifs`, and
 * the kernel cifs client ignores `credentials=`: only `username=`,
 * `password=` and `domain=` in `o` authenticate. So the control plane never
 * puts a login in compose text; it sends it as sealed `variableMaterial`
 * named by `networkShareCredentials`, and the daemon adds the three options to
 * the staged compose it publishes (the `0640` compose file in the deployment
 * folder, like the `.env` beside it; the one `docker compose up` reads, also
 * after a reboot). No separate login file
 * exists. Docker keeps the options in its own root-only volume store.
 *
 * Docker and Compose cache a volume's options, and a non-interactive
 * `compose up` declines to recreate a volume whose options changed. The
 * daemon therefore appends a keyed fingerprint (an HMAC under a daemon-only
 * secret) of the final options to the Docker volume name
 * (`<project>_<volume>_<fingerprint>`): a changed login is a new volume that
 * mounts with the new login, and the volumes of earlier fingerprints are
 * removed after a successful deploy (the share's data lives on the server,
 * not in the Docker volume).
 *
 * Values must be one line with no comma (Docker and the kernel both split `o`
 * on commas); a `$` is escaped for Compose and arrives intact.
 */

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
} from "./secret-runtime.ts";

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_VALUE_LENGTH = 256;
const FINGERPRINT_LENGTH = 12;
/** Options the daemon owns on a share that has a login; authored copies are replaced. */
const LOGIN_OPTION_KEYS = new Set([
  "username",
  "user",
  "password",
  "pass",
  "pwd",
  "password2",
  "domain",
  "workgroup",
  "credentials",
  "cred",
]);

export type ShareLogin = {
  username: string;
  password: string;
  domain?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line, no comma, no control character, not empty. */
function assertLoginValue(value: string, what: string): void {
  if (value.length === 0) throw new Error(`share login ${what} is empty`);
  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error(`share login ${what} is too long`);
  }
  if (value.includes(",")) {
    throw new Error(
      `share login ${what} contains a comma, which mount options cannot carry`,
    );
  }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new Error(`share login ${what} contains a control character`);
    }
  }
}

function materialKey(
  entry: EnvironmentDeployNetworkShareCredential,
  key: string,
): string {
  return `${entry.composeServiceName ?? ""}::${key}`;
}

/**
 * Decrypt the logins, by volume name. A missing key, a missing value, a
 * duplicate volume, a volume name that is not a plain name or a value that
 * cannot ride in mount options refuses the deploy before anything is written.
 */
export async function resolveShareLogins(
  entries: readonly EnvironmentDeployNetworkShareCredential[],
  material: readonly EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn | undefined,
): Promise<Map<string, ShareLogin>> {
  const logins = new Map<string, ShareLogin>();
  if (entries.length === 0) return logins;

  const wanted = wantedMaterial(entries);
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
      "Network share logins need secrets but secrets decrypt is unavailable",
    );
  }
  const plaintexts = await decryptEnvelopes(
    decryptSecrets,
    needed.map((item) => item.valueEnvelope),
  );
  const values = indexDecryptedMaterial(needed, plaintexts, true);
  for (const entry of entries) {
    logins.set(entry.volume, loginOf(entry, values));
  }
  return logins;
}

/** The material keys the entries name; refuses a bad or repeated volume. */
function wantedMaterial(
  entries: readonly EnvironmentDeployNetworkShareCredential[],
): Set<string> {
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
  return wanted;
}

function loginOf(
  entry: EnvironmentDeployNetworkShareCredential,
  values: ReadonlyMap<string, string>,
): ShareLogin {
  const password = values.get(materialKey(entry, entry.passwordKey));
  const username = entry.usernameKey !== undefined
    ? values.get(materialKey(entry, entry.usernameKey))
    : entry.username;
  if (password === undefined || username === undefined) {
    throw new Error(`no sealed login for the share volume ${entry.volume}`);
  }
  assertLoginValue(username, "username");
  assertLoginValue(password, "password");
  if (entry.domain !== undefined) assertLoginValue(entry.domain, "domain");
  return {
    username,
    password,
    ...(entry.domain === undefined ? {} : { domain: entry.domain }),
  };
}

/** The `o` tokens the daemon injects for a login. */
export function loginTokens(login: ShareLogin): string[] {
  return [
    `username=${login.username}`,
    `password=${login.password}`,
    ...(login.domain === undefined ? [] : [`domain=${login.domain}`]),
  ];
}

/**
 * The volume-name fingerprint: an HMAC-SHA-256 under a daemon-only secret, so
 * a volume name that reaches a log or `docker volume ls` does not let anyone
 * test password guesses offline.
 */
export async function fingerprint(
  secret: Uint8Array,
  parts: readonly string[],
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(JSON.stringify(["tp-smb-login-v1", ...parts])),
  );
  return Array.from(
    new Uint8Array(mac),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("").slice(0, FINGERPRINT_LENGTH);
}

const SHARE_TYPES: ReadonlySet<string> = new Set(["cifs", "smb3"]);

export type AppliedShareLogins = {
  yaml: string;
  /** Volume to the exact tokens injected into its `o`. */
  injected: Map<string, string[]>;
  /** Volume to the Docker volume name it now has. */
  volumeNames: Map<string, string>;
};

/** `$` is Compose's interpolation character; `$$` reaches the mount as `$`. */
function escapeForCompose(value: string): string {
  return value.replaceAll("$", "$$$$");
}

type PlannedShareVolume = {
  name: string;
  spec: Record<string, unknown>;
  opts: Record<string, unknown>;
  device: string;
  tokens: string[];
  final: string[];
};

/** One share volume with its login folded into `o`; nothing is written yet. */
function planShareVolume(
  volumes: Record<string, unknown>,
  name: string,
  login: ShareLogin,
): PlannedShareVolume {
  const spec = volumes[name];
  if (!isRecord(spec) || !isRecord(spec.driver_opts)) {
    throw new Error(
      `networkShareCredentials names volume ${name}, which is not a share volume`,
    );
  }
  const opts = { ...spec.driver_opts };
  const kept = typeof opts.o === "string"
    ? splitMountOptions(opts.o).filter((token) => {
      const key = token.split("=")[0].trim().toLowerCase();
      return token.trim() !== "" && !LOGIN_OPTION_KEYS.has(key);
    })
    : [];
  const tokens = loginTokens(login);
  const final = [...kept, ...tokens];
  opts.o = final.map(escapeForCompose).join(",");
  const device = typeof opts.device === "string" ? opts.device : "";
  return { name, spec, opts, device, tokens, final };
}

/**
 * Give each named share volume its login in `o` (replacing any
 * `username=`/`domain=`/`credentials=` the author wrote) and a Docker volume
 * name carrying the login's fingerprint. A named volume that is absent from
 * the compose file or has no `driver_opts` refuses the deploy: a login with no
 * share to belong to is an error, not something to ignore.
 */
export async function applyShareLoginsToCompose(
  yaml: string,
  projectName: string,
  logins: ReadonlyMap<string, ShareLogin>,
  secret: Uint8Array,
): Promise<AppliedShareLogins> {
  const injected = new Map<string, string[]>();
  const volumeNames = new Map<string, string>();
  if (logins.size === 0) return { yaml, injected, volumeNames };
  const doc = parse(yaml) as unknown;
  if (!isRecord(doc) || !isRecord(doc.volumes)) {
    throw new Error("networkShareCredentials names volumes the compose lacks");
  }
  const volumes = { ...doc.volumes };
  const planned = [...logins].map(([name, login]) =>
    planShareVolume(volumes, name, login)
  );
  const prints = await Promise.all(
    planned.map((plan) =>
      fingerprint(secret, [projectName, plan.name, plan.device, ...plan.final])
    ),
  );
  planned.forEach((plan, i) => {
    const volumeName = `${projectName}_${plan.name}_${prints[i]}`;
    volumes[plan.name] = {
      ...plan.spec,
      name: volumeName,
      driver_opts: plan.opts,
    };
    injected.set(plan.name, plan.tokens);
    volumeNames.set(plan.name, volumeName);
  });
  return {
    yaml: stringify({ ...doc, volumes }, { lineWidth: 0 }),
    injected,
    volumeNames,
  };
}

type RunDocker = (
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/** The exact name of a share volume of `volume`: `<project>_<volume>_<12 hex>`. */
function shareVolumeShape(projectName: string, volume: string): RegExp {
  const suffix = `_[0-9a-f]{${FINGERPRINT_LENGTH}}$`;
  return new RegExp(
    "^" + escapeRegExp(projectName) + "_" + escapeRegExp(volume) + suffix,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Remove the Docker volumes this project made for a share under an earlier
 * login (same compose volume, other fingerprint). Only a name of exactly
 * `<project>_<volume>_<12 hex>` goes: the unsuffixed `<project>_<volume>` of
 * a volume that used to be local holds real data and is never removed. Best
 * effort: one still in use stays and is retried by the next deploy. Returns
 * the names removed.
 */
export async function pruneStaleShareVolumes(
  projectName: string,
  current: ReadonlyMap<string, string>,
  run: RunDocker,
): Promise<string[]> {
  const perVolume = await Promise.all(
    [...current].map(([volume, keep]) =>
      pruneVolume(projectName, volume, keep, run)
    ),
  );
  return perVolume.flat();
}

async function pruneVolume(
  projectName: string,
  volume: string,
  keep: string,
  run: RunDocker,
): Promise<string[]> {
  const shape = shareVolumeShape(projectName, volume);
  const listed = await run([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
    "--filter",
    `label=com.docker.compose.volume=${volume}`,
  ]);
  if (!listed.success) return [];
  const stale = listed.stdout.split("\n").map((l) => l.trim())
    .filter((name) => name !== keep && shape.test(name));
  const results = await Promise.all(
    stale.map(async (name) =>
      (await run(["volume", "rm", name])).success ? name : null
    ),
  );
  return results.filter((name): name is string => name !== null);
}

/**
 * On an environment delete: remove every share volume of the project, by the
 * same name shape (`<project>_<compose volume>_<12 hex>`, the compose volume
 * read from Docker's label). Best effort, never throws.
 */
export async function removeProjectShareVolumes(
  projectName: string,
  run: RunDocker,
): Promise<string[]> {
  try {
    const listed = await run([
      "volume",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--format",
      '{{.Name}}\t{{.Label "com.docker.compose.volume"}}',
    ]);
    if (!listed.success) return [];
    const candidates: string[] = [];
    for (const line of listed.stdout.split("\n")) {
      const [name, volume] = line.split("\t").map((part) => part.trim());
      if (name && volume && shareVolumeShape(projectName, volume).test(name)) {
        candidates.push(name);
      }
    }
    const results = await Promise.all(
      candidates.map(async (name) => {
        const type = await run([
          "volume",
          "inspect",
          "--format",
          '{{index .Options "type"}}',
          name,
        ]);
        if (!type.success || !SHARE_TYPES.has(type.stdout.trim())) return null;
        return (await run(["volume", "rm", name])).success ? name : null;
      }),
    );
    return results.filter((name): name is string => name !== null);
  } catch {
    // Best effort: a leftover volume holds only a mount, not data.
    return [];
  }
}
