import { assertEquals } from "@std/assert";
import type { RunFn } from "../ensure-principal.ts";
import {
  ensureReleaseTree,
  RELEASE_DIR_MODE,
  RELEASE_STAGING_MODE,
  resolveReleasePaths,
} from "./release-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Call = { command: string; args: string[] };

function captureRun(): { run: RunFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunFn = (command, args) => {
    calls.push({ command, args: [...args] });
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  return { run, calls };
}

/** `sudo -n install -d -m <mode> -o <user> -g <group> <path>` → the parts. */
function installCall(
  calls: readonly Call[],
  path: string,
): { mode: string; owner: string; group: string } | null {
  for (const call of calls) {
    if (call.command !== "sudo") continue;
    if (!call.args.includes("install") || !call.args.includes("-d")) continue;
    if (call.args[call.args.length - 1] !== path) continue;
    return {
      mode: call.args[call.args.indexOf("-m") + 1] ?? "",
      owner: call.args[call.args.indexOf("-o") + 1] ?? "",
      group: call.args[call.args.indexOf("-g") + 1] ?? "",
    };
  }
  return null;
}

function stubPaths(root: string) {
  return resolveReleasePaths(
    { principalHomeRoot: root, daemonStateDir: `${root}/state` },
    { username: "appuser", serviceId: "svc-1", releaseId: "rel-1" },
  );
}

test("ensureReleaseTree makes the immutable tree root-owned", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-tree-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await ensureReleaseTree(paths, "appuser", run);

    for (const dir of [paths.sitesDir, paths.siteDir, paths.releasesDir]) {
      assertEquals(installCall(calls, dir), {
        mode: RELEASE_DIR_MODE,
        owner: "root",
        group: "appuser-grp",
      });
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureReleaseTree leaves the staging release writable, not principal-owned", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-staging-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await ensureReleaseTree(paths, "appuser", run);

    assertEquals(installCall(calls, paths.releaseDir), {
      mode: RELEASE_STAGING_MODE,
      owner: "root",
      group: "appuser-grp",
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("ensureReleaseTree hands shared/ to the principal", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-release-shared-" });
  const paths = stubPaths(root);
  const { run, calls } = captureRun();
  try {
    await ensureReleaseTree(paths, "appuser", run);

    // `shared/` is the one writable path: created (or repaired) as the
    // principal, never as root.
    const chown = calls.find((call) =>
      call.command === "sudo" && call.args.includes("chown") &&
      call.args[call.args.length - 1] === paths.sharedDir
    );
    const install = installCall(calls, paths.sharedDir);
    assertEquals(
      chown?.args.includes("appuser:appuser-grp") ??
        install?.owner === "appuser",
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
