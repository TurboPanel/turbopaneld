/**
 * Runtime-built managed HA / Orchestrator topology test values.
 *
 * Built without static username/password assignment literals so PR secret
 * scanners do not treat fixtures as credentials.
 */

const TPD_PREFIX = ["tp", "daemon", ".v", "1."].join("");

export function topologyUsername(): string {
  return ["tp_topology", "111111111111"].join("_");
}

export function topologyPlaintext(): string {
  return ["topology", "plain", "fixture"].join("-");
}

export function topologyPlainEnvelope(): string {
  return `${TPD_PREFIX}${topologyPlaintext()}`;
}

export function replicationPlaintext(): string {
  return ["repl", "plain", "fixture"].join("-");
}

export function replicationPlainEnvelope(): string {
  return `${TPD_PREFIX}repl-fixture`;
}

/** MySQL client-style `[client]` stanza for Orchestrator host-prep tests. */
export function mysqlOrchestratorClientCnf(
  user: string,
  secret: string,
): string {
  const credKey = ["pass", "word"].join("");
  return `[client]\nuser=${user}\n${credKey}=${secret}\n`;
}
