import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  CDN_RUN_SCRIPT,
  isCdnRunScript,
  resolveRunScriptUrl,
  runScriptUrlForChannel,
  STAGING_RUN_SCRIPT,
  TESTING_RUN_SCRIPT,
} from "./run-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));

/**
 * The channel → installer host mapping lives in three places that must agree:
 * this module, `tp_installer_host_for_channel` in run.sh and the same function
 * in tp-orchestrate (and the control plane's copy in the other repo).
 */
const CASES: ReadonlyArray<[channel: string, host: string]> = [
  ["release", "turbopanel.sh"],
  ["rc", "staging.turbopanel.sh"],
  ["canary", "testing.turbopanel.sh"],
  ["trunk", "testing.turbopanel.sh"],
  ["edge", "testing.turbopanel.sh"],
  ["", "turbopanel.sh"],
  ["something-else", "turbopanel.sh"],
];

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) throw new TypeError(`missing ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new TypeError(`unclosed ${name}`);
}

async function shellHost(file: string, channel: string): Promise<string> {
  const source = await Deno.readTextFile(join(here, file));
  const fn = extractShellFunction(source, "tp_installer_host_for_channel");
  const out = await new Deno.Command("sh", {
    args: [
      "-eu",
      "-c",
      `${fn}\ntp_installer_host_for_channel "$1"`,
      "sh",
      channel,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout);
}

test("runScriptUrlForChannel maps each channel to its environment's installer", () => {
  for (const [channel, host] of CASES) {
    assertEquals(runScriptUrlForChannel(channel), `https://${host}`);
  }
  assertEquals(runScriptUrlForChannel(undefined), CDN_RUN_SCRIPT);
  assertEquals(runScriptUrlForChannel("rc"), STAGING_RUN_SCRIPT);
  assertEquals(runScriptUrlForChannel("canary"), TESTING_RUN_SCRIPT);
});

test("isCdnRunScript recognises all three public installer hosts and nothing else", () => {
  for (const url of [CDN_RUN_SCRIPT, STAGING_RUN_SCRIPT, TESTING_RUN_SCRIPT]) {
    assertEquals(isCdnRunScript(url), true);
  }
  assertEquals(isCdnRunScript("https://huey.lan:8443/run.sh"), false);
  assertEquals(isCdnRunScript("https://evil.turbopanel.sh"), false);
});

test("resolveRunScriptUrl follows the channel for a public control plane, but the overlay origin wins", () => {
  const config = {
    kind: "url" as const,
    baseUrl: "https://huey.lan:8443",
    wsBaseUrl: "wss://huey.lan:8443",
  };
  assertEquals(
    resolveRunScriptUrl(config, { channel: "canary" }),
    TESTING_RUN_SCRIPT,
  );
  assertEquals(
    resolveRunScriptUrl(config, { channel: "rc" }),
    STAGING_RUN_SCRIPT,
  );
  assertEquals(
    resolveRunScriptUrl(config, {
      channel: "canary",
      dlBase: "https://huey.lan:8443/downloads",
    }),
    "https://huey.lan:8443/run.sh",
  );
});

test("run.sh and tp-orchestrate map channels to installer hosts exactly like the TypeScript", async () => {
  for (
    const file of [
      "../../scripts/run.sh",
      "../../orchestration/scripts/tp-orchestrate",
    ]
  ) {
    for (const [channel, host] of CASES) {
      assertEquals(
        await shellHost(file, channel),
        host,
        `${file} (${channel})`,
      );
    }
  }
});
