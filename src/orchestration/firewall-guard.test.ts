import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Drives orchestration/scripts/tp-firewall-guard (the root rollback guard for
 * an unconfirmed firewall ruleset) with stub `iptables` / `systemctl` / `id`
 * binaries on PATH, in a temp tree standing in for /run, /etc and /var/lib.
 * What the stubs record is the order and shape of the host commands the guard
 * issues; what the tree holds afterwards is what a late confirm would see.
 */
const here = dirname(fromFileUrl(import.meta.url));
const GUARD = join(here, "../../orchestration/scripts/tp-firewall-guard");
const FIXTURES = join(here, "../firewall/fixtures");

const STUB = String.raw`#!/bin/sh
# Records "<name> <args>" (and stdin for the -restore tools). Behaviour is a
# tiny model of the xtables tools, driven by marker files in $FAKE_DIR.
name="$(basename "$0")"
printf '%s %s\n' "$name" "$*" >> "$FAKE_LOG"
case "$name" in
  id) [ "$1" = "-u" ] && { printf '%s\n' "$FAKE_UID"; exit 0; }; exit 0 ;;
  systemctl) exit 0 ;;
  iptables-restore|ip6tables-restore)
    cat > "$FAKE_DIR/restore.$name.$$"
    case "$*" in
      *--test*) [ -e "$FAKE_DIR/fail-test" ] && exit 1 ;;
      *) [ -e "$FAKE_DIR/fail-restore" ] && exit 1 ;;
    esac
    exit 0
    ;;
  iptables|ip6tables)
    while [ "$#" -gt 0 ] && [ "$1" = "-w" ]; do shift 2; done
    verb="$1"; parent="$2"
    case "$verb" in
      -D) [ -e "$FAKE_DIR/jump.$name.$parent" ] || exit 1
          rm -f "$FAKE_DIR/jump.$name.$parent"; exit 0 ;;
      -C) [ -e "$FAKE_DIR/jump.$name.$parent" ] || exit 1; exit 0 ;;
      -I) : > "$FAKE_DIR/jump.$name.$parent"; exit 0 ;;
      -S) [ -e "$FAKE_DIR/docker-user" ] || exit 1; exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
esac
`;

type Tree = {
  root: string;
  run: string;
  state: string;
  config: string;
  fake: string;
  bin: string;
  log: string;
};

async function withTree<T>(fn: (tree: Tree) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-fwg-" });
  const tree: Tree = {
    root,
    run: join(root, "run"),
    state: join(root, "state"),
    config: join(root, "etc"),
    fake: join(root, "fake"),
    bin: join(root, "bin"),
    log: join(root, "fake", "calls.log"),
  };
  try {
    for (
      const dir of [tree.run, tree.state, tree.config, tree.fake, tree.bin]
    ) {
      await Deno.mkdir(dir, { recursive: true });
    }
    await Deno.writeTextFile(tree.log, "");
    for (
      const name of [
        "id",
        "systemctl",
        "iptables",
        "ip6tables",
        "iptables-restore",
        "ip6tables-restore",
      ]
    ) {
      await Deno.writeTextFile(join(tree.bin, name), STUB, { mode: 0o755 });
    }
    return await fn(tree);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function runGuard(
  tree: Tree,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stderr: string; calls: string[] }> {
  const output = await new Deno.Command("/bin/sh", {
    args: [GUARD],
    clearEnv: true,
    env: {
      PATH: `${tree.bin}:/usr/bin:/bin`,
      TURBOPANEL_RUN_DIR: tree.run,
      TURBOPANEL_STATE_DIR: tree.state,
      TURBOPANEL_CONFIG_DIR: tree.config,
      TURBOPANEL_INSTALL_ROOT: join(tree.root, "opt"),
      TMPDIR: tree.root,
      FAKE_DIR: tree.fake,
      FAKE_LOG: tree.log,
      FAKE_UID: "0",
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const calls = (await Deno.readTextFile(tree.log)).split("\n").filter((l) =>
    l !== "" && !l.startsWith("id ")
  );
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
    calls,
  };
}

const DIGEST = "d".repeat(64);
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

async function arm(tree: Tree, deadlineAt: string): Promise<void> {
  await Deno.writeTextFile(
    join(tree.run, "firewall-pending.json"),
    JSON.stringify({
      version: 1,
      digest: DIGEST,
      generation: 3,
      armedAt: PAST,
      deadlineAt,
      windowSeconds: 120,
      v6: "keep",
    }),
  );
  await Deno.writeTextFile(
    join(tree.config, "firewall.pending.v4"),
    "pending\n",
  );
  await Deno.writeTextFile(
    join(tree.config, "firewall.pending.v6"),
    "pending\n",
  );
}

/** The kernel as the pending apply left it: both TurboPanel jumps in place. */
async function loadedKernel(tree: Tree): Promise<void> {
  for (const name of ["iptables", "ip6tables"]) {
    await Deno.writeTextFile(join(tree.fake, `jump.${name}.INPUT`), "");
    await Deno.writeTextFile(join(tree.fake, `jump.${name}.DOCKER-USER`), "");
  }
  await Deno.writeTextFile(join(tree.fake, "docker-user"), "");
}

const exists = async (path: string) => {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
};

async function rollbackRecord(tree: Tree) {
  return JSON.parse(
    await Deno.readTextFile(join(tree.state, "firewall-rollback.json")),
  ) as { digest: string; restored: string; at: string };
}

const index = (calls: string[], needle: string) =>
  calls.findIndex((c) => c.includes(needle));

test("nothing pending: the guard stops its timer and touches no firewall", async () => {
  await withTree(async (tree) => {
    const result = await runGuard(tree);
    assertEquals(result.code, 0);
    assertEquals(result.calls, [
      "systemctl stop turbopanel-firewall-guard.timer",
    ]);
  });
});

test("pending but inside the window: the guard leaves everything alone and keeps the marker", async () => {
  await withTree(async (tree) => {
    await arm(tree, FUTURE);
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0);
    assertEquals(result.calls, []);
    assert(await exists(join(tree.run, "firewall-pending.json")));
    assert(await exists(join(tree.config, "firewall.pending.v4")));
    assert(await exists(join(tree.fake, "jump.iptables.INPUT")));
  });
});

test("past the deadline with confirmed rules: jumps come out first, then the confirmed documents load and the jumps return", async () => {
  await withTree(async (tree) => {
    // The documents the renderer really emits must pass the guard's validator.
    await Deno.copyFile(
      join(FIXTURES, "golden.v4"),
      join(tree.config, "firewall.v4"),
    );
    await Deno.copyFile(
      join(FIXTURES, "golden.v6"),
      join(tree.config, "firewall.v6"),
    );
    await arm(tree, PAST);
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);

    const { calls } = result;
    const firstDelete = index(calls, "iptables -w 5 -D INPUT -j TP-INPUT");
    const firstTest = index(calls, "iptables-restore -w 5 --noflush --test");
    const firstRestore = calls.findIndex((c) =>
      c.startsWith("iptables-restore") && !c.includes("--test")
    );
    assert(firstDelete >= 0, "the INPUT jump is taken out");
    assert(firstDelete < firstTest, "open before anything is restored");
    assert(firstTest < firstRestore, "--test before the real restore");
    assert(
      calls.includes("iptables -w 5 -I INPUT 1 -j TP-INPUT"),
      "the jump returns with the confirmed rules",
    );
    assert(calls.includes("iptables -w 5 -I DOCKER-USER 1 -j TP-FWD"));
    assert(calls.includes("ip6tables -w 5 -I INPUT 1 -j TP-INPUT"));

    const record = await rollbackRecord(tree);
    assertEquals(record.restored, "durable");
    assertEquals(record.digest, DIGEST);
    assert(!(await exists(join(tree.run, "firewall-pending.json"))));
    assert(!(await exists(join(tree.config, "firewall.pending.v4"))));
    assert(!(await exists(join(tree.config, "firewall.pending.v6"))));
    assert(
      await exists(join(tree.config, "firewall.v4")),
      "the confirmed documents are never deleted by a rollback",
    );
    assertEquals(
      calls.at(-1),
      "systemctl stop turbopanel-firewall-guard.timer",
    );
    assert(
      !calls.some((c) => c.includes("turbopaneld")),
      "the guard never depends on the daemon being up",
    );
  });
});

test("past the deadline with no confirmed rules: the chains are removed and the host is open", async () => {
  await withTree(async (tree) => {
    await arm(tree, PAST);
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assert(!(await exists(join(tree.fake, "jump.iptables.INPUT"))));
    assert(!(await exists(join(tree.fake, "jump.iptables.DOCKER-USER"))));
    for (const chain of ["TP-INPUT", "TP-FWD"]) {
      assert(result.calls.includes(`iptables -w 5 -F ${chain}`));
      assert(result.calls.includes(`iptables -w 5 -X ${chain}`));
    }
    assert(
      !result.calls.some((c) => c.startsWith("iptables-restore")),
      "nothing is restored when there was nothing confirmed",
    );
    assertEquals((await rollbackRecord(tree)).restored, "none");
  });
});

test("a confirmed document that is not strictly TurboPanel's own is never loaded: the host ends open", async () => {
  const bad: Record<string, string> = {
    "a rule in another chain":
      "*filter\n:TP-INPUT - [0:0]\n-A INPUT -j ACCEPT\nCOMMIT\n",
    "a goto": "*filter\n:TP-INPUT - [0:0]\n-A TP-INPUT -g OTHER\nCOMMIT\n",
    "a foreign target":
      "*filter\n:TP-INPUT - [0:0]\n-A TP-INPUT -j MASQUERADE\nCOMMIT\n",
    "a command-looking line":
      "*filter\n:TP-INPUT - [0:0]\n-A TP-INPUT -p tcp ; reboot\nCOMMIT\n",
    "another table": "*nat\n:PREROUTING ACCEPT [0:0]\nCOMMIT\n",
  };
  for (const [label, document] of Object.entries(bad)) {
    await withTree(async (tree) => {
      await Deno.writeTextFile(join(tree.config, "firewall.v4"), document);
      await arm(tree, PAST);
      await loadedKernel(tree);
      const result = await runGuard(tree);
      assertEquals(result.code, 0, `${label}: ${result.stderr}`);
      assert(
        !result.calls.some((c) => c.startsWith("iptables-restore")),
        `${label}: must not reach iptables-restore`,
      );
      assert(!(await exists(join(tree.fake, "jump.iptables.INPUT"))), label);
      assertEquals((await rollbackRecord(tree)).restored, "open", label);
    });
  }
});

test("a confirmed document behind a symlink is never read", async () => {
  await withTree(async (tree) => {
    const target = join(tree.root, "elsewhere");
    await Deno.copyFile(join(FIXTURES, "golden.v4"), target);
    await Deno.symlink(target, join(tree.config, "firewall.v4"));
    await arm(tree, PAST);
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assert(!result.calls.some((c) => c.startsWith("iptables-restore")));
    assertEquals((await rollbackRecord(tree)).restored, "open");
  });
});

test("confirmed rules the kernel refuses leave the host open, not half restored", async () => {
  await withTree(async (tree) => {
    await Deno.copyFile(
      join(FIXTURES, "golden.v4"),
      join(tree.config, "firewall.v4"),
    );
    await arm(tree, PAST);
    await loadedKernel(tree);
    await Deno.writeTextFile(join(tree.fake, "fail-test"), "");
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assertEquals((await rollbackRecord(tree)).restored, "open");
    assert(!(await exists(join(tree.fake, "jump.iptables.INPUT"))));
    assert(result.calls.includes("iptables -w 5 -X TP-INPUT"));
  });
});

test("an unreadable marker is rolled back at once; a symlinked one is never followed", async () => {
  await withTree(async (tree) => {
    await Deno.writeTextFile(
      join(tree.run, "firewall-pending.json"),
      "{garbage",
    );
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assert(!(await exists(join(tree.fake, "jump.iptables.INPUT"))));
    assertEquals((await rollbackRecord(tree)).digest, "unknown");
    assert(!(await exists(join(tree.run, "firewall-pending.json"))));
  });
  await withTree(async (tree) => {
    const target = join(tree.root, "marker-target");
    await Deno.writeTextFile(
      target,
      JSON.stringify({ digest: DIGEST, deadlineAt: FUTURE }),
    );
    await Deno.symlink(target, join(tree.run, "firewall-pending.json"));
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assert(
      !(await exists(join(tree.fake, "jump.iptables.INPUT"))),
      "a symlinked marker is not trusted to say the window is still open",
    );
  });
});

test("a host without ip6tables still rolls back IPv4", async () => {
  await withTree(async (tree) => {
    await Deno.remove(join(tree.bin, "ip6tables"));
    await Deno.remove(join(tree.bin, "ip6tables-restore"));
    await arm(tree, PAST);
    await loadedKernel(tree);
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assert(!(await exists(join(tree.fake, "jump.iptables.INPUT"))));
    assert(!result.calls.some((c) => c.startsWith("ip6tables")));
  });
});

test("a clock the guard cannot read counts as the window being over", async () => {
  await withTree(async (tree) => {
    await arm(tree, FUTURE);
    await loadedKernel(tree);
    await Deno.writeTextFile(
      join(tree.bin, "date"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    const result = await runGuard(tree);
    assertEquals(result.code, 0, result.stderr);
    assert(!(await exists(join(tree.fake, "jump.iptables.INPUT"))));
  });
});

test("it refuses to run as anyone but root", async () => {
  await withTree(async (tree) => {
    await arm(tree, PAST);
    const result = await runGuard(tree, { FAKE_UID: "1000" });
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "must run as root");
    assertEquals(result.calls, []);
  });
});
