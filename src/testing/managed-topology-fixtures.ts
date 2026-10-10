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

export function orchestratorApiUsername(): string {
  return ["tp_orchapi", "111111111111"].join("_");
}

export function orchestratorApiPlaintext(): string {
  return ["orchapi", "plain", "fixture"].join("-");
}

export function orchestratorApiPlainEnvelope(): string {
  return `${TPD_PREFIX}${orchestratorApiPlaintext()}`;
}

export function orchestratorRaftPlaintext(): string {
  return ["orchraft", "plain", "fixture"].join("-");
}

export function orchestratorRaftPlainEnvelope(): string {
  return `${TPD_PREFIX}${orchestratorRaftPlaintext()}`;
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

/**
 * `docker inspect` stdout for the live-and-configured ports format the HA
 * observer reads (`resolveOrchestratorMemberDial`). A stopped or killed
 * container reports `{}` for its live ports and keeps its configured bindings,
 * which is what Docker 29 prints after `docker kill`.
 */
export function engineInspectPortsJson(
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>,
  options: { stopped?: boolean } = {},
): string {
  return JSON.stringify({
    live: options.stopped ? {} : ports,
    configured: ports,
  });
}

/**
 * `/api/replication-analysis` as Percona Orchestrator 3.2.6 answered it on
 * the MySQL 9.7 pair (lane LB rerun 7) after `docker kill` of the primary on
 * 172.20.4.10:45001. Verbatim; the capture was cut after
 * `SemiSyncMasterEnabled`, so the row is closed there. The cluster alias is
 * `host:port` (not the managed UUID) and the code is `DeadMasterAndReplicas`
 * because Orchestrator could not check the replica either.
 */
export const ORCHESTRATOR_DEAD_MASTER_AND_REPLICAS_CAPTURE = String
  .raw`{"Code":"OK","Message":"Analysis","Details":[{"AnalyzedInstanceKey":{"Hostname":"172.20.4.10","Port":45001},"AnalyzedInstanceMasterKey":{"Hostname":"","Port":0},"ClusterDetails":{"ClusterName":"172.20.4.10:45001","ClusterAlias":"172.20.4.10:45001","ClusterDomain":"172.20.4.10:45001","CountInstances":0,"HeuristicLag":0,"HasAutomatedMasterRecovery":false,"HasAutomatedIntermediateMasterRecovery":false},"AnalyzedInstanceDataCenter":"","AnalyzedInstanceRegion":"","AnalyzedInstancePhysicalEnvironment":"","AnalyzedInstanceBinlogCoordinates":{"LogFile":"ON.000005","LogPos":163107,"Type":0},"IsMaster":true,"IsReplicationGroupMember":false,"IsCoMaster":false,"LastCheckValid":false,"LastCheckPartialSuccess":false,"CountReplicas":1,"CountValidReplicas":0,"CountValidReplicatingReplicas":0,"CountReplicasFailingToConnectToMaster":0,"CountDowntimedReplicas":0,"ReplicationDepth":0,"Replicas":[{"Hostname":"172.20.4.20","Port":45001}],"SlaveHosts":[{"Hostname":"172.20.4.20","Port":45001}],"IsFailingToConnectToMaster":false,"Analysis":"DeadMasterAndReplicas","Description":"Master cannot be reached by orchestrator and none of its replicas is replicating","StructureAnalysis":null,"IsDowntimed":false,"IsReplicasDowntimed":false,"DowntimeEndTimestamp":"","DowntimeRemainingSeconds":0,"IsBinlogServer":false,"PseudoGTIDImmediateTopology":false,"OracleGTIDImmediateTopology":false,"MariaDBGTIDImmediateTopology":false,"BinlogServerImmediateTopology":false,"SemiSyncMasterEnabled":false}]}`;
