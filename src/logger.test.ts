import { assertEquals } from "@std/assert";
import { setActiveInstallPresenter } from "./orchestration/install-presenter-context.ts";
import { InstallPresenter } from "./orchestration/install-presenter.ts";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  sanitizeForLog,
  stripLogInjection,
} from "./logger.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("stripLogInjection replaces control whitespace", () => {
  assertEquals(stripLogInjection("a\nb\rc\td"), "a_b_c_d");
});

test("sanitizeForLog covers primitives, errors, and objects", () => {
  assertEquals(sanitizeForLog(new Error("boom\nline")), "boom_line");
  assertEquals(sanitizeForLog("plain\ttext"), "plain_text");
  assertEquals(sanitizeForLog(42), "42");
  assertEquals(sanitizeForLog(true), "true");
  assertEquals(sanitizeForLog(10n), "10");
  assertEquals(sanitizeForLog(null), "null");
  assertEquals(sanitizeForLog(undefined), "undefined");
  assertEquals(sanitizeForLog({ a: 1 }), String.raw`{"a":1}`);

  const circular: { self?: unknown } = {};
  circular.self = circular;
  assertEquals(sanitizeForLog(circular), "[unserializable]");
  assertEquals(sanitizeForLog(Symbol("x")), "[unserializable]");
  assertEquals(sanitizeForLog(() => "fn"), "[unserializable]");
});

test("log helpers write structured lines without throwing", () => {
  logInfo("logger-test", "info", { ok: true });
  logDebug("logger-test", "debug");
  logWarn("logger-test", "warn\nline");
  logError("logger-test", new Error("err"));
  logInfo("logger-test", "multi\nline\n");
});

test("log routes orchestration components through the active installer presenter", () => {
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);
  try {
    presenter.beginStep("Test step");
    logDebug("ansible", "debug is swallowed by the presenter");
    logInfo("uv", "installing runtime packages");
    logWarn(
      "orchestration",
      "creating venv at /opt/turbopanel/vendor/ansible/venv",
    );
    logInfo("ansible", "");
    logInfo("python", "installing runtime interpreter");
    logInfo("logger-test", "\n");
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
});
