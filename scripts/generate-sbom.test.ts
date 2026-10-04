import { assertEquals, assertThrows } from "@std/assert";
import { sbomFromLock } from "./generate-sbom.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = { name: "turbopaneld", version: "9.9.9" };

const LOCK = JSON.stringify({
  version: "5",
  jsr: { "@std/assert@1.0.19": { integrity: "ab".repeat(32) } },
  npm: {
    "postgres@3.4.5": { integrity: "sha512-AQID" },
    "@scope/pkg@2.0.0_peer@1.0.0": {},
  },
});

test("sbomFromLock lists every locked package once, sorted, with hashes", () => {
  const sbom = sbomFromLock(LOCK, ROOT);
  assertEquals(sbom.metadata.component.version, "9.9.9");
  assertEquals(sbom.components.map((c) => c["bom-ref"]), [
    "jsr:@std/assert@1.0.19",
    "npm:@scope/pkg@2.0.0",
    "npm:postgres@3.4.5",
  ]);
  assertEquals(sbom.components[0].hashes, [
    { alg: "SHA-256", content: "ab".repeat(32) },
  ]);
  assertEquals(sbom.components[1].purl, "pkg:npm/%40scope/pkg@2.0.0");
  assertEquals(sbom.components[2].hashes, [
    { alg: "SHA-512", content: "010203" },
  ]);
});

test("sbomFromLock is deterministic for one lockfile", () => {
  assertEquals(
    JSON.stringify(sbomFromLock(LOCK, ROOT)),
    JSON.stringify(sbomFromLock(LOCK, ROOT)),
  );
});

test("sbomFromLock refuses a lockfile format it does not know", () => {
  assertThrows(
    () => sbomFromLock(JSON.stringify({ version: "9" }), ROOT),
    Error,
    "unsupported deno.lock version",
  );
});

test("the real deno.lock yields an SBOM that covers every locked package", async () => {
  const lockText = await Deno.readTextFile(
    new URL("../deno.lock", import.meta.url),
  );
  const lock = JSON.parse(lockText) as {
    jsr?: Record<string, unknown>;
    npm?: Record<string, unknown>;
  };
  const sbom = sbomFromLock(lockText, ROOT);
  assertEquals(
    sbom.components.length,
    Object.keys(lock.jsr ?? {}).length + Object.keys(lock.npm ?? {}).length,
  );
});
