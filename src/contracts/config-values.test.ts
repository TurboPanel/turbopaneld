import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigValueError,
  hasLineBreakOrControl,
  MAX_ENV_VALUE_LENGTH,
  MAX_URL_PATH_LENGTH,
  safeConfigLine,
  safeConfigToken,
  safeEnvName,
  safeEnvValue,
  safePhpIniValue,
  safeUrlPath,
} from "./config-values.ts";
import { HOSTILE_CONFIG_FRAGMENTS } from "../testing/config-fragments.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("hasLineBreakOrControl flags C0, DEL, C1 and Unicode separators only", () => {
  for (const ch of ["\n", "\r", "\0", "\t", "\u007f", "\u0085", " "]) {
    assertEquals(hasLineBreakOrControl(`a${ch}b`), true, JSON.stringify(ch));
  }
  assertEquals(hasLineBreakOrControl(" "), true);
  assertEquals(hasLineBreakOrControl("plain ascii {} $ ; é ✓"), false);
});

test("safeUrlPath accepts clean absolute prefixes unchanged", () => {
  for (const ok of ["/", "/api", "/api/", "/v1/docs", "/a.b_c~d-e/f"]) {
    assertEquals(safeUrlPath("f", ok), ok);
  }
});

test("safeUrlPath refuses every hostile fragment, traversal and shape error", () => {
  for (const fragment of HOSTILE_CONFIG_FRAGMENTS) {
    assertThrows(
      () => safeUrlPath("hostings[].proxy.stripPrefix", `/api${fragment}x`),
      ConfigValueError,
      "hostings[].proxy.stripPrefix must be",
    );
  }
  for (
    const bad of ["", "api", "//", "/a//b", "/..", "/a/../b", "/.", "/a/./b"]
  ) {
    assertThrows(() => safeUrlPath("f", bad), ConfigValueError);
  }
  assertThrows(
    () => safeUrlPath("f", `/${"a".repeat(MAX_URL_PATH_LENGTH)}`),
    ConfigValueError,
    "characters",
  );
  assertEquals(
    safeUrlPath("f", `/${"a".repeat(MAX_URL_PATH_LENGTH - 1)}`).length,
    MAX_URL_PATH_LENGTH,
  );
});

test("safeEnvName accepts identifiers and refuses everything else", () => {
  for (const ok of ["A", "_x", "APP_ENV", "a1_2"]) {
    assertEquals(safeEnvName("f", ok), ok);
  }
  for (const bad of ["", "1A", "A-B", "A B", "A\nB", "A=B", "Ä", "A "]) {
    assertThrows(() => safeEnvName("webEnv", bad), ConfigValueError, "webEnv");
  }
  assertThrows(() => safeEnvName("f", "A".repeat(129)), ConfigValueError);
});

test("safeEnvValue keeps one line and never echoes the value", () => {
  assertEquals(
    safeEnvValue("f", 'quotes " and \\ and {x} $y'),
    'quotes " and \\ and {x} $y',
  );
  for (const ch of ["\n", "\r", "\0", "\u0085", " ", " "]) {
    const err = assertThrows(
      () => safeEnvValue("sites.web.webEnv.TOKEN", `secret${ch}tail`),
      ConfigValueError,
      "sites.web.webEnv.TOKEN must not contain line breaks",
    );
    assertEquals(err.message.includes("secret"), false);
  }
  assertThrows(
    () => safeEnvValue("f", "x".repeat(MAX_ENV_VALUE_LENGTH + 1)),
    ConfigValueError,
    "at most",
  );
});

test("safePhpIniValue allows typed PHP settings and refuses ini/vhconf syntax", () => {
  for (
    const ok of [
      "256M",
      "30",
      "On",
      "E_ALL & ~E_DEPRECATED",
      "Etc/GMT+5",
      "exec,passthru",
    ]
  ) {
    assertEquals(safePhpIniValue("f", ok), ok);
  }
  for (
    const bad of [
      "}",
      "{",
      "${HOME}",
      '"x"',
      "a;b",
      "a=b",
      "<<<END",
      "a\nb",
      "a b",
    ]
  ) {
    assertThrows(
      () => safePhpIniValue("php.settings.x", bad),
      ConfigValueError,
    );
  }
  assertThrows(() => safePhpIniValue("f", "1".repeat(513)), ConfigValueError);
});

test("safeConfigLine and safeConfigToken", () => {
  assertEquals(
    safeConfigLine("f", "node server.mjs --a='b' $PORT"),
    "node server.mjs --a='b' $PORT",
  );
  assertThrows(
    () => safeConfigLine("startCommand", "a\nExecStartPre=x"),
    ConfigValueError,
    "startCommand",
  );
  for (
    const ok of [
      "web",
      "api-1",
      "svc_2.x",
      "00000000-0000-4000-8000-0000000000aa",
    ]
  ) {
    assertEquals(safeConfigToken("f", ok), ok);
  }
  for (
    const bad of ["", "-x", ".x", "a/b", "a b", "a\nb", "a}", "x".repeat(129)]
  ) {
    assertThrows(() => safeConfigToken("f", bad), ConfigValueError);
  }
});
