import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  SITE_PHP_ID_RE,
  sitePhpFpmConf,
  sitePhpIni,
  sitePhpKey,
  sitePhpRuntimeId,
  sitePhpRuntimeMode,
  type SitePhpRuntimeSpec,
  sitePhpServiceUnit,
  sitePhpSocketPath,
} from "./php-runtime.ts";
import {
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
  ]);
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
      sitePhpIni([{ key: "error_reporting", value: "E_ALL & ~(E_NOTICE)" }]),
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
  const started = await reconcileSitePhpRuntimes(io);
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
