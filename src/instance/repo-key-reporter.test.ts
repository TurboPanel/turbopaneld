import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DaemonMessage } from "../contracts/cell-messages.ts";
import { RepoKeyLedger } from "../orchestration/repo-key-changes.ts";
import { RepoKeyReporter } from "./repo-key-reporter.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see other suites here. */
const test = Deno.test.bind(Deno);

const OLD = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88";
const NEW = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
const CHANGE = { name: "docker", expected: [OLD], got: NEW };

async function setup(options: { supports: boolean; open: boolean }) {
  const dir = await Deno.makeTempDir({ prefix: "tp-repo-key-reporter-" });
  const path = join(dir, "spool", "repo-key-reports.json");
  const ledger = new RepoKeyLedger(path);
  const sent: DaemonMessage[] = [];
  const state = { ...options };
  const reporter = new RepoKeyReporter({
    send: (message) => {
      if (!state.open) return false;
      sent.push(message);
      return true;
    },
    peerSupportsReport: () => state.supports,
    ledger: () => ledger,
    nowMs: () => Date.parse("2026-10-31T12:00:00.000Z"),
  });
  return { dir, path, ledger, sent, state, reporter };
}

test("a pending change goes out once, as one frame, then stays reported", async () => {
  const { dir, ledger, sent, reporter } = await setup({
    supports: true,
    open: true,
  });
  await ledger.record(CHANGE);
  await reporter.flush();
  await reporter.flush();
  assertEquals(sent, [{
    type: "repo-key-changed",
    keyName: "docker",
    expected: [OLD],
    got: NEW,
    at: "2026-10-31T12:00:00.000Z",
  }]);
  assertEquals(await ledger.pending(), []);
  // Seen again on the next converge: still only one report.
  await ledger.record(CHANGE);
  await reporter.flush();
  assertEquals(sent.length, 1);
  await Deno.remove(dir, { recursive: true });
});

test("a control plane without the feature gets nothing and the change is kept", async () => {
  const { dir, ledger, sent, state, reporter } = await setup({
    supports: false,
    open: true,
  });
  await ledger.record(CHANGE);
  await reporter.flush();
  assertEquals(sent, []);
  assertEquals((await ledger.pending()).length, 1);

  state.supports = true;
  await reporter.flush();
  assertEquals(sent.length, 1);
  await Deno.remove(dir, { recursive: true });
});

test("a socket that is not open does not mark the change as sent", async () => {
  const { dir, ledger, sent, state, reporter } = await setup({
    supports: true,
    open: false,
  });
  await ledger.record(CHANGE);
  await reporter.flush();
  assertEquals(sent, []);
  assertEquals((await ledger.pending()).length, 1);

  state.open = true;
  await reporter.flush();
  assertEquals(sent.length, 1);
  assertEquals(await ledger.pending(), []);
  await Deno.remove(dir, { recursive: true });
});

test("attach sends what was waiting and what is recorded later, detach stops", async () => {
  const { dir, ledger, sent, reporter } = await setup({
    supports: true,
    open: true,
  });
  await ledger.record(CHANGE);
  reporter.attach();
  await reporter.flush();
  assertEquals(sent.length, 1);

  await ledger.record({ ...CHANGE, name: "sury-php" });
  await reporter.flush();
  assertEquals(sent.length, 2);

  reporter.detach();
  await ledger.record({ ...CHANGE, got: OLD });
  await reporter.flush();
  // Detach only stops the listener; an explicit flush still delivers.
  assertEquals(sent.length, 3);
  await Deno.remove(dir, { recursive: true });
});
