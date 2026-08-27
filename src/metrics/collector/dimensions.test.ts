import { assertEquals } from "@std/assert";
import { METRICS_SCHEMA_VERSION } from "../contract.ts";
import { resolveDimensions } from "./dimensions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveDimensions uses injected os-release prettyName and kernel release", async () => {
  const dims = await resolveDimensions({
    readOsRelease: () => ({
      family: "linux",
      prettyName: "Debian GNU/Linux 13 (trixie)",
    }),
    readProcFile: () => "6.1.0-fixture\n",
    getBuildInfo: () => ({ commit: "abc1234" }),
    build: { os: "linux", arch: "aarch64" },
  });
  assertEquals(dims, {
    schemaVersion: METRICS_SCHEMA_VERSION,
    daemonVersion: "abc1234",
    operatingSystem: "Debian GNU/Linux 13 (trixie)",
    architecture: "aarch64",
    kernelRelease: "6.1.0-fixture",
  });
});

test("resolveDimensions falls back to Deno.build when deps are omitted", async () => {
  const dims = await resolveDimensions({
    readOsRelease: () => undefined,
    readProcFile: () => undefined,
    getBuildInfo: () => ({ commit: "defaultbuild" }),
  });
  assertEquals(dims.operatingSystem, Deno.build.os);
  assertEquals(dims.architecture, Deno.build.arch);
  assertEquals(dims.daemonVersion, "defaultbuild");
  assertEquals(dims.kernelRelease, "");
});

test("resolveDimensions falls back to Deno.build.os when prettyName is absent", async () => {
  const dims = await resolveDimensions({
    readOsRelease: () => ({ family: "linux" }),
    readProcFile: () => undefined,
    getBuildInfo: () => ({ commit: "deadbeef" }),
    build: { os: "linux", arch: "x86_64" },
  });
  assertEquals(dims.operatingSystem, "linux");
  assertEquals(dims.kernelRelease, "");
  assertEquals(dims.daemonVersion, "deadbeef");
  assertEquals(dims.architecture, "x86_64");
});
