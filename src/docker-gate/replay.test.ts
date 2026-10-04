import { assert, assertEquals } from "@std/assert";
import {
  parseUsedIds,
  PersistentReplayCache,
} from "../../orchestration/roles/docker-gate/files/replay.ts";

const test = Deno.test.bind(Deno);
const NOW = 1_700_000_000;

type Rec = Record<string, unknown>;

async function withFile(
  run: (file: string, logs: Rec[]) => void | Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await run(`${dir}/approval-used.json`, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function open(file: string, enforce: boolean, logs: Rec[], now = NOW) {
  return new PersistentReplayCache(file, enforce, (r) => logs.push(r), now);
}

test("a token used before a restart is refused after it", () =>
  withFile((file, logs) => {
    assert(open(file, true, logs).claim("a", NOW + 600, NOW));
    const restarted = open(file, true, logs, NOW + 5);
    assertEquals(restarted.claim("a", NOW + 600, NOW + 5), false);
    assert(restarted.claim("b", NOW + 600, NOW + 5));
    assertEquals(logs, []);
  }));

test("the state file is 0600 and leaves no temp file", () =>
  withFile(async (file, logs) => {
    open(file, true, logs).claim("a", NOW + 600, NOW);
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    }
    const names = [...Deno.readDirSync(file.replace(/\/[^/]+$/, ""))]
      .map((e) => e.name);
    assertEquals(names, ["approval-used.json"]);
  }));

test("expired ids are pruned on load and on use", () =>
  withFile((file, logs) => {
    const first = open(file, true, logs);
    first.claim("old", NOW + 10, NOW);
    first.claim("new", NOW + 800, NOW);
    const later = NOW + 100;
    const restarted = open(file, true, logs, later);
    // the expired id is forgotten (its token is refused by expiry anyway)
    assert(restarted.claim("old", later + 600, later));
    assertEquals(restarted.claim("new", NOW + 800, later), false);
    const saved = JSON.parse(Deno.readTextFileSync(file));
    assertEquals(Object.keys(saved.ids).sort(), ["new", "old"]);
    assert(restarted.claim("x", later + 900, NOW + 900));
    const pruned = JSON.parse(Deno.readTextFileSync(file));
    assertEquals(Object.keys(pruned.ids), ["x"]);
  }));

test("a far-future expiry in the file is clamped to a token lifetime", () => {
  const ids = parseUsedIds(
    JSON.stringify({ v: 1, ids: { a: NOW + 10 ** 9 } }),
    NOW,
  );
  assertEquals(ids.get("a"), NOW + 900 + 60);
});

test("a corrupt file closes the door in enforce mode", () =>
  withFile((file, logs) => {
    for (
      const text of [
        "{nope",
        "[]",
        '{"v":2,"ids":{}}',
        '{"v":1,"ids":{"a":"x"}}',
      ]
    ) {
      Deno.writeTextFileSync(file, text);
      logs.length = 0;
      const cache = open(file, true, logs);
      assertEquals(cache.claim("a", NOW + 600, NOW), false, text);
      assertEquals(logs[0].event, "docker-gate.approval-state-corrupt");
      assertEquals(logs[0].failClosed, true);
      assertEquals(Deno.readTextFileSync(file), text, "left for inspection");
    }
  }));

test("a corrupt file is logged and replaced in observe mode", () =>
  withFile((file, logs) => {
    Deno.writeTextFileSync(file, "{nope");
    const cache = open(file, false, logs);
    assertEquals(logs[0].event, "docker-gate.approval-state-corrupt");
    assertEquals(logs[0].failClosed, false);
    assert(cache.claim("a", NOW + 600, NOW));
    assertEquals(JSON.parse(Deno.readTextFileSync(file)).ids, { a: NOW + 600 });
  }));

test("an unreadable file (a directory) fails closed in enforce mode", () =>
  withFile((file, logs) => {
    Deno.mkdirSync(file);
    const cache = open(file, true, logs);
    assertEquals(cache.claim("a", NOW + 600, NOW), false);
    assertEquals(logs[0].event, "docker-gate.approval-state-unreadable");
  }));

test("a failed write refuses in enforce and is logged in observe", () =>
  withFile((file, logs) => {
    const missing = `${file}-dir/approval-used.json`;
    assertEquals(open(missing, true, logs).claim("a", NOW + 600, NOW), false);
    assertEquals(logs.at(-1)?.event, "docker-gate.approval-state-unwritable");
    assert(open(missing, false, logs).claim("a", NOW + 600, NOW));
  }));

test("concurrent use of one token accepts it exactly once", () =>
  withFile(async (file, logs) => {
    const cache = open(file, true, logs);
    const results = await Promise.all(
      Array.from(
        { length: 50 },
        () => Promise.resolve().then(() => cache.claim("a", NOW + 600, NOW)),
      ),
    );
    assertEquals(results.filter(Boolean).length, 1);
    const other = await Promise.all(
      Array.from(
        { length: 20 },
        (_, i) =>
          Promise.resolve().then(() => cache.claim(`t${i}`, NOW + 600, NOW)),
      ),
    );
    assert(other.every(Boolean));
    assertEquals(
      Object.keys(JSON.parse(Deno.readTextFileSync(file)).ids).length,
      21,
    );
  }));
