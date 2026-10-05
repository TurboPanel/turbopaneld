import { assertEquals } from "@std/assert";
import { parseTimerNextRun, timerNextRunArgs } from "./timer-next-run.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TIMER = "turbopanel-backup-0192f1de-7c3b-7e4a-9f10-00000000000a.timer";

test("timerNextRunArgs lists exactly one timer as JSON", () => {
  assertEquals(timerNextRunArgs(TIMER), [
    "list-timers",
    "--all",
    "--output=json",
    "--no-pager",
    TIMER,
  ]);
});

test("parseTimerNextRun reads the next fire in microseconds (systemd 257 output)", () => {
  const json = JSON.stringify([
    {
      next: 1_791_275_135_043_059,
      left: 1_791_275_135_043_059,
      last: 1_791_188_704_415_332,
      passed: 715_744_324_975,
      unit: TIMER,
      activates: TIMER.replace(".timer", ".service"),
    },
  ]);
  assertEquals(parseTimerNextRun(json, TIMER), "2026-10-06T08:25:35.043Z");
});

test("parseTimerNextRun is undefined when nothing is scheduled or the text is not that JSON", () => {
  assertEquals(parseTimerNextRun("[]", TIMER), undefined);
  assertEquals(parseTimerNextRun("", TIMER), undefined);
  assertEquals(
    parseTimerNextRun("Tue 2026-10-06 03:25:35 CDT", TIMER),
    undefined,
  );
  assertEquals(parseTimerNextRun('{"next":1}', TIMER), undefined);
  assertEquals(
    parseTimerNextRun(JSON.stringify([{ unit: TIMER, next: 0 }]), TIMER),
    undefined,
  );
  assertEquals(
    parseTimerNextRun(JSON.stringify([{ unit: TIMER, next: null }]), TIMER),
    undefined,
  );
  assertEquals(
    parseTimerNextRun(
      JSON.stringify([{ unit: "other.timer", next: 1e15 }]),
      TIMER,
    ),
    undefined,
  );
});
