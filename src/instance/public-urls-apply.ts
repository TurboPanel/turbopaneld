import { join } from "@std/path";
import {
  devOwnershipPlaybookExtraArgs,
  runLocalPlaybook,
} from "../orchestration/ansible.ts";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/assets.ts";
import {
  mergeDevCertPublicUrls,
  readDevForwardHostsFile,
} from "../orchestration/dev-forward-hosts.ts";
import { resolveDevRoot, resolveLayout } from "../paths/layout.ts";
import {
  closeInstanceAcmeWindow,
  issueInstanceLetsEncryptCertificates,
  letsEncryptHostnames,
  openInstanceAcmeWindow,
  preflightInstanceLetsEncryptHttp01,
  withInstanceAcmeWindowLock,
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

/**
 * Leaf SANs for instance-certs. Operator platform-ca hosts only, plus the
 * Vagrant host LAN names in co-located dev. Those names are not hostname rows.
 */
export function certificateGenerationPublicUrls(
  hostnames: readonly InstanceHostnameApplyEntry[],
  env: Record<string, string | undefined> = Deno.env.toObject(),
  readForwardHosts: () => string = readDevForwardHostsFile,
): string {
  const platformCa = platformCaHosts(hostnames).join(",");
  if (!isCoLocatedDev(env)) return platformCa;
  return mergeDevCertPublicUrls(platformCa, readForwardHosts());
}

export async function runInstanceCertsApply(
  instanceDir: string,
  hostnames: readonly InstanceHostnameApplyEntry[],
  deps: {
    runPlaybook?: typeof runLocalPlaybook;
    instanceAcme?: InstanceAcmeWireSettings;
    readForwardHosts?: () => string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const env = deps.env ?? Deno.env.toObject();
  // tp-orchestrate accepts only key=value extra-vars. A JSON object is
  // refused before ansible-playbook starts, which is an exit 1 with no
  // task log. resolve-hostnames.yml decodes the list from
  // turbopanel_hostnames_json.
  const args = [
    "-e",
    `turbopanel_instance_dir=${instanceDir}`,
    "-e",
    `turbopanel_public_urls=${
      certificateGenerationPublicUrls(
        hostnames,
        env,
        deps.readForwardHosts ?? readDevForwardHostsFile,
      )
    }`,
    "-e",
    `turbopanel_hostnames_json=${
      JSON.stringify(hostnames.map(ansibleHostname))
    }`,
  ];
  const email = deps.instanceAcme?.contactEmail.trim();
  if (email) args.push("-e", `turbopanel_acme_email=${email}`);
  const directory = deps.instanceAcme?.directoryUrl.trim();
  if (directory) args.push("-e", `turbopanel_acme_directory=${directory}`);
  args.push(...devOwnershipPlaybookExtraArgs(env));
  const runPlaybook = deps.runPlaybook ?? runLocalPlaybook;
  await runPlaybook(INSTANCE_CERTS_APPLY_PLAYBOOK, args);
}

export async function applyPublicUrls(
  hostnames: readonly InstanceHostnameApplyEntry[],
  deps: {
    runCertsApply?: typeof runInstanceCertsApply;
    runPlaybook?: typeof runLocalPlaybook;
    readForwardHosts?: () => string;
    instanceAcme?: InstanceAcmeWireSettings;
    writeUploadedCerts?: typeof writeUploadedInstanceCerts;
    openWindow?: typeof openInstanceAcmeWindow;
    preflightLetsEncrypt?: typeof preflightInstanceLetsEncryptHttp01;
    issueLetsEncrypt?: typeof issueInstanceLetsEncryptCertificates;
    closeWindow?: typeof closeInstanceAcmeWindow;
    withLock?: typeof withInstanceAcmeWindowLock;
  } = {},
): Promise<void> {
  const instanceDir = resolveInstanceDir();
  const layout = resolveLayout(Deno.env.toObject());
  await upsertPublicUrlsInEnv(platformCaHosts(hostnames));
  const writeUploaded = deps.writeUploadedCerts ?? writeUploadedInstanceCerts;
  const certsDir = resolveInstanceCertsDir();
  await writeUploaded(hostnames, certsDir);
  await issueLetsEncryptHosts(hostnames, layout, certsDir, deps);
  const runCerts = deps.runCertsApply ?? runInstanceCertsApply;
  await runCerts(instanceDir, hostnames, {
    instanceAcme: deps.instanceAcme,
    readForwardHosts: deps.readForwardHosts,
    runPlaybook: deps.runPlaybook,
  });
}

async function issueLetsEncryptHosts(
  hostnames: readonly InstanceHostnameApplyEntry[],
  layout: ReturnType<typeof resolveLayout>,
  certsDir: string,
  deps: {
    instanceAcme?: InstanceAcmeWireSettings;
    openWindow?: typeof openInstanceAcmeWindow;
    preflightLetsEncrypt?: typeof preflightInstanceLetsEncryptHttp01;
    issueLetsEncrypt?: typeof issueInstanceLetsEncryptCertificates;
    closeWindow?: typeof closeInstanceAcmeWindow;
    withLock?: typeof withInstanceAcmeWindowLock;
  },
): Promise<void> {
  const hosts = letsEncryptHostnames(hostnames);
  if (hosts.length === 0) return;
  const instanceAcme = deps.instanceAcme;
  if (!instanceAcme?.tosAccepted) {
    throw new Error("Let's Encrypt terms have not been accepted");
  }
  const withLock = deps.withLock ?? withInstanceAcmeWindowLock;
  await withLock(() =>
    openIssueWindow(hostnames, hosts, layout, certsDir, instanceAcme, deps)
  );
}

async function openIssueWindow(
  hostnames: readonly InstanceHostnameApplyEntry[],
  hosts: readonly string[],
  layout: ReturnType<typeof resolveLayout>,
  certsDir: string,
  instanceAcme: InstanceAcmeWireSettings,
  deps: {
    openWindow?: typeof openInstanceAcmeWindow;
    preflightLetsEncrypt?: typeof preflightInstanceLetsEncryptHttp01;
    issueLetsEncrypt?: typeof issueInstanceLetsEncryptCertificates;
    closeWindow?: typeof closeInstanceAcmeWindow;
  },
): Promise<void> {
  const open = deps.openWindow ?? openInstanceAcmeWindow;
  const preflight = deps.preflightLetsEncrypt ??
    preflightInstanceLetsEncryptHttp01;
  const issue = deps.issueLetsEncrypt ?? issueInstanceLetsEncryptCertificates;
  const close = deps.closeWindow ?? closeInstanceAcmeWindow;
  let attempted = false;
  let closed = false;
  const closeOnce = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await close(layout);
  };
  try {
    attempted = true;
    await open(layout, hosts);
    await preflight(hostnames, layout);
    await issue(layout, hosts, instanceAcme, certsDir, {
      closeWindow: () => closeOnce(),
    });
  } catch (err) {
    if (attempted) await closeOnce().catch(() => undefined);
    throw err;
  }
}
