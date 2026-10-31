/**
 * A package source's signing key that is not one TurboPanel expects.
 *
 * The `repo-key` Ansible role keeps going with such a key (apt still checks
 * every package signature) and says so twice: a `WARN` line for people and a
 * `debug` task whose message is `{turbopanel_repo_key_changed: {name, expected,
 * got}}`. {@link repoKeyChangesFromEvent} reads the second one out of the
 * playbook's task events, so nothing parses free text. The failed fetch
 * ("using the copy shipped with TurboPanel") is deliberately not one of these:
 * it is noise.
 *
 * {@link RepoKeyLedger} remembers, per key name and fingerprint, what has
 * been seen and what has been reported to the control plane, in
 * `<daemonStateDir>/spool/repo-key-reports.json`. A change is reported once;
 * it stays pending until a report actually goes out, so a converge that ran
 * before the socket was up (or against a control plane too old to take the
 * report) is not lost.
 */
import { dirname, join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { AnsibleEvent, AnsibleTaskResultEvent } from "./ansible-events.ts";
import { forEachSequential } from "../util/sequential.ts";
import { logWarn } from "../util/logger.ts";

export const REPO_KEY_CHANGED_MARKER = "turbopanel_repo_key_changed";

/** A short lower-case source name such as `docker` or `sury-php`. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const FINGERPRINT_RE = /^(?:[0-9A-Fa-f]{40}|[0-9A-Fa-f]{64})$/;
const FINGERPRINT_SCAN_RE = /[0-9A-Fa-f]{40}(?:[0-9A-Fa-f]{24})?/g;
/** The wire frame lists at most this many expected fingerprints. */
export const REPO_KEY_MAX_EXPECTED = 16;
/** Reported entries remembered; the oldest go first. */
const MAX_SENT_REMEMBERED = 200;
const MAX_PENDING = 64;

export type RepoKeyChange = {
  /** The source's short name. */
  name: string;
  /** Fingerprints the daemon expected (upper case). */
  expected: string[];
  /** The fingerprint it found (upper case). */
  got: string;
};

/** One key name and fingerprint: what "once" means. */
export function repoKeyChangeId(change: Pick<RepoKeyChange, "name" | "got">) {
  return `${change.name}:${change.got.toUpperCase()}`;
}

function fingerprintList(value: unknown): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && FINGERPRINT_RE.test(item.trim())) {
        found.push(item.trim().toUpperCase());
      }
    }
  } else if (typeof value === "string") {
    // A list that reached us as text, such as "['AB..', 'CD..']".
    for (const match of value.match(FINGERPRINT_SCAN_RE) ?? []) {
      found.push(match.toUpperCase());
    }
  }
  return [...new Set(found)].slice(0, REPO_KEY_MAX_EXPECTED);
}

/** The change one structured message carries, or null when it is not one or is malformed. */
export function parseRepoKeyChange(message: unknown): RepoKeyChange | null {
  if (typeof message !== "object" || message === null) return null;
  const body = (message as Record<string, unknown>)[REPO_KEY_CHANGED_MARKER];
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const got = typeof record.got === "string" ? record.got.trim() : "";
  if (!NAME_RE.test(name) || !FINGERPRINT_RE.test(got)) return null;
  const expected = fingerprintList(record.expected);
  if (expected.length === 0) return null;
  return { name, expected, got: got.toUpperCase() };
}

/** Every key change a finished task carries (one per host in the result). */
export function repoKeyChangesFromEvent(event: AnsibleEvent): RepoKeyChange[] {
  if (event._event !== "v2_runner_on_ok") return [];
  const hosts = (event as AnsibleTaskResultEvent).hosts;
  if (typeof hosts !== "object" || hosts === null) return [];
  const changes: RepoKeyChange[] = [];
  for (const result of Object.values(hosts)) {
    const change = parseRepoKeyChange(result?.msg);
    if (change) changes.push(change);
  }
  return changes;
}

type LedgerFile = {
  version: 1;
  /** Seen, not yet reported. */
  pending: Record<string, RepoKeyChange & { seenAt: string }>;
  /** Reported, with when. */
  sent: Record<string, string>;
};

function emptyLedger(): LedgerFile {
  return { version: 1, pending: {}, sent: {} };
}

export function repoKeyLedgerPath(layout: Pick<LayoutPaths, "daemonStateDir">) {
  return join(layout.daemonStateDir, "spool", "repo-key-reports.json");
}

export type RepoKeyListener = () => void;

export class RepoKeyLedger {
  readonly #path: string;
  readonly #now: () => string;
  readonly #listeners = new Set<RepoKeyListener>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    path: string,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#path = path;
    this.#now = now;
  }

  /** Runs after a new change becomes pending. Returns the unsubscribe. */
  subscribe(listener: RepoKeyListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Note a change; true when it is new (neither pending nor already reported). */
  record(change: RepoKeyChange): Promise<boolean> {
    return this.#serial(async () => {
      const file = await this.#read();
      const id = repoKeyChangeId(change);
      if (id in file.sent || id in file.pending) return false;
      if (Object.keys(file.pending).length >= MAX_PENDING) return false;
      file.pending[id] = { ...change, seenAt: this.#now() };
      await this.#write(file);
      return true;
    }).then((isNew) => {
      if (isNew) { for (const listener of this.#listeners) listener(); }
      return isNew;
    });
  }

  /** Changes still waiting for a report, oldest first. */
  pending(): Promise<RepoKeyChange[]> {
    return this.#serial(async () => {
      const file = await this.#read();
      return Object.values(file.pending)
        .sort((a, b) => a.seenAt.localeCompare(b.seenAt))
        .map(({ name, expected, got }) => ({ name, expected, got }));
    });
  }

  /** The report went out: never pending or reported again. */
  markSent(change: RepoKeyChange): Promise<void> {
    return this.#serial(async () => {
      const file = await this.#read();
      const id = repoKeyChangeId(change);
      delete file.pending[id];
      file.sent[id] = this.#now();
      const ids = Object.keys(file.sent);
      if (ids.length > MAX_SENT_REMEMBERED) {
        const oldest = ids.toSorted((a, b) =>
          file.sent[a].localeCompare(file.sent[b])
        );
        for (const old of oldest.slice(0, ids.length - MAX_SENT_REMEMBERED)) {
          delete file.sent[old];
        }
      }
      await this.#write(file);
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #read(): Promise<LedgerFile> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.#path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return emptyLedger();
      throw err;
    }
    try {
      const parsed = JSON.parse(text) as Partial<LedgerFile>;
      if (parsed?.version !== 1) return emptyLedger();
      return {
        version: 1,
        pending: parsed.pending && typeof parsed.pending === "object"
          ? parsed.pending
          : {},
        sent: parsed.sent && typeof parsed.sent === "object" ? parsed.sent : {},
      };
    } catch {
      // A torn or hand-edited file starts over: at worst a notice repeats.
      return emptyLedger();
    }
  }

  async #write(file: LedgerFile): Promise<void> {
    await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await Deno.rename(tmp, this.#path);
  }
}

const ledgers = new Map<string, RepoKeyLedger>();

/** The process-wide ledger for a layout, so the runner and the reporter share one write queue. */
export function repoKeyLedgerFor(
  layout: Pick<LayoutPaths, "daemonStateDir"> = resolveLayout(
    Deno.env.toObject(),
  ),
): RepoKeyLedger {
  const path = repoKeyLedgerPath(layout);
  let ledger = ledgers.get(path);
  if (!ledger) {
    ledger = new RepoKeyLedger(path);
    ledgers.set(path, ledger);
  }
  return ledger;
}

/**
 * Called by the playbook runner for every task event. The returned promise
 * never rejects (the runner does not wait for it): a notice that cannot be
 * written is only a missed notice.
 */
export async function noteRepoKeyChanges(
  event: AnsibleEvent,
  ledger: () => RepoKeyLedger = repoKeyLedgerFor,
): Promise<void> {
  const changes = repoKeyChangesFromEvent(event);
  if (changes.length === 0) return;
  try {
    const target = ledger();
    await forEachSequential(changes, (change) => target.record(change));
  } catch (err) {
    logWarn(
      "orchestration",
      "could not remember a repository key change:",
      String(err),
    );
  }
}
