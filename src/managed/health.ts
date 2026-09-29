/**
 * On-demand replication health for one managed member.
 *
 * Transport: correlated cell request `managed-health-request` →
 * `managed-health-result` (feature `managed-health-v1`, see instance
 * `version-wire.ts`). Not a command: nothing is queued, no command row is
 * written, and the control plane decides what to do with the observation.
 *
 * The probe reads health exactly as `managed.apply` / `managed.lifecycle`
 * do (`collectManagedMemberHealth`), but takes the member's **real role**
 * from the request. A replica is read as a `standby`; asking a standby's
 * engine for `primary` health would report `pg_stat_replication` rows that
 * can say `streaming` for a replica that is not.
 */

import {
  MANAGED_ENGINE_CODES,
  type ManagedEngineCode,
  type ManagedMemberObservedResult,
} from "../contracts/commands-contracts.ts";
import {
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import { sanitizeForLog } from "../util/logger.ts";
import { collectManagedMemberHealth } from "./containers.ts";
import { managedComposeProject, SAFE_MANAGED_ID_RE } from "./engine-paths.ts";
import { getManagedEngineRuntime } from "./engines/index.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

const MEMBER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ManagedHealthProbeRequest = {
  managedId: string;
  memberId: string;
  role: string;
  engine: string;
};

export type ManagedHealthProbeResult =
  | { ok: true; member: ManagedMemberObservedResult }
  | { ok: false; error: string };

function isEngineCode(value: string): value is ManagedEngineCode {
  return (MANAGED_ENGINE_CODES as readonly string[]).includes(value);
}

/**
 * Read one member's replication health now. Never throws: every failure is a
 * typed `{ ok: false, error }` so the control plane is answered instead of
 * left to its timeout.
 */
export async function probeManagedMemberHealth(
  request: ManagedHealthProbeRequest,
  run: RunDockerFn = defaultRunDocker,
): Promise<ManagedHealthProbeResult> {
  if (!SAFE_MANAGED_ID_RE.test(request.managedId)) {
    return { ok: false, error: "managedId contains unsupported characters" };
  }
  if (!MEMBER_ID_RE.test(request.memberId)) {
    return { ok: false, error: "memberId is not a valid id" };
  }
  if (request.role !== "primary" && request.role !== "replica") {
    return { ok: false, error: "role must be primary or replica" };
  }
  if (!isEngineCode(request.engine)) {
    return { ok: false, error: "unsupported managed engine" };
  }

  try {
    const engine = getManagedEngineRuntime(request.engine);
    if (!engine.replication) {
      return {
        ok: false,
        error: `engine ${request.engine} has no replication health`,
      };
    }
    const collected = await collectManagedMemberHealth(
      managedComposeProject(request.managedId),
      engine,
      {
        memberId: request.memberId,
        role: request.role,
        redact: (text) => sanitizeForLog(text),
      },
      run,
    );
    const member = collected.member;
    if (!member || !member.replication) {
      // `collectManagedMemberHealth` swallows engine errors and omits the
      // member (container down, engine not answering). Say so.
      return {
        ok: false,
        error: "replication health unavailable (engine not running or not " +
          "answering)",
      };
    }
    return { ok: true, member };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeForLog(err instanceof Error ? err.message : String(err)),
    };
  }
}
