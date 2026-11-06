import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import {
  assertTestRunMayWrite,
  isDenoTestRun,
  isStrictlyInside,
} from "./test-write-guard.ts";
import { removeDaemonFile, writeDaemonFile } from "./daemon-files.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Never created: every writer must refuse before touching it. */
const REAL_LOOKING_DIR = "/var/lib/turbopanel-test-guard-never-written";

const neverRun = () => {
  throw new Error("the host fallback must not run");
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

test("a deno test run is detected from the main module", () => {
  assert(isDenoTestRun());
  assert(isDenoTestRun("file:///src/instance/client.test.ts"));
  assertEquals(isDenoTestRun("file:///opt/turbopanel/bin/main.ts"), false);
  assertEquals(isDenoTestRun(""), false);
});

test("isStrictlyInside rejects the root itself, siblings and dot segments", () => {
  assert(isStrictlyInside("/tmp/a", "/tmp"));
  assert(isStrictlyInside("/tmp/a/b/", "/tmp/"));
  assertEquals(isStrictlyInside("/tmp", "/tmp"), false);
  assertEquals(isStrictlyInside("/tmpx/a", "/tmp"), false);
  assertEquals(isStrictlyInside("/tmp/../var/lib/turbopanel", "/tmp"), false);
  assertEquals(isStrictlyInside("/tmp/./a", "/tmp"), false);
});

test("the guard refuses the real state dir in a test run and allows it in production", () => {
  assertThrows(
    () => assertTestRunMayWrite("/var/lib/turbopanel/server.id"),
    Error,
    "refusing to write",
  );
  assertThrows(() =>
    assertTestRunMayWrite("/etc/turbopanel/instance-ca.pem", {
      testRun: true,
      roots: ["/tmp"],
    })
  );
  assertTestRunMayWrite("/var/lib/turbopanel/server.id", { testRun: false });
});

test("the guard resolves symlinks: a link in a temp dir to a real dir is refused", async () => {
  const dir = await Deno.makeTempDir({ dir: "/tmp", prefix: "tp-guard-" });
  try {
    await Deno.symlink("/etc", join(dir, "to-etc"));
    await Deno.symlink(REAL_LOOKING_DIR, join(dir, "dangling"));
    await Deno.mkdir(join(dir, "plain"));
    assertThrows(() => assertTestRunMayWrite(join(dir, "to-etc", "server.id")));
    assertThrows(() => assertTestRunMayWrite(join(dir, "dangling")));
    assertTestRunMayWrite(join(dir, "plain", "server.id"));
    assertTestRunMayWrite(join(dir, "not-made-yet", "server.id"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a dir from Deno.makeTempDir is accepted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-guard-" });
  try {
    assertTestRunMayWrite(join(dir, "server.id"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("writeDaemonFile and removeDaemonFile refuse a real-looking dir before any I/O", async () => {
  const path = join(REAL_LOOKING_DIR, "server.id");
  await assertRejects(
    () => writeDaemonFile(path, "x\n", 0o640, neverRun),
    Error,
    "refusing to write",
  );
  await assertRejects(
    () => removeDaemonFile(path, neverRun),
    Error,
    "refusing to write",
  );
  assertEquals(await pathExists(REAL_LOOKING_DIR), false);
});

// ── Inventory: raw writers of daemon identity files call the guard ───────────

const REPO = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

/** A quoted daemon identity or trust file name. */
const NAMES_IDENTITY =
  /["'`/](?:license\.id|license\.token|server\.id|server-key\.json|server-key-id|sealing-key\.json|instance-ca\.pem|trust-level)["'`]/;

/** Deno calls that change the filesystem. */
const WRITES =
  /\bDeno\.(?:writeTextFile|writeFile|remove|rename|create|open|copyFile|symlink|link|truncate|chmod|chown)(?:Sync)?\s*\(/;

const GUARD = "assertTestRunMayWrite(";

const TOP_LEVEL_DECLARATION =
  /\n(?=(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\b)/;

/** Modules allowed to write these names without the guard, with the reason. */
const EXEMPT = new Map([
  [
    "src/permissions/daemon-files.ts",
    "the guarded helpers themselves (checked by the test above)",
  ],
]);

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name !== "testing") productionSources(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(relative(REPO, path));
    }
  }
  return out;
}

function codeOnly(source: string): string {
  return source
    .split("\n")
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? "" : line))
    .join("\n");
}

type Finding = { file: string; writer: string; guarded: boolean };

function findIdentityWriters(file: string, source: string): Finding[] {
  const code = codeOnly(source);
  if (!NAMES_IDENTITY.test(code)) return [];
  return code
    .split(TOP_LEVEL_DECLARATION)
    .filter((chunk) => WRITES.test(chunk))
    .map((chunk) => {
      const writer =
        /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class)\s+(\w+)/
          .exec(chunk)?.[1] ?? chunk.split("\n")[0].slice(0, 40);
      const guard = chunk.indexOf(GUARD);
      return {
        file,
        writer,
        guarded: guard >= 0 && guard < chunk.search(WRITES),
      };
    });
}

function inventory(): Finding[] {
  return productionSources(join(REPO, "src"))
    .sort()
    .filter((file) => !EXEMPT.has(file))
    .flatMap((file) =>
      findIdentityWriters(file, Deno.readTextFileSync(join(REPO, file)))
    );
}

test("every raw writer in a module that names daemon identity files calls the guard first", () => {
  assertEquals(inventory().filter((f) => !f.guarded), []);
});

test("the scan flags a writer that skips the guard or calls it too late", () => {
  const missing = [
    "export async function sneak(dir: string): Promise<void> {",
    '  await Deno.writeTextFile(`${dir}/server.id`, "x");',
    "}",
  ].join("\n");
  assertEquals(findIdentityWriters("x.ts", missing), [
    { file: "x.ts", writer: "sneak", guarded: false },
  ]);
  const late = [
    "export function late(dir: string): void {",
    "  Deno.removeSync(`${dir}/server-key-id`);",
    "  assertTestRunMayWrite(dir);",
    "}",
  ].join("\n");
  assertEquals(findIdentityWriters("y.ts", late), [
    { file: "y.ts", writer: "late", guarded: false },
  ]);
  const good = [
    "export async function ok(dir: string): Promise<void> {",
    "  assertTestRunMayWrite(`${dir}/server.id`);",
    '  await Deno.writeTextFile(`${dir}/server.id`, "x");',
    "}",
  ].join("\n");
  assertEquals(findIdentityWriters("z.ts", good), [
    { file: "z.ts", writer: "ok", guarded: true },
  ]);
});

test("the known raw writers of daemon identity files are exactly these", () => {
  // Everything else goes through writeDaemonFile / removeDaemonFile.
  assertEquals(inventory().map((f) => `${f.file}#${f.writer}`), [
    "src/instance/client.ts#writeKeyId",
  ]);
});
