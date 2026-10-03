import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  isSitePhpRuntimeOf,
  phpIniBytes,
  SITE_PHP_ID_RE,
  SITE_PHP_LOCKED_INI_KEYS,
  sitePhpFpmConf,
  sitePhpIni,
  sitePhpKey,
  sitePhpLockedValues,
  sitePhpRuntimeId,
  sitePhpRuntimeIdsIn,
  sitePhpRuntimeMode,
  type SitePhpRuntimeSpec,
  sitePhpServiceUnit,
  sitePhpSocketPath,
  sitePhpUnitLimits,
} from "./php-runtime.ts";
import {
  holdSitePhpRuntime,
  orphanSitePhpRuntimes,
  reconcileSitePhpRuntimes,
  type SitePhpRuntimeIo,
} from "./php-runtime-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SPEC: SitePhpRuntimeSpec = {
  id: "shop-0a1b2c3d4e5f-fcgi84",
  mode: "fastcgi",
  series: "8.4",
  user: "alice",
  group: "alice-grp",
  home: "/srv/users/alice",
  configDir: "/etc/turbopanel",
  webAccount: "tpnginx",
};

test("site keys fit tp-host's alphabet whatever the environment and service look like", () => {
  for (
    const [env, service] of [
      ["env1", "shop"],
      ["Env_With_Caps-0123456789abcdef0123456789abcdef", "Web_App.v2"],
      ["e", "___"],
      ["e", "a-very-long-service-name-that-goes-on-and-on"],
    ]
  ) {
    const key = sitePhpKey(env, service);
    for (const mode of ["fastcgi", "fpm"] as const) {
      const id = sitePhpRuntimeId(key, mode, "8.4");
      assertEquals(SITE_PHP_ID_RE.test(id), true, id);
      assertEquals(id.length <= 64, true, id);
    }
  }
  assertEquals(sitePhpKey("env1", "shop").startsWith("shop-"), true);
  assertEquals(/^[0-9a-f]{12}$/.test(sitePhpKey("e", "___")), true);
});

test("services that slug alike, or the same service in two environments, get different keys", () => {
  const keys = new Set([
    sitePhpKey("env1", "web_1"),
    sitePhpKey("env1", "Web-1"),
    sitePhpKey("env1", "web.1"),
    sitePhpKey("env2", "web_1"),
  ]);
  assertEquals(keys.size, 4);
  assertEquals(sitePhpKey("env1", "web_1"), sitePhpKey("env1", "web_1"));
});

test("each mode and series is its own runtime, so a switch runs side by side", () => {
  const key = sitePhpKey("env1", "shop");
  const ids = new Set([
    sitePhpRuntimeId(key, "fastcgi", "8.4"),
    sitePhpRuntimeId(key, "fpm", "8.4"),
    sitePhpRuntimeId(key, "fpm", "8.3"),
  ]);
  assertEquals(ids.size, 3);
  assertEquals(
    sitePhpSocketPath(sitePhpRuntimeId(key, "fpm", "8.4")),
    `/run/turbopanel-php-${key}-fpm84/php.sock`,
  );
});

test("the per-site mode: nginx and Apache only, lsphp refused there, none keeps the shared master", () => {
  const site = (
    engine: "caddy" | "nginx" | "apache" | "openlitespeed",
    mode?: "fastcgi" | "fpm" | "lsphp-detached" | "lsphp-attached",
  ) => ({
    composeServiceName: "shop",
    engine,
    php: mode === undefined ? { version: "8.4" } : { version: "8.4", mode },
  });
  assertEquals(sitePhpRuntimeMode(site("nginx", "fastcgi")), "fastcgi");
  assertEquals(sitePhpRuntimeMode(site("apache", "fpm")), "fpm");
  assertEquals(sitePhpRuntimeMode(site("nginx")), null);
  assertEquals(sitePhpRuntimeMode(site("openlitespeed", "fastcgi")), null);
  assertEquals(sitePhpRuntimeMode(site("caddy", "fpm")), null);
  assertEquals(
    sitePhpRuntimeMode({ composeServiceName: "s", engine: "nginx" }),
    null,
  );
  assertThrows(
    () => sitePhpRuntimeMode(site("apache", "lsphp-attached")),
    Error,
    "needs OpenLiteSpeed, not apache",
  );
});

test("php.ini keeps the isolation pinned and refuses what tp-host would", () => {
  const ini = sitePhpIni([
    { key: "memory_limit", value: "512M" },
    { key: "session.save_path", value: "/var/lib/php/sessions" },
    { key: "opcache.validate_root", value: "0" },
    { key: "opcache.memory_consumption", value: "1024" },
  ], SPEC.home);
  assertStringIncludes(ini, "memory_limit = 512M\n");
  assertEquals(ini.includes("memory_limit = 128M"), false);
  assertStringIncludes(ini, "session.save_path = /tmp\n");
  assertStringIncludes(ini, "upload_tmp_dir = /tmp\n");
  assertStringIncludes(ini, "opcache.validate_root = 1\n");
  assertStringIncludes(ini, "opcache.validate_permission = 1\n");
  assertStringIncludes(ini, "opcache.memory_consumption = 128\n");
  assertEquals(ini.includes("error_log"), false);
  assertEquals(ini.includes("zend_extension"), false);
  assertThrows(
    () =>
      sitePhpIni(
        [{ key: "error_reporting", value: "E_ALL & ~(E_NOTICE)" }],
        SPEC.home,
      ),
    Error,
    "error_reporting",
  );
});

test("php-fpm.conf: one pool named after the runtime, no user or group, an ACL for the web server", () => {
  const spec = { ...SPEC, id: "shop-0a1b2c3d4e5f-fpm84", mode: "fpm" as const };
  const conf = sitePhpFpmConf(spec, {
    pool: [{ key: "pm", value: "static" }, {
      key: "pm.max_children",
      value: "4",
    }],
    chdir: "/srv/users/alice/sites/shop/current/public",
  });
  assertStringIncludes(conf, "[shop-0a1b2c3d4e5f-fpm84]\n");
  assertStringIncludes(
    conf,
    "listen = /run/turbopanel-php-shop-0a1b2c3d4e5f-fpm84/php.sock\n",
  );
  assertStringIncludes(conf, "listen.acl_users = tpnginx\n");
  assertStringIncludes(conf, "pm = static\npm.max_children = 4\n");
  // ondemand-only; php-fpm refuses it under another pm.
  assertEquals(conf.includes("process_idle_timeout"), false);
  for (const refused of ["\nuser", "\ngroup", "listen.owner", "listen.group"]) {
    assertEquals(conf.includes(refused), false, refused);
  }
});

test("only php-fpm starts at boot; FastCGI waits on its socket", () => {
  const fastcgi = sitePhpServiceUnit(SPEC, { writablePaths: [] });
  assertEquals(fastcgi.includes("[Install]"), false);
  assertStringIncludes(
    fastcgi,
    "Requires=turbopanel-php-shop-0a1b2c3d4e5f-fcgi84.socket",
  );
  assertStringIncludes(fastcgi, "ReadWritePaths=/srv/users/alice/tmp\n");
  const fpm = sitePhpServiceUnit({ ...SPEC, mode: "fpm" }, {
    writablePaths: ["/srv/users/alice/tmp", "-/srv/users/alice/sites/x/shared"],
  });
  assertStringIncludes(fpm, "[Install]\nWantedBy=multi-user.target\n");
  assertStringIncludes(
    fpm,
    "ReadWritePaths=/srv/users/alice/tmp -/srv/users/alice/sites/x/shared\n",
  );
});

test("boot reconcile starts only what is down: the socket for FastCGI, the master for php-fpm", async () => {
  const calls: string[] = [];
  const io: SitePhpRuntimeIo = {
    unitDir: "/units",
    run: (_command, args) => {
      const argv = args.slice(1);
      calls.push(argv.join(" "));
      if (argv[0] === "ls" && argv.at(-1) !== "/units") {
        return Promise.resolve({
          success: true,
          stdout: "v.conf\n",
          stderr: "",
        });
      }
      if (argv[0] === "cat") {
        return Promise.resolve({
          success: true,
          stdout: ["up-fcgi84", "down-fcgi84", "down-fpm84", "stuck-fpm84"]
            .map((id) =>
              `fastcgi_pass unix:/run/turbopanel-php-${id}/php.sock;`
            )
            .join("\n"),
          stderr: "",
        });
      }
      if (argv[0] === "ls") {
        return Promise.resolve({
          success: true,
          stdout: [
            "turbopanel-php-up-fcgi84.service",
            "turbopanel-php-up-fcgi84.socket",
            "turbopanel-php-down-fcgi84.service",
            "turbopanel-php-down-fcgi84.socket",
            "turbopanel-php-down-fpm84.service",
            "turbopanel-php-stuck-fpm84.service",
          ].join("\n"),
          stderr: "",
        });
      }
      const unit = argv.at(-1) ?? "";
      const up = unit.includes("-up-");
      const stuck = unit.includes("-stuck-") && argv[1] === "start";
      return Promise.resolve({
        success: argv[1] === "is-active" ? up : !stuck,
        stdout: "",
        stderr: stuck ? "failed" : "",
      });
    },
  };
  const { started, removed } = await reconcileSitePhpRuntimes(io, "/etc/tp");
  assertEquals(removed, []);
  assertEquals(started, [
    "turbopanel-php-down-fcgi84.socket",
    "turbopanel-php-down-fpm84.service",
  ]);
  assertEquals(
    calls.filter((c) => c.startsWith("systemctl start")),
    [
      "systemctl start turbopanel-php-down-fcgi84.socket",
      "systemctl start turbopanel-php-down-fpm84.service",
      "systemctl start turbopanel-php-stuck-fpm84.service",
    ],
  );
});

test("a runtime id belongs to a site only by its exact shape, never by prefix", () => {
  const key = sitePhpKey("env1", "shop");
  // A second site whose service slugs to this key plus more: its runtimes
  // start with `<key>-` too.
  const longer = `${key}-x-0a1b2c3d4e5f`;
  assertEquals(isSitePhpRuntimeOf(`${key}-fcgi84`, key), true);
  assertEquals(isSitePhpRuntimeOf(`${key}-fpm83`, key), true);
  // OpenLiteSpeed's detached lsphp.
  assertEquals(isSitePhpRuntimeOf(`${key}-lsd84`, key), true);
  for (
    const id of [`${longer}-fcgi84`, `${key}-fcgi`, `${key}-lsphp84`, key]
  ) {
    assertEquals(isSitePhpRuntimeOf(id, key), false, id);
  }
});

test("php.ini locks the limits for every script under the owner home", () => {
  const ini = sitePhpIni(
    [{ key: "memory_limit", value: "256M" }, {
      key: "max_execution_time",
      value: "90",
    }],
    SPEC.home,
  );
  const [, locked] = ini.split(`[PATH=${SPEC.home}]\n`);
  assertEquals(typeof locked, "string");
  assertStringIncludes(locked, "memory_limit = 256M\n");
  assertStringIncludes(locked, "max_execution_time = 90\n");
  assertStringIncludes(locked, "upload_max_filesize = 32M\n");
  for (const line of locked.trim().split("\n")) {
    assertEquals(
      SITE_PHP_LOCKED_INI_KEYS.includes(line.split(" = ")[0]),
      true,
      line,
    );
  }
  for (const root of ["/", "relative", "/srv/users/../etc", "/srv/a b"]) {
    assertThrows(() => sitePhpIni([], root), Error, "cannot lock");
  }
});

test("the unit closes loopback and link-local but for the database and resolver hosts", () => {
  const unit = sitePhpServiceUnit(SPEC, { writablePaths: [] });
  assertStringIncludes(
    unit,
    "\nIPAddressDeny=localhost link-local multicast 0.0.0.0/8 fc00::/7\n",
  );
  // Only the resolver stub: 127.0.0.1 would reopen every loopback service.
  assertStringIncludes(unit, "\nIPAddressAllow=127.0.0.53\n");
});

test("vhost references are read from the socket path, nothing else", () => {
  assertEquals(
    sitePhpRuntimeIdsIn(
      [
        "fastcgi_pass unix:/run/turbopanel-php-a-0a1b-fcgi84/php.sock;",
        'SetHandler "proxy:unix:/run/turbopanel-php-b-fpm83/php.sock|fcgi://localhost/"',
        "# /run/turbopanel-php-c-fpm83/lsphp.sock",
      ].join("\n"),
    ),
    ["a-0a1b-fcgi84", "b-fpm83"],
  );
});

function orphanIo(opts: {
  units: string[];
  vhosts: Record<string, string>;
  unreadable?: string;
}): SitePhpRuntimeIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    unitDir: "/units",
    run: (_command, args) => {
      const argv = args.slice(1);
      calls.push(argv.join(" "));
      const path = argv.at(-1) ?? "";
      const answer = (success: boolean, stdout = "", stderr = "") =>
        Promise.resolve({ success, stdout, stderr });
      if (argv[0] === "ls" && path === "/units") {
        return answer(true, opts.units.join("\n"));
      }
      if (argv[0] === "ls") {
        // tp-host's ls refuses a file the way it refuses a missing directory.
        if (path in opts.vhosts) {
          return answer(false, "", `tp-host: no such directory ${path}`);
        }
        const names = new Set(
          Object.keys(opts.vhosts)
            .filter((p) => p.startsWith(`${path}/`))
            .map((p) => p.slice(path.length + 1).split("/")[0]),
        );
        return answer(true, [...names].join("\n"));
      }
      if (argv[0] === "cat") {
        if (path === opts.unreadable) return answer(false, "", "denied");
        if (!(path in opts.vhosts)) {
          return answer(false, "", `tp-host: no such file ${path}`);
        }
        return answer(true, opts.vhosts[path]);
      }
      return answer(argv[1] !== "is-active");
    },
  };
}

const socketLine = (id: string) =>
  `fastcgi_pass unix:/run/turbopanel-php-${id}/php.sock;`;

test("boot reconcile removes a runtime no vhost names and never starts it", async () => {
  const io = orphanIo({
    units: [
      "turbopanel-php-live-fpm84.service",
      "turbopanel-php-gone-fcgi84.service",
      "turbopanel-php-gone-fcgi84.socket",
      // OpenLiteSpeed's: not this module's to remove or start.
      "turbopanel-php-ols-lsphp84.service",
      "turbopanel-php-ols-lsphp84.socket",
    ],
    vhosts: {
      "/etc/tp/nginx/sites/tp-e-live.conf": socketLine("live-fpm84"),
      // A staged candidate counts: a rollout may swap it in.
      "/etc/tp/apache/sites/tp-e-x.conf.tpnew": "",
    },
  });
  const { started, removed } = await reconcileSitePhpRuntimes(io, "/etc/tp");
  assertEquals(removed, ["gone-fcgi84"]);
  assertEquals(started, ["turbopanel-php-live-fpm84.service"]);
  assertEquals(
    io.calls.filter((c) => c.startsWith("systemctl start")),
    ["systemctl start turbopanel-php-live-fpm84.service"],
  );
  assertEquals(
    io.calls.includes(
      "systemctl stop turbopanel-php-gone-fcgi84.socket turbopanel-php-gone-fcgi84.service",
    ),
    true,
  );
  assertEquals(
    io.calls.includes("rm -rf -- /etc/tp/php/sites/gone-fcgi84"),
    true,
  );
  assertEquals(io.calls.some((c) => c.includes("ols-lsphp84")), false);
});

test("boot reconcile does nothing when a vhost cannot be read", async () => {
  const io = orphanIo({
    units: ["turbopanel-php-gone-fpm84.service"],
    vhosts: { "/etc/tp/nginx/sites/tp-e-a.conf": "" },
    unreadable: "/etc/tp/nginx/sites/tp-e-a.conf",
  });
  assertEquals(await reconcileSitePhpRuntimes(io, "/etc/tp"), {
    started: [],
    removed: [],
  });
  assertEquals(
    io.calls.some((c) => c.startsWith("systemctl") || c.startsWith("rm")),
    false,
  );
});

test("boot reconcile keeps what an OpenLiteSpeed vhconf names and sweeps lsd orphans", async () => {
  const ols = "/etc/tp/openlitespeed/vhosts";
  const uds = (id: string) =>
    `  address                 uds:///run/turbopanel-php-${id}/php.sock`;
  const io = orphanIo({
    units: [
      "turbopanel-php-a-lsd84.service",
      "turbopanel-php-a-lsd84.socket",
      // FastCGI that only an OpenLiteSpeed vhost names: not an orphan.
      "turbopanel-php-b-fcgi84.service",
      "turbopanel-php-b-fcgi84.socket",
      "turbopanel-php-gone-lsd84.service",
      "turbopanel-php-gone-lsd84.socket",
    ],
    vhosts: {
      [`${ols}/tp_e_a/vhconf.conf`]: uds("a-lsd84"),
      // A staged copy counts too.
      [`${ols}/tp_e_b/vhconf.conf.tpnew`]: uds("b-fcgi84"),
    },
  });
  const { started, removed } = await reconcileSitePhpRuntimes(io, "/etc/tp");
  assertEquals(removed, ["gone-lsd84"]);
  assertEquals(started.sort(), [
    "turbopanel-php-a-lsd84.socket",
    "turbopanel-php-b-fcgi84.socket",
  ]);
});

test("boot reconcile does nothing when an OpenLiteSpeed vhconf cannot be read", async () => {
  const vhconf = "/etc/tp/openlitespeed/vhosts/tp_e_a/vhconf.conf";
  const io = orphanIo({
    units: ["turbopanel-php-gone-lsd84.service"],
    vhosts: { [vhconf]: "" },
    unreadable: vhconf,
  });
  assertEquals(await reconcileSitePhpRuntimes(io, "/etc/tp"), {
    started: [],
    removed: [],
  });
});

test("a runtime an apply still holds is never an orphan", async () => {
  const io = orphanIo({
    units: ["turbopanel-php-new-fpm84.service"],
    vhosts: {},
  });
  const listing = new Map([["new-fpm84", { service: true, socket: false }]]);
  const release = holdSitePhpRuntime("new-fpm84");
  assertEquals(await orphanSitePhpRuntimes(io, "/etc/tp", listing), []);
  release();
  release();
  assertEquals(await orphanSitePhpRuntimes(io, "/etc/tp", listing), [
    "new-fpm84",
  ]);
});

Deno.test("phpIniBytes reads shorthand and treats -1 as unlimited", () => {
  assertEquals(phpIniBytes("64M"), 64 * 1024 ** 2);
  assertEquals(phpIniBytes("1G"), 1024 ** 3);
  assertEquals(phpIniBytes("-1"), null);
});

Deno.test("sitePhpUnitLimits derives MemoryMax from memory_limit and workers", () => {
  const limits = sitePhpUnitLimits([{ key: "memory_limit", value: "64M" }], 4);
  assertEquals(limits.memoryMaxBytes, 4 * 64 * 1024 ** 2 + 256 * 1024 ** 2);
  assertEquals(limits.tasksMax, 128);
  // Baseline 128M when the site sets nothing.
  assertEquals(
    sitePhpUnitLimits([], 1).memoryMaxBytes,
    (128 + 256) * 1024 ** 2,
  );
  assertEquals(
    sitePhpUnitLimits([{ key: "memory_limit", value: "-1" }], 4)
      .memoryMaxBytes,
    null,
  );
});

Deno.test("the service unit carries MemoryMax and TasksMax when limits are given", () => {
  const unit = sitePhpServiceUnit(SPEC, {
    writablePaths: [],
    limits: { memoryMaxBytes: 536870912, tasksMax: 128 },
  });
  assertStringIncludes(unit, "MemoryMax=536870912");
  assertStringIncludes(unit, "TasksMax=128");
});

Deno.test("php-fpm pool locks memory_limit as php_admin_value", () => {
  const admin = sitePhpLockedValues([{ key: "memory_limit", value: "64M" }]);
  const conf = sitePhpFpmConf({ ...SPEC, mode: "fpm" }, { pool: [], admin });
  assertStringIncludes(conf, "php_admin_value[memory_limit] = 64M");
});
