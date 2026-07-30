/**
 * Host machine key derivation.
 *
 * `TURBOPANEL_MACHINE_ID_NAMESPACE` is **not a secret** — it is a fixed
 * application-id constant. Both the daemon and the instance compute the same
 * HMAC independently and must never diverge. Keep the literal identical to
 * `instance/src/lib/machine-key.ts`.
 *
 * Argument ordering matches systemd `sd_id128_get_machine_app_specific`:
 * key = raw machine id, message = namespace.
 */

import { encodeHex } from "@std/encoding/hex";

/**
 * Fixed application-id UUID for machine-key derivation.
 * Not a secret — both sides compute independently; must never diverge.
 */
export const TURBOPANEL_MACHINE_ID_NAMESPACE =
  "57fd317c-089a-4d52-9d3d-bbf76ba30383";

const MACHINE_ID_PATH = "/etc/machine-id";
const textEncoder = new TextEncoder();

let cachedKey: string | undefined | null = null;

function readTextFile(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    // Deno 2 may block some paths under scoped --allow-read; fall back to cat.
  }

  try {
    const { code, stdout } = new Deno.Command("cat", {
      args: [path],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    if (code !== 0) return undefined;
    return new TextDecoder().decode(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Derive a deterministic, non-reversible machine key from a raw `/etc/machine-id`.
 * Returns `undefined` for empty input (never derive from an empty string).
 *
 * HMAC-SHA256 with key = machine id, message = namespace (systemd app-specific
 * ordering). Web Crypto only so the identical logic works on Workers.
 */
export async function deriveMachineKey(
  rawMachineId: string,
): Promise<string | undefined> {
  const normalized = rawMachineId.trim().toLowerCase();
  if (!normalized) return undefined;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(normalized),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    textEncoder.encode(TURBOPANEL_MACHINE_ID_NAMESPACE),
  );
  return encodeHex(new Uint8Array(signature));
}

/**
 * Read `/etc/machine-id`, derive the machine key, and memoize at module scope.
 * Call this on the connect path before the sync hello getter runs.
 */
export async function readMachineKey(): Promise<string | undefined> {
  if (cachedKey !== null) return cachedKey;
  const raw = readTextFile(MACHINE_ID_PATH) ?? "";
  cachedKey = (await deriveMachineKey(raw)) ?? undefined;
  return cachedKey;
}

/** Sync accessor — returns only the memoized value (undefined until warmed). */
export function cachedMachineKey(): string | undefined {
  return cachedKey ?? undefined;
}

/** Test helper — clear the process-level cache between cases. */
export function resetMachineKeyCacheForTests(): void {
  cachedKey = null;
}
