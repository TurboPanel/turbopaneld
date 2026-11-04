/**
 * The CI daemon state sentinel: it notices every kind of write, it never
 * seeds over real files, and verify.yml seeds it before the tests and checks
 * it after them. Temp dirs under `/tmp` only.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  isUnderSystemTemp,
  realPathOfNearest,
  seedSentinel,
  SENTINEL_FILES,
  sentinelProblems,
} from "./daemon-state-sentinel.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const SCRIPT = join(REPO, "scripts", "daemon-state-sentinel.ts");
const [FIRST_FILE, SECOND_FILE] = Object.keys(SENTINEL_FILES);

async function withSeeded(
  fn: (dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "tp-state-sentinel-",
  });
  try {
    seedSentinel(dir, false);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("a freshly seeded sentinel has no problems", async () => {
  await withSeeded((dir) => {
    assertEquals(sentinelProblems(dir), []);
    for (const [name, body] of Object.entries(SENTINEL_FILES)) {
      assertEquals(Deno.readTextFileSync(join(dir, name)), body);
    }
  });
});

test("the sentinel holds the daemon identity files", () => {
  assertEquals(Object.keys(SENTINEL_FILES).length, 6);
  assert(Object.keys(SENTINEL_FILES).includes("server.id"));
  assert(Object.keys(SENTINEL_FILES).includes("sealing-key.json"));
});

test("an overwritten file is reported", async () => {
  await withSeeded(async (dir) => {
    await Deno.writeTextFile(join(dir, FIRST_FILE), "a throwaway value");
    assertEquals(sentinelProblems(dir), [`changed: ${FIRST_FILE}`]);
  });
});

test("a removed file is reported", async () => {
  await withSeeded(async (dir) => {
    await Deno.remove(join(dir, SECOND_FILE));
    assertEquals(sentinelProblems(dir), [`removed: ${SECOND_FILE}`]);
  });
});

test("a new file or folder anywhere under the dir is reported", async () => {
  await withSeeded(async (dir) => {
    await Deno.mkdir(join(dir, "update", "run"), { recursive: true });
    assertEquals(sentinelProblems(dir), [
      "new entry: update",
      "new entry: update/run",
    ]);
  });
});

test("a sentinel file replaced by a link is reported", async () => {
  await withSeeded(async (dir) => {
    await Deno.remove(join(dir, "server.id"));
    await Deno.symlink("/etc/hostname", join(dir, "server.id"));
    assertEquals(sentinelProblems(dir), ["not a plain file: server.id"]);
  });
});

test("a missing dir is reported", () => {
  assertEquals(sentinelProblems("/tmp/tp-state-sentinel-never-made"), [
    "/tmp/tp-state-sentinel-never-made is missing",
  ]);
});

test("seed never writes over files that are not the sentinel", async () => {
  const dir = await Deno.makeTempDir({
    prefix: "tp-state-sentinel-",
  });
  try {
    await Deno.writeTextFile(join(dir, "server.id"), "real-looking");
    assertThrows(() => seedSentinel(dir, false), Error, "refusing to seed");
    assertEquals(
      await Deno.readTextFile(join(dir, "server.id")),
      "real-looking",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("seed refuses a dir outside the system temp folder unless it runs under GitHub Actions", () => {
  assertThrows(
    () => seedSentinel("/var/lib/turbopanel-sentinel-never-made", false),
    Error,
    "outside the system temp folder",
  );
});

test("seed refuses a temp path that is a link to a folder outside the temp folder", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-state-sentinel-" });
  try {
    // A link that leaves the temp folder (the repo checkout stands in for a
    // real state dir; nothing is written through it).
    const link = join(root, "state");
    await Deno.symlink(REPO, link);
    assertEquals(isUnderSystemTemp(link), false);
    assertEquals(isUnderSystemTemp(join(link, "never-made")), false);
    assertThrows(
      () => seedSentinel(join(link, "never-made"), false),
      Error,
      "outside the system temp folder",
    );
    assertEquals(
      await Deno.lstat(join(REPO, "never-made")).then(() => true, () => false),
      false,
    );
    // A plain temp path, existing or not, is inside.
    assert(isUnderSystemTemp(root));
    assert(isUnderSystemTemp(join(root, "a", "b")));
    assertEquals(
      realPathOfNearest(join(root, "a", "b")),
      join(Deno.realPathSync(root), "a", "b"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("verify exits non-zero and names the change", async () => {
  await withSeeded(async (dir) => {
    await Deno.writeTextFile(join(dir, "server.id"), "throwaway");
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", SCRIPT, "verify", dir],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 1);
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      "changed: server.id",
    );
  });
});

test("verify.yml seeds the sentinel before the tests and verifies it after", () => {
  const verify = Deno.readTextFileSync(
    join(REPO, ".github", "workflows", "verify.yml"),
  );
  const seed = verify.indexOf(
    "scripts/daemon-state-sentinel.ts seed /var/lib/turbopanel",
  );
  const tests = verify.indexOf("run: deno task test:coverage");
  const check = verify.indexOf(
    "scripts/daemon-state-sentinel.ts verify /var/lib/turbopanel",
  );
  assert(seed >= 0 && tests > seed, "seed the sentinel before the tests");
  assert(check > tests, "verify the sentinel after the tests");
  const step = verify.slice(verify.lastIndexOf("- name:", check), check);
  assertStringIncludes(step, "!cancelled()", "verify even when tests fail");
});

test("the privileged single-file test runs are inside the sentinel too", () => {
  const verify = Deno.readTextFileSync(
    join(REPO, ".github", "workflows", "verify.yml"),
  );
  const job = verify.slice(
    verify.indexOf("\n  privileged-suites:"),
    verify.indexOf("\n  ci-ok:"),
  );
  const seed = job.indexOf(
    "scripts/daemon-state-sentinel.ts seed /var/lib/turbopanel",
  );
  const check = job.indexOf(
    "scripts/daemon-state-sentinel.ts verify /var/lib/turbopanel",
  );
  const runs = [...job.matchAll(/deno test /g)].map((m) => m.index);
  assert(runs.length > 0, "the job runs tests");
  assert(seed >= 0 && runs.every((at) => at > seed), "seed before every run");
  assert(runs.every((at) => check > at), "verify after every run");
  const step = job.slice(job.lastIndexOf("- name:", check), check);
  assertStringIncludes(step, "!cancelled()", "verify even when tests fail");
});
