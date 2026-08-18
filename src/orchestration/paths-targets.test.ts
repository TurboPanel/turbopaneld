import { assertEquals } from "@std/assert";
import {
  CLOUDFLARED_VERSION,
  cloudflaredBin,
  cloudflaredDownloadUrl,
  cloudflaredDir,
  galaxyDockerRoleCodeloadUrl,
  GALAXY_DOCKER_ROLE_GITHUB_REPO,
  resolveCloudflaredAsset,
  resolveUvTarget,
  UV_VERSION,
  uvDownloadUrl,
} from "./paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveUvTarget maps linux aarch64 and x86_64 to release assets", () => {
  assertEquals(resolveUvTarget("linux", "aarch64"), {
    triple: "aarch64-unknown-linux-gnu",
    asset: "uv-aarch64-unknown-linux-gnu.tar.gz",
  });
  assertEquals(resolveUvTarget("linux", "x86_64"), {
    triple: "x86_64-unknown-linux-gnu",
    asset: "uv-x86_64-unknown-linux-gnu.tar.gz",
  });
});

test("resolveUvTarget rejects unsupported platforms", () => {
  try {
    resolveUvTarget("darwin", "aarch64");
    throw new Error("expected resolveUvTarget to throw for darwin");
  } catch (err) {
    assertEquals(
      err instanceof Error ? err.message : String(err),
      'Unsupported OS for orchestration runtime: "darwin". Only "linux" is supported.',
    );
  }

  const unsupportedArch = "arm" as unknown as typeof Deno.build.arch;
  try {
    resolveUvTarget("linux", unsupportedArch);
    throw new Error("expected resolveUvTarget to throw for arm");
  } catch (err) {
    assertEquals(
      err instanceof Error ? err.message : String(err),
      'Unsupported CPU architecture for orchestration runtime: "arm". ' +
        'Only "aarch64" and "x86_64" are supported.',
    );
  }
});

test("uvDownloadUrl points at the pinned uv release asset", () => {
  const asset = "uv-x86_64-unknown-linux-gnu.tar.gz";
  assertEquals(
    uvDownloadUrl(asset),
    `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`,
  );
});

test("resolveCloudflaredAsset maps supported linux architectures", () => {
  assertEquals(resolveCloudflaredAsset("aarch64"), "cloudflared-linux-arm64");
  assertEquals(resolveCloudflaredAsset("x86_64"), "cloudflared-linux-amd64");
});

test("resolveCloudflaredAsset rejects unsupported architectures", () => {
  const unsupportedArch = "arm" as unknown as typeof Deno.build.arch;
  try {
    resolveCloudflaredAsset(unsupportedArch);
    throw new Error("expected resolveCloudflaredAsset to throw for arm");
  } catch (err) {
    assertEquals(
      err instanceof Error ? err.message : String(err),
      'Unsupported CPU architecture for cloudflared: "arm". ' +
        'Only "aarch64" and "x86_64" are supported.',
    );
  }
});

test("cloudflared paths and download URL use the pinned version", () => {
  const asset = resolveCloudflaredAsset();
  assertEquals(cloudflaredDir(), cloudflaredDir(CLOUDFLARED_VERSION));
  assertEquals(cloudflaredBin(), cloudflaredBin(CLOUDFLARED_VERSION));
  assertEquals(
    cloudflaredDownloadUrl(asset),
    `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`,
  );
});

test("galaxyDockerRoleCodeloadUrl uses the codeload archive path", () => {
  const version = "7.0.0";
  assertEquals(
    galaxyDockerRoleCodeloadUrl(version),
    `https://codeload.github.com/${GALAXY_DOCKER_ROLE_GITHUB_REPO}/tar.gz/refs/tags/${version}`,
  );
});
