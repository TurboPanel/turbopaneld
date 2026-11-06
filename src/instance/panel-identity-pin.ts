/**
 * The panel key pin: `lib/panel-identity`, written by the installer
 * (`scripts/run.sh`, root:tp 0640) and read here. It holds the fingerprints of
 * the panel's identity key that this server trusts. The daemon cannot write
 * it; later changes go through `tp-host panel-identity-write`.
 *
 * The file is `key=value` lines: `current`, `next`, `keyset`, `urls`,
 * `pinned_by`, `updated`, and (optional, written once the server learned them)
 * `rp_id` and `passkeys`: the rotation passkeys whose approval moves the pin
 * (`<pkid>.<es256|eddsa>.<base64url raw key>`, comma separated). A server installed with `--unsafe-no-panel-key` has
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
  /** WebAuthn relying party id of the rotation passkeys; "" until learned. */
  rpId: string;
  /** Rotation passkeys that approve key changes; empty until learned. */
  passkeys: RotationPasskey[];
};

/** One pinned rotation passkey: `id` is base64url SHA-256 of its credential id. */
export type RotationPasskey = {
  id: string;
  alg: "ES256" | "EdDSA";
  pub: string;
};

const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;
const PINNED_BY: ReadonlySet<string> = new Set([
  "install",
  "upgrade",
  "unsafe",
]);
const KEYS = [
  "current",
  "next",
  "keyset",
  "urls",
  "pinned_by",
  "updated",
] as const;
/** Lines a pin from before rotation passkeys does not have; absent reads as empty. */
const OPTIONAL_KEYS = ["rp_id", "passkeys"] as const;
const ALL_KEYS: readonly string[] = [...KEYS, ...OPTIONAL_KEYS];
const RP_ID = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PASSKEY_ENTRY = /^([A-Za-z0-9_-]{43})\.(es256|eddsa)\.([A-Za-z0-9_-]+)$/;

type PinFields =
  & Record<(typeof KEYS)[number], string>
  & Record<(typeof OPTIONAL_KEYS)[number], string>;

function fields(text: string): PinFields {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    if (at < 1) throw new TypeError(`panel-identity: bad line "${line}"`);
    const key = line.slice(0, at);
    if (!ALL_KEYS.includes(key) || map.has(key)) {
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
  for (const key of OPTIONAL_KEYS) found[key] = map.get(key) ?? "";
  return found as PinFields;
}

/** Parse a `passkeys=` value; throws on any malformed entry. */
export function parseRotationPasskeys(line: string): RotationPasskey[] {
  if (line === "") return [];
  const entries = line.split(",").map((entry) => {
    const match = PASSKEY_ENTRY.exec(entry);
    if (!match) {
      throw new TypeError("panel-identity: passkeys holds a bad entry");
    }
    const [, id, alg, pub] = match;
    return {
      id: id!,
      alg: alg === "es256" ? "ES256" : "EdDSA",
      pub: pub!,
    } as const;
  });
  if (entries.length > 5) {
    throw new TypeError("panel-identity: more than five passkeys");
  }
  return entries;
}

/** The `passkeys=` line for a set, sorted by id (what the pin report hashes). */
export function rotationPasskeysLine(
  passkeys: readonly RotationPasskey[],
): string {
  return [...passkeys]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => `${p.id}.${p.alg === "ES256" ? "es256" : "eddsa"}.${p.pub}`)
    .join(",");
}

/** Parse the pin file; throws a TypeError naming the first problem. */
export function parsePanelIdentityPin(text: string): PanelIdentityPin {
  const values = fields(text);
  const pinnedBy = values.pinned_by;
  if (!PINNED_BY.has(pinnedBy)) {
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
  if (values.rp_id !== "" && !RP_ID.test(values.rp_id)) {
    throw new TypeError("panel-identity: rp_id is not a host name");
  }
  const passkeys = parseRotationPasskeys(values.passkeys);
  if ((passkeys.length > 0) !== (values.rp_id !== "")) {
    throw new TypeError("panel-identity: rp_id and passkeys go together");
  }
  return {
    current,
    next: next === "" ? null : next,
    keyset: Number(values.keyset),
    urls: values.urls === "" ? [] : values.urls.split(","),
    pinnedBy: pinnedBy as PanelPinnedBy,
    updated: values.updated,
    rpId: values.rp_id,
    passkeys,
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
