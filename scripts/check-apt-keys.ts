/**
 * Scheduled drift check for the apt signing keys bundled in
 * `orchestration/apt-keys/`. For each entry in keys.json it fetches the live key
 * from the vendor URL and reports when the bytes differ from the bundled copy or
 * when the recorded expiry is within 60 days. Exit 1 on any finding.
 *
 * Run: deno run --allow-read --allow-net scripts/check-apt-keys.ts
 */
import { encodeHex } from "@std/encoding/hex";
import { join } from "@std/path";

export type AptKeyEntry = {
  url: string;
  bundled: string;
  fingerprints: string[];
  expires: string;
};

const SIXTY_DAYS_MS = 60 * 86_400_000;

async function sha256(bytes: Uint8Array): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
  );
}

export async function checkAptKeys(
  keysDir: string,
  fetchBytes: (url: string) => Promise<Uint8Array> = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  now = Date.now(),
): Promise<string[]> {
  const entries = JSON.parse(
    await Deno.readTextFile(join(keysDir, "keys.json")),
  ) as Record<string, AptKeyEntry>;
  const findings: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    const bundled = await Deno.readFile(join(keysDir, entry.bundled));
    if (Date.parse(entry.expires) - now < SIXTY_DAYS_MS) {
      findings.push(`${name}: key expires ${entry.expires} (within 60 days)`);
    }
    try {
      const live = await fetchBytes(entry.url);
      if (await sha256(live) !== await sha256(bundled)) {
        findings.push(
          `${name}: live key at ${entry.url} differs from the bundled copy; ` +
            "check the fingerprint with the vendor, then refresh the file and fingerprints in orchestration/apt-keys",
        );
      }
    } catch (error) {
      findings.push(
        `${name}: could not fetch ${entry.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return findings;
}

if (import.meta.main) {
  const dir = new URL("../orchestration/apt-keys", import.meta.url).pathname;
  const findings = await checkAptKeys(dir);
  for (const f of findings) console.error(`apt key drift: ${f}`);
  if (findings.length > 0) Deno.exit(1);
  console.log("apt keys match their bundled copies");
}
