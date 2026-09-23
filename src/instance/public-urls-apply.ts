import { join } from "@std/path";
import {
  devOwnershipPlaybookExtraArgs,
  runLocalPlaybook,
} from "../orchestration/ansible.ts";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/assets.ts";
import { resolveDevRoot, resolveLayout } from "../paths/layout.ts";
import {
  preflightInstanceLetsEncryptHttp01,
  syncInstanceAcmeHttp01Site,
} from "../deploy/instance-acme-http01.ts";
import type {
  InstanceAcmeWireSettings,
  InstanceHostnameWireEntry,
} from "../contracts/cell-messages.ts";
import { upsertPublicUrlsInEnv } from "./public-urls-env.ts";

/** Wire hostname, including the one-hop decrypted upload pair. */
export type InstanceHostnameApplyEntry = InstanceHostnameWireEntry;

const UPLOADED_CERT_ID = /^[0-9a-f-]{36}$/i;

function stripTrailingSlashes(path: string): string {
  let out = path;
  while (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out.length > 0 ? out : "/";
}

function isCoLocatedDev(
  env: Record<string, string | undefined>,
): boolean {
  if (env.TURBOPANEL_DEV_USER?.trim()) return true;
  if (env.TURBOPANEL_DEV_INSTANCE === "1") return true;
  const mode = env.TURBOPANEL_MODE?.trim().toLowerCase();
  return mode === "development";
}

/**
 * Instance source tree for cert generation (`scripts/` + `certs/`).
 *
 * Co-located development uses the checkout (`TURBOPANEL_INSTANCE_REPO` or
 * `<devRoot>/turbopanel`). {@link resolveLayout}.instanceDir stays on the FHS
 * install root (`/opt/turbopanel`, where the compiled instance lies flat in
 * bin/) — that path has no generate script, so public-urls apply must not use
 * it in dev; a managed host runs the binary's own verb there instead.
 */
export function resolveInstanceDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  const explicit = env.TURBOPANEL_INSTANCE_DIR?.trim();
  if (explicit) {
    return stripTrailingSlashes(explicit);
  }

  const repo = env.TURBOPANEL_INSTANCE_REPO?.trim();
  if (repo) {
    return stripTrailingSlashes(repo);
  }

  if (isCoLocatedDev(env)) {
    return join(resolveDevRoot(env), "turbopanel");
  }

  return resolveLayout(env).instanceDir;
}

export {
  resolveInstanceConfigDir,
  resolveInstanceRuntimeEnvPath,
  upsertPublicUrlsInEnv,
} from "./public-urls-env.ts";

/** Certs directory the instance-certs role writes, matched to its defaults. */
export function resolveInstanceCertsDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  if (isCoLocatedDev(env)) {
    return join(resolveInstanceDir(env), "certs");
  }
  return join(resolveLayout(env).stateDir, "tls", "certs");
}

export function platformCaHosts(
  hostnames: readonly InstanceHostnameApplyEntry[],
): string[] {
  return hostnames
    .filter((entry) => entry.source === "platform-ca")
    .map((entry) => entry.host);
}

function ansibleHostname(entry: InstanceHostnameApplyEntry): {
  host: string;
  source: InstanceHostnameApplyEntry["source"];
  cert_id: string;
} {
  return {
    host: entry.host,
    source: entry.source,
    cert_id: entry.uploadedCertId ?? "",
  };
}

export async function writeUploadedInstanceCerts(
  hostnames: readonly InstanceHostnameApplyEntry[],
  certsDir: string,
): Promise<void> {
  const seen = new Set<string>();
  let wrote = false;
  for (const entry of hostnames) {
    if (entry.source !== "uploaded") continue;
    const id = entry.uploadedCertId;
    if (!id || !entry.certPem || !entry.keyPem) continue;
    if (!UPLOADED_CERT_ID.test(id)) {
      throw new Error(`refusing uploaded certificate id ${id}`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (!wrote) {
      await Deno.mkdir(certsDir, { recursive: true, mode: 0o750 });
      wrote = true;
    }
    await Deno.writeTextFile(
      join(certsDir, `uploaded-${id}.crt`),
      entry.certPem,
      {
        mode: 0o640,
      },
    );
    await Deno.writeTextFile(
      join(certsDir, `uploaded-${id}.key`),
      entry.keyPem,
      {
        mode: 0o640,
      },
    );
  }
}

export async function runInstanceCertsApply(
  instanceDir: string,
  hostnames: readonly InstanceHostnameApplyEntry[],
  deps: {
    runPlaybook?: typeof runLocalPlaybook;
    instanceAcme?: InstanceAcmeWireSettings;
  } = {},
): Promise<void> {
  const platformCa = platformCaHosts(hostnames);
  const extra: Record<string, unknown> = {
    turbopanel_hostnames: hostnames.map(ansibleHostname),
  };
  const email = deps.instanceAcme?.contactEmail.trim();
  if (email) extra.turbopanel_acme_email = email;
  const directory = deps.instanceAcme?.directoryUrl.trim();
  if (directory) extra.turbopanel_acme_directory = directory;
  const args = [
    "-e",
    `turbopanel_instance_dir=${instanceDir}`,
    "-e",
    `turbopanel_public_urls=${platformCa.join(",")}`,
    "-e",
    JSON.stringify(extra),
    ...devOwnershipPlaybookExtraArgs(),
  ];
  const runPlaybook = deps.runPlaybook ?? runLocalPlaybook;
  await runPlaybook(INSTANCE_CERTS_APPLY_PLAYBOOK, args);
}

export async function applyPublicUrls(
  hostnames: readonly InstanceHostnameApplyEntry[],
  deps: {
    runCertsApply?: typeof runInstanceCertsApply;
    instanceAcme?: InstanceAcmeWireSettings;
    writeUploadedCerts?: typeof writeUploadedInstanceCerts;
    syncChallenge?: typeof syncInstanceAcmeHttp01Site;
    preflightLetsEncrypt?: typeof preflightInstanceLetsEncryptHttp01;
  } = {},
): Promise<void> {
  const instanceDir = resolveInstanceDir();
  await upsertPublicUrlsInEnv(platformCaHosts(hostnames));
  const writeUploaded = deps.writeUploadedCerts ?? writeUploadedInstanceCerts;
  await writeUploaded(hostnames, resolveInstanceCertsDir());
  const preflight = deps.preflightLetsEncrypt ??
    preflightInstanceLetsEncryptHttp01;
  await preflight(hostnames, resolveLayout(Deno.env.toObject()));
  const runCerts = deps.runCertsApply ?? runInstanceCertsApply;
  await runCerts(instanceDir, hostnames, {
    instanceAcme: deps.instanceAcme,
  });
  const syncChallenge = deps.syncChallenge ?? syncInstanceAcmeHttp01Site;
  await syncChallenge(resolveLayout(Deno.env.toObject()));
}
