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
