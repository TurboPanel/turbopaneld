/**
 * Allowlist validators for tenant-influenced values that reach a config file a
 * root-run or root-loaded engine parses (the hosting Caddyfile, Apache vhosts,
 * php-fpm pools, OpenLiteSpeed vhconf, Traefik labels).
 *
 * Doctrine: **refuse, never sanitize.** Each helper either returns the value
 * unchanged (typed with a brand, so a renderer field can demand it) or throws a
 * {@link ConfigValueError} naming the field. A renderer that gets a value it
 * cannot represent fails the apply with that message; it never escapes its way
 * around the problem, because every engine's quoting has a different hole.
 *
 * The control plane runs the same rules at its API boundary
 * (`../turbopanel/src/features/hostings/config-values.ts`); this copy is the
 * defence in depth, and the one that holds for a control plane that predates it.
 * The table of every sink lives in `src/deploy/AGENTS.md` ("Tenant values in
 * root-loaded configs").
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** An absolute URL path prefix: `/` plus clean segments (see {@link safeUrlPath}). */
export type SafeUrlPath = Brand<string, "SafeUrlPath">;
/** A process environment variable name (see {@link safeEnvName}). */
export type SafeEnvName = Brand<string, "SafeEnvName">;
/** A single-line environment variable value (see {@link safeEnvValue}). */
export type SafeEnvValue = Brand<string, "SafeEnvValue">;

/** A tenant value a renderer refused. The message names the field, never the value. */
export class ConfigValueError extends Error {
  constructor(readonly field: string, reason: string) {
    super(`${field} ${reason}`);
    this.name = "ConfigValueError";
  }
}

/** Longest URL path prefix accepted (matches the compose extension's cap). */
export const MAX_URL_PATH_LENGTH = 200;
/** Longest environment variable name accepted. */
export const MAX_ENV_NAME_LENGTH = 128;
/** Longest environment variable value accepted (matches the control plane). */
export const MAX_ENV_VALUE_LENGTH = 4096;

const URL_PATH_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
const ENV_NAME_RE = /^[A-Za-z_]\w*$/;

/**
 * True when `value` holds a C0 control (including TAB, LF, CR and NUL), DEL, a
 * C1 control (including U+0085 NEL) or a Unicode line/paragraph separator
 * (U+2028/U+2029). Any of them can end a line for some parser on the path.
 */
export function hasLineBreakOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * An absolute URL path prefix: `/` alone, or `/` followed by segments of
 * `[A-Za-z0-9._~-]` joined by single `/`, with at most one trailing `/`. No
 * `.` or `..` segment, no `//`, nothing that a Caddyfile, a Traefik rule or a
 * label list reads as syntax (space, braces, quotes, backtick, comma, `#`, `$`).
 */
export function safeUrlPath(field: string, value: string): SafeUrlPath {
  if (value.length === 0 || value.length > MAX_URL_PATH_LENGTH) {
    throw new ConfigValueError(
      field,
      `must be 1-${MAX_URL_PATH_LENGTH} characters`,
    );
  }
  if (!value.startsWith("/")) {
    throw new ConfigValueError(field, "must start with /");
  }
  if (value === "/") return value as SafeUrlPath;
  const body = value.endsWith("/") ? value.slice(1, -1) : value.slice(1);
  for (const segment of body.split("/")) {
    if (!URL_PATH_SEGMENT_RE.test(segment)) {
      throw new ConfigValueError(
        field,
        "must be / followed by segments of letters, digits, '.', '_', '~' or '-'",
      );
    }
    if (segment === "." || segment === "..") {
      throw new ConfigValueError(field, "must not contain . or .. segments");
    }
  }
  return value as SafeUrlPath;
}

/** `[A-Za-z_][A-Za-z0-9_]*`, at most {@link MAX_ENV_NAME_LENGTH} characters. */
export function safeEnvName(field: string, value: string): SafeEnvName {
  if (value.length > MAX_ENV_NAME_LENGTH || !ENV_NAME_RE.test(value)) {
    throw new ConfigValueError(
      field,
      "must be a letter or '_' followed by letters, digits or '_'",
    );
  }
  return value as SafeEnvName;
}

/** A PHP ini value safe in a php-fpm pool and an OpenLiteSpeed `phpIniOverride{}`. */
export type SafePhpIniValue = Brand<string, "SafePhpIniValue">;
/** One line of text for a systemd directive (see {@link safeConfigLine}). */
export type SafeConfigLine = Brand<string, "SafeConfigLine">;

/**
 * Characters a PHP setting value may use: what the control plane's typed PHP
 * settings produce (sizes, integers, `On`/`Off`, timezones, function lists,
 * `E_ALL & ~E_DEPRECATED`) and nothing an ini or vhconf parser reads as syntax:
 * no quotes, `;`, `=`, `$` (ini `${VAR}` expansion), braces (the OpenLiteSpeed
 * block), `<` (its heredoc), or line breaks.
 */
const PHP_INI_VALUE_RE = /^[A-Za-z0-9 _.,:/+~&|^!()-]+$/;

/** Longest PHP setting value accepted. */
export const MAX_PHP_INI_VALUE_LENGTH = 512;

/** A PHP setting value from the {@link PHP_INI_VALUE_RE} alphabet. */
export function safePhpIniValue(field: string, value: string): SafePhpIniValue {
  if (
    value.length > MAX_PHP_INI_VALUE_LENGTH || !PHP_INI_VALUE_RE.test(value)
  ) {
    throw new ConfigValueError(
      field,
      "must use only letters, digits, spaces and _.,:/+~&|^!()-",
    );
  }
  return value as SafePhpIniValue;
}

/**
 * A value written on one systemd directive line: no control character or
 * line/paragraph separator, so it cannot end the line and add a directive.
 */
export function safeConfigLine(field: string, value: string): SafeConfigLine {
  if (hasLineBreakOrControl(value)) {
    throw new ConfigValueError(
      field,
      "must not contain line breaks or control characters",
    );
  }
  return value as SafeConfigLine;
}

/**
 * One line of text: no control character or line/paragraph separator, at most
 * {@link MAX_ENV_VALUE_LENGTH} characters. Engine quoting is the renderer's job;
 * this only guarantees the value cannot end the line it is written on.
 */
export function safeEnvValue(field: string, value: string): SafeEnvValue {
  if (value.length > MAX_ENV_VALUE_LENGTH) {
    throw new ConfigValueError(
      field,
      `must be at most ${MAX_ENV_VALUE_LENGTH} characters`,
    );
  }
  if (hasLineBreakOrControl(value)) {
    throw new ConfigValueError(
      field,
      "must not contain line breaks or control characters",
    );
  }
  return value as SafeEnvValue;
}

/** An identifier written bare into a config line or used as one path segment. */
export type SafeConfigToken = Brand<string, "SafeConfigToken">;

const CONFIG_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Longest identifier token accepted. */
export const MAX_CONFIG_TOKEN_LENGTH = 128;

/**
 * An identifier (a compose service name, a TLS id): a letter or digit, then
 * letters, digits, `_`, `.` or `-`. No `/`, so it is always one path segment,
 * and nothing a config parser reads as syntax.
 */
export function safeConfigToken(field: string, value: string): SafeConfigToken {
  if (value.length > MAX_CONFIG_TOKEN_LENGTH || !CONFIG_TOKEN_RE.test(value)) {
    throw new ConfigValueError(
      field,
      "must be a letter or digit followed by letters, digits, '_', '.' or '-'",
    );
  }
  return value as SafeConfigToken;
}
