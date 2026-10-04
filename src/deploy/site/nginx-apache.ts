/**
 * nginx in front of Apache (`engine: "nginx+apache"`).
 *
 * The classic shared-hosting layout: nginx answers on the site's `listenPort`
 * and serves common static file types itself; everything else goes to Apache
 * on `backendPort`, a second loopback port only nginx connects to, so
 * `.htaccess` rewrites and deny rules apply to every request that is not a
 * plain static file. Apache hands PHP to the site's own runtime exactly as a
 * plain Apache site does.
 *
 * - nginx refuses dotfiles itself (`.htaccess`, `.env`, `.git/`; not
 *   `/.well-known/`): they never reach Apache through nginx, are never served
 *   as static files, and Apache's backend vhost refuses them too, for a
 *   loopback caller that skips nginx.
 * - nginx connects to Apache from its own loopback source address,
 *   `127.0.0.2` (`proxy_bind`), and Apache trusts `X-Forwarded-For` from that
 *   address only (mod_remoteip). Apache still listens on `127.0.0.1` (Linux
 *   routes all of 127/8 to `lo`), so a caller that connects from its own
 *   address is not trusted. This is not a security boundary: a local user can
 *   bind `127.0.0.2` too and claim any client address, so `.htaccess` IP
 *   rules must not be relied on for security.
 * - nginx sends Apache exactly one address: the visitor, taken (realip) from
 *   the site-edge Caddy's `X-Forwarded-For` when the connection is from
 *   loopback, the peer itself otherwise (docker bridge). The hosting Caddy
 *   (>= 2.5, no `trusted_proxies`) replaces any inbound `X-Forwarded-For`
 *   with the visitor's address, so a visitor cannot prefix it. A local
 *   process that calls nginx directly can still claim any address: nginx
 *   cannot tell it from Caddy (both are loopback).
 * - Files nginx serves itself skip `.htaccess`. That is why the static list is
 *   short: images, CSS, JS, fonts and media, nothing a protective rule usually
 *   guards.
 *
 * A site of this kind is served by two engines, rolled out Apache first: the
 * nginx probe on `listenPort` goes through to Apache, so Apache has to be
 * serving the new vhost before nginx is reloaded.
 */

import type { SiteEngineId, SiteValidationTarget } from "./engine-driver.ts";

/** The `engine` value of a site served by nginx in front of Apache. */
export const NGINX_APACHE_ENGINE = "nginx+apache";

/**
 * Extensions nginx serves from disk (decided: images, CSS, JS, fonts, media).
 * Anything else, `.html`, `.txt` and `.json` included, goes to Apache.
 */
export const NGINX_APACHE_STATIC_EXTENSIONS: readonly string[] = Object.freeze([
  // Images
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "svgz",
  "tif",
  "tiff",
  "webp",
  // Stylesheets and scripts
  "css",
  "js",
  "mjs",
  // Fonts
  "eot",
  "otf",
  "ttf",
  "woff",
  "woff2",
  // Media
  "aac",
  "flac",
  "m4a",
  "m4v",
  "mov",
  "mp3",
  "mp4",
  "oga",
  "ogg",
  "ogv",
  "opus",
  "wav",
  "webm",
]);

/** Apache's backend listener address (nginx's upstream, the daemon's probe). */
export const NGINX_APACHE_BACKEND_HOST = "127.0.0.1";

/**
 * nginx's source address toward Apache (`proxy_bind`), and the only address
 * Apache accepts a forwarded client address from. Nothing else on the host
 * binds it by convention; site PHP cannot reach any loopback address but
 * DNS, but a local user's own process could bind it.
 */
export const NGINX_APACHE_TRUSTED_PROXY = "127.0.0.2";

/**
 * Dotfile paths refused by both engines; `/.well-known/` (security.txt, app
 * links) is not one.
 */
export const DOTFILE_PATH_RE = String.raw`/\.(?!well-known(?:/|$))`;

type SiteEngineRef = Readonly<{ engine: string }>;

/** True for a site served by nginx in front of Apache. */
export function isNginxApacheSite(site: SiteEngineRef): boolean {
  return site.engine === NGINX_APACHE_ENGINE;
}

/**
 * Engines that serve this site, in rollout order: Apache before nginx for the
 * paired layout, the site's own engine otherwise.
 */
export function siteServingEngines(
  site: Readonly<{ engine: SiteEngineId | typeof NGINX_APACHE_ENGINE }>,
): SiteEngineId[] {
  if (site.engine === NGINX_APACHE_ENGINE) return ["apache", "nginx"];
  return [site.engine];
}

/** The engine on the site's public `listenPort`. */
export function siteFrontEngine(
  site: Readonly<{ engine: SiteEngineId | typeof NGINX_APACHE_ENGINE }>,
): SiteEngineId {
  return site.engine === NGINX_APACHE_ENGINE ? "nginx" : site.engine;
}

/** Apache's own loopback endpoint behind nginx, probed after its reload. */
export function nginxApacheBackendProbe(
  composeServiceName: string,
  backendPort: number,
): SiteValidationTarget {
  return {
    label: `${composeServiceName} (Apache behind nginx)`,
    url: `http://${NGINX_APACHE_BACKEND_HOST}:${backendPort}/`,
  };
}

/**
 * The body of the nginx `server {}` block in front of Apache.
 *
 * Regex locations match in order, so the dotfile refusal comes before the
 * static one: `/.git/logo.png` is a 403, not a file. A static path that does
 * not exist on disk still goes to Apache (`try_files $uri @apache`), where an
 * application can render its own 404 or generate the file.
 *
 * `set_real_ip_from` loopback: the site-edge Caddy reaches nginx there, so
 * `$remote_addr` becomes the last `X-Forwarded-For` entry Caddy set; a docker
 * bridge peer stays itself. Apache gets that one address, never a list.
 *
 * nginx streams request bodies straight through (`proxy_request_buffering off`,
 * no size cap here): Apache and PHP's own `post_max_size` set the limit, so an
 * upload is not refused at a different size depending on which engine read it.
 */
export function nginxApacheLocations(backendPort: number): string {
  const upstream = `http://${NGINX_APACHE_BACKEND_HOST}:${backendPort}`;
  const extensions = NGINX_APACHE_STATIC_EXTENSIONS.join("|");
  return [
    "",
    "  client_max_body_size 0;",
    "  proxy_http_version 1.1;",
    "  proxy_request_buffering off;",
    "  proxy_set_header Host $host;",
    "  set_real_ip_from 127.0.0.1;",
    "  set_real_ip_from ::1;",
    "  real_ip_header X-Forwarded-For;",
    `  proxy_bind ${NGINX_APACHE_TRUSTED_PROXY};`,
    "  proxy_set_header X-Forwarded-For $remote_addr;",
    "",
    "  # Dotfiles (.htaccess, .env, .git) are refused here and never reach Apache.",
    ...nginxDotfileDenyLines(),
    "",
    "  # Common static types only; everything else goes to Apache, where .htaccess applies.",
    String.raw`  location ~* \.(?:${extensions})$ {`,
    "    try_files $uri @apache;",
    "  }",
    "",
    "  location / {",
    `    proxy_pass ${upstream};`,
    "  }",
    "",
    "  location @apache {",
    `    proxy_pass ${upstream};`,
    "  }",
  ].join("\n");
}

/**
 * mod_remoteip and dotfile lines for Apache's vhost behind nginx: the client
 * address comes from `X-Forwarded-For` only when the connection is from nginx
 * (`127.0.0.2`), and dotfiles are refused to a caller that skips nginx. A
 * `<LocationMatch>` merges after `<Directory>` and `.htaccess`, so neither
 * can grant them back.
 */
export function apacheBehindNginxLines(): string[] {
  return [
    "  RemoteIPHeader X-Forwarded-For",
    `  RemoteIPInternalProxy ${NGINX_APACHE_TRUSTED_PROXY}`,
    ...apacheDotfileDenyLines(),
  ];
}

/**
 * Refuse dotfiles (`.htaccess`, `.env`, `.git/…`) on an Apache vhost. A
 * `<LocationMatch>` merges after `<Directory>` and `.htaccess`, so neither can
 * grant them back.
 */
export function apacheDotfileDenyLines(): string[] {
  return [
    `  <LocationMatch "${DOTFILE_PATH_RE}">`,
    "    Require all denied",
    "  </LocationMatch>",
  ];
}

/** nginx `location` refusing dotfiles; first among the regex locations. */
export function nginxDotfileDenyLines(): string[] {
  return [
    `  location ~ ${DOTFILE_PATH_RE} {`,
    "    return 403;",
    "  }",
  ];
}
