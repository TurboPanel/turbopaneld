import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  collectVocabularyFailures,
  isAllowlisted,
  isSkippedPath,
  reportVocabularyFailures,
  runVocabularyCheck,
} from "./check-vocabulary.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isSkippedPath skips Galaxy, skills, migrations, and this checker", () => {
  assertEquals(isSkippedPath("roles/geerlingguy.docker/tasks/main.yml"), true);
  assertEquals(isSkippedPath("vendor/roles/geerlingguy/docker/tasks"), true);
  assertEquals(isSkippedPath(".agents/skills/ui-ux-pro-max/SKILL.md"), true);
  assertEquals(isSkippedPath("docs/.agents/skills/pack.md"), true);
  assertEquals(isSkippedPath("src/migrations/0001.sql"), true);
  assertEquals(isSkippedPath("db/migrations/foo.sql"), true);
  assertEquals(isSkippedPath("scripts/check-vocabulary.ts"), true);
  assertEquals(isSkippedPath("src/daemon-cli.ts"), false);
});

test("isAllowlisted covers HTTP, skills, and coding-agent wording", () => {
  assertEquals(isAllowlisted("User-Agent: curl"), true);
  assertEquals(isAllowlisted("see .agents/skills/foo"), true);
  assertEquals(isAllowlisted("### Agent policy"), true);
  assertEquals(isAllowlisted("## Agent notes"), true);
  assertEquals(isAllowlisted("the coding-agent workflow"), true);
  assertEquals(isAllowlisted("a coding agent writes tests"), true);
  assertEquals(isAllowlisted("https-proxy-agent"), true);
  assertEquals(isAllowlisted("@scalar/agent-chat"), true);
  assertEquals(isAllowlisted("agent-base"), true);
  assertEquals(isAllowlisted("agent-cli-detector"), true);
  assertEquals(isAllowlisted(`the TurboPanel${" agent"}`), false);
});

test("collectVocabularyFailures flags forbidden phrases and skips allowlisted lines", () => {
  const failures = collectVocabularyFailures(
    "README.md",
    [
      `Install the TurboPanel${" agent"} on each host.`,
      "User-Agent: turbopanel",
      `node${" agent"} leftover`,
      `agent${" identity"} on enroll`,
      `agent${" host"} leftover`,
      `agent${" commit"} leftover`,
      "server.daemon.projection.agent",
    ].join("\n"),
  );
  assertEquals(failures.length, 6);
  assertEquals(failures[0]?.includes(`turbopanel${" agent"}`), true);
  assertEquals(
    collectVocabularyFailures("src/ok.ts", "the host daemon enrolls"),
    [],
  );
});

test("reportVocabularyFailures exits on problems and logs success", () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const exits: number[] = [];
  reportVocabularyFailures(["bad phrase"], {
    error: (message) => {
      errors.push(message);
    },
    log: (message) => {
      logs.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(exits, [1]);
  assertEquals(errors[0], "Vocabulary check failed:\n");
  assertEquals(errors.some((line) => line.includes("problem(s) found")), true);

  reportVocabularyFailures([], {
    error: (message) => {
      errors.push(message);
    },
    log: (message) => {
      logs.push(message);
    },
    exit: (code) => {
      exits.push(code);
    },
  });
  assertEquals(logs.at(-1)?.includes("passed"), true);
});

test("reportVocabularyFailures defaults to console and Deno.exit", () => {
  const errors: string[] = [];
  const logs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  const originalExit = Deno.exit;
  console.error = ((message: unknown) => {
    errors.push(String(message));
  }) as typeof console.error;
  console.log = ((message: unknown) => {
    logs.push(String(message));
  }) as typeof console.log;
  Deno.exit = ((code: number) => {
    throw new TypeError(`exit ${code}`);
  }) as typeof Deno.exit;
  try {
    assertThrows(() => reportVocabularyFailures(["x"]), TypeError, "exit 1");
    reportVocabularyFailures([]);
    assertEquals(logs.at(-1)?.includes("passed"), true);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    Deno.exit = originalExit;
  }
});

test("runVocabularyCheck walks fixtures and skips lockfiles and skip dirs", async () => {
  const root = await Deno.makeTempDir({ prefix: "vocab-walk-" });
  try {
    await Deno.mkdir(join(root, "src/coverage"), { recursive: true });
    await Deno.mkdir(join(root, "workers"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "src/bad.ts"),
      `export const note = "TurboPanel${" agent"}";\n`,
    );
    await Deno.writeTextFile(join(root, "src/ok.ts"), "export const ok = 1;\n");
    await Deno.writeTextFile(join(root, "src/notes.txt"), `node${" agent"}\n`);
    await Deno.writeTextFile(join(root, "deno.lock"), `node${" agent"}\n`);
    await Deno.writeTextFile(
      join(root, "package-lock.json"),
      `node${" agent"}\n`,
    );
    await Deno.writeTextFile(join(root, "pnpm-lock.yaml"), `node${" agent"}\n`);
    await Deno.writeTextFile(join(root, "yarn.lock"), `node${" agent"}\n`);
    await Deno.writeTextFile(
      join(root, "src/coverage/hidden.ts"),
      `node${" agent"}\n`,
    );
    await Deno.writeTextFile(
      join(root, "workers/public.ts"),
      `node${" agent"}\n`,
    );

    const failures = await runVocabularyCheck(root);
    assertEquals(
      failures.some((line) => line.includes("src/bad.ts")),
      true,
    );
    assertEquals(
      failures.some((line) => line.includes("src/coverage/hidden.ts")),
      false,
    );
    assertEquals(failures.some((line) => line.includes("deno.lock")), false);
    assertEquals(
      failures.some((line) => line.includes("package-lock.json")),
      false,
    );
    assertEquals(
      failures.some((line) => line.includes("pnpm-lock.yaml")),
      false,
    );
    assertEquals(failures.some((line) => line.includes("yarn.lock")), false);
    assertEquals(failures.some((line) => line.includes("workers/")), false);
    assertEquals(failures.some((line) => line.includes("notes.txt")), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
