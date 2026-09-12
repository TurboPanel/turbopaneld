import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  dockerNetworkingDescriptorsEqual,
  dockerNetworkingStatePath,
  isEmptyDockerNetworkingDescriptor,
  isValidDockerNetworkingDescriptor,
  readDockerNetworkingState,
  writeDockerNetworkingState,
} from "./docker-networking-state.ts";
import { syncHostDockerNetworking } from "./docker-networking-sync.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withConfigDir(
  fn: (layout: { configDir: string }) => Promise<void>,
): Promise<void> {
  const configDir = await Deno.makeTempDir({ prefix: "tp-docker-net-" });
  try {
    await fn({ configDir });
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
}

const POOLS = {
  addressPools: [{ base: "10.200.0.0/16", size: 24 }],
  defaultBridgeCidr: "172.26.0.1/16",
};

test("docker networking state round-trips under <configDir>/docker/networking.json with 0640/0750", async () => {
  await withConfigDir(async (layout) => {
    assertEquals(await readDockerNetworkingState(layout), null);
    await writeDockerNetworkingState(layout, POOLS);
    assertEquals(
      dockerNetworkingStatePath(layout),
      join(layout.configDir, "docker", "networking.json"),
    );
    assertEquals(await readDockerNetworkingState(layout), POOLS);
    const file = await Deno.stat(dockerNetworkingStatePath(layout));
    const dir = await Deno.stat(join(layout.configDir, "docker"));
    assertEquals((file.mode ?? 0) & 0o777, 0o640);
    assertEquals((dir.mode ?? 0) & 0o777, 0o750);
  });
});

test("docker networking state treats a corrupt file as absent", async () => {
  await withConfigDir(async (layout) => {
    await Deno.mkdir(join(layout.configDir, "docker"), { recursive: true });
    await Deno.writeTextFile(dockerNetworkingStatePath(layout), "{not json");
    assertEquals(await readDockerNetworkingState(layout), null);
    await Deno.writeTextFile(
      dockerNetworkingStatePath(layout),
      JSON.stringify({ addressPools: "nope", defaultBridgeCidr: null }),
    );
    assertEquals(await readDockerNetworkingState(layout), null);
  });
});

test("descriptor validation, equality and emptiness", () => {
  assertEquals(isValidDockerNetworkingDescriptor(POOLS), true);
  assertEquals(
    isValidDockerNetworkingDescriptor({
      addressPools: [],
      defaultBridgeCidr: null,
    }),
    true,
  );
  assertEquals(
    isValidDockerNetworkingDescriptor({
      addressPools: [{ base: "bad", size: 24 }],
      defaultBridgeCidr: null,
    }),
    false,
  );
  assertEquals(
    isValidDockerNetworkingDescriptor({
      addressPools: [],
      defaultBridgeCidr: "x",
    }),
    false,
  );
  assertEquals(dockerNetworkingDescriptorsEqual(null, null), true);
  assertEquals(dockerNetworkingDescriptorsEqual(null, POOLS), false);
  assertEquals(
    dockerNetworkingDescriptorsEqual(POOLS, {
      defaultBridgeCidr: "172.26.0.1/16",
      addressPools: [{ size: 24, base: "10.200.0.0/16" }],
    }),
    true,
  );
  assertEquals(isEmptyDockerNetworkingDescriptor(null), true);
  assertEquals(
    isEmptyDockerNetworkingDescriptor({
      addressPools: [],
      defaultBridgeCidr: null,
    }),
    true,
  );
  assertEquals(isEmptyDockerNetworkingDescriptor(POOLS), false);
});

test("syncHostDockerNetworking applies only on change and persists after a successful apply", async () => {
  await withConfigDir(async (layout) => {
    const applied: unknown[] = [];
    const deps = {
      layout,
      fetch: () => Promise.resolve(POOLS),
      apply: (descriptor: unknown, options: unknown) => {
        applied.push([descriptor, options]);
        return Promise.resolve();
      },
      dockerBinaryPresent: () => Promise.resolve(true),
    };
    assertEquals(await syncHostDockerNetworking(deps), "applied");
    assertEquals(applied, [[POOLS, { clearAddressing: false }]]);
    assertEquals(await readDockerNetworkingState(layout), POOLS);
    // Same content again → nothing runs.
    assertEquals(await syncHostDockerNetworking(deps), "unchanged");
    assertEquals(applied.length, 1);
  });
});

test("syncHostDockerNetworking only persists when Docker is absent or nothing is configured", async () => {
  await withConfigDir(async (layout) => {
    let applied = 0;
    const empty = { addressPools: [], defaultBridgeCidr: null };
    // Unconfigured org, nothing ever applied: record, don't run the role.
    assertEquals(
      await syncHostDockerNetworking({
        layout,
        fetch: () => Promise.resolve(empty),
        apply: () => {
          applied += 1;
          return Promise.resolve();
        },
        dockerBinaryPresent: () => Promise.resolve(true),
      }),
      "persisted",
    );
    assertEquals(applied, 0);
    assertEquals(await readDockerNetworkingState(layout), empty);
    // Docker not installed: persist so the on-demand install applies it.
    assertEquals(
      await syncHostDockerNetworking({
        layout,
        fetch: () => Promise.resolve(POOLS),
        apply: () => {
          applied += 1;
          return Promise.resolve();
        },
        dockerBinaryPresent: () => Promise.resolve(false),
      }),
      "persisted",
    );
    assertEquals(applied, 0);
    assertEquals(await readDockerNetworkingState(layout), POOLS);
  });
});

test("syncHostDockerNetworking clears a previously applied descriptor instead of skipping the empty one", async () => {
  await withConfigDir(async (layout) => {
    const empty = { addressPools: [], defaultBridgeCidr: null };
    const applied: unknown[] = [];
    const apply = (descriptor: unknown, options: unknown) => {
      applied.push([descriptor, options]);
      return Promise.resolve();
    };
    const dockerBinaryPresent = () => Promise.resolve(true);
    // Pools were applied on an earlier session.
    await writeDockerNetworkingState(layout, POOLS);
    // The org config is now empty: the role must run with the clear flag so
    // the old default-address-pools/bip are removed from daemon.json.
    assertEquals(
      await syncHostDockerNetworking({
        layout,
        fetch: () => Promise.resolve(empty),
        apply,
        dockerBinaryPresent,
      }),
      "applied",
    );
    assertEquals(applied, [[empty, { clearAddressing: true }]]);
    assertEquals(await readDockerNetworkingState(layout), empty);
    // Persisted empty → fetched empty is a plain no-op, not a re-clear.
    assertEquals(
      await syncHostDockerNetworking({
        layout,
        fetch: () => Promise.resolve(empty),
        apply,
        dockerBinaryPresent,
      }),
      "unchanged",
    );
    assertEquals(applied.length, 1);
  });
});

test("syncHostDockerNetworking keeps the old descriptor when clearing fails", async () => {
  await withConfigDir(async (layout) => {
    const empty = { addressPools: [], defaultBridgeCidr: null };
    await writeDockerNetworkingState(layout, POOLS);
    let threw = false;
    try {
      await syncHostDockerNetworking({
        layout,
        fetch: () => Promise.resolve(empty),
        apply: () => Promise.reject(new Error("playbook failed")),
        dockerBinaryPresent: () => Promise.resolve(true),
      });
    } catch (err) {
      threw = (err as Error).message === "playbook failed";
    }
    assertEquals(threw, true);
    // Still recorded as applied, so the next session retries the clear
    // rather than reporting "unchanged" while daemon.json keeps the pools.
    assertEquals(await readDockerNetworkingState(layout), POOLS);
  });
});

test("syncHostDockerNetworking leaves the persisted copy untouched when apply fails", async () => {
  await withConfigDir(async (layout) => {
    let threw = false;
    try {
      await syncHostDockerNetworking({
        layout,
        fetch: () => Promise.resolve(POOLS),
        apply: () => Promise.reject(new Error("playbook failed")),
        dockerBinaryPresent: () => Promise.resolve(true),
      });
    } catch (err) {
      threw = (err as Error).message === "playbook failed";
    }
    assertEquals(threw, true);
    assertEquals(await readDockerNetworkingState(layout), null);
  });
});
