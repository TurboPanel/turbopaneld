import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  checksumsOf,
  isNewer,
  latestRelease,
  parseVersion,
  RELEASE_API,
  renderReport,
} from "./check-connector-release.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const RELEASE = {
  tag: "2026.6.0",
  url: "https://example.test/release",
  assets: [
    { name: "cloudflared-linux-amd64", digest: `sha256:${HEX_A}` },
    { name: "cloudflared-linux-arm64", digest: `sha256:${HEX_B}` },
    { name: "cloudflared-windows-amd64.exe", digest: `sha256:${HEX_A}` },
  ],
};

test("release numbers compare by year, month and patch", () => {
  assertEquals(parseVersion("2026.5.2"), [2026, 5, 2]);
  assertEquals(parseVersion("v2026.5.2"), null);
  assertEquals(parseVersion("latest"), null);
  assertEquals(isNewer("2026.5.3", "2026.5.2"), true);
  assertEquals(isNewer("2026.10.0", "2026.9.9"), true);
  assertEquals(isNewer("2027.1.0", "2026.12.9"), true);
  assertEquals(isNewer("2026.5.2", "2026.5.2"), false);
  assertEquals(isNewer("2026.5.1", "2026.5.2"), false);
  assertEquals(isNewer("nope", "2026.5.2"), false);
});

test("the checksums are the two Linux files, and a missing or odd digest is null", () => {
  assertEquals(checksumsOf(RELEASE), {
    "cloudflared-linux-amd64": HEX_A,
    "cloudflared-linux-arm64": HEX_B,
  });
  assertEquals(
    checksumsOf({
      ...RELEASE,
      assets: [{ name: "cloudflared-linux-amd64", digest: "md5:abc" }],
    }),
    { "cloudflared-linux-amd64": null, "cloudflared-linux-arm64": null },
  );
});

test("the report names the new version, the checksums, and what a daemon release must change", () => {
  const body = renderReport("2026.5.2", RELEASE, {
    "cloudflared-linux-amd64": "c".repeat(64),
  });
  assertStringIncludes(body, "**2026.6.0**");
  assertStringIncludes(body, `\`${HEX_A}\``);
  assertStringIncludes(body, `pinned today: \`${"c".repeat(64)}\``);
  assertStringIncludes(body, "src/orchestration/assets.ts");
  assertStringIncludes(body, "permission list");
  assertStringIncludes(body, "no pin was edited");
});

test("the latest release is read from the public API and reduced to what the report needs", async () => {
  let asked = "";
  const fake = ((url: string) => {
    asked = url;
    return Promise.resolve(
      Response.json({
        tag_name: "2026.6.0",
        html_url: "https://example.test/release",
        assets: [
          { name: "cloudflared-linux-amd64", digest: `sha256:${HEX_A}` },
          { name: 5 },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  const release = await latestRelease(fake);
  assertEquals(asked, RELEASE_API);
  assertEquals(release.tag, "2026.6.0");
  assertEquals(release.assets, [{
    name: "cloudflared-linux-amd64",
    digest: `sha256:${HEX_A}`,
  }]);
});

test("a failed lookup or an odd tag is an error, never a report", async () => {
  const status = ((_: string) =>
    Promise.resolve(
      new Response("no", { status: 503 }),
    )) as unknown as typeof fetch;
  let failed = false;
  await latestRelease(status).catch(() => (failed = true));
  assertEquals(failed, true);
  const odd = ((_: string) =>
    Promise.resolve(
      Response.json({ tag_name: "weekly" }),
    )) as unknown as typeof fetch;
  failed = false;
  await latestRelease(odd).catch(() => (failed = true));
  assertEquals(failed, true);
});
