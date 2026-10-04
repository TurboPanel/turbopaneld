import { assertEquals, assertThrows } from "@std/assert";
import { RollbackRefusedError } from "./errors.ts";
import {
  ALLOW_DOWNGRADE_ENV,
  assertNotRollback,
  isRollback,
} from "./freshness.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const INSTALLED = {
  commit: "aaa",
  version: "0.1.3",
  builtAt: "2026-09-30T12:00:00Z",
};

test("isRollback: a lower base version is a rollback", () => {
  assertEquals(
    isRollback(INSTALLED, {
      commit: "bbb",
      version: "0.1.2",
      builtAt: "2026-10-05T00:00:00Z",
    }),
    true,
  );
});

test("isRollback: a higher base version is not, whatever its build time", () => {
  assertEquals(
    isRollback(INSTALLED, {
      commit: "bbb",
      version: "0.1.4-rc.1",
      builtAt: "2026-01-01T00:00:00Z",
    }),
    false,
  );
});

test("isRollback: same base compares builtAt, ignoring the pre-release label", () => {
  const older = { commit: "bbb", builtAt: "2026-09-29T00:00:00Z" };
  const newer = { commit: "ccc", builtAt: "2026-10-01T00:00:00Z" };
  assertEquals(
    isRollback(INSTALLED, { ...older, version: "0.1.3-canary.7" }),
    true,
  );
  assertEquals(
    isRollback(INSTALLED, { ...newer, version: "0.1.3-canary.8" }),
    false,
  );
  assertEquals(isRollback(INSTALLED, { ...newer, version: "0.1.3" }), false);
});

test("isRollback: the trunk drop (no version) compares builtAt only", () => {
  assertEquals(
    isRollback(INSTALLED, { commit: "bbb", builtAt: "2026-09-01T00:00:00Z" }),
    true,
  );
  assertEquals(
    isRollback(INSTALLED, { commit: "bbb", builtAt: "2026-10-02T00:00:00Z" }),
    false,
  );
});

test("isRollback: the same commit is never a rollback", () => {
  assertEquals(
    isRollback(INSTALLED, {
      commit: "aaa",
      version: "0.1.2",
      builtAt: "2020-01-01T00:00:00Z",
    }),
    false,
  );
});

test("isRollback: missing or unparsable evidence is not a rollback", () => {
  const target = { commit: "bbb", builtAt: "2020-01-01T00:00:00Z" };
  assertEquals(
    isRollback({ commit: "dev", builtAt: "unstamped" }, target),
    false,
  );
  assertEquals(isRollback({ commit: "dev" }, target), false);
  assertEquals(
    isRollback(INSTALLED, { commit: "bbb", builtAt: "not a date" }),
    false,
  );
});

test("assertNotRollback refuses with RollbackRefusedError, and breaks glass only via host env", () => {
  const old = {
    commit: "bbb",
    version: "0.1.2",
    builtAt: "2026-09-01T00:00:00Z",
  };
  assertThrows(
    () => assertNotRollback(INSTALLED, old, {}),
    RollbackRefusedError,
    "refusing to roll back",
  );
  assertThrows(
    () => assertNotRollback(INSTALLED, old, { [ALLOW_DOWNGRADE_ENV]: "0" }),
    RollbackRefusedError,
  );
  assertNotRollback(INSTALLED, old, { [ALLOW_DOWNGRADE_ENV]: "1" });
});
