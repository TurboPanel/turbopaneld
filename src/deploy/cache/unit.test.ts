import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { principalHardeningLines } from "../native/unit.ts";
import { cacheMemoryMaxBytes, renderCacheUnit } from "./unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const LAYOUT = {
  runtimesDir: "/opt/turbopanel/vendor",
  configDir: "/etc/turbopanel",
  principalHomeRoot: "/srv/users",
};
const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BASE = {
  id: ID,
  username: "alice",
  patch: "8.1.11",
  maxMemoryMb: 64,
};

const COMMON_HEAD = [
  "[Unit]",
  `Description=TurboPanel project cache ${ID}`,
  "After=network.target",
  "StartLimitIntervalSec=0",
  "",
  "[Service]",
  "Type=notify",
  `ExecStart=/opt/turbopanel/vendor/valkey/8.1.11/bin/valkey-server /etc/turbopanel/cache/${ID}/valkey.conf`,
  "User=alice",
  "Group=alice",
  "Slice=turbopanel-alice.slice",
  "MemoryMax=167772160",
  "TasksMax=64",
  "UMask=0077",
  `WorkingDirectory=/srv/users/alice/cache/${ID}`,
  `ReadWritePaths=/srv/users/alice/cache/${ID}`,
  "TemporaryFileSystem=/etc/turbopanel:ro",
  `BindReadOnlyPaths=/etc/turbopanel/cache/${ID}`,
  `RuntimeDirectory=turbopanel-cache-${ID}`,
  "RuntimeDirectoryMode=0700",
  "NoNewPrivileges=yes",
  "PrivateTmp=yes",
  "ProtectSystem=strict",
  "ProtectKernelTunables=yes",
  "ProtectKernelModules=yes",
  "ProtectControlGroups=yes",
  "RestrictSUIDSGID=yes",
  "RestrictRealtime=yes",
  "LockPersonality=yes",
  "CapabilityBoundingSet=",
  "AmbientCapabilities=",
  "PrivateDevices=yes",
  "MemoryDenyWriteExecute=yes",
  "RestrictNamespaces=yes",
  "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  "IPAddressDeny=any",
];
const COMMON_TAIL = [
  "TimeoutStartSec=300",
  "TimeoutStopSec=120",
  "Restart=always",
  "RestartSec=2",
  "RestartSteps=10",
  "RestartMaxDelaySec=120",
  "StandardOutput=journal",
  "StandardError=journal",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
];

test("a socket cache unit is exactly the pinned text", () => {
  assertEquals(
    renderCacheUnit(LAYOUT, BASE),
    [...COMMON_HEAD, ...COMMON_TAIL].join("\n"),
  );
});

test("a port cache unit adds the loopback allowance and the port the walls read", () => {
  assertEquals(
    renderCacheUnit(LAYOUT, { ...BASE, port: 18100 }),
    [
      ...COMMON_HEAD,
      "IPAddressAllow=127.0.0.1",
      "Environment=PORT=18100",
      ...COMMON_TAIL,
    ].join("\n"),
  );
});

test("the memory ceiling is twice maxmemory plus 32 MiB", () => {
  assertEquals(cacheMemoryMaxBytes(64), 167772160);
  assertEquals(cacheMemoryMaxBytes(16), 67108864);
  assertEquals(cacheMemoryMaxBytes(65536), 137472507904);
  assertStringIncludes(
    renderCacheUnit(LAYOUT, { ...BASE, maxMemoryMb: 4096 }),
    "MemoryMax=8623489024\n",
  );
});

test("the shared hardening lines, never give up restarts and no ProtectHome are present", () => {
  const text = renderCacheUnit(LAYOUT, BASE);
  const lines = new Set(text.split("\n"));
  for (const line of principalHardeningLines()) {
    assert(lines.has(line), `missing ${line}`);
  }
  assert(lines.has("StartLimitIntervalSec=0"));
  assert(lines.has("Restart=always"));
  assert(lines.has("RestartSteps=10"));
  assert(lines.has("RestartMaxDelaySec=120"));
  assertEquals(text.includes("ProtectHome"), false);
});

test("a dash in the account name gets the dotted slice", () => {
  assertStringIncludes(
    renderCacheUnit(LAYOUT, { ...BASE, username: "a-b" }),
    "Slice=turbopanel-a.b.slice\n",
  );
});

test("no secret is in the unit text", () => {
  const text = renderCacheUnit(LAYOUT, { ...BASE, port: 18100 });
  assertEquals(/password|sha256|#[0-9a-f]{64}/i.test(text), false);
});
