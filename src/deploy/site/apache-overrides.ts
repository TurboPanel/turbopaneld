/**
 * What a site's `.htaccess` may do on the shared Apache.
 *
 * One list, used by the vhost (`AllowOverride` / `AllowOverrideList`), by the
 * deploy-time `.htaccess` check and by the tests that keep the Apache role's
 * module list in step. A name only works when its module is loaded: Apache
 * silently discards an unknown `AllowOverrideList` name at startup, so never
 * add a directive here without the module that provides it
 * (`orchestration/roles/apache/templates/httpd.conf.j2`).
 *
 * Never `AllowOverride All` or the `FileInfo` class: it brings `AddHandler`,
 * `Action`, `PassEnv`, `ProxyFCGISetEnvIf` and input filters. Never
 * `FollowSymLinks`: it undoes the owner-match link rule the release link
 * checks rely on.
 */

/**
 * Override classes. `ExecCGI`, `Includes` and `IncludesNOEXEC` are named only
 * so files that switch them off (`Options -ExecCGI -Includes`) parse: Apache
 * checks the option name even for `-`. They do nothing while `cgi`, `cgid` and
 * `include` stay unloaded.
 */
export const APACHE_OVERRIDE_CLASSES =
  "AuthConfig Indexes Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch,ExecCGI,Includes,IncludesNOEXEC";

/** Directives a `.htaccess` may name, on top of the classes above. */
export const APACHE_OVERRIDE_LIST: readonly string[] = [
  "RewriteEngine",
  "RewriteCond",
  "RewriteRule",
  "RewriteBase",
  "RewriteOptions",
  "Redirect",
  "RedirectMatch",
  "RedirectPermanent",
  "RedirectTemp",
  "ErrorDocument",
  "Header",
  "RequestHeader",
  "AddType",
  "RemoveType",
  "AddEncoding",
  "RemoveEncoding",
  "AddCharset",
  "RemoveCharset",
  "AddDefaultCharset",
  "AddLanguage",
  "RemoveLanguage",
  "DefaultLanguage",
  "MultiviewsMatch",
  "ForceType",
  "SetHandler",
  "RemoveHandler",
  "AddOutputFilter",
  "RemoveOutputFilter",
  "AddOutputFilterByType",
  "SetOutputFilter",
  "SetEnv",
  "UnsetEnv",
  "SetEnvIf",
  "SetEnvIfNoCase",
  "SetEnvIfExpr",
  "BrowserMatch",
  "BrowserMatchNoCase",
  "FileETag",
  "AcceptPathInfo",
  "QualifyRedirectURL",
];

/** Directives the vhost refuses on purpose (the deploy check names them). */
export const APACHE_REFUSED_DIRECTIVES: readonly string[] = [
  "AddHandler",
  "Action",
  "PassEnv",
  "ProxyFCGISetEnvIf",
  "ProxyFCGIBackendType",
  "SetInputFilter",
  "AddInputFilter",
  "RemoveInputFilter",
  "CGIMapExtension",
  "CGIVar",
  "ScriptInterpreterSource",
  "php_value",
  "php_flag",
  "php_admin_value",
  "php_admin_flag",
];

/**
 * Module file names `httpd.conf.j2` loads for ordinary `.htaccess` files
 * (Basic auth, old-style access rules, expiry headers, output compression,
 * opt-in directory listing). A test compares this with the template.
 */
export const APACHE_HTACCESS_MODULES: readonly string[] = [
  "authn_core",
  "authn_file",
  "auth_basic",
  "authz_user",
  "authz_groupfile",
  "access_compat",
  "expires",
  "filter",
  "deflate",
  "autoindex",
];

/** The `AllowOverrideList` value for a vhost's `<Directory>` block. */
export function apacheOverrideListLine(): string {
  return APACHE_OVERRIDE_LIST.join(" ");
}
