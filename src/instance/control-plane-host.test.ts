import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  CONTROL_PLANE_BINARY_PATH,
  hasRootOwnedControlPlaneBinary,
  isControlPlaneHost,
  isDevelopmentControlPlaneHost,
} from "./control-plane-host.ts";

const test = Deno.test.bind(Deno);

type Stat = { isFile: boolean; uid: number | null };

function statOf(stat: Stat) {
  const seen: string[] = [];
  return {
    seen,
    lstat: (path: string) => {
      seen.push(path);
      return Promise.resolve(stat);
    },
  };
}

test("the control plane binary is the fixed install path, not an env choice", () => {
  assertEquals(CONTROL_PLANE_BINARY_PATH, "/opt/turbopanel/bin/turbopanel");
});

test("a root-owned regular control plane binary makes this the control plane host", async () => {
  const probe = statOf({ isFile: true, uid: 0 });
  assertEquals(
    await isControlPlaneHost({ lstat: probe.lstat, mode: "production" }),
    true,
  );
  assertEquals(probe.seen, [CONTROL_PLANE_BINARY_PATH]);
});

test("a binary owned by another account, a symlink or a folder does not count", async () => {
  for (
    const stat of [
      { isFile: true, uid: 998 },
      { isFile: true, uid: null },
      { isFile: false, uid: 0 },
    ]
  ) {
    assertEquals(
      await hasRootOwnedControlPlaneBinary({ lstat: statOf(stat).lstat }),
      false,
    );
  }
});

test("a missing binary is not the control plane host", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-cp-host-" });
  try {
    assertEquals(
      await isControlPlaneHost({
        binaryPath: join(dir, "turbopanel"),
        mode: "production",
        env: { TURBOPANEL_DEV_INSTANCE: "1" },
      }),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a file this test wrote under /tmp is not root-owned", async () => {
  if (Deno.uid() === 0) return;
  const dir = await Deno.makeTempDir({ prefix: "tp-cp-host-" });
  try {
    const binaryPath = join(dir, "turbopanel");
    await Deno.writeTextFile(binaryPath, "binary");
    assertEquals(await hasRootOwnedControlPlaneBinary({ binaryPath }), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a development install counts only with TURBOPANEL_DEV_INSTANCE=1", async () => {
  const noBinary = () => Promise.reject(new Deno.errors.NotFound("missing"));
  assertEquals(
    await isControlPlaneHost({
      lstat: noBinary,
      mode: "development",
      env: { TURBOPANEL_DEV_INSTANCE: " 1 " },
    }),
    true,
  );
  assertEquals(
    isDevelopmentControlPlaneHost({ mode: "development", env: {} }),
    false,
  );
  // The flag alone never makes a production install the control plane host.
  assertEquals(
    isDevelopmentControlPlaneHost({
      mode: "production",
      env: { TURBOPANEL_DEV_INSTANCE: "1" },
    }),
    false,
  );
});

test("the default probe reads the install mode and the process env", () => {
  assertEquals(typeof isDevelopmentControlPlaneHost(), "boolean");
});
