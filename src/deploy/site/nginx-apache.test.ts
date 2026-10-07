import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  apacheSiteConfig,
  nginxSiteConfig,
  resolveSiteEngineNeeds,
  resolveSiteOwnership,
  type SiteApplySpec,
  siteEngineUnixUser,
} from "../site.ts";
import {
  NGINX_APACHE_STATIC_EXTENSIONS,
  siteFrontEngine,
  siteServingEngines,
} from "./nginx-apache.ts";
import { sitePhpRuntimeMode } from "./php-runtime.ts";

/** Sonar S2187 recognizes `test()`; see site-apply.test.ts. */
const test = Deno.test.bind(Deno);

const DOC_ROOT = "/srv/users/alice/sites/svc-1/current/public";
const SOCKET = "/run/turbopanel-php-x/php.sock";

const pairedSite: SiteApplySpec = {
  composeServiceName: "wp",
  engine: "nginx+apache",
  root: "public",
  listenPort: 18080,
  backendPort: 18090,
  principal: { principalId: "pr-1", username: "alice" },
  php: { version: "8.4", mode: "fastcgi" },
};

function frontConfig(dockerBind: string | null = null): string {
  return nginxSiteConfig(pairedSite, DOC_ROOT, dockerBind, {
    releaseBacked: true,
    apacheBackendPort: 18090,
  });
}

const DOTFILE_LOCATION = String.raw`location ~ /\.(?!well-known(?:/|$)) {`;

test("nginx in front of Apache refuses dotfiles before it serves static files", () => {
  const conf = frontConfig();
  const dotfiles = conf.indexOf(DOTFILE_LOCATION);
  const statics = conf.indexOf(String.raw`location ~* \.(?:`);
  assert(dotfiles > 0, conf);
  assert(statics > dotfiles, "regex locations match in order");
  assertStringIncludes(
    conf,
    `${DOTFILE_LOCATION}
    return 403;
  }`,
  );
});

test("the dotfile refusal spares /.well-known/ but not dotfiles under it", () => {
  // The pattern both engines use, as nginx and Apache (PCRE) read it.
  const re = /\/\.(?!well-known(?:\/|$))/;
  for (
    const path of ["/.env", "/.git/config", "/a/.htaccess", "/.well-known/.env"]
  ) {
    assert(re.test(path), path);
  }
  for (const path of ["/.well-known/security.txt", "/.well-known", "/a.b/c"]) {
    assertEquals(re.test(path), false, path);
  }
});

test("nginx sends Apache one client address, from nginx's own source address", () => {
  const conf = frontConfig();
  // Only loopback (the site-edge Caddy) may name the client; a docker bridge
  // peer is itself.
  assertStringIncludes(
    conf,
    `  set_real_ip_from 127.0.0.1;
  set_real_ip_from ::1;
  real_ip_header X-Forwarded-For;
  proxy_bind 127.0.0.2;
  proxy_set_header X-Forwarded-For $remote_addr;`,
  );
  // Appending would hand Apache "<client>, 127.0.0.1", and Apache trusts
  // 127.0.0.2 only.
  assertEquals(conf.includes("$proxy_add_x_forwarded_for"), false);
  assertEquals(conf.includes("$http_x_forwarded_for"), false);
});

test("nginx in front of Apache serves only common static types and proxies the rest", () => {
  const conf = frontConfig();
  assertStringIncludes(conf, "listen 127.0.0.1:18080;");
  assertStringIncludes(conf, "listen [::1]:18080;");
  assertStringIncludes(conf, `root ${DOC_ROOT};`);
  assertStringIncludes(conf, "disable_symlinks on from=$document_root;");
  // A static path missing on disk still reaches Apache.
  assertStringIncludes(conf, "try_files $uri @apache;");
  assertStringIncludes(
    conf,
    `location / {
    proxy_pass http://127.0.0.1:18090;
  }`,
  );
  assertStringIncludes(
    conf,
    `location @apache {
    proxy_pass http://127.0.0.1:18090;
  }`,
  );
  assertStringIncludes(conf, "proxy_set_header Host $host;");
  // PHP is Apache's: nginx neither runs nor indexes it.
  assertEquals(conf.includes("fastcgi"), false);
  assertEquals(conf.includes("index.php"), false);
  assertEquals(conf.includes("18090;\n  listen"), false);
});

test("nginx in front of Apache keeps the docker bridge listener on its own port", () => {
  const conf = frontConfig("172.17.0.1");
  assertStringIncludes(conf, "listen 172.17.0.1:18080;");
  assertEquals(conf.includes("172.17.0.1:18090"), false);
});

test("the static list is images, CSS, JS, fonts and media only", () => {
  for (
    const ext of ["png", "jpg", "webp", "svg", "css", "js", "woff2", "mp4"]
  ) {
    assert(NGINX_APACHE_STATIC_EXTENSIONS.includes(ext), ext);
  }
  // Anything an .htaccess rule might guard, or PHP might render, goes to Apache.
  for (const ext of ["php", "phtml", "html", "htm", "txt", "json", "xml"]) {
    assertEquals(NGINX_APACHE_STATIC_EXTENSIONS.includes(ext), false, ext);
  }
  for (const ext of NGINX_APACHE_STATIC_EXTENSIONS) {
    assert(/^[a-z0-9]+$/.test(ext), ext);
  }
});

test("Apache behind nginx listens on the backend port only and trusts nginx's 127.0.0.2", () => {
  const conf = apacheSiteConfig(pairedSite, DOC_ROOT, {
    phpFpmSocket: SOCKET,
    dockerBindAddress: "172.17.0.1",
    behindNginxPort: 18090,
  });
  assertStringIncludes(conf, "# TurboPanel site wp (behind nginx)");
  assertStringIncludes(conf, "Listen 127.0.0.1:18090\n");
  assertStringIncludes(conf, "<VirtualHost 127.0.0.1:18090>");
  assertEquals(conf.includes("18080"), false, "nginx owns listenPort");
  assertEquals(conf.includes("172.17.0.1"), false, "nginx owns the bridge");
  assertStringIncludes(conf, "  RemoteIPHeader X-Forwarded-For\n");
  // nginx connects from 127.0.0.2 (proxy_bind); any other local caller
  // reaches 127.0.0.1:<backendPort> as itself.
  assertEquals(conf.match(/RemoteIP\w*Proxy.*/g), [
    "RemoteIPInternalProxy 127.0.0.2",
  ]);
  // Dotfiles are refused to a caller that skips nginx; .htaccess cannot
  // grant a <LocationMatch> back.
  assertStringIncludes(
    conf,
    String.raw`  <LocationMatch "/\.(?!well-known(?:/|$))">
    Require all denied
  </LocationMatch>`,
  );
  // .htaccess applies, and PHP runs in the site's mode as on plain Apache.
  assertStringIncludes(conf, "AllowOverride AuthConfig FileInfo");
  assertStringIncludes(conf, "ProxyFCGIBackendType GENERIC");
  assertStringIncludes(
    conf,
    `SetHandler "proxy:unix:${SOCKET}|fcgi://localhost/"`,
  );
});

test("plain Apache keeps its own listener and no mod_remoteip lines", () => {
  const conf = apacheSiteConfig(
    { ...pairedSite, engine: "apache", backendPort: undefined },
    DOC_ROOT,
    { phpFpmSocket: SOCKET, dockerBindAddress: "172.17.0.1" },
  );
  assertStringIncludes(conf, "Listen 127.0.0.1:18080\nListen 172.17.0.1:18080");
  assertEquals(conf.includes("RemoteIP"), false);
  // Dotfiles are refused on plain Apache too, but no client-address trust.
  assertStringIncludes(conf, "<LocationMatch");
});

test("a paired site is served by Apache then nginx, with nginx in front", () => {
  assertEquals(siteServingEngines(pairedSite), ["apache", "nginx"]);
  assertEquals(siteFrontEngine(pairedSite), "nginx");
  assertEquals(siteServingEngines({ engine: "apache" }), ["apache"]);
  assertEquals(siteFrontEngine({ engine: "caddy" }), "caddy");
});

test("a paired site needs both engines and reaches PHP through Apache", () => {
  const needs = resolveSiteEngineNeeds([pairedSite]);
  assertEquals(needs.nginx, true);
  assertEquals(needs.apache, true);
  assertEquals(needs.caddy, false);
  assertEquals([...needs.phpFpmEngines], ["apache"]);
});

test("a paired site's tree carries the principal group both engines join", () => {
  assertEquals(resolveSiteOwnership(pairedSite), {
    user: "alice",
    group: "alice",
  });
  assertEquals(siteEngineUnixUser(pairedSite.engine), "tpapache");
  assertEquals(sitePhpRuntimeMode(pairedSite), "fastcgi");
});
