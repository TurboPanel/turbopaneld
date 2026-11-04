import { join } from "@std/path";
import { forEachSequential } from "../util/sequential.ts";
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
  InstanceEdgeTrustWire,
  InstanceHostnameWireEntry,
} from "../contracts/cell-messages.ts";
import {
  isValidHostname,
  isValidNtpServer,
  parseCidrLiteral,
} from "../contracts/commands-contracts.ts";
import {
  instanceAcmeCooldownError,
  instanceAcmeRowFailure,
  instanceAcmeWindowFailure,
  noteInstanceAcmeFailure,
} from "../deploy/instance-acme-failure.ts";
import { instanceAcmeIssuerKey } from "../deploy/instance-acme-issuer.ts";
import { upsertPublicUrlsInEnv } from "./public-urls-env.ts";
import type { RunFn } from "../deploy/ensure-principal.ts";
import { runHostCommand } from "../deploy/systemd-unit-set.ts";
import { hostSudoArgs } from "../permissions/host-sudo.ts";
import { writePrivateFileAtomic } from "../permissions/host-unit-files.ts";

/** Wire hostname, including the one-hop decrypted upload pair. */
export type InstanceHostnameApplyEntry = InstanceHostnameWireEntry;

/** The control plane's certificate id: a UUID (tp-host's `tp_instance_cert_id_ok`). */
const UPLOADED_CERT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `https://<host>[:port][/]`, the install origin the control plane stores. */
const INSTALL_ORIGIN =
  /^https:\/\/(?:\[([0-9A-Fa-f:.]+)\]|([^/:[\]]+))(?::(\d{1,5}))?\/?$/;
const ACME_EMAIL_LOCAL = /^[A-Za-z0-9._+-]{1,64}$/;
const ACME_DIRECTORY_PATH = /^[A-Za-z0-9._~/:-]*$/;

/** A bare host, or its install origin, with a host the NTP check accepts. */
function isApplyHost(value: string): boolean {
  if (!value.startsWith("https://")) return isValidNtpServer(value);
  const match = INSTALL_ORIGIN.exec(value);
  if (!match) return false;
  const [, ipv6, host, port] = match;
  if (port !== undefined && Number(port) > 65535) return false;
  return ipv6 !== undefined
    ? ipv6.includes(":") && isValidNtpServer(ipv6)
    : isValidNtpServer(host);
}

/**
 * These values reach a root-run playbook as key=value extra-vars, so they are
 * held to plain host / email / URL shapes before they leave the daemon (and
 * again by tp-orchestrate). The control plane validates them too; this is the
 * daemon not trusting that it did.
 */
export function assertInstanceCertsApplyInputs(
  hostnames: readonly InstanceHostnameApplyEntry[],
  instanceAcme?: Pick<
    InstanceAcmeWireSettings,
    "contactEmail" | "directoryUrl"
  >,
): void {
  for (const entry of hostnames) {
    if (!isApplyHost(entry.host)) {
      throw new Error(
        `refusing instance hostname ${JSON.stringify(entry.host)}`,
      );
    }
    const id = entry.uploadedCertId;
    if (id && !UPLOADED_CERT_ID.test(id)) {
      throw new Error(`refusing uploaded certificate id ${JSON.stringify(id)}`);
    }
  }
  const email = instanceAcme?.contactEmail.trim();
  if (email) {
    const at = email.lastIndexOf("@");
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (
      at <= 0 || !ACME_EMAIL_LOCAL.test(local) || local.startsWith(".") ||
      local.endsWith(".") || !isValidHostname(domain) || !domain.includes(".")
    ) {
      throw new Error(`refusing ACME contact email ${JSON.stringify(email)}`);
    }
  }
  const directory = instanceAcme?.directoryUrl.trim();
  if (directory) {
    const rest = directory.startsWith("https://")
      ? directory.slice("https://".length)
      : null;
    if (
      rest === null || rest.length === 0 || !ACME_DIRECTORY_PATH.test(rest) ||
      rest.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(
        `refusing ACME directory URL ${JSON.stringify(directory)}`,
      );
    }
  }
}

/** Shortest prefix an edge range may have; anything wider is refused. */
const MIN_EDGE_PREFIX = { 4: 8, 6: 16 } as const;

/**
 * Loopback, private, link-local, CGNAT, ULA, multicast and reserved space, as
 * [a, b, c, d, prefix] (IPv4) and [first hextet, prefix] (IPv6) so no address
 * literal sits in the source.
 */
const NEVER_EDGE_V4: ReadonlyArray<readonly number[]> = [
  [0, 0, 0, 0, 8],
  [10, 0, 0, 0, 8],
  [100, 64, 0, 0, 10],
  [127, 0, 0, 0, 8],
  [169, 254, 0, 0, 16],
  [172, 16, 0, 0, 12],
  [192, 168, 0, 0, 16],
  [224, 0, 0, 0, 3],
];
const NEVER_EDGE_V6: ReadonlyArray<readonly [string, number]> = [
  ["0", 8],
  ["fc00", 7],
  ["fe80", 10],
  ["ff00", 8],
];
const NEVER_EDGE_RANGES = [
  ...NEVER_EDGE_V4.map(([a, b, c, d, bits]) => `${a}.${b}.${c}.${d}/${bits}`),
  ...NEVER_EDGE_V6.map(([hextet, bits]) => `${hextet}::/${bits}`),
].flatMap((cidr) => {
  const parsed = parseCidrLiteral(cidr);
  return parsed ? [parsed] : [];
});

/**
 * A range Caddy may trust as an edge, checked again on the daemon so the
 * root-side boundary stands alone: a CIDR literal, not wider than the prefix
 * floor, and clear of every local, private or reserved block.
 */
export function isSafeEdgeRange(value: string): boolean {
  const parsed = parseCidrLiteral(value);
  if (parsed === null || parsed.prefix < MIN_EDGE_PREFIX[parsed.version]) {
    return false;
  }
  return !NEVER_EDGE_RANGES.some((blocked) =>
    blocked.version === parsed.version && blocked.base <= parsed.last &&
    parsed.base <= blocked.last
  );
}

/**
 * The ranges reach a root-run template, so every entry must be a CIDR literal
 * and the per-provider lists must sit inside the union. Returns the compact
 * JSON that travels as `turbopanel_edge_trust_json`.
 */
export function edgeTrustExtraVar(edgeTrust: InstanceEdgeTrustWire): string {
  const lists = [edgeTrust.cidrs, edgeTrust.cloudflare, edgeTrust.bunny];
  for (const entry of lists.flat()) {
    if (!isSafeEdgeRange(entry)) {
      throw new Error(`refusing edge range ${JSON.stringify(entry)}`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(edgeTrust.hash)) {
    throw new Error("refusing edge range set with a malformed hash");
  }
  const union = new Set(edgeTrust.cidrs);
  if (
    [...edgeTrust.cloudflare, ...edgeTrust.bunny].some((c) => !union.has(c))
  ) {
    throw new Error("refusing edge range set whose lists are not in the union");
  }
  return JSON.stringify({
    hash: edgeTrust.hash,
    cloudflare: edgeTrust.cloudflare,
    bunny: edgeTrust.bunny,
  });
}

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

/** A TCP port the panel's Caddy may redirect to, else undefined. */
function validPublicPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) &&
      value >= 1 && value <= 65535
    ? value
    : undefined;
}

/**
 * One `turbopanel_hostnames_json` row. `public_port` is present only when the
 * control plane sent a valid `publicPort`; without it the Caddyfile adds no
 * edge port redirect for the name.
 */
export function ansibleHostname(entry: InstanceHostnameApplyEntry): {
  host: string;
  source: InstanceHostnameApplyEntry["source"];
  cert_id: string;
  public_port?: number;
} {
  const publicPort = validPublicPort(entry.publicPort);
  return {
    host: entry.host,
    source: entry.source,
    cert_id: entry.uploadedCertId ?? "",
    ...(publicPort === undefined ? {} : { public_port: publicPort }),
  };
}

/** Largest certificate chain tp-host installs (`TP_INSTANCE_CERT_MAX`). */
export const INSTANCE_CERT_CHAIN_MAX_BYTES = 65_536;
/** Largest private key tp-host installs (`TP_INSTANCE_KEY_MAX`). */
export const INSTANCE_CERT_KEY_MAX_BYTES = 16_384;
/** Most certificates in one chain (`TP_INSTANCE_CERT_BLOCKS_MAX`). */
export const INSTANCE_CERT_CHAIN_MAX_BLOCKS = 10;

const KEY_LABELS = new Set([
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
]);
const PEM_BEGIN = /^-----BEGIN ([A-Z ]+)-----$/;
const PEM_BASE64_LINE = /^[A-Za-z0-9+/=]{1,128}$/;

/**
 * Labels of the PEM blocks in `text`, or null unless it is PEM blocks and
 * nothing else (blank lines between blocks only). Mirrors tp-host's
 * `tp_instance_pem_ok`, so a pair the daemon accepts is not refused root-side.
 */
function pemBlockLabels(text: string): string[] | null {
  const scan: PemScan = { labels: [], open: null, lines: 0 };
  for (const line of text.split("\n")) {
    if (!scanPemLine(scan, line)) return null;
  }
  return scan.open === null ? scan.labels : null;
}

type PemScan = { labels: string[]; open: string | null; lines: number };

/** Feeds one line to the scan; false when the text is not PEM blocks only. */
function scanPemLine(scan: PemScan, line: string): boolean {
  if (scan.open === null) return openPemBlock(scan, line);
  if (line === `-----END ${scan.open}-----`) {
    if (scan.lines === 0) return false;
    scan.open = null;
    return true;
  }
  if (!PEM_BASE64_LINE.test(line)) return false;
  scan.lines += 1;
  return true;
}

/** Outside a block only blank lines and a BEGIN line may appear. */
function openPemBlock(scan: PemScan, line: string): boolean {
  if (line === "") return true;
  const begin = PEM_BEGIN.exec(line);
  if (!begin) return false;
  scan.open = begin[1]!;
  scan.labels.push(scan.open);
  scan.lines = 0;
  return true;
}

/** LF line endings and one final newline, the bytes tp-host checks. */
function normalizePem(text: string): string {
  return `${text.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

/**
 * The pair as staged, or an error naming what is wrong with it. The same
 * shapes and caps tp-host enforces: 1 to 10 CERTIFICATE blocks, exactly one
 * unencrypted private key block.
 */
export function uploadedCertPair(
  id: string,
  certPem: string,
  keyPem: string,
): { cert: string; key: string } {
  const cert = normalizePem(certPem);
  const key = normalizePem(keyPem);
  const encoder = new TextEncoder();
  if (encoder.encode(cert).byteLength > INSTANCE_CERT_CHAIN_MAX_BYTES) {
    throw new Error(
      `refusing uploaded certificate ${id}: the chain is over ${INSTANCE_CERT_CHAIN_MAX_BYTES} bytes`,
    );
  }
  if (encoder.encode(key).byteLength > INSTANCE_CERT_KEY_MAX_BYTES) {
    throw new Error(
      `refusing uploaded certificate ${id}: the private key is over ${INSTANCE_CERT_KEY_MAX_BYTES} bytes`,
    );
  }
  const chain = pemBlockLabels(cert);
  if (
    !chain || chain.length === 0 ||
    chain.length > INSTANCE_CERT_CHAIN_MAX_BLOCKS ||
    chain.some((label) => label !== "CERTIFICATE")
  ) {
    throw new Error(
      `refusing uploaded certificate ${id}: the certificate is not a PEM chain of 1 to ${INSTANCE_CERT_CHAIN_MAX_BLOCKS} certificates`,
    );
  }
  const keys = pemBlockLabels(key);
  if (keys?.length !== 1 || !KEY_LABELS.has(keys[0]!)) {
    throw new Error(
      `refusing uploaded certificate ${id}: the private key is not one unencrypted PEM private key`,
    );
  }
  return { cert, key };
}

/** Installs one checked pair as `uploaded-<id>.{crt,key}` in the certs dir. */
export type UploadedCertInstaller = (
  id: string,
  pair: { cert: string; key: string },
) => Promise<void>;

/**
 * Where the daemon stages a pair for `tp-host instance-cert-install`
 * (`<state>/system/instance-certs`, tp-host's `R_INSTANCE_CERT_STAGE`).
 */
export function instanceCertStageDir(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return join(resolveLayout(env).stateDir, "system", "instance-certs");
}

/**
 * Co-located development: the certs dir is the developer's own (beside the
 * checkout), so the daemon writes the pair itself.
 */
export function writeUploadedCertDirect(
  certsDir: string,
): UploadedCertInstaller {
  let made = false;
  return async (id, pair) => {
    if (!made) {
      await Deno.mkdir(certsDir, { recursive: true, mode: 0o750 });
      made = true;
    }
    await Deno.writeTextFile(join(certsDir, `uploaded-${id}.crt`), pair.cert, {
      mode: 0o640,
    });
    await Deno.writeTextFile(join(certsDir, `uploaded-${id}.key`), pair.key, {
      mode: 0o640,
    });
  };
}

/**
 * A managed host: the certs dir belongs to the instance-certs role and the
 * daemon account cannot write it. Stage the pair in a 0700 folder the daemon
 * owns and let `tp-host instance-cert-install <id>` check it and place it
 * (root:tp 0640). The staged copies are removed whatever the outcome.
 */
export function installUploadedCertViaHost(
  deps: { stageDir: string; run?: RunFn },
): UploadedCertInstaller {
  const run = deps.run ?? runHostCommand;
  return async (id, pair) => {
    await Deno.mkdir(deps.stageDir, { recursive: true, mode: 0o700 });
    await Deno.chmod(deps.stageDir, 0o700);
    const staged = [
      join(deps.stageDir, `${id}.crt`),
      join(deps.stageDir, `${id}.key`),
    ];
    try {
      await writePrivateFileAtomic(deps.stageDir, `${id}.crt`, pair.cert);
      await writePrivateFileAtomic(deps.stageDir, `${id}.key`, pair.key);
      const result = await run(
        "sudo",
        hostSudoArgs(["-n", "instance-cert-install", id]),
      );
      if (!result.success) {
        throw new Error(
          `installing uploaded certificate ${id} failed: ${
            result.stderr.trim() || "tp-host refused it"
          }`,
        );
      }
    } finally {
      await Promise.all(
        staged.map((path) => Deno.remove(path).catch(() => undefined)),
      );
    }
  };
}

/** The installer for this host's layout. */
export function uploadedCertInstaller(
  certsDir: string,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): UploadedCertInstaller {
  return isCoLocatedDev(env)
    ? writeUploadedCertDirect(certsDir)
    : installUploadedCertViaHost({ stageDir: instanceCertStageDir(env) });
}

export async function writeUploadedInstanceCerts(
  hostnames: readonly InstanceHostnameApplyEntry[],
  certsDir: string,
  install: UploadedCertInstaller = uploadedCertInstaller(certsDir),
): Promise<void> {
  const seen = new Set<string>();
  await forEachSequential(hostnames, async (entry) => {
    if (entry.source !== "uploaded") return;
    const id = entry.uploadedCertId;
    if (!id || !entry.certPem || !entry.keyPem) return;
    if (!UPLOADED_CERT_ID.test(id)) {
      throw new Error(`refusing uploaded certificate id ${id}`);
    }
    if (seen.has(id)) return;
    seen.add(id);
    await install(id, uploadedCertPair(id, entry.certPem, entry.keyPem));
  });
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
    edgeTrust?: InstanceEdgeTrustWire;
    readForwardHosts?: () => string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const env = deps.env ?? Deno.env.toObject();
  assertInstanceCertsApplyInputs(hostnames, deps.instanceAcme);
  // tp-orchestrate accepts only key=value extra-vars here. A JSON object is
  // refused before ansible-playbook starts, which is an exit 1 with no
  // task log. resolve-hostnames.yml decodes the list from
  // turbopanel_hostnames_json.
  const args = [
    "-e",
    `turbopanel_instance_dir=${instanceDir}`,
    "-e",
    `turbopanel_hostnames_json=${
      JSON.stringify(hostnames.map(ansibleHostname))
    }`,
  ];
  // tp-orchestrate's tp_host_list_ok refuses an empty extra-var value
  // outright — an all-lets-encrypt/all-uploaded hostname set (no
  // platform-ca hosts, not co-located dev) legitimately computes "" here.
  // The role already defaults this var to '' when absent
  // (instance-certs/defaults/main.yml), so omitting it is equivalent to
  // passing empty and keeps tp-orchestrate from refusing the whole apply.
  const publicUrls = certificateGenerationPublicUrls(
    hostnames,
    env,
    deps.readForwardHosts ?? readDevForwardHostsFile,
  );
  if (publicUrls) args.push("-e", `turbopanel_public_urls=${publicUrls}`);
  // Absent means "keep the persisted set" (resolve-edge-trust.yml reads the
  // sidecar), so a hostname-only apply never drops the ranges.
  if (deps.edgeTrust) {
    args.push(
      "-e",
      `turbopanel_edge_trust_json=${edgeTrustExtraVar(deps.edgeTrust)}`,
    );
  }
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
    edgeTrust?: InstanceEdgeTrustWire;
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
    edgeTrust: deps.edgeTrust,
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
  const issuerKey = instanceAcmeIssuerKey(instanceAcme);
  const cooling = instanceAcmeCooldownError(hosts, issuerKey, Date.now());
  if (cooling) throw cooling;
  try {
    attempted = true;
    await open(layout, hosts).catch((err) => {
      throw instanceAcmeWindowFailure(err, hosts[0]);
    });
    await preflight(hostnames, layout);
    await issue(layout, hosts, instanceAcme, certsDir, {
      closeWindow: () => closeOnce(),
    }).catch((err) => {
      noteInstanceAcmeFailure(err, hosts, issuerKey, Date.now());
      throw instanceAcmeRowFailure(err, hosts[0]);
    });
  } catch (err) {
    if (attempted) await closeOnce().catch(() => undefined);
    throw err;
  }
}
