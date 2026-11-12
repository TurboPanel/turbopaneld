import { assertEquals } from "@std/assert";
import {
  parseSystemctlShow,
  readEnvFileValue,
  readInstanceDatabaseUrl,
  readUnits,
  splitEnvironment,
} from "./units.ts";
import {
  fakeRun,
  type RecordedCall,
  systemctlShowText,
} from "../testing/dev-host-fixture.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("one systemctl show reads every unit", async () => {
  const calls: RecordedCall[] = [];
  const run = fakeRun(calls, {
    answer: () => ({
      code: 0,
      stdout: systemctlShowText({
        turbopaneld: { active: true, startedAtSec: 1_700_000_000 },
        "turbopanel-ui": { active: false, startedAtSec: null },
      }),
      stderr: "",
    }),
  });
  const units = await readUnits(run, ["turbopaneld", "turbopanel-ui"]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].args, [
    "show",
    "--timestamp=unix",
    "--property=Id,ActiveState,ExecMainStartTimestamp",
    "turbopaneld.service",
    "turbopanel-ui.service",
  ]);
  assertEquals(units.get("turbopaneld"), {
    activeState: "active",
    active: true,
    startedAtMs: 1_700_000_000_000,
  });
  assertEquals(units.get("turbopanel-ui")?.startedAtMs, null);
});

test("a failed systemctl is an empty reading", async () => {
  const run = fakeRun([], {
    answer: () => ({ code: 1, stdout: "", stderr: "no" }),
  });
  assertEquals((await readUnits(run, ["x"])).size, 0);
  assertEquals(parseSystemctlShow("garbage").size, 0);
});

test("Environment= values split on unquoted spaces", () => {
  assertEquals(
    splitEnvironment(`A=1 "B=two words" C=x\\ y D=`),
    ["A=1", "B=two words", "C=x y", "D="],
  );
});

test("env file values: quotes, export and the last assignment win", () => {
  const text = [
    "# comment",
    "TURBOPANEL_DATABASE_URL=postgres://a@h/one",
    "export TURBOPANEL_DATABASE_URL='postgres://b@h/two'",
    "OTHER=1",
  ].join("\n");
  assertEquals(
    readEnvFileValue(text, "TURBOPANEL_DATABASE_URL"),
    "postgres://b@h/two",
  );
  assertEquals(readEnvFileValue(text, "MISSING"), null);
});

test("the database URL comes from Environment=, then the env files in order", async () => {
  const run = fakeRun([], {
    answer: () => ({
      code: 0,
      stdout: [
        "Environment=HOME=/x TURBOPANEL_DATABASE_URL=postgres://env@h/db",
        "EnvironmentFiles=/etc/a.env (ignore_errors=yes)",
        "EnvironmentFiles=/etc/b.env (ignore_errors=yes)",
      ].join("\n"),
      stderr: "",
    }),
  });
  const files: Record<string, string> = {
    "/etc/a.env": "TURBOPANEL_DATABASE_URL=postgres://a@h/db\n",
    "/etc/b.env": "NOTHING=1\n",
  };
  const url = await readInstanceDatabaseUrl(
    run,
    "turbopanel-instance",
    (path) => Promise.resolve(files[path] ?? null),
  );
  assertEquals(url, "postgres://a@h/db");
});

test("no database URL anywhere is null", async () => {
  const run = fakeRun([], {
    answer: () => ({ code: 0, stdout: "Environment=HOME=/x\n", stderr: "" }),
  });
  assertEquals(
    await readInstanceDatabaseUrl(run, "u", () => Promise.resolve(null)),
    null,
  );
});
