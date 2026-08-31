import { assertEquals } from "@std/assert";
import {
  hostDockerFromVersions,
  parseComposeVersion,
  parseDockerCliVersion,
  parseDockerDataRoot,
  readDocker,
  resolveDockerDataRoot,
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
  assertEquals(parseDockerCliVersion("v"), undefined);
  assertEquals(parseDockerCliVersion("V"), undefined);
});

test("parse helpers strip an uppercase V prefix", () => {
  assertEquals(parseDockerCliVersion("V28.3.3"), "28.3.3");
  assertEquals(parseComposeVersion("V2.39.1"), "2.39.1");
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

function writeStubDocker(dir: string, script: string): string {
  const bin = `${dir}/docker`;
  Deno.writeTextFileSync(bin, script);
  Deno.chmodSync(bin, 0o750);
  return bin;
}

test({
  name: "readDocker returns undefined when both version probes fail",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-both-fail-" });
    try {
      const bin = writeStubDocker(
        dir,
        String.raw`#!/bin/sh
exit 1
`,
      );
      assertEquals(readDocker(bin), undefined);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

test({
  name: "readDocker reports CLI version when compose probes fail",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-cli-only-" });
    try {
      const bin = writeStubDocker(
        dir,
        String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 28.1.0, build abc"
  exit 0
fi
exit 1
`,
      );
      assertEquals(readDocker(bin), { version: "28.1.0" });
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

test({
  name: "readDocker reports compose version when --version fails",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-compose-only-" });
    try {
      const bin = writeStubDocker(
        dir,
        String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  exit 1
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ] && [ "$3" = "--short" ]; then
  echo "2.40.0"
  exit 0
fi
exit 1
`,
      );
      assertEquals(readDocker(bin), { composeVersion: "2.40.0" });
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

test({
  name: "readDocker uses long compose banner when --short is unparseable",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-compose-long-" });
    try {
      const bin = writeStubDocker(
        dir,
        String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "28.3.3"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ] && [ "$3" = "--short" ]; then
  echo "compose is not installed"
  exit 0
fi
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  echo "Docker Compose version v2.39.1"
  exit 0
fi
exit 1
`,
      );
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
  name: "readDocker returns undefined when the stub exists but cannot run",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-noexec-" });
    const bin = `${dir}/docker`;
    try {
      Deno.writeTextFileSync(bin, "not-executable");
      // mode 0640: exists for pathExists, Deno.Command throws on execute.
      Deno.chmodSync(bin, 0o640);
      assertEquals(readDocker(bin), undefined);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

test({
  name: "readDocker uses test -e when Deno.statSync is blocked",
  permissions: { read: true, write: true, run: true },
  fn() {
    const dir = Deno.makeTempDirSync({ prefix: "tp-docker-stat-" });
    const originalStat = Deno.statSync;
    try {
      const bin = writeStubDocker(
        dir,
        String.raw`#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "Docker version 26.1.0, build abc"
  exit 0
fi
exit 1
`,
      );
      Deno.statSync = () => {
        throw new Error("stat blocked");
      };
      assertEquals(readDocker(bin), { version: "26.1.0" });
      assertEquals(readDocker("/no/such/turbopanel-docker"), undefined);
    } finally {
      Deno.statSync = originalStat;
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

test({
  name: "readDocker treats test command failures as a missing binary",
  permissions: { read: true, write: true, run: true },
  fn() {
    const OriginalCommand = Deno.Command;
    const originalStat = Deno.statSync;
    Deno.statSync = () => {
      throw new Error("stat blocked");
    };
    Deno.Command = function (
      cmd: string,
      options?: Deno.CommandOptions,
    ): Deno.Command {
      if (cmd === "test") {
        throw new Error("test unavailable");
      }
      return new OriginalCommand(cmd, options);
    } as unknown as typeof Deno.Command;
    try {
      assertEquals(readDocker("/usr/bin/docker"), undefined);
    } finally {
      Deno.Command = OriginalCommand;
      Deno.statSync = originalStat;
    }
  },
});

test("parseDockerDataRoot accepts absolute paths and rejects garbage", () => {
  assertEquals(parseDockerDataRoot("/var/lib/docker\n"), "/var/lib/docker");
  assertEquals(parseDockerDataRoot("/mnt/docker-data"), "/mnt/docker-data");
  assertEquals(parseDockerDataRoot("relative/path"), undefined);
  assertEquals(parseDockerDataRoot(""), undefined);
  assertEquals(parseDockerDataRoot("/var/lib/docker extra"), undefined);
});

test("parseDockerDataRoot maps the docker-info fixtures", () => {
  const fixture = (name: string) =>
    Deno.readTextFileSync(
      new URL(
        `../metrics/collector/testdata/${name}`,
        import.meta.url,
      ),
    );
  assertEquals(
    parseDockerDataRoot(fixture("docker-info-root.txt")),
    "/var/lib/docker",
  );
  assertEquals(
    parseDockerDataRoot(fixture("docker-info-dedicated-mount.txt")),
    "/mnt/docker-data",
  );
});

test("resolveDockerDataRoot reads DockerRootDir from the Engine API", async () => {
  assertEquals(
    await resolveDockerDataRoot({
      info: () => Promise.resolve({ DockerRootDir: "/var/lib/docker" }),
    }),
    "/var/lib/docker",
  );
  assertEquals(
    await resolveDockerDataRoot({
      info: () => Promise.resolve({ DockerRootDir: "/mnt/docker-data" }),
    }),
    "/mnt/docker-data",
  );
});

test("resolveDockerDataRoot returns undefined when the daemon is unreachable", async () => {
  assertEquals(
    await resolveDockerDataRoot({
      info: () => Promise.reject(new Error("socket down")),
    }),
    undefined,
  );
});

test("resolveDockerDataRoot sanitizes malformed DockerRootDir values", async () => {
  assertEquals(
    await resolveDockerDataRoot({
      info: () => Promise.resolve({ DockerRootDir: "relative/path" }),
    }),
    undefined,
  );
  assertEquals(
    await resolveDockerDataRoot({
      info: () => Promise.resolve({}),
    }),
    undefined,
  );
  assertEquals(
    await resolveDockerDataRoot({
      info: () =>
        Promise.resolve(
          { DockerRootDir: 42 } as unknown as { DockerRootDir?: string },
        ),
    }),
    undefined,
  );
});
