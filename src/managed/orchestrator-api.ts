/**
 * Daemon-local Orchestrator HTTP client.
 *
 * The control plane never calls Orchestrator. Discover, designated recover,
 * and problem listing stay on this host's loopback listener.
 */

import {
  MANAGED_HA_HTTP_PORT,
  type OrchestratorApiCredentials,
} from "./orchestrator.ts";

export type OrchestratorHttpFn = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type OrchestratorApiDeps = {
  fetch?: OrchestratorHttpFn;
  baseUrl?: string;
  credentials?: OrchestratorApiCredentials;
};

function basicAuthHeader(creds: OrchestratorApiCredentials): string {
  const token = btoa(`${creds.user}:${creds.password}`);
  return `Basic ${token}`;
}

function defaultBaseUrl(): string {
  return `http://127.0.0.1:${MANAGED_HA_HTTP_PORT}`;
}

async function orchestratorGet(
  path: string,
  deps: OrchestratorApiDeps,
): Promise<unknown> {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.baseUrl ?? defaultBaseUrl();
  const headers: Record<string, string> = {};
  if (deps.credentials) {
    headers.Authorization = basicAuthHeader(deps.credentials);
  }
  const response = await fetchFn(`${base}${path}`, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `orchestrator ${path} failed: HTTP ${response.status}${
        body ? ` ${body.slice(0, 200)}` : ""
      }`,
    );
  }
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export type OrchestratorDiscoverTarget = {
  host: string;
  port: number;
};

export async function discoverInstance(
  target: OrchestratorDiscoverTarget,
  deps: OrchestratorApiDeps = {},
): Promise<void> {
  await orchestratorGet(
    `/api/discover/${encodeURIComponent(target.host)}/${target.port}`,
    deps,
  );
}

export async function registerCandidate(
  target: OrchestratorDiscoverTarget,
  rule: "prefer" | "must_not",
  deps: OrchestratorApiDeps = {},
): Promise<void> {
  await orchestratorGet(
    `/api/register-candidate/${
      encodeURIComponent(target.host)
    }/${target.port}/${rule}`,
    deps,
  );
}

export async function setClusterAlias(
  clusterName: string,
  alias: string,
  deps: OrchestratorApiDeps = {},
): Promise<void> {
  await orchestratorGet(
    `/api/set-cluster-alias/${encodeURIComponent(clusterName)}/${
      encodeURIComponent(alias)
    }`,
    deps,
  );
}

export type OrchestratorRecoverTarget = {
  sourceHost: string;
  sourcePort: number;
  targetHost: string;
  targetPort: number;
};

export async function recoverToCandidate(
  target: OrchestratorRecoverTarget,
  deps: OrchestratorApiDeps = {},
): Promise<void> {
  await orchestratorGet(
    `/api/recover/${
      encodeURIComponent(target.sourceHost)
    }/${target.sourcePort}/${
      encodeURIComponent(target.targetHost)
    }/${target.targetPort}`,
    deps,
  );
}

export type OrchestratorProblem = {
  clusterAlias?: string;
  key?: { hostname?: string; port?: number };
  problems?: string[];
};

const DEAD_PRIMARY_PROBLEMS = new Set([
  "DeadMaster",
  "DeadPrimary",
  "UnreachableMaster",
  "UnreachablePrimary",
]);

export function isDeadPrimaryProblem(problem: string): boolean {
  return DEAD_PRIMARY_PROBLEMS.has(problem);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseProblemKey(
  value: unknown,
): OrchestratorProblem["key"] | undefined {
  const keyRecord = asRecord(value);
  if (!keyRecord) return undefined;
  return {
    hostname: optionalString(keyRecord.Hostname) ??
      optionalString(keyRecord.hostname),
    port: optionalNumber(keyRecord.Port) ?? optionalNumber(keyRecord.port),
  };
}

function parseProblemNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function parseProblemEntry(entry: unknown): OrchestratorProblem | null {
  const record = asRecord(entry);
  if (!record) return null;
  const parsed: OrchestratorProblem = {};
  const clusterAlias = optionalString(record.ClusterAlias) ??
    optionalString(record.clusterAlias);
  if (clusterAlias !== undefined) parsed.clusterAlias = clusterAlias;
  const key = parseProblemKey(record.Key ?? record.key);
  if (key) parsed.key = key;
  const problems = parseProblemNames(record.Problems ?? record.problems);
  if (problems) parsed.problems = problems;
  return parsed;
}

export function parseOrchestratorProblems(
  value: unknown,
): OrchestratorProblem[] {
  if (!Array.isArray(value)) return [];
  const problems: OrchestratorProblem[] = [];
  for (const entry of value) {
    const parsed = parseProblemEntry(entry);
    if (parsed) problems.push(parsed);
  }
  return problems;
}

export async function listOrchestratorProblems(
  deps: OrchestratorApiDeps = {},
): Promise<OrchestratorProblem[]> {
  const value = await orchestratorGet("/api/problems", deps);
  return parseOrchestratorProblems(value);
}
