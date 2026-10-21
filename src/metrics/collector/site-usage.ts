/**
 * Per-home and per-site disk usage, measured by `tp-host site-usage`.
 *
 * Principal homes under `/srv/users` are `root:<principal>` 0750, so the
 * daemon account cannot walk them itself. The verb prints sizes and directory
 * names only (`home <bytes> <name>` / `site <bytes> <id>`), never a file name
 * or content. This module parses that and keeps the five largest sites as
 * short ids with sizes: free text for the metrics row, no domains.
 */
import { runPrivileged } from "../../deploy/release/release-layout.ts";
import { hostSudoArgs } from "../../permissions/host-sudo.ts";

/** How many of the largest sites are reported. */
export const TOP_SITE_COUNT = 5;

export type SiteSize = { id: string; bytes: number };

export type SiteUsageReading = {
  /** Sum of every principal home: the hosting tree's used bytes. */
  hostingBytes: number;
  /** Largest sites first, at most {@link TOP_SITE_COUNT}. */
  topSites: SiteSize[];
};

export type SiteUsageRun = (
  command: string,
  args: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }>;

/** Parse the verb's output. `null` when it holds no home at all. */
export function parseSiteUsage(text: string): SiteUsageReading | null {
  let hostingBytes = 0;
  let homes = 0;
  const sizes = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [kind, rawBytes, id, ...rest] = line.trim().split(" ");
    if (rest.length > 0 || id === undefined || !/^\d+$/.test(rawBytes ?? "")) {
      continue;
    }
    const bytes = Number(rawBytes);
    if (kind === "home") {
      hostingBytes += bytes;
      homes += 1;
    } else if (kind === "site") {
      sizes.set(id, (sizes.get(id) ?? 0) + bytes);
    }
  }
  if (homes === 0) return null;
  const topSites = [...sizes]
    .map(([id, bytes]) => ({ id, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id))
    .slice(0, TOP_SITE_COUNT);
  return { hostingBytes, topSites };
}

/** One `tp-host site-usage` call; `null` when it is unavailable or fails. */
export async function readSiteUsage(
  run: SiteUsageRun = runPrivileged,
): Promise<SiteUsageReading | null> {
  try {
    const result = await run("sudo", hostSudoArgs(["-n", "site-usage"]));
    return result.success ? parseSiteUsage(result.stdout) : null;
  } catch {
    return null;
  }
}
