#!/usr/bin/env -S deno run --allow-net=api.github.com --allow-read --allow-write
/**
 * Look for a newer tunnel connector release than the version this daemon pins
 * (`CLOUDFLARED_VERSION` in `src/orchestration/assets.ts`) and write a short
 * report for the owner: the new version, its release page and the checksum of
 * each Linux asset, plus the places that carry the pin. It changes no pin and
 * never touches a server: a new connector reaches servers only when a daemon
 * release carries it. The scheduled workflow files or updates ONE issue from
 * this report.
 *
 * Usage: `deno run ... scripts/check-connector-release.ts <report-file>`.
 * Writes the issue body to the file and prints `newer` or `current`.
 */
import {
  CLOUDFLARED_SHA256,
  CLOUDFLARED_VERSION,
} from "../src/orchestration/assets.ts";

export const RELEASE_API =
  "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
export const ISSUE_TITLE = "Tunnel connector update available";
const ASSETS = ["cloudflared-linux-amd64", "cloudflared-linux-arm64"] as const;
const VERSION_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;
const DIGEST_RE = /^sha256:([0-9a-f]{64})$/;

export type ReleaseAsset = { name: string; digest: string | null };
export type Release = { tag: string; url: string; assets: ReleaseAsset[] };

/** `2026.5.2` to `[2026, 5, 2]`, or null when it is not a release number. */
export function parseVersion(value: string): [number, number, number] | null {
  const m = VERSION_RE.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether `candidate` is a later release number than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The newest published release, reduced to what the report needs. */
export async function latestRelease(
  fetchFn: typeof fetch = fetch,
): Promise<Release> {
  const res = await fetchFn(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`release lookup failed: HTTP ${res.status}`);
  const body = await res.json() as {
    tag_name?: unknown;
    html_url?: unknown;
    prerelease?: unknown;
    assets?: Array<{ name?: unknown; digest?: unknown }>;
  };
  if (typeof body.tag_name !== "string" || !parseVersion(body.tag_name)) {
    throw new Error("release lookup returned an unexpected tag");
  }
  return {
    tag: body.tag_name,
    url: typeof body.html_url === "string" ? body.html_url : "",
    assets: (body.assets ?? []).flatMap((a) =>
      typeof a.name === "string"
        ? [{
          name: a.name,
          digest: typeof a.digest === "string" ? a.digest : null,
        }]
        : []
    ),
  };
}

/** The checksum of each Linux asset, or null for one the release lacks. */
export function checksumsOf(release: Release): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of ASSETS) {
    const digest = release.assets.find((a) => a.name === name)?.digest;
    out[name] = digest ? (DIGEST_RE.exec(digest)?.[1] ?? null) : null;
  }
  return out;
}

const code = (value: string) => `\`${value}\``;

/** One checksum line: the new digest and, when there is one, today's pin. */
function assetLine(
  name: string,
  digest: string | null | undefined,
  pin: string | undefined,
): string {
  const now = digest ? code(digest) : "not listed by the release";
  const was = pin ? ` (pinned today: ${code(pin)})` : "";
  return `- ${code(name)}: ${now}${was}`;
}

/** The issue body: what is new and exactly what a daemon release must change. */
export function renderReport(
  current: string,
  release: Release,
  pinned: Readonly<Record<string, string>> = CLOUDFLARED_SHA256,
): string {
  const sums = checksumsOf(release);
  const lines = [
    `A newer tunnel connector is published: **${release.tag}** (this daemon pins ${current}).`,
    "",
    release.url ? `Release page: ${release.url}` : "",
    "",
    "Checksums of the Linux files (SHA-256, as the release reports them):",
    "",
    ...ASSETS.map((name) => assetLine(name, sums[name], pinned[name])),
    "",
    "Nothing has changed on any server and no pin was edited. A new connector reaches servers only with a daemon release. To move to it, a pull request changes these together:",
    "",
    "- `CLOUDFLARED_VERSION` and `CLOUDFLARED_SHA256` in `src/orchestration/assets.ts`",
    "- the exact connector path in the daemon's permission list (`orchestration/roles/daemon-launch/templates/turbopaneld.service.j2`)",
    "- the version in `src/orchestration/cloudflared.ts` and `deno.json` where they name it",
    "- the test samples that name the version",
    "",
    "After the daemon update each server starts the new version beside the old one and stops the old one once the new one is connected.",
    "",
  ];
  return lines.filter((l, i) => !(l === "" && lines[i - 1] === "")).join("\n");
}

async function main(): Promise<void> {
  const reportFile = Deno.args[0];
  if (!reportFile) throw new Error("usage: check-connector-release <file>");
  const release = await latestRelease();
  if (!isNewer(release.tag, CLOUDFLARED_VERSION)) {
    console.log("current");
    return;
  }
  await Deno.writeTextFile(
    reportFile,
    renderReport(CLOUDFLARED_VERSION, release),
  );
  console.log("newer");
}

if (import.meta.main) await main();
