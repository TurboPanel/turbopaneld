import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { EnvironmentDeployComposeCheckout } from "../contracts/commands-contracts.ts";
import type { CheckoutParams } from "./release/checkout.ts";
import { applyComposeCheckout } from "./compose-checkout.ts";
import { readComposeCheckoutMarker } from "./compose-checkout-marker.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

const CHECKOUT: EnvironmentDeployComposeCheckout = {
  sourceId: "00000000-0000-4000-8000-000000000002",
  provider: "github",
  cloneUrl: "https://git.example.net/acme/stack.git",
  ref: "main",
  commitSha: SHA_A,
  composePath: "deploy/compose.yaml",
};

/** A fake clone: writes the files the repository "has" and a `.git` folder. */
function fakeClone(
  files: Record<string, string>,
  seen: CheckoutParams[] = [],
) {
  return async (params: CheckoutParams) => {
    seen.push(params);
    const workingDir = join(params.scratchDir, "source");
    await Deno.mkdir(join(workingDir, ".git"), { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      await Deno.mkdir(join(workingDir, path, ".."), { recursive: true });
      await Deno.writeTextFile(join(workingDir, path), text);
    }
    return { workingDir, commitSha: params.commitSha };
  };
}

/** The clone's scratch folder: a sibling of the deployment, never inside it. */
const scratchFor = (dir: string) => `${dir}-scratch`;

async function inTempDeployment(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-compose-checkout-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(scratchFor(dir), { recursive: true }).catch(() => {});
  }
}

test("the repository lands in repo/<commit>, without .git, and the commit is recorded", () =>
  inTempDeployment(async (dir) => {
    const outcome = await applyComposeCheckout(dir, CHECKOUT, {
      scratchDir: scratchFor(dir),
      decryptSecrets: undefined,
      checkoutFn: fakeClone({
        "deploy/compose.yaml": "services: {}\n",
        "vpn/Dockerfile": "FROM scratch\n",
      }),
    });
    assertEquals(outcome.fetched, true);
    assertEquals(outcome.projectDir, join(dir, "repo", SHA_A, "deploy"));
    assertEquals(
      await Deno.readTextFile(join(dir, "repo", SHA_A, "vpn", "Dockerfile")),
      "FROM scratch\n",
    );
    await assertRejects(() => Deno.stat(join(dir, "repo", SHA_A, ".git")));
    await assertRejects(() => Deno.stat(scratchFor(dir)));
    assertEquals((await readComposeCheckoutMarker(dir))?.commitSha, SHA_A);
    // A repo file named compose.yaml never collides with the compiled file.
    await assertRejects(() => Deno.stat(join(dir, "compose.yaml")));
  }));

test("the same commit is not fetched twice, a new one gets its own folder", () =>
  inTempDeployment(async (dir) => {
    const seen: CheckoutParams[] = [];
    const deps = {
      scratchDir: scratchFor(dir),
      decryptSecrets: undefined,
      checkoutFn: fakeClone({ "deploy/compose.yaml": "a\n" }, seen),
    };
    await applyComposeCheckout(dir, CHECKOUT, deps);
    const again = await applyComposeCheckout(dir, CHECKOUT, deps);
    assertEquals(again.fetched, false);
    assertEquals(seen.length, 1);

    await Deno.writeTextFile(join(dir, "repo", SHA_A, "kept.txt"), "old");
    const next = await applyComposeCheckout(
      dir,
      { ...CHECKOUT, commitSha: SHA_B },
      deps,
    );
    assertEquals(next.fetched, true);
    assertEquals(seen.length, 2);
    // The earlier generation is untouched: its containers may still run from it.
    assertEquals(
      await Deno.readTextFile(join(dir, "repo", SHA_A, "kept.txt")),
      "old",
    );
    assertEquals(next.root, join(dir, "repo", SHA_B));
    assertEquals((await readComposeCheckoutMarker(dir))?.commitSha, SHA_B);

    // A rollback to the older commit reuses its folder without a fetch.
    const back = await applyComposeCheckout(dir, CHECKOUT, deps);
    assertEquals(back.fetched, false);
    assertEquals(seen.length, 2);
    assertEquals((await readComposeCheckoutMarker(dir))?.commitSha, SHA_A);
  }));

test("a repository without the compose file is refused and the old tree stays", () =>
  inTempDeployment(async (dir) => {
    await applyComposeCheckout(dir, CHECKOUT, {
      scratchDir: scratchFor(dir),
      decryptSecrets: undefined,
      checkoutFn: fakeClone({ "deploy/compose.yaml": "a\n" }),
    });
    const err = await assertRejects(
      () =>
        applyComposeCheckout(dir, { ...CHECKOUT, commitSha: SHA_B }, {
          scratchDir: scratchFor(dir),
          decryptSecrets: undefined,
          checkoutFn: fakeClone({ "other.txt": "x" }),
        }),
      Error,
    );
    assert(
      err.message.includes("deploy/compose.yaml is not in the repository"),
    );
    assertEquals((await readComposeCheckoutMarker(dir))?.commitSha, SHA_A);
    assertEquals(
      await Deno.readTextFile(
        join(dir, "repo", SHA_A, "deploy", "compose.yaml"),
      ),
      "a\n",
    );
    await assertRejects(() => Deno.stat(scratchFor(dir)));
  }));

test("the sealed credential is decrypted and handed to the clone", () =>
  inTempDeployment(async (dir) => {
    const seen: CheckoutParams[] = [];
    await applyComposeCheckout(
      dir,
      {
        ...CHECKOUT,
        credential: "sealed",
        credentialKind: "token",
        credentialUsername: "oauth2",
      },
      {
        scratchDir: scratchFor(dir),
        decryptSecrets: (envelopes) =>
          Promise.resolve(envelopes.map((e) => `plain-of-${e}`)),
        checkoutFn: fakeClone({ "deploy/compose.yaml": "a\n" }, seen),
      },
    );
    assertEquals(seen[0].credential, "plain-of-sealed");
    assertEquals(seen[0].credentialKind, "token");
    assertEquals(seen[0].credentialUsername, "oauth2");
    assertEquals(seen[0].cloneUrl, CHECKOUT.cloneUrl);
  }));

test("a credential with no way to decrypt it fails before any clone", () =>
  inTempDeployment(async (dir) => {
    const seen: CheckoutParams[] = [];
    await assertRejects(
      () =>
        applyComposeCheckout(
          dir,
          { ...CHECKOUT, credential: "sealed", credentialKind: "token" },
          {
            scratchDir: scratchFor(dir),
            decryptSecrets: undefined,
            checkoutFn: fakeClone({}, seen),
          },
        ),
      Error,
      "secrets decrypt is unavailable",
    );
    assertEquals(seen.length, 0);
  }));

test("build contexts next to the compose file exist at the project directory", () =>
  inTempDeployment(async (dir) => {
    // A stack whose services set `build: ./vpn` with a local `image:`, as in
    // a VPN plus torrent client project: the folders must be on the host.
    const layouts = [
      ["compose.yaml", SHA_A],
      ["stack/compose.yaml", SHA_B],
    ];
    for (const [composePath, commitSha] of layouts) {
      const base = composePath === "compose.yaml" ? "" : "stack/";
      const outcome = await applyComposeCheckout(
        dir,
        { ...CHECKOUT, composePath, commitSha },
        {
          scratchDir: scratchFor(dir),
          decryptSecrets: undefined,
          checkoutFn: fakeClone({
            [composePath]: "services: {}\n",
            [`${base}vpn/Dockerfile`]: "FROM scratch\n",
            [`${base}qbittorrent/Dockerfile`]: "FROM scratch\n",
          }),
        },
      );
      for (const context of ["vpn", "qbittorrent"]) {
        const info = await Deno.stat(join(outcome.projectDir, context));
        assert(info.isDirectory, `${context} exists at ${outcome.projectDir}`);
      }
    }
  }));
