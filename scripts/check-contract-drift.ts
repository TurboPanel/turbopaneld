#!/usr/bin/env -S deno run --allow-read
/**
 * Cross-repo contract drift check (daemon side).
 *
 * Mirrors `turbopanel/scripts/check-contract-drift.mjs`. Missing sibling
 * `../turbopanel` → skip (exit 0). Dual-checkout CI (turbopanel
 * `metrics-legacy` job) runs the Node twin; this task covers a co-located
 * daemon workspace.
 *
 * Run: `deno task check:contract-drift`.
 */
import { fromFileUrl, join } from "@std/path";

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const ROOT = stripTrailingSlash(fromFileUrl(new URL("..", import.meta.url)));
const SIBLING = join(ROOT, "..", "turbopanel");

function stripHeaderDocblock(source: string): string {
  const end = source.indexOf("*/");
  return end === -1 ? source : source.slice(end + 2);
}

function isWordChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") || ch === "_";
}

function isWord(value: string): boolean {
  if (!value) return false;
  for (const ch of value) {
    if (!isWordChar(ch)) return false;
  }
  return true;
}

function normalizeWs(value: string): string {
  let out = "";
  let inSpace = false;
  for (const ch of value.trim()) {
    const space = ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
    if (space) {
      inSpace = true;
      continue;
    }
    if (inSpace && out.length > 0) out += " ";
    inSpace = false;
    out += ch;
  }
  return out;
}

function quotedStrings(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const quote = source[i];
    if (quote !== "'" && quote !== '"') {
      i += 1;
      continue;
    }
    const end = source.indexOf(quote, i + 1);
    if (end === -1) break;
    const token = source.slice(i + 1, end);
    if (token.length > 0) out.push(token);
    i = end + 1;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function stripQuotes(value: string): string {
  return value.replaceAll("'", "").replaceAll('"', "");
}

function extractAfterEquals(source: string, marker: string): number | null {
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const eq = source.indexOf("=", start + marker.length);
  if (eq === -1) return null;
  return eq + 1;
}

function extractConst(source: string, name: string): string | null {
  const from = extractAfterEquals(source, `export const ${name}`);
  if (from == null) return null;
  let end = from;
  while (end < source.length && source[end] !== "\n" && source[end] !== ";") {
    end += 1;
  }
  const captured = source.slice(from, end).trim();
  if (!captured) return null;
  return stripQuotes(normalizeWs(captured));
}

function extractTypeFields(source: string, typeName: string): string[] | null {
  const from = extractAfterEquals(source, `export type ${typeName}`);
  if (from == null) return null;
  const open = source.indexOf("{", from);
  const close = source.indexOf("}", open);
  if (open === -1 || close === -1) return null;
  const names: string[] = [];
  for (const line of source.slice(open + 1, close).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 1) continue;
    let name = trimmed.slice(0, colon);
    if (name.endsWith("?")) name = name.slice(0, -1);
    if (isWord(name)) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

function extractArrayConst(source: string, name: string): string[] | null {
  const idx = source.indexOf(`const ${name}`);
  if (idx === -1) return null;
  const open = source.indexOf("[", idx);
  const close = source.indexOf("]", open);
  if (open === -1 || close === -1) return null;
  return quotedStrings(source.slice(open + 1, close));
}

function fail(message: string): never {
  console.error(`check-contract-drift: ${message}`);
  Deno.exit(1);
}

async function readRel(root: string, rel: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(root, rel));
  } catch {
    return null;
  }
}

function requireText(value: string | null, message: string): string {
  if (value == null) fail(message);
  return value;
}

function requireEqual(
  left: string | null,
  right: string | null,
  message: string,
): void {
  if (left !== right || left == null) fail(message);
}

function requireJoinedEqual(
  left: string[] | null,
  right: string[] | null,
  message: string,
): void {
  if (left?.join(",") !== right?.join(",") || right == null) fail(message);
}

function updateChannelsFromType(source: string): string[] | null {
  const marker = "export type UpdateChannel";
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const from = source.indexOf("=", start);
  const to = source.indexOf(";", from);
  if (from === -1 || to === -1) return null;
  return quotedStrings(source.slice(from + 1, to));
}

async function checkMetrics(tp: string, td: string): Promise<void> {
  const metricsLeft = requireText(
    await readRel(tp, "src/contracts/metrics-contract.ts"),
    "metrics-contract.ts missing on one side of the pair",
  );
  const metricsRight = requireText(
    await readRel(td, "src/contracts/metrics-contract.ts"),
    "metrics-contract.ts missing on one side of the pair",
  );
  if (stripHeaderDocblock(metricsLeft) !== stripHeaderDocblock(metricsRight)) {
    fail("metrics-contract.ts body drifted (below the header docblock)");
  }
}

async function checkHostname(tp: string, td: string): Promise<void> {
  const hostnameLeft = requireText(
    await readRel(tp, "src/contracts/commands/hostname.ts"),
    "hostname sources missing on one side of the pair",
  );
  const hostnameRight = requireText(
    await readRel(td, "src/contracts/commands-contracts.ts"),
    "hostname sources missing on one side of the pair",
  );
  requireEqual(
    extractConst(hostnameLeft, "HOSTNAME_RE"),
    extractConst(hostnameRight, "HOSTNAME_RE"),
    "HOSTNAME_RE drifted",
  );
  requireEqual(
    extractConst(hostnameLeft, "HOSTNAME_MAX_LENGTH"),
    extractConst(hostnameRight, "HOSTNAME_MAX_LENGTH"),
    "HOSTNAME_MAX_LENGTH drifted",
  );
}

async function checkMachineKey(tp: string, td: string): Promise<void> {
  const mkLeft = requireText(
    await readRel(tp, "src/lib/machine-key.ts"),
    "machine-key.ts missing on one side of the pair",
  );
  const mkRight = requireText(
    await readRel(td, "src/host/machine-key.ts"),
    "machine-key.ts missing on one side of the pair",
  );
  requireEqual(
    extractConst(mkLeft, "TURBOPANEL_MACHINE_ID_NAMESPACE"),
    extractConst(mkRight, "TURBOPANEL_MACHINE_ID_NAMESPACE"),
    "TURBOPANEL_MACHINE_ID_NAMESPACE drifted",
  );
}

async function checkUpdateChannels(tp: string, td: string): Promise<void> {
  const channelsLeftSrc = requireText(
    await readRel(tp, "src/contracts/update-channel.ts"),
    "update-channel sources missing on one side of the pair",
  );
  const channelsRightSrc = requireText(
    await readRel(td, "src/update/types.ts"),
    "update-channel sources missing on one side of the pair",
  );
  const channelsLeft = extractArrayConst(channelsLeftSrc, "UPDATE_CHANNELS");
  const channelsRight = updateChannelsFromType(channelsRightSrc);
  requireJoinedEqual(
    channelsLeft,
    channelsRight,
    `UPDATE_CHANNELS drifted (${channelsLeft?.join(",")} vs ${
      channelsRight?.join(",")
    })`,
  );
}

async function checkReportedIp(tp: string, td: string): Promise<void> {
  const ipLeftSrc = requireText(
    await readRel(tp, "src/contracts/server-addresses.ts"),
    "ServerReportedIp sources missing on one side of the pair",
  );
  const ipRightSrc = requireText(
    await readRel(td, "src/contracts/server-reported-ip.ts"),
    "ServerReportedIp sources missing on one side of the pair",
  );
  const ipLeft = extractTypeFields(ipLeftSrc, "ServerReportedIp");
  const ipRight = extractTypeFields(ipRightSrc, "ServerReportedIp");
  requireJoinedEqual(
    ipLeft,
    ipRight,
    `ServerReportedIp fields drifted (${ipLeft?.join(",")} vs ${
      ipRight?.join(",")
    })`,
  );
}

async function checkSlotMapping(tp: string, td: string): Promise<void> {
  const slotLeftTypes = requireText(
    await readRel(tp, "src/contracts/topology-types.ts"),
    "topology slot-mapping sources missing on one side of the pair",
  );
  const slotRightTypes = requireText(
    await readRel(td, "src/contracts/topology-types.ts"),
    "topology slot-mapping sources missing on one side of the pair",
  );
  const slotLeftMap = requireText(
    await readRel(tp, "src/contracts/topology-slot-mapping.ts"),
    "topology slot-mapping sources missing on one side of the pair",
  );
  const slotRightMap = requireText(
    await readRel(td, "src/contracts/topology-slot-mapping.ts"),
    "topology slot-mapping sources missing on one side of the pair",
  );
  requireEqual(
    extractConst(slotLeftTypes, "MAX_NIC_SLOTS"),
    extractConst(slotRightTypes, "MAX_NIC_SLOTS"),
    "MAX_NIC_SLOTS drifted",
  );
  requireJoinedEqual(
    extractArrayConst(slotLeftMap, "FILESYSTEM_ROLE_PRIORITY"),
    extractArrayConst(slotRightMap, "FILESYSTEM_ROLE_PRIORITY"),
    "FILESYSTEM_ROLE_PRIORITY drifted",
  );
}

const siblingSrc = join(SIBLING, "src");
try {
  await Deno.stat(siblingSrc);
} catch {
  console.log(
    `check-contract-drift: sibling checkout missing at ${SIBLING}; skip`,
  );
  Deno.exit(0);
}

const tp = SIBLING;
const td = ROOT;
await checkMetrics(tp, td);
await checkHostname(tp, td);
await checkMachineKey(tp, td);
await checkUpdateChannels(tp, td);
await checkReportedIp(tp, td);
await checkSlotMapping(tp, td);

console.log(
  "check-contract-drift: metrics, hostname, machine-key, channels, ServerReportedIp, slot-mapping agree.",
);
