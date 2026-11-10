/**
 * Daemon-signed reports on a signed session. The control plane acts on a
 * `managed-ha-event` only when it is signed (it fences and promotes database
 * members), and on a
 * `command-outcome` (a fabric reconcile result carries this host's
 * TurboFabric public key, which it hands to other servers) and on a
 * `fabric-peers-report` (peer health it reads as liveness), so on a signed
 * session these two are signed with the daemon key. A proxy or tunnel that
 * ends TLS between this server and the control plane can still strip the
 * signature, but a forged or altered signed report is detected, and once the
 * control plane has seen this server sign it refuses unsigned reports. So a
 * report is never sent unsigned just because the attach frame's feature list
 * has not arrived yet (`signed-session.ts` holds it).
 *
 * Same byte rules as the control plane's signed frames
 * (`panel-identity-frames.ts`): the message gets the envelope members
 * `{sessionId, iat, kid}`, is serialized once, and the signature over
 * `"tp-report\n" + type + "\n" + <those bytes>` is written as
 * `,"sig":"<base64url>"}` in place of the final `}`. There is no `seq`: a
 * `command-outcome` is idempotent by its id and a peer report only replaces
 * the last reading.
 */
import { signChallenge } from "../crypto/keys.ts";
import { REPORT_PREFIX, SIG_SUFFIX_MARKER } from "./panel-identity-frames.ts";

/**
 * The frames this daemon signs on a signed session. `managed-ha-event` (dead
 * primary and boot-hold reports) is signed only for a control plane that
 * lists `signed-ha-events-v1`; that control plane acts on no unsigned one.
 */
export const SIGNED_REPORT_TYPES: ReadonlySet<string> = new Set([
  "command-outcome",
  "fabric-peers-report",
  "managed-ha-event",
]);

/** Envelope members a signed report carries; a report may not use these names. */
const REPORT_ENVELOPE_FIELDS = ["sessionId", "iat", "kid", "sig"] as const;

const TYPE_MARKERS = [...SIGNED_REPORT_TYPES].map((type) =>
  `"type":${JSON.stringify(type)}`
);

export interface ReportSigningKey {
  keyId: string;
  privateJwk: JsonWebKey;
}

/** The text the daemon key signs for one report. */
export function reportSigningInput(type: string, unsigned: string): string {
  return `${REPORT_PREFIX}${type}\n${unsigned}`;
}

/** Cheap pre-check before a frame is parsed: false means it is not a report. */
export function mayBeSignedReport(data: string): boolean {
  return TYPE_MARKERS.some((marker) => data.includes(marker));
}

function reportRecord(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.type === "string" &&
        SIGNED_REPORT_TYPES.has(record.type)
      ? record
      : null;
  } catch {
    return null;
  }
}

/** The report type of `data` (one of {@link SIGNED_REPORT_TYPES}), or null. */
export function reportTypeOf(data: string): string | null {
  return (reportRecord(data)?.type as string | undefined) ?? null;
}

/**
 * `data` signed as a report for `sessionId`, or `data` unchanged when it is
 * not one of {@link SIGNED_REPORT_TYPES}. Throws when the report already
 * uses an envelope member name or signing fails; the caller then sends the
 * frame unsigned.
 */
export async function signReportFrame(
  data: string,
  ctx: { sessionId: string; key: ReportSigningKey; nowMs: number },
): Promise<string> {
  const record = reportRecord(data);
  if (!record) return data;
  const type = record.type as string;
  for (const field of REPORT_ENVELOPE_FIELDS) {
    if (field in record) {
      throw new TypeError(`${type} already has envelope member ${field}`);
    }
  }
  const unsigned = JSON.stringify({
    ...record,
    sessionId: ctx.sessionId,
    iat: Math.floor(ctx.nowMs / 1000),
    kid: ctx.key.keyId,
  });
  const sig = await signChallenge(
    ctx.key.privateJwk,
    reportSigningInput(type, unsigned),
  );
  return `${unsigned.slice(0, -1)}${SIG_SUFFIX_MARKER}${sig}"}`;
}
