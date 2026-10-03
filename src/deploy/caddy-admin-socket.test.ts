/**
 * Audit P0-1: no Caddy this repo configures may serve its admin API on a TCP
 * listener. Loopback TCP is reachable by every local tenant process (PHP, a
 * native app, cron, an SSH shell), and the admin API loads arbitrary config as
 * the Caddy account, which reads every uploaded TLS key (hosting Caddy) or
 * every Caddy-served principal's tree (site Caddy). A global block with no
 * `admin` line is refused too: Caddy then listens on `localhost:2019`.
 */
import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { caddyfile, caddyUnit } from "./ingress.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const SCANNED_ROOTS = ["orchestration", "src", "scripts"];
const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", ".cache"]);

/** A whole Caddy config (has a global options block), not a site snippet. */
function isCaddyfileName(name: string): boolean {
  return /^Caddyfile(\.[A-Za-z0-9]+)*$/.test(name);
}

function isCaddySnippetName(name: string): boolean {
  return /\.caddy(\.j2)?$/.test(name);
}

function isJsonName(name: string): boolean {
  return /\.json(\.j2)?$/.test(name);
}

function isUnitName(name: string): boolean {
  return /\.service(\.j2)?$/.test(name);
}

function isScanned(name: string): boolean {
  return isCaddyfileName(name) || isCaddySnippetName(name) ||
    isJsonName(name) || isUnitName(name);
}

async function walk(dir: string): Promise<string[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory && !SKIPPED_DIRS.has(entry.name))
      .map((entry) => walk(join(dir, entry.name))),
  );
  const files = entries
    .filter((entry) => entry.isFile && isScanned(entry.name))
    .map((entry) => join(dir, entry.name));
  return [...files, ...nested.flat()];
}

/** Every `admin <address>` value in a Caddyfile's text. */
function caddyfileAdminAddresses(text: string): string[] {
  return [...text.matchAll(/^[ \t]*admin[ \t]+(\S+)/gm)].map((m) => m[1]!);
}

/** Every `"admin": {"listen": "<address>"}` value in a JSON config's text. */
function jsonAdminAddresses(text: string): string[] {
  return [
    ...text.matchAll(/"admin"\s*:\s*\{[^}]*?"listen"\s*:\s*"([^"]*)"/g),
  ].map((m) => m[1]!);
}

/** Every `caddy reload … --address <address>` value in a unit's text. */
function reloadAddresses(text: string): string[] {
  return [...text.matchAll(/\bcaddy reload\b[^\n]*?--address[ =](\S+)/g)].map(
    (m) => m[1]!,
  );
}

function isPrivateAdmin(address: string): boolean {
  return address === "off" || address.startsWith("unix/");
}

/** Problems with one file's admin listeners; empty when it is safe. */
function adminProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  const caddyfileAdmins = isCaddyfileName(name) || isCaddySnippetName(name)
    ? caddyfileAdminAddresses(text)
    : [];
  const addresses = [
    ...caddyfileAdmins,
    ...(isJsonName(name) ? jsonAdminAddresses(text) : []),
    ...(isUnitName(name) ? reloadAddresses(text) : []),
  ];
  for (const address of addresses) {
    if (!isPrivateAdmin(address)) problems.push(`TCP admin ${address}`);
  }
  if (isCaddyfileName(name) && caddyfileAdmins.length === 0) {
    problems.push("global block without admin (defaults to localhost:2019)");
  }
  return problems;
}

Deno.test("adminProblems flags every TCP admin shape", () => {
  assertEquals(
    adminProblems("Caddyfile", "{\n\tadmin unix//run/a.sock\n}"),
    [],
  );
  assertEquals(adminProblems("Caddyfile", "{\n\tadmin off\n}"), []);
  assertEquals(adminProblems("Caddyfile", "{\n  admin 127.0.0.1:2029\n}"), [
    "TCP admin 127.0.0.1:2029",
  ]);
  assertEquals(adminProblems("Caddyfile.j2", "{\n\tauto_https off\n}"), [
    "global block without admin (defaults to localhost:2019)",
  ]);
  assertEquals(
    adminProblems("x.json", '{"admin":{"listen":"localhost:2019"}}'),
    ["TCP admin localhost:2019"],
  );
  assertEquals(
    adminProblems(
      "a.service",
      "ExecReload=/c/caddy reload --config /c --address 127.0.0.1:2039",
    ),
    ["TCP admin 127.0.0.1:2039"],
  );
});

Deno.test("the hosting Caddy render has no TCP admin listener", () => {
  assertEquals(adminProblems("Caddyfile", caddyfile("/etc/turbopanel")), []);
  const unit = caddyUnit(
    {
      runtimesDir: "/opt/turbopanel/vendor",
      configDir: "/etc/turbopanel",
    } as Parameters<typeof caddyUnit>[0],
  );
  assertEquals(reloadAddresses(unit).length, 1);
  assertEquals(adminProblems("turbopanel-hosting-caddy.service", unit), []);
});

Deno.test("no Caddy config or unit in the repo has a TCP admin listener", async () => {
  const files = (await Promise.all(
    SCANNED_ROOTS.map((root) => walk(join(REPO, root))),
  )).flat();
  const texts = await Promise.all(files.map((file) => Deno.readTextFile(file)));
  const caddyfiles = files.filter((file) =>
    isCaddyfileName(file.split("/").pop()!)
  );
  // The site and control-plane templates at least; a vanished scan would pass.
  assert(caddyfiles.length >= 2, `found ${caddyfiles.length} Caddyfiles`);
  const problems = files.flatMap((file, i) =>
    adminProblems(file.split("/").pop()!, texts[i]!).map((problem) =>
      `${relative(REPO, file)}: ${problem}`
    )
  );
  assertEquals(problems, []);
});
