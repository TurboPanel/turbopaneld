import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { EnvironmentDeployCache } from "../../contracts/commands-contracts.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  applyEnvironmentCaches,
  type CacheIo,
  readCacheIndex,
  removeEnvironmentCaches,
} from "./apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV = "env-0123";
const ID_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ID_B = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const ID_C = "2c3d4e5f-6a7b-4c8d-9eaf-1a2b3c4d5e6f";
const SHA = "ab".repeat(32);

function cache(
  id: string,
  extra: Partial<EnvironmentDeployCache> = {},
): EnvironmentDeployCache {
  return {
    id,
    name: `cache-${id.slice(0, 4)}`,
    username: "alice",
    engine: "valkey",
    version: "8.1",
    access: "socket",
    maxMemoryMb: 64,
    passwordSha256: SHA,
    ...extra,
  };
}

type Fake = {
  io: CacheIo;
  calls: string[];
  runtimes: string[];
  root: string;
  files: Map<string, string>;
  active: Set<string>;
  failOn: Set<string>;
  missingUsers: Set<string>;
  cleanup: () => Promise<void>;
};

/** The verb of a `sudo -n [--] [tp-host] <verb> …` call, whichever way the host routes it. */
function verbAndArgs(args: string[]): string[] {
  const rest = args.filter((a) => a !== "-n" && a !== "--");
  return rest[0]?.endsWith("/tp-host") ? rest.slice(1) : rest;
}

async function makeFake(
  opts: { binary?: boolean } = {},
): Promise<Fake> {
  const root = await Deno.makeTempDir({ prefix: "cache-apply-" });
  const layout = {
    runtimesDir: join(root, "vendor"),
    configDir: join(root, "etc"),
    stateDir: join(root, "state"),
    principalHomeRoot: join(root, "srv"),
  };
  const unitDir = join(root, "units");
  await Deno.mkdir(unitDir, { recursive: true });
  const calls: string[] = [];
  const runtimes: string[] = [];
  const files = new Map<string, string>();
  const active = new Set<string>();
  const failOn = new Set<string>();
  const missingUsers = new Set<string>();
  const ok = { success: true, stdout: "", stderr: "" };
  const no = (stderr = "refused") => ({ success: false, stdout: "", stderr });
  const run: RunFn = async (command, args) => {
    if (command === "id") {
      return missingUsers.has(args[1]) ? no() : ok;
    }
    const [verb, ...rest] = verbAndArgs(args);
    calls.push([verb, ...rest.map((a) => a.replace(root, "<root>"))].join(" "));
    if (failOn.has(verb) || failOn.has(`${verb} ${rest[1] ?? ""}`)) {
      return no(`${verb} refused`);
    }
    if (verb === "install") {
      const [staged, installed] = rest.slice(-2);
      files.set(installed, await Deno.readTextFile(staged));
    } else if (verb === "cmp") {
      const [staged, installed] = rest.slice(-2);
      const have = files.get(installed);
      return have !== undefined && have === await Deno.readTextFile(staged)
        ? ok
        : no();
    } else if (verb === "rm") {
      files.delete(rest.at(-1) ?? "");
    } else if (verb === "systemctl") {
      const unit = rest.at(-1) ?? "";
      if (rest[0] === "is-active") return active.has(unit) ? ok : no();
      if (rest[0] === "enable") active.add(unit);
      if (rest[0] === "disable") active.delete(unit);
    }
    return ok;
  };
  const io: CacheIo = {
    run,
    layout,
    unitDir,
    ensureRuntime: (patch) => {
      runtimes.push(patch);
      return Promise.resolve();
    },
    binaryExists: () => Promise.resolve(opts.binary ?? false),
    sleep: () => Promise.resolve(),
    activeTimeoutMs: 3000,
  };
  return {
    io,
    calls,
    runtimes,
    root,
    files,
    active,
    failOn,
    missingUsers,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

async function withFake(
  fn: (fake: Fake) => Promise<void>,
  opts: { binary?: boolean } = {},
) {
  const fake = await makeFake(opts);
  try {
    await fn(fake);
  } finally {
    await fake.cleanup();
  }
}

const verbs = (calls: string[]) => calls.map((c) => c.split(" ")[0]);

test("a first apply vendors the runtime, makes each cache, reloads once and starts it", async () => {
  await withFake(async (fake) => {
    const out = await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A)],
      { pruneUnlisted: true },
    );
    assertEquals(out.results, [{
      id: ID_A,
      state: "ready",
      runtimeVersion: "8.1.11",
    }]);
    assertEquals(fake.runtimes, ["8.1.11"]);
    assertEquals(out.warnings, []);
    const order = verbs(fake.calls);
    assertEquals(
      order.filter((v) =>
        !["cmp", "install", "systemctl", "php-loopback-sync"].includes(v)
      ),
      ["cache-prepare", "cache-config-install"],
    );
    const reload = fake.calls.indexOf("systemctl daemon-reload");
    const enable = fake.calls.findIndex((c) =>
      c.startsWith("systemctl enable --now")
    );
    assert(reload > 0 && reload < enable);
    assertEquals(
      fake.calls.filter((c) => c === "systemctl daemon-reload").length,
      1,
    );
    assertEquals(
      fake.calls.some((c) => c.startsWith("systemctl restart")),
      false,
    );
    // The walls are rebuilt from the unit now on disk, port or not.
    assert(fake.calls.includes("php-loopback-sync"));
    const index = await readCacheIndex(fake.io.layout, ENV);
    assertEquals(index.length, 1);
    assertEquals(index[0].port, null);
    assertEquals(typeof index[0].configSha256, "string");
  });
});

test("the runtime is vendored only when its binary is missing", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    assertEquals(fake.runtimes, []);
  }, { binary: true });
});

test("an apply with nothing changed restarts nothing, and a changed limit restarts only that cache", async () => {
  await withFake(async (fake) => {
    const both = [cache(ID_A), cache(ID_B)];
    await applyEnvironmentCaches(fake.io, ENV, both, { pruneUnlisted: true });
    fake.calls.length = 0;
    await applyEnvironmentCaches(fake.io, ENV, both, { pruneUnlisted: true });
    assertEquals(
      fake.calls.some((c) => c.startsWith("systemctl restart")),
      false,
    );
    assertEquals(
      fake.calls.filter((c) => c.startsWith("cache-prepare")).length,
      2,
    );
    fake.calls.length = 0;
    await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A, { maxMemoryMb: 128 }), cache(ID_B)],
      { pruneUnlisted: true },
    );
    const restarts = fake.calls.filter((c) =>
      c.startsWith("systemctl restart")
    );
    assertEquals(restarts.length, 1);
    assertStringIncludes(restarts[0], ID_A);
  });
});

test("a changed password restarts the cache even though the unit text is the same", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    fake.calls.length = 0;
    await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A, { passwordSha256: "cd".repeat(32) })],
      { pruneUnlisted: true },
    );
    assertEquals(
      fake.calls.filter((c) => c.startsWith("systemctl restart")).length,
      1,
    );
  });
});

test("a cache that fails fails alone, and its neighbour still starts", async () => {
  await withFake(async (fake) => {
    fake.failOn.add(`cache-config-install ${ID_A}`);
    // The fake matches `<verb> <second arg>`; the second argument is the id.
    const out = await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A), cache(ID_B)],
      { pruneUnlisted: true },
    );
    assertEquals(out.results.map((r) => [r.id, r.state]), [
      [ID_A, "failed"],
      [ID_B, "ready"],
    ]);
    assertStringIncludes(out.results[0].error ?? "", "installing the config");
    // The failed cache is not remembered as running.
    assertEquals((await readCacheIndex(fake.io.layout, ENV)).map((e) => e.id), [
      ID_B,
    ]);
  });
});

test("a cache that does not come up is reported failed with a plain sentence", async () => {
  await withFake(async (fake) => {
    // `enable --now` succeeds but the unit never reports active.
    const run = fake.io.run;
    fake.io.run = (command, args) => {
      const [verb, sub] = verbAndArgs(args);
      if (verb === "systemctl" && sub === "enable") {
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      }
      return run(command, args);
    };
    const out = await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    assertEquals(out.results[0].state, "failed");
    assertStringIncludes(out.results[0].error ?? "", "did not report running");
  });
});

test("a cache whose account is not on the host is pending and nothing is run for it", async () => {
  await withFake(async (fake) => {
    fake.missingUsers.add("bob");
    const out = await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A, { username: "bob" }), cache(ID_B)],
      { pruneUnlisted: false },
    );
    assertEquals(out.results.map((r) => [r.id, r.state]), [
      [ID_A, "pending"],
      [ID_B, "ready"],
    ]);
    assertStringIncludes(out.results[0].error ?? "", "next deploy");
    assertEquals(fake.calls.some((c) => c.includes("bob")), false);
  });
});

test("when the runtime cannot be vendored every runnable cache fails and a pending one stays pending", async () => {
  await withFake(async (fake) => {
    fake.missingUsers.add("bob");
    fake.io.ensureRuntime = () => Promise.reject(new Error("download failed"));
    const out = await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A), cache(ID_B, { username: "bob" })],
      { pruneUnlisted: true },
    );
    assertEquals(out.results.map((r) => r.state), ["failed", "pending"]);
    assertStringIncludes(out.results[0].error ?? "", "download failed");
    assertEquals(fake.calls.length, 0);
  });
});

test("a port cache is guarded before it starts", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A, { access: "port", port: 18100 })],
      { pruneUnlisted: true },
    );
    const sync = fake.calls.indexOf("php-loopback-sync");
    const enable = fake.calls.findIndex((c) =>
      c.startsWith("systemctl enable --now")
    );
    assert(sync > 0 && sync < enable);
    const unit = [...fake.files.entries()].find(([path]) =>
      path.endsWith(`turbopanel-cache-${ID_A}.service`)
    )?.[1] ?? "";
    assertStringIncludes(unit, "Environment=PORT=18100");
  });
});

test("an account's slice is written only when a ceiling is sent, never emptied", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    assertEquals(
      [...fake.files.keys()].some((p) => p.endsWith(".slice")),
      false,
    );
    await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A, { accountLimits: { memoryBytes: 1073741824 } })],
      { pruneUnlisted: true },
    );
    const slice = [...fake.files.entries()].find(([p]) => p.endsWith(".slice"));
    assertStringIncludes(slice?.[1] ?? "", "MemoryMax=1073741824");
    // A later apply without a ceiling leaves the slice as it is.
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    assertStringIncludes(
      [...fake.files.entries()].find(([p]) => p.endsWith(".slice"))?.[1] ?? "",
      "MemoryMax=1073741824",
    );
  });
});

test("a cache that left the list loses its unit and config but keeps its data", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A), cache(ID_B)], {
      pruneUnlisted: true,
    });
    fake.calls.length = 0;
    const out = await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    assert(fake.calls.includes(`cache-remove alice ${ID_B}`));
    assertEquals(fake.calls.some((c) => c.includes("--data")), false);
    assertEquals(out.warnings.length, 1);
    assertStringIncludes(out.warnings[0], "data stayed");
    assertEquals((await readCacheIndex(fake.io.layout, ENV)).map((e) => e.id), [
      ID_A,
    ]);
    // An empty list clears the environment's caches the same way.
    await applyEnvironmentCaches(fake.io, ENV, [], { pruneUnlisted: true });
    assertEquals(await readCacheIndex(fake.io.layout, ENV), []);
  });
});

test("an apply that only adds never removes what is not listed", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    fake.calls.length = 0;
    const out = await applyEnvironmentCaches(fake.io, ENV, [cache(ID_B)], {
      pruneUnlisted: false,
    });
    assertEquals(out.warnings, []);
    assertEquals(fake.calls.some((c) => c.startsWith("cache-remove")), false);
    assertEquals(
      (await readCacheIndex(fake.io.layout, ENV)).map((e) => e.id).sort(),
      [ID_A, ID_B].sort(),
    );
  });
});

test("a named removal deletes the data only when told", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A), cache(ID_B), cache(ID_C)],
      { pruneUnlisted: false },
    );
    fake.calls.length = 0;
    const out = await applyEnvironmentCaches(fake.io, ENV, [cache(ID_C)], {
      pruneUnlisted: false,
      removed: [
        { id: ID_A, username: "alice", deleteData: true },
        { id: ID_B, username: "alice", deleteData: false },
      ],
    });
    assertEquals(out.warnings, []);
    assert(fake.calls.includes(`cache-remove alice ${ID_A} --data`));
    assert(fake.calls.includes(`cache-remove alice ${ID_B}`));
    assertEquals(
      fake.calls.filter((c) => c === "systemctl daemon-reload").length,
      1,
    );
    assertEquals((await readCacheIndex(fake.io.layout, ENV)).map((e) => e.id), [
      ID_C,
    ]);
  });
});

test("a removal that fails is a warning and the cache stays in the index for the next try", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    fake.failOn.add("cache-remove");
    const out = await applyEnvironmentCaches(fake.io, ENV, [], {
      pruneUnlisted: true,
    });
    assert(out.warnings.some((w) => w.includes("could not be removed")));
    assertEquals((await readCacheIndex(fake.io.layout, ENV)).map((e) => e.id), [
      ID_A,
    ]);
  });
});

test("a destroy removes every cache the host index lists and then the index", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A), cache(ID_B)], {
      pruneUnlisted: true,
    });
    fake.calls.length = 0;
    const warnings = await removeEnvironmentCaches(fake.io, ENV, false);
    assertEquals(warnings, []);
    assertEquals(
      fake.calls.filter((c) => c.startsWith("cache-remove")).sort(),
      [
        `cache-remove alice ${ID_A}`,
        `cache-remove alice ${ID_B}`,
      ],
    );
    assertEquals(await readCacheIndex(fake.io.layout, ENV), []);
    fake.calls.length = 0;
    // Nothing left: nothing is run.
    assertEquals(await removeEnvironmentCaches(fake.io, ENV, true), []);
    assertEquals(fake.calls, []);
  });
});

test("a destroy deletes the data only when it asked for it", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    fake.calls.length = 0;
    await removeEnvironmentCaches(fake.io, ENV, true);
    assert(fake.calls.includes(`cache-remove alice ${ID_A} --data`));
  });
});

test("a run that failed after installing the new files is retried with a reload and a restart", async () => {
  await withFake(async (fake) => {
    const port = { access: "port" as const, port: 18100 };
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A, port)], {
      pruneUnlisted: true,
    });
    // A new password is installed, then the walls cannot be rebuilt.
    const changed = cache(ID_A, { ...port, passwordSha256: "cd".repeat(32) });
    fake.failOn.add("php-loopback-sync");
    const first = await applyEnvironmentCaches(fake.io, ENV, [changed], {
      pruneUnlisted: true,
    });
    assertEquals(first.results[0].state, "failed");
    const entry = (await readCacheIndex(fake.io.layout, ENV))[0];
    assertEquals(entry.configSha256, undefined);
    // The same deploy again, with the walls working.
    fake.failOn.delete("php-loopback-sync");
    fake.calls.length = 0;
    const retry = await applyEnvironmentCaches(fake.io, ENV, [changed], {
      pruneUnlisted: true,
    });
    assertEquals(retry.results[0].state, "ready");
    assert(fake.calls.includes("systemctl daemon-reload"));
    assertEquals(
      fake.calls.filter((c) => c.startsWith("systemctl restart")).length,
      1,
    );
    assertEquals(
      typeof (await readCacheIndex(fake.io.layout, ENV))[0].configSha256,
      "string",
    );
  });
});

test("a change from a port to a socket drops the old unit first and rebuilds the walls", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(
      fake.io,
      ENV,
      [cache(ID_A, { access: "port", port: 18100 })],
      { pruneUnlisted: true },
    );
    fake.calls.length = 0;
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: true,
    });
    const rm = fake.calls.findIndex((c) => c.startsWith("rm -f"));
    const conf = fake.calls.findIndex((c) =>
      c.startsWith("cache-config-install")
    );
    assert(rm >= 0 && rm < conf);
    assert(fake.calls.includes("php-loopback-sync"));
    assertEquals(
      fake.calls.filter((c) => c.startsWith("systemctl restart")).length,
      1,
    );
  });
});

test("a removal acts only on a cache the index lists, for the account the index names", async () => {
  await withFake(async (fake) => {
    await applyEnvironmentCaches(fake.io, ENV, [cache(ID_A)], {
      pruneUnlisted: false,
    });
    fake.calls.length = 0;
    const out = await applyEnvironmentCaches(fake.io, ENV, [], {
      pruneUnlisted: false,
      removed: [
        // Not in this environment's index: nothing is stopped or deleted.
        { id: ID_B, username: "alice", deleteData: true },
        // In the index, but for another account.
        { id: ID_A, username: "bob", deleteData: true },
      ],
    });
    assertEquals(fake.calls.some((c) => c.startsWith("cache-remove")), false);
    assertEquals(fake.calls.some((c) => c.includes("disable")), false);
    assertStringIncludes(out.warnings.join("\n"), "another account");
    assertEquals((await readCacheIndex(fake.io.layout, ENV)).length, 1);
  });
});
