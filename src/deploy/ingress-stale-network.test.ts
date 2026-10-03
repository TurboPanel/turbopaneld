import { assertEquals, assertRejects } from "@std/assert";
import {
  removeStaleNetworkContainers,
  staleNetworkContainerIds,
} from "./ingress-stale-network.ts";
import type { DockerCliResult } from "./docker-cli.ts";

const test = Deno.test.bind(Deno);

const ok = (stdout = ""): DockerCliResult => ({
  success: true,
  code: 0,
  stdout,
  stderr: "",
});

test("staleNetworkContainerIds picks only containers on an old network id", () => {
  const lines = "aaa net1=OLD \nbbb net1=NEW other=X\nccc other=OLD\n\n";
  assertEquals(staleNetworkContainerIds(lines, "net1", "NEW"), ["aaa"]);
});

function fakeDocker(inspectOut: string, calls: string[][]) {
  return (args: string[]): Promise<DockerCliResult> => {
    calls.push(args);
    if (args[0] === "network") return Promise.resolve(ok("NEW\n"));
    if (args[0] === "ps") return Promise.resolve(ok("aaa\nbbb\n"));
    if (args[0] === "inspect") return Promise.resolve(ok(inspectOut));
    return Promise.resolve(ok());
  };
}

test("removeStaleNetworkContainers removes containers pinned to a dead network", async () => {
  const calls: string[][] = [];
  await removeStaleNetworkContainers(
    "proj",
    "net1",
    fakeDocker("aaa net1=OLD \nbbb net1=NEW \n", calls),
  );
  assertEquals(calls.at(-1), ["rm", "-f", "aaa"]);
});

test("removeStaleNetworkContainers leaves healthy containers alone", async () => {
  const calls: string[][] = [];
  await removeStaleNetworkContainers(
    "proj",
    "net1",
    fakeDocker("aaa net1=NEW \n", calls),
  );
  assertEquals(calls.some((a) => a[0] === "rm"), false);
});

test("removeStaleNetworkContainers surfaces a failed removal", async () => {
  const run = (args: string[]): Promise<DockerCliResult> => {
    if (args[0] === "rm") {
      return Promise.resolve({ ...ok(), success: false, stderr: "busy" });
    }
    return fakeDocker("aaa net1=OLD \n", [])(args);
  };
  await assertRejects(
    () => removeStaleNetworkContainers("proj", "net1", run),
    Error,
    "busy",
  );
});
