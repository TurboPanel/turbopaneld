import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  parseTurbopanelStageLine,
  UpdateProgressReporter,
} from "./update-progress-reporter.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseTurbopanelStageLine accepts known stages", () => {
  assertEquals(
    parseTurbopanelStageLine("::turbopanel-stage::downloading"),
    "downloading",
  );
  assertEquals(parseTurbopanelStageLine("noise"), null);
});

test("UpdateProgressReporter persists and flushes when the peer supports progress", async () => {
  const root = await Deno.makeTempDir({ prefix: "update-progress-" });
  const sent: string[] = [];
  const reporter = new UpdateProgressReporter({
    stateDir: join(root, "state"),
    progressId: "req-1",
    upgradeId: "up-1",
    canSend: () => true,
    send: (message) => {
      sent.push(message.stage);
      return true;
    },
  });
  reporter.reportStage("daemon", "preparing");
  assertEquals(sent, ["preparing"]);
  sent.length = 0;
  reporter.setContext({
    canSend: () => true,
    send: (message) => {
      sent.push(message.stage);
      return true;
    },
  });
  await reporter.flushOnAttach();
  assertEquals(sent.length, 0);
  reporter.reportStage("daemon", "downloading");
  reporter.setContext({
    canSend: () => false,
    send: () => false,
  });
  reporter.reportStage("daemon", "installing");
  sent.length = 0;
  reporter.setContext({
    canSend: () => true,
    send: (message) => {
      sent.push(message.stage);
      return true;
    },
  });
  await reporter.flushOnAttach();
  assertEquals(sent, ["installing"]);
  await Deno.remove(root, { recursive: true });
});

test("UpdateProgressReporter does not send when the feature gate is closed", () => {
  let sends = 0;
  const reporter = new UpdateProgressReporter({
    progressId: "req-2",
    canSend: () => false,
    send: () => {
      sends += 1;
      return true;
    },
  });
  reporter.reportStage("daemon", "preparing");
  assertEquals(sends, 0);
});

test("UpdateProgressReporter serializes delayed append against a rewrite", async () => {
  const root = await Deno.makeTempDir({ prefix: "update-progress-delay-" });
  const queuePath = join(root, "state", "update", "progress-queue.jsonl");
  let stored = "";
  const persist = {
    mkdir: async () => {
      await Deno.mkdir(join(root, "state", "update"), { recursive: true });
    },
    readTextFile: () => Promise.resolve(stored),
    writeTextFile: async (_path: string, data: string) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      stored = data;
      await Deno.mkdir(join(root, "state", "update"), { recursive: true });
      await Deno.writeTextFile(queuePath, data);
    },
    remove: async () => {
      stored = "";
      try {
        await Deno.remove(queuePath);
      } catch {
        // Absent is fine.
      }
    },
  };
  let canSend = false;
  const sent: string[] = [];
  const reporter = new UpdateProgressReporter({
    stateDir: join(root, "state"),
    progressId: "req-delay",
    persist,
    canSend: () => canSend,
    send: (message) => {
      sent.push(message.stage);
      return true;
    },
  });
  reporter.reportStage("daemon", "installing");
  canSend = true;
  await reporter.flushOnAttach();
  await reporter.flush();
  const replayed: string[] = [];
  const resumed = new UpdateProgressReporter({
    stateDir: join(root, "state"),
    persist,
    canSend: () => true,
    send: (message) => {
      replayed.push(message.stage);
      return true;
    },
  });
  await resumed.flushOnAttach();
  assertEquals(sent, ["installing"]);
  assertEquals(replayed, []);
  await Deno.remove(root, { recursive: true });
});

test("UpdateProgressReporter replays queued stages in order on a fresh instance", async () => {
  const root = await Deno.makeTempDir({ prefix: "update-progress-replay-" });
  const reporter = new UpdateProgressReporter({
    stateDir: join(root, "state"),
    progressId: "req-order",
    canSend: () => false,
    send: () => false,
  });
  reporter.reportStage("daemon", "preparing");
  reporter.reportStage("daemon", "downloading");
  reporter.reportStage("daemon", "installing");
  await reporter.flush();
  const sent: string[] = [];
  const resumed = new UpdateProgressReporter({
    stateDir: join(root, "state"),
    canSend: () => true,
    send: (message) => {
      sent.push(`${message.id}:${message.stage}`);
      return true;
    },
  });
  await resumed.flushOnAttach();
  assertEquals(sent, [
    "req-order:preparing",
    "req-order:downloading",
    "req-order:installing",
  ]);
  await Deno.remove(root, { recursive: true });
});
