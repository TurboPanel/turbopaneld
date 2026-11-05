/**
 * Which remotes the daemon may fetch a repository from: repository reads
 * (`repo-read-request`, `repo-default-branch-request`) and release checkouts
 * (`checkout.ts`) alike. Repositories must be on a public git host; there is
 * no setting that lifts this.
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
 * git itself is also pinned to https and ssh ({@link REPO_READ_GIT_PROTOCOLS},
 * {@link gitProtocolEnv}), so a transport the check missed, or a redirect to
 * another scheme, is refused by git too. An https redirect to another host on
 * the same scheme is not stopped here.
 */

import { internalHostReason } from "../compose-build-policy.ts";

/** The transports git may use to fetch a repository. */
export const REPO_READ_GIT_PROTOCOLS = ["https", "ssh"] as const;

/**
 * Which remotes a fetch may use and how git is pinned to them. The default
 * ({@link PUBLIC_REMOTE}) is the only one production uses: https and ssh to a
 * public host. A test passes a local-path transport to fetch a fixture
 * repository with real git.
 */
export type RepoGitTransport = {
  /** git transports allowed (`protocol.<name>.allow=always`, `GIT_ALLOW_PROTOCOL`). */
  protocols: readonly string[];
  /** Throws when the clone URL may not be fetched. */
  checkUrl: (cloneUrl: string) => void;
};

/** Leading words of every refusal, so an operator knows what to change. */
export const PUBLIC_GIT_HOST_REQUIRED =
  "repositories must be on a public git host";

/** `user@host:path`: the user and the host, before the first colon. */
const SCP_LIKE_RE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/;

/** A host name or IPv4 literal that starts like one, never with `-` or `.`. */
const HOST_START_RE = /^[A-Za-z0-9[]/;

export class CloneUrlRefusedError extends Error {
  constructor(reason: string) {
    super(
      `this repository address is refused: ${PUBLIC_GIT_HOST_REQUIRED} (${reason})`,
    );
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

/** `ssh://user@host:port`: everything between the scheme and the first `/`. */
function sshAuthority(cloneUrl: string): string {
  const rest = cloneUrl.slice("ssh://".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function hostOf(cloneUrl: string): string {
  if (cloneUrl.startsWith("https://")) return urlHost(cloneUrl, "https");
  if (cloneUrl.startsWith("ssh://")) {
    // The URL parser leaves an `ssh:` host percent-encoded, but git decodes
    // the whole URL before it calls ssh: `ssh://git@x%40127.0.0.1/r` would
    // pass the host check as `x%40127.0.0.1` and dial 127.0.0.1.
    if (sshAuthority(cloneUrl).includes("%")) {
      throw new CloneUrlRefusedError(
        "an ssh address must not percent-encode its user or host",
      );
    }
    return urlHost(cloneUrl, "ssh");
  }
  const scp = SCP_LIKE_RE.exec(cloneUrl);
  if (scp === null) {
    throw new CloneUrlRefusedError(
      "only https://, ssh:// and user@host:path addresses are read",
    );
  }
  return scp[2]!;
}

/** Throws {@link CloneUrlRefusedError} unless the daemon may fetch from `cloneUrl`. */
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

/** https and ssh to a public host: the transport every production fetch uses. */
export const PUBLIC_REMOTE: RepoGitTransport = {
  protocols: REPO_READ_GIT_PROTOCOLS,
  checkUrl: assertCloneUrlAllowed,
};

/** `-c` options that refuse every transport but the allowed ones. */
export function gitProtocolArgs(protocols: readonly string[]): string[] {
  return [
    "-c",
    "protocol.allow=never",
    ...protocols.flatMap((name) => ["-c", `protocol.${name}.allow=always`]),
  ];
}

/**
 * `GIT_ALLOW_PROTOCOL` for the allowed transports. git reads it before any
 * `protocol.*` setting, so on its own it refuses every other transport.
 */
export function gitProtocolEnv(
  protocols: readonly string[],
): Record<string, string> {
  return { GIT_ALLOW_PROTOCOL: protocols.join(":") };
}
