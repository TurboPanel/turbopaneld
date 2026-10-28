import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  allocateMetricsPort,
  isTunnelId,
  mapConnectorStatus,
  parseConnectorRecord,
  renderTunnelEnvFile,
  renderTunnelUnit,
  TUNNEL_METRICS_PORT_MAX,
  TUNNEL_METRICS_PORT_MIN,
  tunnelEnvPath,
  tunnelUnitName,
  tunnelUnitPath,
} from "./connector-unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BIN = "/opt/turbopanel/vendor/cloudflared/2026.5.2/cloudflared";

test("a tunnel id is a lower-case UUID or one of the two legacy names", () => {
  assert(isTunnelId(ID));
  assert(isTunnelId("instance"));
  assert(isTunnelId("default"));
});

test("an id that could become a path or a unit name is refused", () => {
  const bad = [
    "",
    " ",
    "..",
    "../etc/passwd",
    `${ID}/../x`,
    `${ID}\n`,
    `${ID} `,
    `${ID}.service`,
    ID.toUpperCase(),
    ID.slice(1),
    `${ID}0`,
    "instance/../x",
    "tunnel@x",
    "a".repeat(36),
    "turbopanel-tunnel-x",
  ];
  for (const value of bad) assertEquals(isTunnelId(value), false, value);
  assertEquals(isTunnelId(undefined), false);
  assertEquals(isTunnelId(5), false);
  assertThrows(() => tunnelUnitName("../x"), TypeError);
  assertThrows(() => tunnelEnvPath({ configDir: "/etc/turbopanel" }, ""));
});

test("unit and token copy are named after the id", () => {
  assertEquals(tunnelUnitName(ID), `turbopanel-tunnel-${ID}.service`);
  assertEquals(
    tunnelUnitPath(ID),
    `/etc/systemd/system/turbopanel-tunnel-${ID}.service`,
  );
  assertEquals(
    tunnelEnvPath({ configDir: "/etc/turbopanel" }, ID),
    `/etc/turbopanel/tunnel-env/${ID}.env`,
  );
});

test("the unit is its own service with the token in a file, never on the command line", () => {
  const envFile = tunnelEnvPath({ configDir: "/etc/turbopanel" }, ID);
  const text = renderTunnelUnit({ id: ID, binary: BIN, port: 20301, envFile });
  assertStringIncludes(text, `EnvironmentFile=${envFile}\n`);
  assertStringIncludes(
    text,
    `ExecStart=${BIN} tunnel run --no-autoupdate --metrics 127.0.0.1:20301\n`,
  );
  assertStringIncludes(text, "Restart=always\nRestartSec=5\n");
  assertStringIncludes(text, "DynamicUser=yes\n");
  assertStringIncludes(text, "NoNewPrivileges=yes\n");
  assertStringIncludes(text, "CapabilityBoundingSet=\n");
  assertStringIncludes(text, "WantedBy=multi-user.target\n");
  assert(!/^User=/m.test(text));
  assert(!/TUNNEL_TOKEN|--token/.test(text));
  assert(!text.includes("\\"));
});

test("the unit text is byte-identical for the same inputs", () => {
  const params = { id: ID, binary: BIN, port: 20300, envFile: "/e" };
  assertEquals(renderTunnelUnit(params), renderTunnelUnit(params));
});

test("a metrics port outside the band is refused", () => {
  const params = { id: ID, binary: BIN, envFile: "/e" };
  for (const port of [0, 80, 20241, 19_799, 20_900, 32_768, 20_300.5, NaN]) {
    assertThrows(() => renderTunnelUnit({ ...params, port }), RangeError);
  }
  renderTunnelUnit({ ...params, port: TUNNEL_METRICS_PORT_MIN });
  renderTunnelUnit({ ...params, port: TUNNEL_METRICS_PORT_MAX });
});

test("the environment file holds exactly one quoted token line", () => {
  assertEquals(
    renderTunnelEnvFile("eyJhIjoiYWJj_-+/=="),
    "TUNNEL_TOKEN='eyJhIjoiYWJj_-+/=='\n",
  );
  for (
    const bad of ["", "a b", "a'b", "a\nb", '"x"', "$(x)", "a".repeat(2049)]
  ) {
    assertThrows(() => renderTunnelEnvFile(bad), TypeError, undefined, bad);
  }
});

test("ports are handed out lowest first and skip the ones in use", () => {
  assertEquals(allocateMetricsPort([]), TUNNEL_METRICS_PORT_MIN);
  assertEquals(
    allocateMetricsPort([20300, 20302]),
    20301,
  );
  const all = Array.from(
    { length: TUNNEL_METRICS_PORT_MAX - TUNNEL_METRICS_PORT_MIN + 1 },
    (_, i) => TUNNEL_METRICS_PORT_MIN + i,
  );
  assertThrows(() => allocateMetricsPort(all));
});

test("a record round-trips and a damaged one is ignored", () => {
  const record = {
    id: ID,
    port: 20310,
    version: "2026.5.2",
    tokenDigest: "ab",
  };
  assertEquals(parseConnectorRecord(JSON.stringify(record)), record);
  assertEquals(parseConnectorRecord("{"), null);
  assertEquals(parseConnectorRecord("null"), null);
  assertEquals(
    parseConnectorRecord(JSON.stringify({ ...record, id: "../x" })),
    null,
  );
  assertEquals(
    parseConnectorRecord(JSON.stringify({ ...record, port: 80 })),
    null,
  );
});

test("status comes from the service state and the connector's own readiness", () => {
  const ready = { kind: "ready", connections: 4 } as const;
  const notReady = { kind: "not-ready", connections: 0 } as const;
  const unreachable = { kind: "unreachable" } as const;
  assertEquals(mapConnectorStatus("active", ready), "connected");
  assertEquals(mapConnectorStatus("active", notReady), "connecting");
  assertEquals(mapConnectorStatus("active", unreachable), "connecting");
  assertEquals(mapConnectorStatus("active", null), "connecting");
  assertEquals(mapConnectorStatus("activating", ready), "connecting");
  assertEquals(mapConnectorStatus("failed", ready), "failed");
  assertEquals(mapConnectorStatus("inactive", ready), "stopped");
  assertEquals(mapConnectorStatus("deactivating", null), "stopped");
  assertEquals(mapConnectorStatus("unknown", null), "not-installed");
  assertEquals(mapConnectorStatus("", null), "not-installed");
  assertEquals(mapConnectorStatus("active\n", ready), "connected");
});
