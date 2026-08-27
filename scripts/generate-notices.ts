#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-net --allow-env
/**
 * Generate or check THIRD_PARTY_NOTICES.md from deno.lock, the turbopanel-sh
 * npm lock, and orchestration pins.
 *
 * Usage:
 *   deno task notices:generate
 *   deno task notices:check
 */
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  defaultLicenseForPackageName,
  type DenoLockfile,
  type DenoLockNoticeOptions,
  evaluateLicensePolicy,
  fillMissingLicenses,
  fingerprintCommentValue,
  formatPolicyFailures,
  isDenoDevelopmentPackageName,
  mergeNoticePackages,
  nameFromJsrNpmSpec,
  type NoticePackage,
  NOTICES_FILE_NAME,
  noticesAreCurrent,
  type OrchestrationPin,
  packagesFromDenoLock,
  packagesFromNpmLockfile,
  packagesFromOrchestrationPins,
  renderThirdPartyNotices,
} from "../src/lib/notices.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Shipped daemon runtimes (native compile + JS bundle). */
export const PRODUCTION_ENTRYPOINTS = ["src/prod-main.ts"] as const;

const ORCHESTRATION_LICENSES: Record<string, string> = {
  "ansible-core": "GPL-3.0-or-later",
  "ansible-lint": "GPL-3.0-or-later",
  "ansible-compat": "GPL-3.0-or-later",
  "ansible.posix": "GPL-3.0-or-later",
  "geerlingguy.docker": "MIT",
};

export type NoticesCliIo = {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type LicenseLookup = (pkg: NoticePackage) => Promise<string>;

export async function runGenerateNotices(options: {
  root?: string;
  argv?: string[];
  io?: NoticesCliIo;
  exit?: (code: number) => void;
  lookupLicense?: LicenseLookup;
  denoProductionRoots?: readonly string[];
  resolveDenoInfoSpecifiers?: (
    entrypoints: readonly string[],
  ) => Promise<string[]>;
} = {}): Promise<0 | 1> {
  const root = options.root ?? ROOT;
  const argv = options.argv ?? Deno.args;
  const io = options.io ?? console;
  const leave = options.exit ?? ((code: number) => Deno.exit(code));
  const check = argv.includes("--check");
  const lookup = options.lookupLicense ?? lookupRegistryLicense;

  const packages = await collectDaemonNoticePackages(root, lookup, {
    denoProductionRoots: options.denoProductionRoots,
    resolveDenoInfoSpecifiers: options.resolveDenoInfoSpecifiers,
  });
  const policy = evaluateLicensePolicy(packages, {
    repoLicense: "AGPL-3.0-only",
  });
  if (policy.length > 0) {
    io.error?.("generate-notices: unreviewed license class:\n");
    io.error?.(formatPolicyFailures(policy));
    leave(1);
    return 1;
  }

  const fingerprints: Record<string, string> = {
    "deno.lock": fingerprintCommentValue(
      await hashFile(join(root, "deno.lock")),
    ),
  };
  const npmLock = join(root, "workers", "turbopanel-sh", "package-lock.json");
  try {
    fingerprints["workers/turbopanel-sh/package-lock.json"] =
      fingerprintCommentValue(
        await hashFile(npmLock),
      );
  } catch {
    // Optional deploy-tool lock may be absent in stripped checkouts.
  }
  for (
    const rel of [
      "orchestration/requirements.txt",
      "orchestration/requirements.yml",
      "orchestration/requirements-docker.yml",
    ]
  ) {
    try {
      fingerprints[rel] = fingerprintCommentValue(
        await hashFile(join(root, rel)),
      );
    } catch {
      // Pin files should exist; skip a missing optional docker pin file.
    }
  }

  const markdown = renderThirdPartyNotices(packages, {
    repoLicense: "AGPL-3.0-only",
    productName: "TurboPanel Daemon",
    regenerateCommand: "deno task notices:generate",
    lockfileFingerprints: fingerprints,
  });
  return await finishNoticesFile({
    check,
    io,
    leave,
    markdown,
    noticesPath: join(root, NOTICES_FILE_NAME),
    packageCount: packages.length,
  });
}

export async function collectDaemonNoticePackages(
  root: string,
  lookup: LicenseLookup,
  graph: {
    denoProductionRoots?: readonly string[];
    resolveDenoInfoSpecifiers?: (
      entrypoints: readonly string[],
    ) => Promise<string[]>;
  } = {},
): Promise<NoticePackage[]> {
  const denoLock = JSON.parse(
    await Deno.readTextFile(join(root, "deno.lock")),
  ) as DenoLockfile;
  const productionRoots = graph.denoProductionRoots ??
    await (graph.resolveDenoInfoSpecifiers ??
      ((entrypoints) => specifiersFromDenoInfo(root, entrypoints)))(
        PRODUCTION_ENTRYPOINTS,
      );
  const denoGraph: DenoLockNoticeOptions = {
    productionRoots: productionRoots.length > 0
      ? productionRoots
      : workspaceProductionRoots(denoLock),
  };
  const denoPackages = await fillMissingLicenses(
    packagesFromDenoLock(denoLock, {}, denoGraph),
    lookup,
  );

  let npmPackages: NoticePackage[] = [];
  const npmLockPath = join(
    root,
    "workers",
    "turbopanel-sh",
    "package-lock.json",
  );
  try {
    const npmLock = JSON.parse(await Deno.readTextFile(npmLockPath));
    npmPackages = await fillMissingLicenses(
      packagesFromNpmLockfile(npmLock),
      lookup,
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const orchestration = packagesFromOrchestrationPins(
    parseOrchestrationPins(root),
  );
  return mergeNoticePackages([denoPackages, npmPackages, orchestration]);
}

export function workspaceProductionRoots(lock: DenoLockfile): string[] {
  return [...(lock.workspace?.dependencies ?? [])].filter((spec) => {
    const name = nameFromJsrNpmSpec(spec);
    return name.length > 0 && !isDenoDevelopmentPackageName(name);
  });
}

export async function specifiersFromDenoInfo(
  root: string,
  entrypoints: readonly string[],
  runCommand?: (
    args: string[],
  ) => Promise<{ success: boolean; stdout: string }>,
): Promise<string[]> {
  const run = runCommand ?? (async (args) => {
    const result = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: result.success,
      stdout: new TextDecoder().decode(result.stdout),
    };
  });
  const specs = new Set<string>();
  for (const entry of entrypoints) {
    const result = await run(["info", "--json", "--quiet", entry]);
    if (!result.success) continue;
    collectSpecifiersFromDenoInfoJson(result.stdout, specs);
  }
  return [...specs].sort((a, b) => a.localeCompare(b));
}

export function collectSpecifiersFromDenoInfoJson(
  json: string,
  into = new Set<string>(),
): Set<string> {
  try {
    const parsed = JSON.parse(json) as {
      modules?: Array<{
        dependencies?: Array<{ specifier?: string }>;
        specifier?: string;
      }>;
      npmPackages?: Record<string, unknown>;
    };
    for (const mod of parsed.modules ?? []) {
      if (isRemoteDenoSpec(mod.specifier)) into.add(mod.specifier ?? "");
      for (const dep of mod.dependencies ?? []) {
        if (isRemoteDenoSpec(dep.specifier)) into.add(dep.specifier ?? "");
      }
    }
    for (const name of Object.keys(parsed.npmPackages ?? {})) {
      into.add(name.includes(":") ? name : `npm:${name}`);
    }
  } catch {
    // ignore malformed deno info JSON
  }
  return into;
}

function isRemoteDenoSpec(spec: string | undefined): spec is string {
  return Boolean(spec?.startsWith("jsr:") || spec?.startsWith("npm:"));
}

export function parseOrchestrationPins(root: string): OrchestrationPin[] {
  const pins: OrchestrationPin[] = [];
  const reqTxt = Deno.readTextFileSync(
    join(root, "orchestration", "requirements.txt"),
  );
  for (const raw of reqTxt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^([A-Za-z0-9_.-]+)\s*([=<>!~].+)?$/.exec(line);
    if (!match) continue;
    const name = match[1] ?? "";
    const version = (match[2] ?? "").trim() || "*";
    pins.push({
      name,
      version,
      license: ORCHESTRATION_LICENSES[name] ?? "",
    });
  }
  pins.push(
    ...galaxyPins(join(root, "orchestration", "requirements.yml")),
    ...galaxyPins(join(root, "orchestration", "requirements-docker.yml")),
  );
  return pins;
}

function galaxyPins(path: string): OrchestrationPin[] {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const pins: OrchestrationPin[] = [];
  const blocks = text.split(/^\s*-\s+name:\s+/m).slice(1);
  for (const block of blocks) {
    const nameMatch = /^["']?([^"'\n]+)["']?/.exec(block);
    const versionMatch = /version:\s*["']?([^"'\n]+)["']?/.exec(block);
    const name = nameMatch?.[1]?.trim();
    if (!name) continue;
    pins.push({
      name,
      version: versionMatch?.[1]?.trim() || "*",
      license: ORCHESTRATION_LICENSES[name] ?? "",
    });
  }
  return pins;
}

export async function lookupRegistryLicense(
  pkg: NoticePackage,
): Promise<string> {
  if (pkg.source === "deno.lock (npm)" || pkg.source === "package-lock.json") {
    return (await readNpmCacheLicense(pkg.name, pkg.version)) ||
      (await fetchNpmLicense(pkg.name, pkg.version));
  }
  if (pkg.source === "deno.lock (jsr)") {
    return (await readJsrCacheLicense(pkg.name, pkg.version)) ||
      (await fetchJsrLicense(pkg.name, pkg.version)) ||
      defaultLicenseForPackageName(pkg.name) ||
      "";
  }
  return "";
}

async function readNpmCacheLicense(
  name: string,
  version: string,
): Promise<string> {
  const home = Deno.env.get("DENO_DIR") ??
    join(Deno.env.get("HOME") ?? "", ".cache", "deno");
  const pkgJson = join(
    home,
    "npm",
    "registry.npmjs.org",
    name,
    version,
    "package.json",
  );
  try {
    const parsed = JSON.parse(await Deno.readTextFile(pkgJson)) as {
      license?: unknown;
    };
    return typeof parsed.license === "string" ? parsed.license : "";
  } catch {
    return "";
  }
}

async function readJsrCacheLicense(
  name: string,
  version: string,
): Promise<string> {
  const home = Deno.env.get("DENO_DIR") ??
    join(Deno.env.get("HOME") ?? "", ".cache", "deno");
  const encoded = name.replaceAll("/", "$");
  const candidates = [
    join(home, "gen", "https", "jsr.io", encoded, `${version}_meta.json`),
    join(home, "deps", "https", "jsr.io", `${name}@${version}.json`),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(candidate)) as {
        license?: unknown;
      };
      if (typeof parsed.license === "string" && parsed.license.trim()) {
        return parsed.license;
      }
    } catch {
      // try next
    }
  }
  return "";
}

async function fetchNpmLicense(name: string, version: string): Promise<string> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${
    encodeURIComponent(version)
  }`;
  try {
    const response = await fetch(url);
    if (!response.ok) return "";
    const parsed = await response.json() as { license?: unknown };
    return typeof parsed.license === "string" ? parsed.license : "";
  } catch {
    return "";
  }
}

async function fetchJsrLicense(name: string, version: string): Promise<string> {
  try {
    const jsonResponse = await fetch(
      `https://jsr.io/${name}/${version}/deno.json`,
    );
    if (jsonResponse.ok) {
      const parsed = await jsonResponse.json() as { license?: unknown };
      if (typeof parsed.license === "string" && parsed.license.trim()) {
        return parsed.license;
      }
    }
  } catch {
    // fall through to LICENSE
  }
  try {
    const response = await fetch(`https://jsr.io/${name}/${version}/LICENSE`);
    if (!response.ok) return "";
    const text = await response.text();
    if (/Permission is hereby granted, free of charge/i.test(text)) {
      return "MIT";
    }
    if (/Apache License[\s\S]{0,80}Version 2\.0/i.test(text)) {
      return "Apache-2.0";
    }
    if (/ISC License/i.test(text)) return "ISC";
    return "";
  } catch {
    return "";
  }
}

async function hashFile(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeHex(new Uint8Array(digest));
}

async function finishNoticesFile(args: {
  check: boolean;
  io: NoticesCliIo;
  leave: (code: number) => void;
  markdown: string;
  noticesPath: string;
  packageCount: number;
}): Promise<0 | 1> {
  if (args.check) {
    let existing: string;
    try {
      existing = await Deno.readTextFile(args.noticesPath);
    } catch {
      args.io.error?.(
        `generate-notices: missing ${NOTICES_FILE_NAME} — run deno task notices:generate`,
      );
      args.leave(1);
      return 1;
    }
    if (!noticesAreCurrent(existing, args.markdown)) {
      args.io.error?.(
        `generate-notices: ${NOTICES_FILE_NAME} is stale relative to the lockfile. Run deno task notices:generate and commit the result.`,
      );
      args.leave(1);
      return 1;
    }
    args.io.log?.(`generate-notices: ${NOTICES_FILE_NAME} is current.`);
    return 0;
  }
  await Deno.writeTextFile(args.noticesPath, args.markdown);
  args.io.log?.(
    `generate-notices: wrote ${NOTICES_FILE_NAME} (${args.packageCount} packages).`,
  );
  return 0;
}

if (import.meta.main) {
  await runGenerateNotices();
}
