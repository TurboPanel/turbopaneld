/**
 * Which remotes a repository read may talk to (`repo-read-request`,
 * `repo-default-branch-request`).
 *
 * Only `https://host/...`, `ssh://[user@]host/...` and the scp-like
 * `user@host:path` are read. Everything else is refused before git runs:
 * `file:`, `git:`, `http:`, `ext::` and other transports, a bare local path,
 * an empty host, a value git could take as an option, credentials in an https
 * URL, and a host that is internal by the same static rule a remote Compose
 * build source is held to (`internalHostReason`: loopback, link-local,
 * private and ULA literals, `localhost`, single-label and reserved names). A
 * DNS name is not resolved: a check before git's own lookup could be answered
 * differently a moment later, so it would promise more than it holds.
 *
 * git itself is also pinned to https and ssh for these reads
 * ({@link REPO_READ_GIT_PROTOCOLS}), so a transport the check missed, or a
 * redirect to another scheme, is refused by git too.
 */

import { internalHostReason } from "../compose-build-policy.ts";

/** The transports git may use for a repository read. */
export const REPO_READ_GIT_PROTOCOLS = ["https", "ssh"] as const;

/** `user@host:path`: the user and the host, before the first colon. */
const SCP_LIKE_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/;

/** A host name or IPv4 literal that starts like one, never with `-` or `.`. */
const HOST_START_RE = /^[A-Za-z0-9[]/;

export class CloneUrlRefusedError extends Error {
  constructor(reason: string) {
    super(`this repository address is refused: ${reason}`);
    this.name = "CloneUrlRefusedError";
  }
}

function urlHost(cloneUrl: string, scheme: "https" | "ssh"): string {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new CloneUrlRefusedError("it cannot be read as a URL");
  }
  if (
    scheme === "https" && (parsed.username !== "" || parsed.password !== "")
  ) {
    throw new CloneUrlRefusedError("an https address must not carry a login");
  }
  if (parsed.password !== "") {
    throw new CloneUrlRefusedError("an ssh address must not carry a password");
  }
  return parsed.hostname;
}

function hostOf(cloneUrl: string): string {
  if (cloneUrl.startsWith("https://")) return urlHost(cloneUrl, "https");
  if (cloneUrl.startsWith("ssh://")) return urlHost(cloneUrl, "ssh");
  const scp = SCP_LIKE_RE.exec(cloneUrl);
  if (scp === null) {
    throw new CloneUrlRefusedError(
      "only https://, ssh:// and user@host:path addresses are read",
    );
  }
  return scp[2]!;
}

/** Throws {@link CloneUrlRefusedError} unless a repository read may use `cloneUrl`. */
export function assertCloneUrlAllowed(cloneUrl: string): void {
  // A backslash is read as `/` by the URL parser here but not by every git
  // transport, so the host checked could differ from the host git dials.
  if (cloneUrl.length === 0 || /[\s\0\\]/.test(cloneUrl)) {
    throw new CloneUrlRefusedError(
      "it is empty or contains a space or a backslash",
    );
  }
  if (cloneUrl.startsWith("-")) {
    throw new CloneUrlRefusedError("it could be read as a git option");
  }
  const host = hostOf(cloneUrl);
  if (host === "" || !HOST_START_RE.test(host)) {
    throw new CloneUrlRefusedError("it names no usable host");
  }
  const internal = internalHostReason(host);
  if (internal !== null) {
    throw new CloneUrlRefusedError(`its host ${internal}`);
  }
}
