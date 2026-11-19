/**
 * A resolved commit id: 40 hex characters (SHA-1) or 64 (SHA-256). A branch
 * name, a tag or an empty string is not one, and must never be recorded or
 * reported as a commit.
 */
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function isResolvedCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_RE.test(value);
}
