import { assertEquals } from "@std/assert";
import {
  hostDockerFromVersions,
  parseComposeVersion,
  parseDockerCliVersion,
  readDocker,
} from "./docker.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseDockerCliVersion maps docker --version banners", () => {
  assertEquals(
    parseDockerCliVersion("Docker version 28.3.3, build 980b856\n"),
    "28.3.3",
  );
  assertEquals(
    parseDockerCliVersion("Docker version 28.3.3-ce, build abc"),
    "28.3.3-ce",
  );
  assertEquals(parseDockerCliVersion("28.3.3"), "28.3.3");
  assertEquals(parseDockerCliVersion(""), undefined);
  assertEquals(parseDockerCliVersion("not a version"), undefined);
});

test("parseComposeVersion maps --short and long banners", () => {
  assertEquals(parseComposeVersion("2.39.1\n"), "2.39.1");
  assertEquals(parseComposeVersion("v2.39.1"), "2.39.1");
  assertEquals(
    parseComposeVersion("Docker Compose version v2.39.1"),
    "2.39.1",
  );
  assertEquals(
    parseComposeVersion("Docker Compose version v2.39.1-desktop.1"),
    "2.39.1-desktop.1",
  );
  assertEquals(parseComposeVersion(""), undefined);
  assertEquals(parseComposeVersion("compose is not installed"), undefined);
});

test("hostDockerFromVersions omits the area when nothing is installed", () => {
  assertEquals(hostDockerFromVersions(undefined, undefined), undefined);
  assertEquals(hostDockerFromVersions("28.3.3", undefined), {
    version: "28.3.3",
  });
  assertEquals(hostDockerFromVersions("28.3.3", "2.39.1"), {
    version: "28.3.3",
    composeVersion: "2.39.1",
  });
  assertEquals(hostDockerFromVersions(undefined, "2.39.1"), {
    composeVersion: "2.39.1",
  });
});

test("readDocker returns undefined when the docker binary is missing", () => {
  assertEquals(readDocker("/no/such/docker"), undefined);
});

test("parseDockerCliVersion rejects oversized or invalid tokens", () => {
  assertEquals(parseDockerCliVersion(`v${"a".repeat(80)}`), undefined);
  assertEquals(parseDockerCliVersion("Docker version bad version!"), undefined);
});

test({
  name: "readDocker probes a stub docker binary for CLI and compose versions",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-stub-" });
    const bin = `${dir}/docker`;
    try {
      Deno.writeTextFileSync(
        bin,
        String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 28.3.3, build abc"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ] && [ "$3" = "--short" ]; then
  echo "2.39.1"
  exit 0
fi
exit 1
`,
      );
      Deno.chmodSync(bin, 0o750);
      assertEquals(readDocker(bin), {
        version: "28.3.3",
        composeVersion: "2.39.1",
      });
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

test({
  name: "readDocker falls back to long compose banner when --short is empty",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-compose-" });
    const bin = `${dir}/docker`;
    try {
      Deno.writeTextFileSync(
        bin,
        String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 27.0.0, build xyz"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ] && [ "$3" = "--short" ]; then
  exit 1
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  echo "Docker Compose version v2.30.0"
  exit 0
fi
exit 1
`,
      );
      Deno.chmodSync(bin, 0o750);
      assertEquals(readDocker(bin), {
        version: "27.0.0",
        composeVersion: "2.30.0",
      });
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
