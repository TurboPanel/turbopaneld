import { assertEquals } from "@std/assert";
import { join } from "@std/path";

const test = Deno.test.bind(Deno);
const HELPER =
  new URL("../../orchestration/scripts/tp-apt-key", import.meta.url)
    .pathname;
const BUNDLED_KEYS = new URL("../../orchestration/apt-keys", import.meta.url)
  .pathname;

/** Fake gpg: reads "fpr=<FPR> exp=<epoch>" from the key file's text. */
const FAKE_GPG = `#!/bin/sh
for last; do :; done
line=$(cat "$last")
fpr=\${line#fpr=}; fpr=\${fpr%% *}
exp=\${line##*exp=}
echo "pub:-:3072:1:AAAA:1:$exp::-:::scESC::::::23::0:"
echo "fpr:::::::::$fpr:"
`;

async function setup(opts: {
  live?: string;
  bundled?: string;
}) {
  const dir = await Deno.makeTempDir();
  const keys = join(dir, "keys");
  await Deno.mkdir(keys);
  const far = Math.floor(Date.now() / 1000) + 3 * 365 * 86400;
  const bundled = opts.bundled ?? `fpr=AA11 exp=${far}`;
  await Deno.writeTextFile(join(keys, "k.gpg"), bundled);
  const livePath = join(dir, "live.gpg");
  if (opts.live !== undefined) await Deno.writeTextFile(livePath, opts.live);
  await Deno.writeTextFile(
    join(keys, "keys.json"),
    JSON.stringify({
      demo: {
        url: `file://${livePath}`,
        bundled: "k.gpg",
        fingerprints: ["AA11"],
        expires: "2030-01-01",
      },
    }),
  );
  const gpg = join(dir, "gpg");
  await Deno.writeTextFile(gpg, FAKE_GPG);
  await Deno.chmod(gpg, 0o755);
  return { dir, keys, gpg, dest: join(dir, "out.gpg"), far };
}

async function run(
  s: Awaited<ReturnType<typeof setup>>,
  policy: string,
) {
  const out = await new Deno.Command("python3", {
    args: [
      "-I",
      HELPER,
      "demo",
      s.dest,
      "--policy",
      policy,
      "--keys-dir",
      s.keys,
    ],
    env: { TP_GPG: s.gpg },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

test("a matching live key installs silently", async () => {
  const s = await setup({ live: `fpr=AA11 exp=9999999999` });
  const r = await run(s, "warn");
  assertEquals([r.code, r.stderr], [0, ""]);
  assertEquals(await Deno.readTextFile(s.dest), "fpr=AA11 exp=9999999999");
});

test("a changed fingerprint warns and proceeds under warn, refuses under enforce", async () => {
  const s = await setup({ live: `fpr=BB22 exp=9999999999` });
  const warn = await run(s, "warn");
  assertEquals(warn.code, 0);
  assertEquals(warn.stderr.includes("WARN tp-apt-key: fingerprint"), true);
  assertEquals(await Deno.readTextFile(s.dest), "fpr=BB22 exp=9999999999");
  await Deno.remove(s.dest);
  const enforce = await run(s, "enforce");
  assertEquals(enforce.code, 1);
  assertEquals(enforce.stderr.includes("update the list in"), true);
});

test("an unreachable vendor falls back to the bundled copy unless enforced", async () => {
  const s = await setup({});
  const r = await run(s, "warn");
  assertEquals(r.code, 0);
  assertEquals(r.stdout.includes("bundled copy"), true);
  assertEquals((await run(s, "enforce")).code, 1);
});

test("policy bundled never fetches", async () => {
  const s = await setup({ live: `fpr=BB22 exp=9999999999` });
  const r = await run(s, "bundled");
  assertEquals([r.code, r.stderr], [0, ""]);
  assertEquals((await Deno.readTextFile(s.dest)).startsWith("fpr=AA11"), true);
});

test("an expired live key loses to a good bundled copy and near expiry warns", async () => {
  const s = await setup({ live: `fpr=AA11 exp=1000` });
  const r = await run(s, "warn");
  assertEquals(r.stderr.includes("expired or near expiry"), true);
  assertEquals(
    (await Deno.readTextFile(s.dest)).startsWith("fpr=AA11 exp=" + s.far),
    true,
  );
  const soon = Math.floor(Date.now() / 1000) + 10 * 86400;
  const t = await setup({ bundled: `fpr=AA11 exp=${soon}` });
  const r2 = await run(t, "bundled");
  assertEquals(r2.stderr.includes("within 60 days"), true);
});

test("the shipped keys.json lists the bundled file and a fingerprint", async () => {
  const meta = JSON.parse(
    await Deno.readTextFile(join(BUNDLED_KEYS, "keys.json")),
  );
  for (const entry of Object.values(meta) as Array<Record<string, unknown>>) {
    await Deno.stat(join(BUNDLED_KEYS, String(entry.bundled)));
    assertEquals((entry.fingerprints as string[]).length > 0, true);
  }
});
