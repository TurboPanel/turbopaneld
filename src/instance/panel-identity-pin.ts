/**
 * The panel key pin: `lib/panel-identity`, written by the installer
 * (`scripts/run.sh`, root:tp 0640) and read here. It holds the fingerprints of
 * the panel's identity key that this server trusts. The daemon cannot write
 * it; later changes go through `tp-host panel-identity-write`.
 *
 * The file is `key=value` lines: `current`, `next`, `keyset`, `urls`,
 * `pinned_by`, `updated`. A server installed with `--unsafe-no-panel-key` has
 * `pinned_by=unsafe` and an empty `current`: nothing is pinned for it.
 * Fingerprints are base64url (no padding) SHA-256 digests, 43 characters.
 */
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";

export const PANEL_IDENTITY_PIN_FILE = "panel-identity";

export type PanelPinnedBy = "install" | "upgrade" | "unsafe";

export type PanelIdentityPin = {
  /** Fingerprint of the pinned current key; "" only when `pinnedBy` is `unsafe`. */
  current: string;
  /** Fingerprint of the offline next key, or null. */
  next: string | null;
  keyset: number;
  urls: string[];
  pinnedBy: PanelPinnedBy;
  updated: string;
};

const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const PINNED_BY: readonly string[] = ["install", "upgrade", "unsafe"];
const KEYS = [
  "current",
  "next",
  "keyset",
  "urls",
  "pinned_by",
  "updated",
] as const;

type PinFields = Record<(typeof KEYS)[number], string>;

function fields(text: string): PinFields {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    if (at < 1) throw new TypeError(`panel-identity: bad line "${line}"`);
    const key = line.slice(0, at);
    if (!(KEYS as readonly string[]).includes(key) || map.has(key)) {
      throw new TypeError(`panel-identity: unexpected key "${key}"`);
    }
    map.set(key, line.slice(at + 1));
  }
  const found: Partial<PinFields> = {};
  for (const key of KEYS) {
    const value = map.get(key);
    if (value === undefined) {
      throw new TypeError(`panel-identity: missing ${key}`);
    }
    found[key] = value;
  }
  return found as PinFields;
}

/** Parse the pin file; throws a TypeError naming the first problem. */
export function parsePanelIdentityPin(text: string): PanelIdentityPin {
  const values = fields(text);
  const pinnedBy = values.pinned_by;
  if (!PINNED_BY.includes(pinnedBy)) {
    throw new TypeError(
      "panel-identity: pinned_by is not install, upgrade or unsafe",
    );
  }
  const current = values.current;
  const unsafe = pinnedBy === "unsafe";
  if (current === "" ? !unsafe : !FINGERPRINT.test(current)) {
    throw new TypeError(
      "panel-identity: current is not a 43-character fingerprint",
    );
  }
  const next = values.next;
  if (next !== "" && !FINGERPRINT.test(next)) {
    throw new TypeError(
      "panel-identity: next is not a 43-character fingerprint",
    );
  }
  if (!/^\d+$/.test(values.keyset)) {
    throw new TypeError("panel-identity: keyset is not an integer");
  }
  return {
    current,
    next: next === "" ? null : next,
    keyset: Number(values.keyset),
    urls: values.urls === "" ? [] : values.urls.split(","),
    pinnedBy: pinnedBy as PanelPinnedBy,
    updated: values.updated,
  };
}

function pinPath(env: Record<string, string | undefined>): string {
  return join(resolveLayout(env).libDir, PANEL_IDENTITY_PIN_FILE);
}

/** The pin, or null when the file is absent (an install from before panel keys). */
export async function readPanelIdentityPin(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<PanelIdentityPin | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(pinPath(env));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
  return parsePanelIdentityPin(text);
}

/** Synchronous read for the hello frame; never throws (no report on any problem). */
export function readPanelIdentityPinSync(
  env?: Record<string, string | undefined>,
): PanelIdentityPin | null {
  try {
    return parsePanelIdentityPin(
      Deno.readTextFileSync(pinPath(env ?? Deno.env.toObject())),
    );
  } catch {
    return null;
  }
}

/** What the hello frame reports to the panel about this server's pin. */
export function panelPinReport(
  pin: PanelIdentityPin | null,
): { pinnedBy: PanelPinnedBy; current: string; keyset: number } | undefined {
  return pin
    ? { pinnedBy: pin.pinnedBy, current: pin.current, keyset: pin.keyset }
    : undefined;
}
