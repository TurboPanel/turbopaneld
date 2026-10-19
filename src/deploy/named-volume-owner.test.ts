import { assertEquals } from "@std/assert";
import {
  ensureNamedVolumeOwners,
  namedVolumeOwnerTargets,
} from "./named-volume-owner.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const resolved = {
  web: {
    volumes: [
      { type: "volume", source: "data", target: "/usr/share/nginx/html" },
      { type: "bind", source: "/srv/x", target: "/bind" },
    ],
  },
  api: { volumes: [{ type: "volume", source: "cache", target: "/cache" }] },
  root: { volumes: [{ type: "volume", source: "r", target: "/r" }] },
};

test("a service the daemon runs as the owner gets its named volume mount paths", () => {
  const targets = namedVolumeOwnerTargets({
    web: {
      user: "30001:30001",
      volumes: [{ type: "volume", source: "uploads", target: "/uploads" }],
    },
    root: { user: "0:0" },
  }, resolved);
  assertEquals(targets, [
    { composeServiceName: "web", user: "30001:30001", target: "/uploads" },
    {
      composeServiceName: "web",
      user: "30001:30001",
      target: "/usr/share/nginx/html",
    },
  ]);
});

test("a service with no daemon-set user, or a non-numeric one, is left alone", () => {
  assertEquals(namedVolumeOwnerTargets({ api: {} }, resolved), []);
  assertEquals(namedVolumeOwnerTargets({ api: { user: "app" } }, resolved), []);
  assertEquals(namedVolumeOwnerTargets(undefined, resolved), []);
});

test("each target is chowned once through the service's own image, and a failure does not stop the rest", async () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  await ensureNamedVolumeOwners([
    { composeServiceName: "web", user: "30001:30001", target: "/a" },
    { composeServiceName: "web", user: "30001:30001", target: "/b" },
  ], {
    projectName: "proj",
    composePaths: ["/c/compose.yaml"],
    log: (line) => lines.push(line),
    run: (args) => {
      calls.push(args);
      return Promise.resolve(
        calls.length === 1
          ? {
            success: false,
            code: 127,
            stdout: "",
            stderr: "chown: not found\n",
          }
          : { success: true, code: 0, stdout: "", stderr: "" },
      );
    },
  });
  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.slice(0, 5), [
    "compose",
    "-p",
    "proj",
    "-f",
    "/c/compose.yaml",
  ]);
  assertEquals(calls[0]!.slice(5, 12), [
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--user",
    "0",
    "--entrypoint",
  ]);
  assertEquals(calls[0]!.slice(-3), ["web", "30001:30001", "/a"]);
  assertEquals(lines.length, 1);
});
