import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import {
  HOST_PROGRAM_VERBS,
  hostSudoArgs,
  TP_HOST_ONLY_VERBS,
  TP_HOST_VERBS,
} from "./host-sudo.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.isFile && entry.name.endsWith(".ts")) yield path;
  }
}

const MANAGED = { installMode: "production" as const, uid: 9999, env: {} };

test("a managed host routes every tp-host verb through /opt/turbopanel/lib/tp-host", () => {
  assertEquals(
    hostSudoArgs(["-n", "install", "-m", "0640", "a", "b"], MANAGED),
    [
      "-n",
      "--",
      "/opt/turbopanel/lib/tp-host",
      "install",
      "-m",
      "0640",
      "a",
      "b",
    ],
  );
  assertEquals(
    hostSudoArgs(["-n", "--", "systemctl", "daemon-reload"], MANAGED),
    ["-n", "--", "/opt/turbopanel/lib/tp-host", "systemctl", "daemon-reload"],
  );
  assertEquals(
    hostSudoArgs(["-n", "modprobe", "drivetemp"], MANAGED),
    ["-n", "--", "/opt/turbopanel/lib/tp-host", "modprobe", "drivetemp"],
  );
});

test("self re-exec, docker, helpers and engine checks are left alone", () => {
  for (
    const args of [
      ["-n", "-u", "tp", "--", "docker", "ps"],
      ["-n", "--", "docker", "ps"],
      [
        "-n",
        "--",
        "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
        "migrate",
      ],
      [
        "-n",
        "/usr/sbin/php-fpm8.4",
        "--fpm-config",
        "/etc/turbopanel/php/8.4/php-fpm.conf",
        "--test",
      ],
      ["sh", "-s", "--"],
    ]
  ) {
    assertEquals(hostSudoArgs(args, MANAGED), args);
  }
});

test("development and root processes keep the direct sudo argv", () => {
  const args = ["-n", "rm", "-rf", "--", "/srv/users/alice/x"];
  assertEquals(
    hostSudoArgs(args, { installMode: "development", uid: 1000 }),
    args,
  );
  assertEquals(
    hostSudoArgs(args, { installMode: "production", uid: 0 }),
    args,
  );
});

const DEV = {
  installMode: "development" as const,
  uid: 1000,
  env: {
    TURBOPANEL_ORCHESTRATION_DIR:
      "/home/dev/turbopanel/turbopaneld/orchestration",
  },
};
const DEV_TP_HOST =
  "/home/dev/turbopanel/turbopaneld/orchestration/scripts/tp-host";

test("development runs a tp-host-only verb through the checkout's tp-host", () => {
  assertEquals(hostSudoArgs(["-n", "tunnel-env-install", "instance"], DEV), [
    "-n",
    "--",
    DEV_TP_HOST,
    "tunnel-env-install",
    "instance",
  ]);
  assertEquals(hostSudoArgs(["-n", "--", "app-env-remove", "s1"], DEV), [
    "-n",
    "--",
    DEV_TP_HOST,
    "app-env-remove",
    "s1",
  ]);
  for (const verb of TP_HOST_ONLY_VERBS) {
    assertEquals(hostSudoArgs(["-n", verb], DEV), [
      "-n",
      "--",
      DEV_TP_HOST,
      verb,
    ]);
  }
});

test("development keeps the direct argv for a verb that is a host program", () => {
  for (const verb of HOST_PROGRAM_VERBS) {
    assertEquals(hostSudoArgs(["-n", verb, "x"], DEV), ["-n", verb, "x"]);
  }
});

test("a managed host routes tp-host-only verbs to the installed tp-host", () => {
  for (const verb of TP_HOST_ONLY_VERBS) {
    assertEquals(hostSudoArgs(["-n", verb], MANAGED), [
      "-n",
      "--",
      "/opt/turbopanel/lib/tp-host",
      verb,
    ]);
  }
  // Root on a managed install is left as it was.
  assertEquals(
    hostSudoArgs(["-n", "tunnel-env-install", "instance"], {
      installMode: "production",
      uid: 0,
    }),
    ["-n", "tunnel-env-install", "instance"],
  );
});

test("host program and tp-host-only verbs are disjoint and cover every verb", () => {
  const overlap = [...TP_HOST_ONLY_VERBS].filter((v) =>
    HOST_PROGRAM_VERBS.has(v)
  );
  assertEquals(overlap, []);
  assertEquals(
    TP_HOST_VERBS.size,
    HOST_PROGRAM_VERBS.size + TP_HOST_ONLY_VERBS.size,
  );
});

test("every `sudo -n <tp-host verb>` literal in src goes through hostSudoArgs", async () => {
  // On a managed host sudoers grants tp-host, not the raw utility: an
  // unwrapped call site would be refused in production and nowhere else.
  const root = join(dirname(fromFileUrl(import.meta.url)), "..");
  const verbs = [...TP_HOST_VERBS].map((v) => v.replaceAll("-", "\\-")).join(
    "|",
  );
  const raw = new RegExp(
    String
      .raw`"sudo"\s*,\s*(?:\{\s*args\s*:\s*)?\[\s*"-n"\s*,\s*(?:"--"\s*,\s*)?"(${verbs})"`,
    "g",
  );
  const offenders: string[] = [];
  for await (const path of sourceFiles(root)) {
    if (path.endsWith(".test.ts") || path.includes("/testing/")) continue;
    const source = await Deno.readTextFile(path);
    for (const match of source.matchAll(raw)) {
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${relative(root, path)}:${line} (${match[1]})`);
    }
  }
  assertEquals(offenders, []);
});

test("every tp-host verb the daemon names is routed through tp-host", async () => {
  // A verb tp-host accepts but this list misses runs as a bare `sudo -n
  // <verb>`, which sudoers refuses on a managed host (and only there).
  const root = join(dirname(fromFileUrl(import.meta.url)), "..");
  const script = await Deno.readTextFile(
    join(root, "..", "orchestration", "scripts", "tp-host"),
  );
  const dispatch = script.slice(script.lastIndexOf('case "$_verb" in'));
  const accepted = new Set(
    [...dispatch.matchAll(/^ {2}([a-z0-9|-]+)\)/gm)].flatMap((m) =>
      m[1].split("|")
    ),
  );
  // A renamed dispatch must not leave this test checking nothing.
  assertEquals(accepted.has("publish-keep") && accepted.has("systemctl"), true);
  const named = new Set<string>();
  for await (const path of sourceFiles(root)) {
    if (path.endsWith(".test.ts") || path.includes("/testing/")) continue;
    const source = await Deno.readTextFile(path);
    for (const verb of accepted) {
      if (source.includes(`"${verb}"`)) named.add(verb);
    }
  }
  const unrouted = [...named].filter((verb) => !TP_HOST_VERBS.has(verb));
  assertEquals(unrouted.sort(), []);
});

test("the publish verbs go through tp-host on a managed host", () => {
  for (const verb of ["publish-open", "publish", "publish-keep"]) {
    const args = ["-n", verb, "alice", "production", "web", "s1", "r1", "p1"];
    assertEquals(hostSudoArgs(args, MANAGED), [
      "-n",
      "--",
      "/opt/turbopanel/lib/tp-host",
      ...args.slice(1),
    ]);
  }
});
