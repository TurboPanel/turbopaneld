import { assertEquals, assertThrows } from "@std/assert";
import {
  describeNativeAppStart,
  isNativeAppStart,
  nativeAppStartExec,
  normalizeNativeAppStartPath,
} from "./start-entry.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const NODE = "/opt/turbopanel/vendor/node-app/24/current/bin/node";

test("normalizeNativeAppStartPath keeps only paths that are one safe argument", () => {
  assertEquals(normalizeNativeAppStartPath("./dist/index.js"), "dist/index.js");
  assertEquals(normalizeNativeAppStartPath(" server.js "), "server.js");
  for (
    const bad of [
      "",
      "/etc/passwd",
      "../up.js",
      "dist/../../x.js",
      "-e",
      "--require=x",
      "a b.js",
      "%h.js",
      "$HOME.js",
      "dist/",
      "dist//x.js",
      "x".repeat(201),
    ]
  ) {
    assertEquals(normalizeNativeAppStartPath(bad), undefined, bad);
  }
});

test("isNativeAppStart accepts exactly the recorded shapes", () => {
  assertEquals(isNativeAppStart({ kind: "start-script" }), true);
  assertEquals(isNativeAppStart({ kind: "next-start" }), true);
  assertEquals(
    isNativeAppStart({ kind: "start-script", prestart: true }),
    true,
  );
  assertEquals(isNativeAppStart({ kind: "file", path: "server.js" }), true);
  for (
    const bad of [
      null,
      [],
      "next-start",
      { kind: "file" },
      { kind: "file", path: "./server.js" },
      { kind: "file", path: "../x.js" },
      { kind: "shell", command: "rm -rf /" },
      { kind: "start-script", prestart: "yes" },
    ]
  ) {
    assertEquals(isNativeAppStart(bad), false, JSON.stringify(bad));
  }
});

test("nativeAppStartExec execs the vendored Node with no shell", () => {
  assertEquals(
    nativeAppStartExec({ kind: "file", path: "server.js" }, NODE, 18591),
    `${NODE} server.js`,
  );
  assertEquals(
    nativeAppStartExec({ kind: "start-script" }, NODE, 18591),
    `${NODE} --run start`,
  );
  // next start reads no hostname from the environment: it is on argv.
  assertEquals(
    nativeAppStartExec({ kind: "next-start" }, NODE, 18591),
    `${NODE} node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 18591`,
  );
  // node --run runs no pre hooks: prestart goes first, then start replaces
  // the shell so systemd supervises the app.
  assertEquals(
    nativeAppStartExec({ kind: "start-script", prestart: true }, NODE, 1),
    `/bin/sh -c '${NODE} --run prestart && exec ${NODE} --run start'`,
  );
  assertThrows(
    () =>
      nativeAppStartExec(
        { kind: "start-script", prestart: true },
        "/opt/it's/node",
        1,
      ),
    TypeError,
  );
  assertThrows(
    () => nativeAppStartExec({ kind: "file", path: "-e" }, NODE, 1),
    TypeError,
  );
});

test("describeNativeAppStart says in plain words what will run", () => {
  assertEquals(
    describeNativeAppStart({ kind: "file", path: "index.js" }),
    "node index.js",
  );
  assertEquals(
    describeNativeAppStart({ kind: "next-start" }),
    "next start on 127.0.0.1",
  );
  assertEquals(
    describeNativeAppStart({ kind: "start-script" }),
    "the package.json start script (node --run start)",
  );
});

const DENO = "/opt/turbopanel/vendor/deno-app/2/current/bin/deno";

test("Deno starts: the recorded shapes, the argv, and the plain-words line", () => {
  assertEquals(isNativeAppStart({ kind: "deno-task" }), true);
  assertEquals(isNativeAppStart({ kind: "deno-file", path: "main.ts" }), true);
  for (
    const bad of [
      { kind: "deno-file" },
      { kind: "deno-file", path: "./main.ts" },
      { kind: "deno-file", path: "../main.ts" },
      { kind: "deno-file", path: "--eval" },
    ]
  ) {
    assertEquals(isNativeAppStart(bad), false, JSON.stringify(bad));
  }
  assertEquals(
    nativeAppStartExec({ kind: "deno-task" }, DENO, 18591),
    `${DENO} task start`,
  );
  assertEquals(
    nativeAppStartExec({ kind: "deno-file", path: "src/main.ts" }, DENO, 1),
    `${DENO} run --allow-all src/main.ts`,
  );
  assertThrows(
    () => nativeAppStartExec({ kind: "deno-file", path: "-e" }, DENO, 1),
    TypeError,
  );
  assertEquals(
    describeNativeAppStart({ kind: "deno-task" }),
    "the deno.json start task (deno task start)",
  );
  assertEquals(
    describeNativeAppStart({ kind: "deno-file", path: "main.ts" }),
    "deno run --allow-all main.ts",
  );
});
