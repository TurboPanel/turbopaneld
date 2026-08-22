/**
 * Transcript redaction.
 *
 * The deny-set is always built from values the daemon just decrypted — variable
 * material, principal / managed credential passwords, TLS private key PEM
 * bodies, sealed-envelope plaintexts. Literal `replaceAll` over known plaintext
 * only; never a generic secret-scanning heuristic (that both misses real
 * secrets and mangles ordinary build output).
 */

import { stripLogInjection } from "../logger.ts";

export type TranscriptRedactor = (line: string) => string;

export const REDACTED = "***";

/**
 * Shared deny-set replacement used by both the transcript redactor and
 * `managed/apply.ts`'s error redaction — one implementation, two call sites.
 */
export function redactSecretValues(
  text: string,
  plaintexts: readonly string[],
): string {
  let out = text;
  for (const secret of plaintexts) {
    if (secret.length === 0) continue;
    out = out.replaceAll(secret, REDACTED);
  }
  return out;
}

/** Single characters would shred ordinary output for no security gain. */
const MIN_SECRET_LENGTH = 2;

const NEWLINE_RE = /\r?\n/;

/** Add one candidate plus its trimmed form (both are matched literally). */
function addDenyCandidate(value: string, into: Set<string>): void {
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  // Keep the exact decrypted value: leading/trailing characters are part of
  // the plaintext and are needed for an exact match.
  into.add(value);
  if (trimmed !== value) into.add(trimmed);
}

/** Stable tie-break for equal-length deny candidates: code point order. */
function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Normalize a deny-set: drop empties/nullish, de-duplicate, expand multiline
 * plaintexts into their individual lines, and order longest first so a longer
 * secret is replaced before any shorter substring of it.
 *
 * The line expansion is what makes PEM bodies redactable: transcripts are
 * processed one line at a time (`logs/sink.ts`), so a decrypted TLS private
 * key — a single plaintext containing embedded newlines — would never match
 * as a whole. Every one of its lines is a deny-set entry of its own.
 */
export function normalizeDenySet(
  values: readonly (string | null | undefined)[],
): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    addDenyCandidate(value, unique);
    if (!NEWLINE_RE.test(value)) continue;
    for (const fragment of value.split(NEWLINE_RE)) {
      addDenyCandidate(fragment, unique);
    }
  }
  return [...unique].sort((a, b) => b.length - a.length || byCodePoint(a, b));
}

/**
 * One-shot redaction over a raw plaintext list — the same normalized deny-set
 * {@link createTranscriptRedactor} builds (used by `managed/apply.ts` for
 * error text, which never passes through the line sink).
 */
export function redactPlaintexts(
  text: string,
  plaintexts: readonly (string | null | undefined)[],
): string {
  return redactSecretValues(text, normalizeDenySet(plaintexts));
}

/**
 * Build a line redactor over a fixed deny-set: scrub every known plaintext,
 * then strip log-injection control characters (`src/logger.ts`).
 */
export function createTranscriptRedactor(
  secrets: readonly string[],
): TranscriptRedactor {
  const denySet = normalizeDenySet(secrets);
  return (line: string) => stripLogInjection(redactSecretValues(line, denySet));
}

/** A redactor whose deny-set grows as the handler decrypts more material. */
export interface MutableTranscriptRedactor {
  add(values: readonly (string | null | undefined)[]): void;
  redact(line: string): string;
  /** Current deny-set (test/diagnostic use). */
  secrets(): readonly string[];
}

export function createMutableTranscriptRedactor(
  initial: readonly (string | null | undefined)[] = [],
): MutableTranscriptRedactor {
  let denySet = normalizeDenySet(initial);
  let redactor = createTranscriptRedactor(denySet);
  return {
    add(values) {
      const merged = normalizeDenySet([...denySet, ...values]);
      if (merged.length === denySet.length) return;
      denySet = merged;
      redactor = createTranscriptRedactor(denySet);
    },
    redact(line) {
      return redactor(line);
    },
    secrets() {
      return denySet;
    },
  };
}

/**
 * Process-wide deny-set.
 *
 * Every decrypt seam feeds this registry (`capture.ts`), *not* whichever
 * collector happens to be running at decrypt time. Container output keeps
 * printing credentials long after the deploy that decrypted them finished, and
 * collection can start late (the org toggle flips mid-life) or restart (a
 * server-id rebind). A per-collector deny-set would start empty in both cases
 * and leak previously decrypted plaintext into retained logs, so the deny-set
 * outlives every collector instance.
 *
 * It only ever grows within a process — a daemon restart is the only thing that
 * clears it, and after one nothing on the host holds the old plaintext either.
 */
let sharedRedactor: MutableTranscriptRedactor | undefined;

/** The process-wide deny-set. Created on first use. */
export function sharedSecretRedactor(): MutableTranscriptRedactor {
  sharedRedactor ??= createMutableTranscriptRedactor();
  return sharedRedactor;
}

/** Extend the process-wide deny-set with plaintext the daemon just decrypted. */
export function rememberSecretPlaintexts(
  values: readonly (string | null | undefined)[],
): void {
  sharedSecretRedactor().add(values);
}

/**
 * Redact a **command summary** — the multi-line stdout/stderr a handler is
 * about to throw as an error message, which never passes through the per-line
 * transcript sink.
 *
 * Two deny-sets are applied because either can be the only one that knows a
 * value: `local` carries the seed a sink was constructed with, and the
 * process-wide registry carries everything any decrypt seam has ever produced.
 * Newlines are preserved on purpose — the caller (`sanitizeForLog`) decides how
 * to flatten the result for a log line.
 */
export function redactCommandSummary(
  text: string,
  local: readonly string[] = [],
): string {
  return redactSecretValues(
    redactSecretValues(text, local),
    sharedSecretRedactor().secrets(),
  );
}

/** Test-only: drop the process-wide deny-set so suites do not bleed into each other. */
export function resetSharedSecretRedactorForTests(): void {
  sharedRedactor = undefined;
}
