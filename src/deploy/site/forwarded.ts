/**
 * What PHP (and `.htaccess`) learn about the visitor behind the front web
 * server.
 *
 * Every site engine listens on loopback (or the docker bridge) behind the
 * hosting Caddy, which terminates TLS and sets `X-Forwarded-For` (the visitor,
 * never a list it was handed) and `X-Forwarded-Proto`. Without the lines here
 * PHP sees `HTTPS` unset, port 80, scheme `http` and the address `127.0.0.1`
 * for every request, so an app that insists on HTTPS loops forever and every
 * visitor is logged as the local machine.
 *
 * Only the loopback front server is trusted. A request from anywhere else
 * (a docker bridge peer) is read as it arrives: its address stays its own and
 * its `X-Forwarded-*` headers are ignored. A local process can still claim any
 * address by calling the engine on loopback, because it looks like the front
 * server; the same is true of the paired nginx and Apache layout.
 */

/** The front server's own loopback address: the only peer Apache trusts. */
export const FORWARDED_TRUSTED_LOOPBACK = "127.0.0.1";

/**
 * Apache: the client address from `X-Forwarded-For`, plus `HTTPS=on`, port 443
 * and scheme `https` for PHP when the trusted peer says the visitor used
 * HTTPS.
 *
 * `CONN_REMOTE_ADDR` is the connection's own peer (mod_remoteip changes
 * `REMOTE_ADDR`, not this). `SetEnv` alone cannot change `SERVER_PORT` or
 * `REQUEST_SCHEME`, which mod_proxy_fcgi rebuilds from the server, so those
 * two use `ProxyFCGISetEnvIf`, which is applied last.
 */
export function apacheForwardedLines(trustedProxy: string): string[] {
  const condition =
    `%{CONN_REMOTE_ADDR} == '${trustedProxy}' && %{HTTP:X-Forwarded-Proto} == 'https'`;
  return [
    "  RemoteIPHeader X-Forwarded-For",
    `  RemoteIPInternalProxy ${trustedProxy}`,
    `  <If "${condition}">`,
    "    SetEnv HTTPS on",
    "  </If>",
    `  ProxyFCGISetEnvIf "${condition}" SERVER_PORT 443`,
    `  ProxyFCGISetEnvIf "${condition}" REQUEST_SCHEME https`,
  ];
}

/**
 * nginx (server level): the visitor's address from `X-Forwarded-For` when the
 * connection is from loopback, and `$tp_fwd_*` values that are the visitor's
 * scheme only when that same trusted peer said `https`.
 *
 * `if` holds `set` only, the one use of it nginx documents as safe. The two
 * conditions are joined in one string because `if` cannot be nested.
 */
export function nginxForwardedLines(): string[] {
  return [
    "  set_real_ip_from 127.0.0.1;",
    "  set_real_ip_from ::1;",
    "  real_ip_header X-Forwarded-For;",
    '  set $tp_fwd_peer "$realip_remote_addr|$http_x_forwarded_proto";',
    '  set $tp_fwd_https "";',
    "  set $tp_fwd_port $server_port;",
    "  set $tp_fwd_scheme $scheme;",
    String.raw`  if ($tp_fwd_peer ~ "^(127\.0\.0\.1|::1)\|https$") {`,
    "    set $tp_fwd_https on;",
    "    set $tp_fwd_port 443;",
    "    set $tp_fwd_scheme https;",
    "  }",
  ];
}

/**
 * nginx PHP location: the forwarded values replace the ones the shared
 * parameter set sends. `HTTPS` is left out (not empty) for a plain request.
 */
export function nginxForwardedFastcgiLines(): string[] {
  return [
    "fastcgi_param HTTPS $tp_fwd_https if_not_empty;",
    "fastcgi_param SERVER_PORT $tp_fwd_port;",
    "fastcgi_param REQUEST_SCHEME $tp_fwd_scheme;",
  ];
}
