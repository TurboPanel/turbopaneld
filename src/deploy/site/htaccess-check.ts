/**
 * A deploy-time read of a site's document-root `.htaccess` against what the
 * shared Apache allows (`apache-overrides.ts`). Pure: it takes the text and
 * returns one finding per refused or unknown directive, with the line number.
 * A refused line makes Apache answer 500 for that folder, so the deploy says
 * so in its warnings; it never fails the deploy.
 */
import {
  APACHE_HTACCESS_MODULES,
  APACHE_OVERRIDE_LIST,
  APACHE_REFUSED_DIRECTIVES,
} from "./apache-overrides.ts";

export type HtaccessFinding = {
  line: number;
  directive: string;
  reason: "not allowed" | "unknown";
};

/** Modules that are always loaded (the base set in `httpd.conf.j2`). */
const BASE_MODULES: readonly string[] = [
  "mpm_event",
  "authz_core",
  "authz_host",
  "dir",
  "mime",
  "env",
  "unixd",
  "alias",
  "rewrite",
  "headers",
  "setenvif",
  "log_config",
  "proxy",
  "proxy_fcgi",
  "remoteip",
];

const LOADED_MODULES = new Set<string>([
  ...BASE_MODULES,
  ...APACHE_HTACCESS_MODULES,
]);

const CONTAINERS = new Set<string>([
  "files",
  "filesmatch",
  "if",
  "elseif",
  "else",
  "limit",
  "limitexcept",
  "requireall",
  "requireany",
  "requirenone",
  "ifdefine",
  "iffile",
  "ifdirective",
  "ifsection",
]);

/** Directives the override classes allow (AuthConfig, Limit, Indexes). */
const CLASS_DIRECTIVES: readonly string[] = [
  "AuthType",
  "AuthName",
  "AuthUserFile",
  "AuthGroupFile",
  "AuthBasicProvider",
  "AuthBasicAuthoritative",
  "Require",
  "CGIPassAuth",
  "Order",
  "Allow",
  "Deny",
  "Satisfy",
  "DirectoryIndex",
  "DirectorySlash",
  "FallbackResource",
  "DefaultIcon",
  "AddDescription",
  "HeaderName",
  "ReadmeName",
];

/** Directive families allowed by prefix (Expires*, Index*, AddIcon*, AddAlt*). */
const CLASS_PREFIXES: readonly string[] = [
  "expires",
  "index",
  "addicon",
  "addalt",
];

const ALLOWED = new Set<string>(
  [...APACHE_OVERRIDE_LIST, ...CLASS_DIRECTIVES].map((name) =>
    name.toLowerCase()
  ),
);
const REFUSED = new Set<string>(
  APACHE_REFUSED_DIRECTIVES.map((name) => name.toLowerCase()),
);

/** Options this server does not allow in a `.htaccess`. */
const REFUSED_OPTIONS = new Set<string>(["followsymlinks", "all"]);

function moduleName(raw: string): string {
  const name = raw.replace(/^!/, "").toLowerCase();
  return name.replace(/^mod_/, "").replace(/\.c$/, "").replace(/_module$/, "");
}

function directiveAllowed(lower: string): boolean {
  return ALLOWED.has(lower) ||
    CLASS_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function optionsRefused(args: string): boolean {
  return args.split(/\s+/).some((word) =>
    REFUSED_OPTIONS.has(word.replace(/^[+-]/, "").toLowerCase())
  );
}

/** Join `\` continuation lines; each entry keeps its first line's number. */
function logicalLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const physical = text.split(/\r?\n/);
  for (let i = 0; i < physical.length; i++) {
    const start = i + 1;
    let joined = physical[i];
    while (joined.endsWith("\\") && i + 1 < physical.length) {
      i++;
      joined = joined.slice(0, -1) + " " + physical[i].trim();
    }
    out.push({ line: start, text: joined.trim() });
  }
  return out;
}

const IF_MODULE_OPEN = /^<\s*IfModule\s+(\S+?)\s*>$/i;
const IF_MODULE_CLOSE = /^<\s*\/\s*IfModule\s*>$/i;

/** Whether the body of `<IfModule name>` is skipped, as Apache does. */
function ifModuleBodySkipped(name: string): boolean {
  const loaded = LOADED_MODULES.has(moduleName(name));
  // The body runs when (loaded and not negated) or (not loaded and negated).
  return name.startsWith("!") ? loaded : !loaded;
}

/**
 * A name safe to print in a warning: a directive-shaped token of at most 64
 * characters, else a placeholder (a long or odd line must not fill the log).
 */
function printableName(raw: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(raw) ? raw : "(unreadable)";
}

/** The finding for one directive line (or container tag), if any. */
function findingForLine(
  line: number,
  content: string,
): HtaccessFinding | null {
  if (content.startsWith("<")) {
    // A container tag, opening or closing: `<Name ...>` or `</Name>`.
    let tag = content.slice(1).trimStart();
    if (tag.startsWith("/")) tag = tag.slice(1).trimStart();
    const name = /^[A-Za-z]+/.exec(tag)?.[0] ?? "";
    if (CONTAINERS.has(name.toLowerCase())) return null;
    return {
      line,
      directive: printableName(name),
      reason: REFUSED.has(name.toLowerCase()) ? "not allowed" : "unknown",
    };
  }
  const space = content.search(/\s/);
  const word = space < 0 ? content : content.slice(0, space);
  const args = space < 0 ? "" : content.slice(space).trim();
  const lower = word.toLowerCase();
  const directive = printableName(word);
  if (REFUSED.has(lower)) return { line, directive, reason: "not allowed" };
  if (lower === "options") {
    return optionsRefused(args)
      ? { line, directive: "Options", reason: "not allowed" }
      : null;
  }
  return directiveAllowed(lower)
    ? null
    : { line, directive, reason: "unknown" };
}

/** Findings for one `.htaccess` text, in line order. */
export function checkHtaccess(text: string): HtaccessFinding[] {
  const findings: HtaccessFinding[] = [];
  // One entry per open <IfModule>: true when its contents are skipped.
  const stack: boolean[] = [];
  for (const { line, text: content } of logicalLines(text)) {
    if (content === "" || content.startsWith("#")) continue;
    const open = IF_MODULE_OPEN.exec(content);
    if (open) {
      stack.push(ifModuleBodySkipped(open[1]));
    } else if (IF_MODULE_CLOSE.test(content)) {
      stack.pop();
    } else if (!stack.includes(true)) {
      const finding = findingForLine(line, content);
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

const MAX_WARNINGS = 10;

/** The deploy warnings for a site's findings (capped, never fails a deploy). */
export function htaccessWarnings(
  service: string,
  findings: readonly HtaccessFinding[],
): string[] {
  const shown = findings.slice(0, MAX_WARNINGS).map((finding) => {
    const what = finding.reason === "not allowed"
      ? `${finding.directive} is not allowed on this server`
      : `${finding.directive} is not a directive this server knows`;
    return `Site ${service}: .htaccess line ${finding.line}: ${what}, so Apache answers 500 for that folder.`;
  });
  if (findings.length > MAX_WARNINGS) {
    shown.push(
      `Site ${service}: .htaccess: and ${findings.length - MAX_WARNINGS} more.`,
    );
  }
  return shown;
}
