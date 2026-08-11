import type { DecryptSecretsFn } from "./materialize-tls.ts";
import type { EnvironmentDeployVariableMaterial } from "../instance/commands/contracts.ts";
import type { ComposeOverlayFragment } from "./compose-overlay.ts";
import type { ResolvedComposeModel } from "./compose-services.ts";

function escapeLiteralComposeValue(value: string): string {
  return value.replaceAll("$", "$$$$");
}

function requireDecryptedPlaintext(
  entry: EnvironmentDeployVariableMaterial,
  plaintext: string | null | undefined,
): string {
  if (plaintext === null || plaintext === undefined || plaintext.length === 0) {
    throw new Error(`Failed to decrypt secret variable ${entry.key}`);
  }
  return plaintext;
}

function formatVariableValue(
  entry: EnvironmentDeployVariableMaterial,
  plaintext: string,
): string {
  return entry.isLiteral ? escapeLiteralComposeValue(plaintext) : plaintext;
}

function ensureService(
  services: Record<string, Record<string, unknown>>,
  name: string,
): Record<string, unknown> {
  const existing = services[name] ?? {};
  services[name] = existing;
  return existing;
}

function applyEntryToServiceStub(
  service: Record<string, unknown>,
  entry: EnvironmentDeployVariableMaterial,
  formatted: string,
): void {
  if (entry.forRuntime) {
    const env = (typeof service.environment === "object" &&
        service.environment !== null &&
        !Array.isArray(service.environment))
      ? { ...(service.environment as Record<string, string>) }
      : {};
    env[entry.key] = formatted;
    service.environment = env;
  }
  if (entry.forBuild) {
    const build = (typeof service.build === "object" &&
        service.build !== null &&
        !Array.isArray(service.build))
      ? { ...(service.build as Record<string, unknown>) }
      : {};
    const args = (typeof build.args === "object" &&
        build.args !== null &&
        !Array.isArray(build.args))
      ? { ...(build.args as Record<string, string>) }
      : {};
    args[entry.key] = formatted;
    build.args = args;
    service.build = build;
  }
}

function targetServiceNames(
  entry: EnvironmentDeployVariableMaterial,
  resolved: ResolvedComposeModel,
): string[] {
  if (entry.composeServiceName) {
    if (!resolved.services[entry.composeServiceName]) {
      throw new Error(
        `Compose service ${entry.composeServiceName} not found for variable ${entry.key}`,
      );
    }
    return [entry.composeServiceName];
  }
  return resolved.serviceNames;
}

/**
 * Decrypt variable material once and emit environment / build.args patches
 * for the daemon overlay. Plaintext never reaches a log line.
 */
export async function buildSecretVariablesFragment(
  material: EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn,
  resolved: ResolvedComposeModel,
): Promise<ComposeOverlayFragment> {
  if (material.length === 0) return {};

  const plaintexts = await decryptSecrets(
    material.map((entry) => entry.valueEnvelope),
  );
  if (plaintexts.length !== material.length) {
    throw new Error("secrets/decrypt returned unexpected length");
  }

  const services: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < material.length; i += 1) {
    const entry = material[i]!;
    const plaintext = requireDecryptedPlaintext(entry, plaintexts[i]);
    const formatted = formatVariableValue(entry, plaintext);
    for (const name of targetServiceNames(entry, resolved)) {
      applyEntryToServiceStub(ensureService(services, name), entry, formatted);
    }
  }

  return Object.keys(services).length > 0 ? { services } : {};
}
