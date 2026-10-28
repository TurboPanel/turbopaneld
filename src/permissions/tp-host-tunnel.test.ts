/**
 * tp-host and the Cloudflare tunnel connector units: the unit the daemon
 * renders is accepted, every one-line change to it is refused, and the token
 * copy lands in a root-only folder. Run unprivileged in tp-host's test mode
 * against a throwaway prefix (see tp-host.test.ts).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";
import {
  renderTunnelEnvFile,
  renderTunnelUnit,
  TUNNEL_METRICS_PORT_MAX,
  TUNNEL_METRICS_PORT_MIN,
  TUNNEL_TOKEN_RE,
} from "../tunnels/connector-unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const TOKEN = "dGVzdA".repeat(8);
const STAGE_DIR = "var/lib/turbopanel/cloudflared/tunnels";
const COPY_DIR = "etc/turbopanel/tunnel-env";

function unitFor(host: Host, id = ID, port = TUNNEL_METRICS_PORT_MIN): string {
  return renderTunnelUnit({
    id,
    binary: host.path("opt/turbopanel/vendor/cloudflared/2026.5.2/cloudflared"),
    port,
    envFile: host.path(`${COPY_DIR}/${id}.env`),
  });
}

const unitName = (id = ID) => `turbopanel-tunnel-${id}.service`;

async function installUnit(host: Host, name: string, content: string) {
  await Deno.writeTextFile(host.path("tmp/unit"), content);
  return host.run([
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    host.path("tmp/unit"),
    host.path(`etc/systemd/system/${name}`),
  ]);
}

async function refusedUnit(host: Host, name: string, content: string) {
  await Deno.writeTextFile(host.path("tmp/unit"), content);
  return await refused(host, [
    "install",
    "-m",
    "0644",
    "-o",
    "root",
    "-g",
    "root",
    host.path("tmp/unit"),
    host.path(`etc/systemd/system/${name}`),
  ]);
}

async function stageToken(host: Host, text: string, id = ID) {
  await Deno.mkdir(host.path(STAGE_DIR), { recursive: true });
  await Deno.writeTextFile(host.path(`${STAGE_DIR}/${id}.env`), text);
}

test("the unit the daemon renders is accepted, for an id and for the two legacy names", async () => {
  await withHost(async (host) => {
    for (const id of [ID, "instance", "default"]) {
      const result = await installUnit(host, unitName(id), unitFor(host, id));
      assertEquals(result.code, 0, result.stderr);
    }
    const last = unitFor(host, OTHER_ID, TUNNEL_METRICS_PORT_MAX);
    assertEquals((await installUnit(host, unitName(OTHER_ID), last)).code, 0);
  });
});

test("every one-line change to the unit is refused", async () => {
  await withHost(async (host) => {
    const good = unitFor(host);
    const lines = good.split("\n");
    const changes: Array<[string, string]> = [];
    for (const [i, line] of lines.entries()) {
      if (line === "") continue;
      const without = lines.filter((_, j) => j !== i).join("\n");
      changes.push([`without ${line}`, without]);
      const key = line.slice(0, line.indexOf("=") + 1);
      if (key.length > 1 && !key.startsWith("Description")) {
        const edited = [...lines];
        edited[i] = `${key}changed`;
        changes.push([`${key} changed`, edited.join("\n")]);
      }
    }
    changes.push(
      [
        "a second ExecStart",
        good.replace(
          "Restart=always",
          "ExecStart=/bin/sh -c id\nRestart=always",
        ),
      ],
      [
        "User=root",
        good.replace("DynamicUser=yes", "DynamicUser=yes\nUser=root"),
      ],
      [
        "a capability",
        good.replace(
          "CapabilityBoundingSet=",
          "CapabilityBoundingSet=CAP_SYS_ADMIN",
        ),
      ],
      [
        "an ambient capability",
        good.replace(
          "LockPersonality=yes",
          "LockPersonality=yes\nAmbientCapabilities=CAP_NET_ADMIN",
        ),
      ],
      ["a privileged exec prefix", good.replace("ExecStart=", "ExecStart=+")],
      [
        "a line continuation",
        good.replace("--no-autoupdate", "--no-autoupdate \\\n--x"),
      ],
      ["a trailing line", `${good}\n`],
      ["a carriage return", good.replace("Restart=always", "Restart=always\r")],
      ["another unit's token", good.replace(`${ID}.env`, `${OTHER_ID}.env`)],
      [
        "the daemon's staging file",
        good.replace(`${COPY_DIR}/${ID}.env`, `${STAGE_DIR}/${ID}.env`),
      ],
      [
        "a command on the line",
        good.replace("--metrics", "--token abc --metrics"),
      ],
      ["a public metrics address", good.replace("127.0.0.1:", "0.0.0.0:")],
      ["another program", good.replace("/cloudflared tunnel", "/sh tunnel")],
      ["a version with a path in it", good.replace("/2026.5.2/", "/../x/")],
      ["an empty version", good.replace("/2026.5.2/", "//")],
    );
    for (const [label, text] of changes) {
      try {
        await refusedUnit(host, unitName(), text);
      } catch (err) {
        throw new Error(
          `${label}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // Nothing was installed.
    assertEquals(
      await Deno.lstat(host.path(`etc/systemd/system/${unitName()}`)).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

test("a port outside the band, or not a plain number, is refused", async () => {
  await withHost(async (host) => {
    const good = unitFor(host);
    const at = (port: string) =>
      good.replace(`127.0.0.1:${TUNNEL_METRICS_PORT_MIN}`, `127.0.0.1:${port}`);
    for (
      const port of [
        "80",
        "20299",
        "20900",
        "020300",
        "20300 ",
        "2030a",
        "123456",
        "",
        "-1",
      ]
    ) {
      await refusedUnit(host, unitName(), at(port));
    }
    assertEquals((await installUnit(host, unitName(), at("20500"))).code, 0);
  });
});

test("a unit name that is not a tunnel id is refused whatever it holds", async () => {
  await withHost(async (host) => {
    for (
      const name of [
        "turbopanel-tunnel-.service",
        "turbopanel-tunnel-..service",
        "turbopanel-tunnel-x.service",
        `turbopanel-tunnel-${ID.toUpperCase()}.service`,
        `turbopanel-tunnel-${ID}0.service`,
        `turbopanel-tunnel-${ID}.timer`,
        `turbopanel-tunnel-${ID}.slice`,
        "turbopanel-tunnel-instance2.service",
        "turbopanel-tunnel-----------------------------------.service",
      ]
    ) {
      await refusedUnit(host, name, unitFor(host));
    }
  });
});

test("systemctl takes a tunnel unit by name and nothing else", async () => {
  await withHost(async (host) => {
    for (
      const verb of [
        "start",
        "stop",
        "restart",
        "enable",
        "disable",
        "is-active",
        "reset-failed",
      ]
    ) {
      const result = await host.run(["systemctl", verb, unitName()]);
      assertEquals(result.code, 0, result.stderr);
    }
    const stdout =
      (await host.run(["systemctl", "enable", "--now", unitName()])).stdout;
    assertStringIncludes(stdout, unitName());
    await refused(host, [
      "systemctl",
      "start",
      "turbopanel-tunnel-../x.service",
    ]);
    await refused(host, ["systemctl", "start", `${unitName()};id`]);
  });
});

test("tunnel-env-install copies a checked token into a root-only folder", async () => {
  await withHost(async (host) => {
    const text = renderTunnelEnvFile(TOKEN);
    await stageToken(host, text);
    const result = await host.run(["tunnel-env-install", ID]);
    assertEquals(result.code, 0, result.stderr);
    const copy = host.path(`${COPY_DIR}/${ID}.env`);
    assertEquals(await Deno.readTextFile(copy), text);
    assertEquals((await Deno.stat(copy)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(host.path(COPY_DIR))).mode! & 0o777, 0o700);
    assertEquals(
      [...Deno.readDirSync(host.path(COPY_DIR))].map((e) => e.name),
      [`${ID}.env`],
    );
    // A later run replaces the copy.
    await stageToken(host, renderTunnelEnvFile(`${TOKEN}AA`));
    assertEquals((await host.run(["tunnel-env-install", ID])).code, 0);
    assertStringIncludes(await Deno.readTextFile(copy), `${TOKEN}AA`);
    // The token never appears in what tp-host prints.
    assert(!result.stdout.includes(TOKEN) && !result.stderr.includes(TOKEN));
  });
});

test("tunnel-env-install and tunnel-env-remove accept the legacy names", async () => {
  await withHost(async (host) => {
    for (const id of ["default", "instance"]) {
      await stageToken(host, renderTunnelEnvFile(TOKEN), id);
      assertEquals((await host.run(["tunnel-env-install", id])).code, 0);
      const copy = host.path(`${COPY_DIR}/${id}.env`);
      assertEquals(await Deno.readTextFile(copy), renderTunnelEnvFile(TOKEN));
      assertEquals((await host.run(["tunnel-env-remove", id])).code, 0);
    }
  });
});

test("tunnel-env-install refuses every line the daemon never writes", async () => {
  await withHost(async (host) => {
    const bad = [
      "",
      "\n",
      `TUNNEL_TOKEN='${TOKEN}'\nEXTRA='x'\n`,
      `TUNNEL_TOKEN='${TOKEN}'\n\n`,
      `TUNNEL_TOKEN="${TOKEN}"\n`,
      `TUNNEL_TOKEN=${TOKEN}\n`,
      `TUNNEL_TOKEN='${TOKEN}' \n`,
      `TUNNEL_TOKEN='${TOKEN}'x\n`,
      "TUNNEL_TOKEN=''\n",
      "TUNNEL_TOKEN='a b'\n",
      "TUNNEL_TOKEN='a$b'\n",
      "TUNNEL_TOKEN='a`b'\n",
      "TUNNEL_TOKEN='a\\b'\n",
      "TUNNEL_TOKEN='a'b'\n",
      `TUNNEL_TOKEN='${"a".repeat(2049)}'\n`,
      `# comment\nTUNNEL_TOKEN='${TOKEN}'\n`,
      `LD_PRELOAD='/x'\n`,
      `TUNNEL_TOKEN='${TOKEN}'\r\n`,
      `TUNNEL_TOKEN='${TOKEN}\n'\n`,
      `ExecStartPre='x'\n`,
    ];
    for (const text of bad) {
      await stageToken(host, text);
      try {
        await refused(host, ["tunnel-env-install", ID]);
      } catch (err) {
        throw new Error(
          `${JSON.stringify(text.slice(0, 40))}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
      assertEquals(
        await Deno.lstat(host.path(`${COPY_DIR}/${ID}.env`)).then(
          () => true,
          () => false,
        ),
        false,
      );
    }
    // The largest allowed token goes through.
    await stageToken(host, `TUNNEL_TOKEN='${"a".repeat(2048)}'\n`);
    assertEquals((await host.run(["tunnel-env-install", ID])).code, 0);
  });
});

test("tunnel-env-install and tunnel-env-remove take one tunnel id and nothing that is a path", async () => {
  await withHost(async (host) => {
    await stageToken(host, renderTunnelEnvFile(TOKEN));
    for (const verb of ["tunnel-env-install", "tunnel-env-remove"]) {
      for (
        const id of [
          "",
          "..",
          "../x",
          `${ID}/x`,
          "/etc/passwd",
          "-x",
          ID.toUpperCase(),
          `${ID}.env`,
          "a".repeat(36),
        ]
      ) {
        await refused(host, [verb, id]);
      }
      await refused(host, [verb]);
      await refused(host, [verb, ID, OTHER_ID]);
    }
    assertEquals(
      await Deno.lstat(host.path(COPY_DIR)).then(() => true, () => false),
      false,
    );
  });
});

test("tunnel-env-install refuses a staged file that is a link or sits outside the staging folder", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(STAGE_DIR), { recursive: true });
    await Deno.writeTextFile(
      host.path("tmp/secret"),
      renderTunnelEnvFile(TOKEN),
    );
    await Deno.symlink(
      host.path("tmp/secret"),
      host.path(`${STAGE_DIR}/${ID}.env`),
    );
    await refused(host, ["tunnel-env-install", ID]);
    // No staging folder at all.
    await Deno.remove(host.path(`${STAGE_DIR}/${ID}.env`));
    await Deno.remove(host.path(STAGE_DIR), { recursive: true });
    await refused(host, ["tunnel-env-install", ID]);
  });
});

test("tunnel-env-install refuses a copy folder or parent that is not root's", async () => {
  await withHost(async (host) => {
    await stageToken(host, renderTunnelEnvFile(TOKEN));
    await Deno.mkdir(host.path(COPY_DIR), { mode: 0o755 });
    await Deno.chmod(host.path(COPY_DIR), 0o755);
    await refused(host, ["tunnel-env-install", ID]);
  });
});

test("tunnel-env-remove deletes only that tunnel's copy, and is fine with nothing there", async () => {
  await withHost(async (host) => {
    assertEquals((await host.run(["tunnel-env-remove", ID])).code, 0);
    for (const id of [ID, OTHER_ID]) {
      await stageToken(host, renderTunnelEnvFile(TOKEN), id);
      assertEquals((await host.run(["tunnel-env-install", id])).code, 0);
    }
    assertEquals((await host.run(["tunnel-env-remove", ID])).code, 0);
    assertEquals(
      [...Deno.readDirSync(host.path(COPY_DIR))].map((e) => e.name),
      [`${OTHER_ID}.env`],
    );
    assertEquals((await host.run(["tunnel-env-remove", ID])).code, 0);
  });
});

test("no generic verb reaches the token copies", async () => {
  await withHost(async (host) => {
    await stageToken(host, renderTunnelEnvFile(TOKEN));
    assertEquals((await host.run(["tunnel-env-install", ID])).code, 0);
    const copy = host.path(`${COPY_DIR}/${ID}.env`);
    await refused(host, ["cat", "--", copy]);
    await refused(host, ["rm", "-f", "--", copy]);
    await refused(host, ["chmod", "0644", copy]);
    await refused(host, ["cp", copy, host.path("tmp/out")]);
    await refused(host, ["install", "-m", "0600", host.path("tmp/unit"), copy]);
    assert(TP_HOST_SCRIPT.length > 0);
  });
});

test("tp-host and the daemon agree on the token and port limits", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  assertStringIncludes(
    script,
    `TP_TUNNEL_PORT_MIN=${TUNNEL_METRICS_PORT_MIN}\n`,
  );
  assertStringIncludes(
    script,
    `TP_TUNNEL_PORT_MAX=${TUNNEL_METRICS_PORT_MAX}\n`,
  );
  assertStringIncludes(script, "TP_TUNNEL_TOKEN_MAX=2048\n");
  assert(TUNNEL_TOKEN_RE.test("a".repeat(2048)));
  assert(!TUNNEL_TOKEN_RE.test("a".repeat(2049)));
});
