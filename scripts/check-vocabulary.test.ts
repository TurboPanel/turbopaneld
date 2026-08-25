import { assertEquals } from "@std/assert";
import {
  collectVocabularyFailures,
  isAllowlisted,
  isSkippedPath,
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
  assertEquals(isSkippedPath(".agents/skills/ui-ux-pro-max/SKILL.md"), true);
  assertEquals(isSkippedPath("src/migrations/0001.sql"), true);
  assertEquals(isSkippedPath("scripts/check-vocabulary.ts"), true);
  assertEquals(isSkippedPath("src/daemon-cli.ts"), false);
});

test("isAllowlisted covers HTTP, skills, and coding-agent wording", () => {
  assertEquals(isAllowlisted("User-Agent: curl"), true);
  assertEquals(isAllowlisted("see .agents/skills/foo"), true);
  assertEquals(isAllowlisted("### Agent policy"), true);
  assertEquals(isAllowlisted("the coding-agent workflow"), true);
  assertEquals(isAllowlisted("https-proxy-agent"), true);
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
    ].join("\n"),
  );
  assertEquals(failures.length, 3);
  assertEquals(failures[0]?.includes(`turbopanel${" agent"}`), true);
  assertEquals(
    collectVocabularyFailures("src/ok.ts", "the host daemon enrolls"),
    [],
  );
});
