/**
 * Managed engine apply: materialize → compose up → credentials → ingress.
 */

import type {
  EnvironmentDeployContainer,
  ManagedApplyCredential,
  ManagedApplyPayload,
  ManagedApplyResult,
} from "../instance/commands/contracts.ts";
import { assertValidBindAddress } from "../deploy/ingress.ts";
import { ensureDocker } from "../deploy/ensure-docker.ts";
import { runDocker } from "../deploy/docker-cli.ts";
import { logInfo, sanitizeForLog } from "../logger.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  MANAGED_ROOT_PASSWORD_VAR,
  normalizeManagedCompose,
} from "./compose.ts";
import {
  collectManagedContainers,
  resolveEngineContainerId,
} from "./containers.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";
import type { ManagedEngineContext } from "./engines/types.ts";
import {
  ensureManagedIngress,
  type ManagedIngressEntry,
  removeManagedIngressEntries,
  syncManagedIngressEntries,
} from "./ingress.ts";
import {
  materializeManagedState,
  normalizeManagedFileOwnership,
} from "./materialize.ts";
import {
  assertSafeManagedIdentifiers,
  managedComposePath,
  managedComposeProject,
  managedEnvFilePath,
} from "./paths.ts";

type DecryptSecretsFn = (ciphertexts: string[]) => Promise<(string | null)[]>;

export type ManagedApplyHandlerDeps = {
  decryptSecrets?: DecryptSecretsFn;
};

function redactSecrets(text: string, plaintexts: readonly string[]): string {
  let out = text;
  for (const secret of plaintexts) {
    if (secret.length === 0) continue;
    out = out.replaceAll(secret, "***");
  }
  return sanitizeForLog(out);
}

async function decryptCredentialPasswords(
  credentials: ManagedApplyCredential[],
  decryptSecrets: DecryptSecretsFn,
  redact: (text: string) => string,
): Promise<{ credentials: ManagedApplyCredential[]; plaintexts: string[] }> {
  const envelopes = credentials.map((c) => c.password);
  const plaintexts = await decryptSecrets(envelopes);
  if (plaintexts.length !== envelopes.length) {
    throw new Error("decryptSecrets returned unexpected length");
  }
  const decrypted: ManagedApplyCredential[] = [];
  const secrets: string[] = [];
  for (let i = 0; i < credentials.length; i++) {
    const plain = plaintexts[i];
    if (typeof plain !== "string" || plain.length === 0) {
      throw new Error(
        redact(
          `failed to decrypt credential password for ${
            credentials[i]!.username
          }`,
        ),
      );
    }
    secrets.push(plain);
    decrypted.push({ ...credentials[i]!, password: plain });
  }
  return { credentials: decrypted, plaintexts: secrets };
}

function buildEngineExec(
  containerId: string,
  redact: (text: string) => string,
): ManagedEngineContext["exec"] {
  return async (argv, input) => {
    const result = await runDocker(
      ["exec", "-i", containerId, ...argv],
      input === undefined ? undefined : { input },
    );
    return {
      success: result.success,
      stdout: result.stdout,
      stderr: redact(result.stderr),
    };
  };
}

function buildIngressEntry(
  payload: ManagedApplyPayload,
): ManagedIngressEntry | null {
  if (!payload.exposure.enabled) return null;
  if (payload.exposure.publishedPort === undefined) {
    throw new Error("exposure.enabled requires publishedPort");
  }
  if (payload.exposure.bindAddress !== undefined) {
    assertValidBindAddress(payload.exposure.bindAddress);
  }
  return {
    managedId: payload.managedId,
    protocol: payload.exposure.protocol,
    publishedPort: payload.exposure.publishedPort,
    containerPort: payload.containerPort,
    ...(payload.exposure.bindAddress !== undefined
      ? { bindAddress: payload.exposure.bindAddress }
      : {}),
    ...(payload.exposure.sni !== undefined
      ? { sni: payload.exposure.sni }
      : {}),
  };
}

/**
 * Host reported on the apply result.
 *
 * When exposure is disabled the engine is loopback-only. When exposed, match
 * Traefik's bind fallback (`bindAddress ?? "0.0.0.0"`) — never report loopback
 * for an all-interfaces bind.
 */
export function resolveManagedApplyHost(
  exposure: ManagedApplyPayload["exposure"],
): string {
  if (!exposure.enabled) return "127.0.0.1";
  return exposure.bindAddress ?? "0.0.0.0";
}

/**
 * Sync managed Traefik before engine compose up so port conflicts fail early
 * and the managed Docker network exists before the engine joins it.
 * {@link ManagedPortConflictError} propagates as a clean command-outcome error.
 */
async function prepareManagedIngressForApply(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
): Promise<void> {
  const ingressEntry = buildIngressEntry(payload);
  if (ingressEntry) {
    const merged = await syncManagedIngressEntries(
      layout,
      payload.managedId,
      [ingressEntry],
    );
    await ensureManagedIngress(layout, merged);
    return;
  }
  const remaining = await removeManagedIngressEntries(
    layout,
    payload.managedId,
  );
  if (remaining !== null) {
    await ensureManagedIngress(layout, remaining);
  }
}

async function requireDecryptedCredentials(
  payload: ManagedApplyPayload,
  deps: ManagedApplyHandlerDeps | undefined,
): Promise<
  {
    decrypted: { credentials: ManagedApplyCredential[]; plaintexts: string[] };
    redact: (text: string) => string;
    rootCredential: ManagedApplyCredential;
  }
> {
  if (!deps?.decryptSecrets) {
    throw new Error("managed.apply requires decryptSecrets");
  }

  // Redact is identity until plaintexts are known; rebuilt after decrypt.
  const initialRedact = (text: string) => sanitizeForLog(text);
  const decrypted = await decryptCredentialPasswords(
    payload.credentials,
    deps.decryptSecrets,
    initialRedact,
  );
  const redact = (text: string) => redactSecrets(text, decrypted.plaintexts);

  const rootCredential = decrypted.credentials.find((c) => c.role === "root");
  if (!rootCredential) {
    throw new Error("managed.apply requires a root credential");
  }

  return { decrypted, redact, rootCredential };
}

async function cleanupManagedEnvFile(
  envPath: string,
  redact: (text: string) => string,
): Promise<void> {
  try {
    await Deno.remove(envPath);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      logInfo(
        "managed",
        `failed to delete managed env file: ${
          redact(err instanceof Error ? err.message : String(err))
        }`,
      );
    }
  }
}

/** Unlink then create — survives a leftover root-owned file from older normalize. */
async function rewriteDaemonOwnedFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  await Deno.writeTextFile(path, contents);
  await Deno.chmod(path, mode);
}

async function composeUpManagedEngine(
  layout: LayoutPaths,
  payload: ManagedApplyPayload,
  composeYaml: string,
  rootCredential: ManagedApplyCredential,
  redact: (text: string) => string,
): Promise<string> {
  const composePath = managedComposePath(layout, payload.managedId);
  const envPath = managedEnvFilePath(layout, payload.managedId);
  const project = managedComposeProject(payload.managedId);

  await rewriteDaemonOwnedFile(composePath, composeYaml, 0o640);

  try {
    await rewriteDaemonOwnedFile(
      envPath,
      `${MANAGED_ROOT_PASSWORD_VAR}=${rootCredential.password}\n`,
      0o600,
    );

    const up = await runDocker([
      "compose",
      "--env-file",
      envPath,
      "-p",
      project,
      "-f",
      composePath,
      "up",
      "-d",
      "--remove-orphans",
    ]);
    if (!up.success) {
      throw new Error(
        `managed.apply compose up failed: ${
          redact(up.stderr || up.stdout || "compose up failed")
        }`,
      );
    }
  } finally {
    await cleanupManagedEnvFile(envPath, redact);
  }

  return project;
}

async function dropManagedUsers(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  payload: ManagedApplyPayload,
  appliedUsers: string[],
): Promise<void> {
  if (
    !payload.dropUsers || payload.dropUsers.length === 0 || !engine.dropUsers
  ) {
    return;
  }
  const toDrop = payload.dropUsers.filter(
    (username) => username !== engine.rootUsername,
  );
  if (toDrop.length === 0) return;
  const dropped = await engine.dropUsers(ctx, toDrop);
  appliedUsers.push(...dropped);
}

async function applyManagedEngineState(
  ctx: ManagedEngineContext,
  engine: ReturnType<typeof getManagedEngineRuntime>,
  payload: ManagedApplyPayload,
  credentials: ManagedApplyCredential[],
): Promise<
  {
    appliedUsers: string[];
    appliedDatabases: string[];
    engineVersion: string | undefined;
  }
> {
  await engine.waitReady(ctx);
  const appliedUsers = await engine.applyCredentials(ctx, credentials);
  await dropManagedUsers(ctx, engine, payload, appliedUsers);
  const appliedDatabases = payload.databases
    ? await engine.applyDatabases(ctx, payload.databases)
    : [];
  const engineVersion = await engine.readVersion(ctx);
  return { appliedUsers, appliedDatabases, engineVersion };
}

function buildManagedApplyResult(
  payload: ManagedApplyPayload,
  state: {
    appliedUsers: string[];
    appliedDatabases: string[];
    engineVersion: string | undefined;
  },
  containers: EnvironmentDeployContainer[] | undefined,
): ManagedApplyResult {
  const host = resolveManagedApplyHost(payload.exposure);
  const port = payload.exposure.enabled
    ? (payload.exposure.publishedPort ?? payload.containerPort)
    : payload.containerPort;

  const result: ManagedApplyResult = {
    host,
    port,
    appliedUsers: state.appliedUsers,
    ...(state.appliedDatabases.length > 0
      ? { appliedDatabases: state.appliedDatabases }
      : {}),
    ...(state.engineVersion !== undefined
      ? { engineVersion: state.engineVersion }
      : {}),
    summary: `managed ${payload.engine} applied`,
  };
  if (containers !== undefined) {
    result.containers = containers;
  }
  return result;
}

export async function handleManagedApply(
  payload: ManagedApplyPayload,
  _daemonReceivedAt: string,
  deps?: ManagedApplyHandlerDeps,
): Promise<ManagedApplyResult> {
  assertSafeManagedIdentifiers(payload);
  const layout = resolveLayout(Deno.env.toObject());
  const engine = getManagedEngineRuntime(payload.engine);

  await ensureDocker();
  await prepareManagedIngressForApply(layout, payload);

  const managedRoot = await materializeManagedState(layout, payload);
  await normalizeManagedFileOwnership(
    payload.image,
    managedRoot,
    engine.containerUser,
    engine.containerGroup,
  );

  const { decrypted, redact, rootCredential } =
    await requireDecryptedCredentials(payload, deps);

  const { composeYaml, composeServiceName } = normalizeManagedCompose(payload);
  const project = await composeUpManagedEngine(
    layout,
    payload,
    composeYaml,
    rootCredential,
    redact,
  );

  const containers = await collectManagedContainers(project, redact);
  const containerId = resolveEngineContainerId(containers, composeServiceName);

  const ctx: ManagedEngineContext = {
    containerId,
    composeServiceName,
    rootUsername: engine.rootUsername,
    defaultDatabase: engine.defaultDatabase,
    exec: buildEngineExec(containerId, redact),
  };

  try {
    const state = await applyManagedEngineState(
      ctx,
      engine,
      payload,
      decrypted.credentials,
    );
    return buildManagedApplyResult(payload, state, containers);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redact(message));
  }
}
