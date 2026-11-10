/**
 * The per-runtime site key that binds an Apache PHP runtime to its own vhost.
 *
 * Apache can reach every per-site PHP socket, so a socket path alone is no
 * boundary. Each Apache PHP runtime therefore has a key: its vhost sends it as
 * the FastCGI parameter `TP_SITE_KEY`, its own `php.ini` holds the expected
 * value, and a guard file answers 403 unless the two match. The key is an
 * HMAC of the runtime id under a daemon-only secret, so the vhost and the
 * runtime always agree and one site's key says nothing about another's.
 */
import { dirname, join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";

const SECRET_FILE = "php-site-key";
const SECRET_HEX = /^[0-9a-f]{64}$/;

/** The folder inside the daemon's `sites` state leaf that holds the secret. */
export function phpSiteKeySecretPath(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): string {
  return join(layout.daemonStateDir, "sites", SECRET_FILE);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Reads the secret, creating it on first use: 32 random bytes as 64 hex
 * characters, written `0600` through a temp file renamed in the same folder.
 * A file that is not exactly 64 hex characters is refused, never replaced.
 */
export async function loadPhpSiteKeySecret(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): Promise<Uint8Array> {
  const path = phpSiteKeySecretPath(layout);
  let text: string;
  try {
    text = (await Deno.readTextFile(path)).trim();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const tmp = join(dirname(path), `.${SECRET_FILE}.${crypto.randomUUID()}`);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(tmp, `${fresh}\n`, {
      mode: 0o600,
      createNew: true,
    });
    try {
      await Deno.rename(tmp, path);
    } catch (renameError) {
      await Deno.remove(tmp).catch(() => undefined);
      throw renameError;
    }
    text = fresh;
  }
  if (!SECRET_HEX.test(text)) {
    throw new Error(`site key secret ${path} is not 64 hex characters`);
  }
  return fromHex(text);
}

const secrets = new Map<string, Promise<Uint8Array>>();

/** `loadPhpSiteKeySecret` once per process and state folder. */
export function cachedPhpSiteKeySecret(
  layout: Pick<LayoutPaths, "daemonStateDir">,
): Promise<Uint8Array> {
  const path = phpSiteKeySecretPath(layout);
  let pending = secrets.get(path);
  if (!pending) {
    pending = loadPhpSiteKeySecret(layout);
    pending.catch(() => secrets.delete(path));
    secrets.set(path, pending);
  }
  return pending;
}

/** Hex HMAC-SHA256 of `"tp-site-php-key-v1\n" + runtimeId` under the secret. */
export async function phpSiteKey(
  secret: Uint8Array,
  runtimeId: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`tp-site-php-key-v1\n${runtimeId}`),
  );
  return toHex(new Uint8Array(mac));
}
