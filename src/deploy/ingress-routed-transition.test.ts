import { assertEquals, assertStringIncludes } from "@std/assert";
import { legacyHttpContainersPresent, traefikCompose } from "./ingress.ts";
import type { DockerCliResult } from "./docker-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function ok(stdout: string): DockerCliResult {
  return { success: true, code: 0, stdout, stderr: "" } as DockerCliResult;
}

function fakeDocker(labelsByContainer: Record<string, Record<string, string>>) {
  return (args: string[]): Promise<DockerCliResult> => {
    if (args[0] === "ps") {
      return Promise.resolve(ok(Object.keys(labelsByContainer).join("\n")));
    }
    return Promise.resolve(
      ok(
        Object.values(labelsByContainer).map((l) => JSON.stringify(l)).join(
          "\n",
        ),
      ),
    );
  };
}

const HTTP = {
  "traefik.enable": "true",
  "traefik.http.routers.a.rule": "Host(`a`)",
};

test("a running HTTP container without the routed label holds the constraint off", async () => {
  assertEquals(
    await legacyHttpContainersPresent(fakeDocker({ c1: HTTP })),
    true,
  );
});

test("labelled HTTP containers and TCP-only containers do not", async () => {
  assertEquals(
    await legacyHttpContainersPresent(fakeDocker({
      c1: { ...HTTP, "com.turbopanel.system.routed": "true" },
      c2: {
        "traefik.enable": "true",
        "traefik.tcp.routers.x.rule": "HostSNI(`*`)",
      },
    })),
    false,
  );
  assertEquals(await legacyHttpContainersPresent(fakeDocker({})), false);
});

test("a Docker error keeps the constraint off", async () => {
  const failing = () =>
    Promise.resolve(
      { success: false, code: 1, stdout: "", stderr: "x" } as DockerCliResult,
    );
  assertEquals(await legacyHttpContainersPresent(failing), true);
});

test("the shared Traefik renders the constraint only when asked", () => {
  const on = traefikCompose("net", ["172.18.0.1"]);
  const off = traefikCompose(
    "net",
    ["172.18.0.1"],
    undefined,
    undefined,
    false,
  );
  assertStringIncludes(on, "providers.docker.constraints=");
  assertEquals(off.includes("providers.docker.constraints"), false);
});

test("the legacy check lists stopped containers too", async () => {
  let psArgs: string[] = [];
  const run = (args: string[]): Promise<DockerCliResult> => {
    if (args[0] === "ps") {
      psArgs = args;
      return Promise.resolve(ok("c1"));
    }
    return Promise.resolve(ok(JSON.stringify(HTTP)));
  };
  assertEquals(await legacyHttpContainersPresent(run), true);
  assertEquals(psArgs.includes("-a"), true);
});
