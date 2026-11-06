import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { AnsibleEvent } from "./ansible-events.ts";
import { runPlaybookStreaming } from "./ansible-events.ts";
import {
  noteRepoKeyChanges,
  parseRepoKeyChange,
  REPO_KEY_CHANGED_MARKER,
  repoKeyChangeId,
  repoKeyChangesFromEvent,
  RepoKeyLedger,
} from "./repo-key-changes.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const OLD = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88";
const NEW = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

function structured(overrides: Record<string, unknown> = {}) {
  return {
    [REPO_KEY_CHANGED_MARKER]: {
      name: "docker",
      expected: [OLD],
      got: NEW,
      ...overrides,
    },
  };
}

function okEvent(msg: unknown): AnsibleEvent {
  return {
    _event: "v2_runner_on_ok",
    _timestamp: "2026-10-31T00:00:00Z",
    task: {
      name: "Report the key change to the daemon",
      id: "1",
      path: "",
      duration: { start: "" },
    },
    hosts: { localhost: { msg } },
  } as AnsibleEvent;
}

async function tempLedger(
  now: () => string = () => "2026-10-31T00:00:00.000Z",
): Promise<{ ledger: RepoKeyLedger; path: string; dir: string }> {
  const dir = await Deno.makeTempDir({ prefix: "tp-repo-key-" });
  const path = join(dir, "spool", "repo-key-reports.json");
  return { ledger: new RepoKeyLedger(path, now), path, dir };
}

test("a structured message becomes a change with upper-case fingerprints", () => {
  assertEquals(
    parseRepoKeyChange(structured({ got: NEW.toLowerCase() })),
    { name: "docker", expected: [OLD], got: NEW },
  );
});

test("a list that reached us as text still yields its fingerprints", () => {
  assertEquals(
    parseRepoKeyChange(structured({ expected: `['${OLD}', '${NEW}']` }))
      ?.expected,
    [OLD, NEW],
  );
});

test("malformed or unrelated messages are not changes", () => {
  assertEquals(parseRepoKeyChange("WARN docker repository key changed"), null);
  assertEquals(parseRepoKeyChange(null), null);
  assertEquals(parseRepoKeyChange({ other: {} }), null);
  assertEquals(parseRepoKeyChange(structured({ name: "Docker Inc" })), null);
  assertEquals(parseRepoKeyChange(structured({ got: "nope" })), null);
  assertEquals(parseRepoKeyChange(structured({ expected: [] })), null);
  assertEquals(parseRepoKeyChange(structured({ expected: ["nope"] })), null);
});

test("only a finished task result carries a change", () => {
  assertEquals(repoKeyChangesFromEvent(okEvent(structured())).length, 1);
  const failed = { ...okEvent(structured()), _event: "v2_runner_on_failed" };
  assertEquals(repoKeyChangesFromEvent(failed as AnsibleEvent), []);
  const skipped = { ...okEvent(structured()), _event: "v2_runner_on_skipped" };
  assertEquals(repoKeyChangesFromEvent(skipped as AnsibleEvent), []);
  // The free-text WARN line and a failed fetch are not changes.
  assertEquals(
    repoKeyChangesFromEvent(
      okEvent(
        "WARN docker repository key could not be fetched from https://example.test; using the copy shipped with TurboPanel",
      ),
    ),
    [],
  );
});

test("the ledger reports a key name and fingerprint once", async () => {
  const { ledger, dir } = await tempLedger();
  const change = { name: "docker", expected: [OLD], got: NEW };
  assertEquals(await ledger.record(change), true);
  assertEquals(await ledger.record(change), false);
  assertEquals(await ledger.pending(), [change]);

  await ledger.markSent(change);
  assertEquals(await ledger.pending(), []);
  // Seen again after it was reported: not new.
  assertEquals(await ledger.record(change), false);
  assertEquals(await ledger.pending(), []);

  // The same name with another fingerprint, or another name, is new.
  assertEquals(await ledger.record({ ...change, got: OLD }), true);
  assertEquals(await ledger.record({ ...change, name: "sury-php" }), true);
  assertEquals((await ledger.pending()).map(repoKeyChangeId), [
    `docker:${OLD}`,
    `sury-php:${NEW}`,
  ]);
  await Deno.remove(dir, { recursive: true });
});

test("a new ledger on the same file remembers what was sent and what is pending", async () => {
  const { ledger, path, dir } = await tempLedger();
  const sent = { name: "docker", expected: [OLD], got: NEW };
  const waiting = { name: "sury-php", expected: [OLD], got: NEW };
  await ledger.record(sent);
  await ledger.markSent(sent);
  await ledger.record(waiting);

  const restarted = new RepoKeyLedger(path);
  assertEquals(await restarted.record(sent), false);
  assertEquals(await restarted.pending(), [waiting]);
  await Deno.remove(dir, { recursive: true });
});

test("a torn file starts over instead of failing", async () => {
  const { ledger, path, dir } = await tempLedger();
  await Deno.mkdir(join(dir, "spool"), { recursive: true });
  await Deno.writeTextFile(path, "{not json");
  assertEquals(await ledger.pending(), []);
  assertEquals(
    await ledger.record({ name: "docker", expected: [OLD], got: NEW }),
    true,
  );
  await Deno.remove(dir, { recursive: true });
});

test("subscribers hear about a new change only", async () => {
  const { ledger, dir } = await tempLedger();
  let heard = 0;
  ledger.subscribe(() => heard++);
  const change = { name: "docker", expected: [OLD], got: NEW };
  await ledger.record(change);
  await ledger.record(change);
  assertEquals(heard, 1);
  await Deno.remove(dir, { recursive: true });
});

test("noteRepoKeyChanges records structured warnings and ignores the rest", async () => {
  const { ledger, dir } = await tempLedger();
  await noteRepoKeyChanges(okEvent("WARN something else"), () => ledger);
  assertEquals(await ledger.pending(), []);
  await noteRepoKeyChanges(okEvent(structured()), () => ledger);
  assertEquals((await ledger.pending()).length, 1);
  await Deno.remove(dir, { recursive: true });
});

test("noteRepoKeyChanges never rejects when the ledger cannot be used", async () => {
  await noteRepoKeyChanges(okEvent(structured()), () => {
    throw new Error("no layout");
  });
});

test("the shared playbook runner captures a structured warning, quiet or not", async () => {
  const { ledger, dir } = await tempLedger();
  const bin = join(dir, "ansible-playbook");
  const line = JSON.stringify(okEvent(structured()));
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' '${line}'\nexit 0\n`,
  );
  await Deno.chmod(bin, 0o755);

  await runPlaybookStreaming(bin, ["play.yml"], {
    quiet: true,
    repoKeyLedger: () => ledger,
  });
  await runPlaybookStreaming(bin, ["play.yml"], {
    quiet: false,
    repoKeyLedger: () => ledger,
  });
  // Let the unawaited writes finish.
  const pending = await ledger.pending();
  assertEquals(pending, [{ name: "docker", expected: [OLD], got: NEW }]);
  await Deno.remove(dir, { recursive: true });
});

test("the repo-key role emits the structured message the runner reads", async () => {
  const role = await Deno.readTextFile(
    new URL(
      "../../orchestration/roles/repo-key/tasks/main.yml",
      import.meta.url,
    ),
  );
  assertEquals(role.includes(`${REPO_KEY_CHANGED_MARKER}:`), true);
  for (const field of ["name:", "expected:", "got:"]) {
    assertEquals(role.includes(`            ${field}`), true, field);
  }
});
