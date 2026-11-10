/**
 * This server's own ACME account, one per certificate authority directory:
 * `<state>/tenant-acme/account/<directory host>.json` (folder 0700, file
 * 0600, written by the daemon account and renamed into place). The file holds
 * the account key PEM and the account address the authority gave it.
 *
 * It sits beside the per-request folders that `sweepTenantAcme` clears at
 * start-up (`requests/`, `caddy/certificates/`), never inside them, so the
 * account survives restarts. `scripts/purge.sh` removes the state tree whole.
 */
import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { withKeyedLock } from "../../util/keyed-lock.ts";
import { writeAll } from "../../util/write-all.ts";
import { AcmeClient } from "./client.ts";
import { generateAccountKeyPem, importAccountKey } from "./jws.ts";

type StoredAccount = {
  v: 1;
  directoryUrl: string;
  accountUrl: string | null;
  keyPem: string;
};

export function acmeAccountDir(layout: Pick<LayoutPaths, "stateDir">): string {
  return join(layout.stateDir, "tenant-acme", "account");
}

/**
 * The file for one directory, named by its host
 * (`acme-v02.api.letsencrypt.org.json`).
 */
export function acmeAccountPath(
  layout: Pick<LayoutPaths, "stateDir">,
  directoryUrl: string,
): string {
  const host = new URL(directoryUrl).host.replaceAll(/[^A-Za-z0-9.-]/g, "_");
  return join(acmeAccountDir(layout), `${host}.json`);
}

function readStored(text: string, directoryUrl: string): StoredAccount | null {
  try {
    const raw = JSON.parse(text) as Partial<StoredAccount>;
    if (
      raw.v !== 1 || raw.directoryUrl !== directoryUrl ||
      typeof raw.keyPem !== "string"
    ) return null;
    return {
      v: 1,
      directoryUrl,
      accountUrl: typeof raw.accountUrl === "string" ? raw.accountUrl : null,
      keyPem: raw.keyPem,
    };
  } catch {
    return null;
  }
}

async function loadStored(
  path: string,
  directoryUrl: string,
): Promise<StoredAccount | null> {
  try {
    return readStored(await Deno.readTextFile(path), directoryUrl);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

/** Write the file whole and flushed to disk before it replaces the old one. */
async function saveStored(path: string, value: StoredAccount): Promise<void> {
  const dir = join(path, "..");
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.chmod(dir, 0o700);
  const temp = `${path}.tpnew`;
  const file = await Deno.open(temp, {
    write: true,
    create: true,
    truncate: true,
    mode: 0o600,
  });
  try {
    await writeAll(
      file,
      new TextEncoder().encode(`${JSON.stringify(value)}\n`),
    );
    await file.sync();
  } finally {
    file.close();
  }
  await Deno.chmod(temp, 0o600);
  await Deno.rename(temp, path);
}

function lockKey(path: string): string {
  return `acme-account:${path}`;
}

export type AcmeAccountOptions = {
  directoryUrl: string;
  /** `mailto:` is added; empty means no contact. */
  contactEmail?: string;
  fetch?: typeof fetch;
};

/**
 * A ready client with a registered account for the directory: the stored one
 * when there is one, otherwise a new key registered once and saved. The key is
 * saved before it is registered, so a crash in between reuses the same key and
 * the authority hands back the same account.
 */
export function acmeAccountClient(
  layout: Pick<LayoutPaths, "stateDir">,
  options: AcmeAccountOptions,
): Promise<AcmeClient> {
  const path = acmeAccountPath(layout, options.directoryUrl);
  return withKeyedLock(lockKey(path), async () => {
    let stored = await loadStored(path, options.directoryUrl);
    if (!stored) {
      stored = {
        v: 1,
        directoryUrl: options.directoryUrl,
        accountUrl: null,
        keyPem: await generateAccountKeyPem(),
      };
      await saveStored(path, stored);
    }
    const client = new AcmeClient({
      directoryUrl: options.directoryUrl,
      key: await importAccountKey(stored.keyPem),
      accountUrl: stored.accountUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (stored.accountUrl) return client;
    const email = options.contactEmail?.trim();
    const accountUrl = await client.ensureAccount(
      email ? [`mailto:${email}`] : [],
    );
    await saveStored(path, { ...stored, accountUrl });
    return client;
  });
}

/**
 * Forget the account so the next order registers a new one (the authority said
 * it is gone).
 */
export function forgetAcmeAccount(
  layout: Pick<LayoutPaths, "stateDir">,
  directoryUrl: string,
): Promise<void> {
  const path = acmeAccountPath(layout, directoryUrl);
  // The same lock as loading, so a registration in flight is never undone half
  // way.
  return withKeyedLock(lockKey(path), async () => {
    try {
      await Deno.remove(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  });
}
