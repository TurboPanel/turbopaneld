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

async function inTempDeployment(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-compose-checkout-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("the repository lands in repo/, without .git, and the commit is recorded", () =>
  inTempDeployment(async (dir) => {
    const outcome = await applyComposeCheckout(dir, CHECKOUT, {
      decryptSecrets: undefined,
      checkoutFn: fakeClone({
        "deploy/compose.yaml": "services: {}\n",
        "vpn/Dockerfile": "FROM scratch\n",
      }),
    });
    assertEquals(outcome.fetched, true);
    assertEquals(outcome.projectDir, join(dir, "repo", "deploy"));
    assertEquals(
      await Deno.readTextFile(join(dir, "repo", "vpn", "Dockerfile")),
      "FROM scratch\n",
    );
    await assertRejects(() => Deno.stat(join(dir, "repo", ".git")));
    await assertRejects(() => Deno.stat(join(dir, ".checkout-scratch")));
    assertEquals((await readComposeCheckoutMarker(dir))?.commitSha, SHA_A);
    // A repo file named compose.yaml never collides with the compiled file.
    await assertRejects(() => Deno.stat(join(dir, "compose.yaml")));
  }));

test("the same commit is not fetched twice, a new one replaces the tree", () =>
  inTempDeployment(async (dir) => {
    const seen: CheckoutParams[] = [];
    const deps = {
      decryptSecrets: undefined,
      checkoutFn: fakeClone({ "deploy/compose.yaml": "a\n" }, seen),
    };
    await applyComposeCheckout(dir, CHECKOUT, deps);
    const again = await applyComposeCheckout(dir, CHECKOUT, deps);
    assertEquals(again.fetched, false);
    assertEquals(seen.length, 1);

    await Deno.writeTextFile(join(dir, "repo", "stale.txt"), "old");
    const next = await applyComposeCheckout(
      dir,
      { ...CHECKOUT, commitSha: SHA_B },
      deps,
    );
    assertEquals(next.fetched, true);
    assertEquals(seen.length, 2);
    await assertRejects(() => Deno.stat(join(dir, "repo", "stale.txt")));
    assertEquals((await readComposeCheckoutMarker(dir))?.commitSha, SHA_B);
    await assertRejects(() => Deno.stat(join(dir, ".repo-previous")));
  }));

test("a repository without the compose file is refused and the old tree stays", () =>
  inTempDeployment(async (dir) => {
    await applyComposeCheckout(dir, CHECKOUT, {
      decryptSecrets: undefined,
      checkoutFn: fakeClone({ "deploy/compose.yaml": "a\n" }),
    });
    const err = await assertRejects(
      () =>
        applyComposeCheckout(dir, { ...CHECKOUT, commitSha: SHA_B }, {
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
      await Deno.readTextFile(join(dir, "repo", "deploy", "compose.yaml")),
      "a\n",
    );
    await assertRejects(() => Deno.stat(join(dir, ".checkout-scratch")));
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
            decryptSecrets: undefined,
            checkoutFn: fakeClone({}, seen),
          },
        ),
      Error,
      "secrets decrypt is unavailable",
    );
    assertEquals(seen.length, 0);
  }));
