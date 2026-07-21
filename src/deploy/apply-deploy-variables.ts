import { parse, stringify } from "yaml";
import type { DecryptSecretsFn } from "./materialize-tls.ts";
import type { EnvironmentDeployVariableMaterial } from "../instance/commands/contracts.ts";

type ComposeService = Record<string, unknown>;
type ComposeDocument = Record<string, unknown> & {
  services?: Record<string, ComposeService>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeLiteralComposeValue(value: string): string {
  return value.replaceAll("$", "$$$$");
}

function readStringEnvMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (typeof envValue === "string") out[key] = envValue;
  }
  return out;
}

function mergeBuildArgs(
  service: ComposeService,
  args: Record<string, string>,
): void {
  if (Object.keys(args).length === 0) return;
  const build = isRecord(service.build) ? { ...service.build } : {};
  const existing = readStringEnvMap(build.args);
  build.args = { ...existing, ...args };
  service.build = build;
}

function applyEntryToService(
  service: ComposeService,
  entry: EnvironmentDeployVariableMaterial,
  formatted: string,
): void {
  if (entry.forRuntime) {
    const env = readStringEnvMap(service.environment);
    env[entry.key] = formatted;
    service.environment = env;
  }
  if (entry.forBuild) {
    mergeBuildArgs(service, { [entry.key]: formatted });
  }
}

function parseComposeDocument(composeYaml: string): ComposeDocument {
  const document = parse(composeYaml);
  if (!isRecord(document) || !isRecord(document.services)) {
    throw new Error("Compose YAML must define a services object");
  }
  return document as ComposeDocument;
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

function applyEntryToServices(
  services: Record<string, ComposeService>,
  entry: EnvironmentDeployVariableMaterial,
  formatted: string,
): void {
  if (entry.composeServiceName) {
    const service = services[entry.composeServiceName];
    if (!isRecord(service)) {
      throw new Error(
        `Compose service ${entry.composeServiceName} not found for variable ${entry.key}`,
      );
    }
    applyEntryToService(service, entry, formatted);
    return;
  }

  for (const service of Object.values(services)) {
    if (isRecord(service)) {
      applyEntryToService(service, entry, formatted);
    }
  }
}

export async function applySecretVariablesToCompose(
  composeYaml: string,
  material: EnvironmentDeployVariableMaterial[],
  decryptSecrets: DecryptSecretsFn,
): Promise<string> {
  if (material.length === 0) return composeYaml;

  const document = parseComposeDocument(composeYaml);
  const services = document.services as Record<string, ComposeService>;
  const plaintexts = await decryptSecrets(material.map((entry) => entry.valueEnvelope));
  if (plaintexts.length !== material.length) {
    throw new Error("secrets/decrypt returned unexpected length");
  }

  for (let i = 0; i < material.length; i += 1) {
    const entry = material[i]!;
    const plaintext = requireDecryptedPlaintext(entry, plaintexts[i]);
    applyEntryToServices(
      services,
      entry,
      formatVariableValue(entry, plaintext),
    );
  }

  return stringify(document);
}
