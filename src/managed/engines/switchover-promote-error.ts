/**
 * Machine-readable planned-switchover promote failures for the control plane.
 */

export type SwitchoverPromoteFailureCode =
  | "gtid_wait_timeout"
  | "gtid_wait_error"
  | "promote_started";

const PREFIX = "switchover_promote:";

export function switchoverPromoteErrorMessage(
  code: SwitchoverPromoteFailureCode,
  detail: string,
): string {
  return `${PREFIX}${code}: ${detail}`;
}

export function parseSwitchoverPromoteFailureCode(
  error: string | undefined,
): SwitchoverPromoteFailureCode | null {
  if (!error) return null;
  const match =
    /^switchover_promote:(gtid_wait_timeout|gtid_wait_error|promote_started):/
      .exec(error);
  if (!match) return null;
  return match[1] as SwitchoverPromoteFailureCode;
}
