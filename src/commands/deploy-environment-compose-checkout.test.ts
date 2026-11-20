import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createNoopCommandOutputSink } from "../logs/contracts.ts";
import { parseEnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import type { CheckoutParams } from "../deploy/release/checkout.ts";
import { readComposeCheckoutMarker } from "../deploy/compose-checkout-marker.ts";
import { applyDeployComposeCheckout } from "./deploy-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BASE = {
  environmentId: "env-1",
  projectId: "proj-1",
  organizationId: "org-1",
  projectName: "demo",
  composeFiles: [{
    filename: "compose.yaml",
    role: "runtime" as const,
    content: "services:\n  web:\n    image: nginx\n",
  }],
  hostings: [] as unknown[],
};

const CHECKOUT = {
  sourceId: "00000000-0000-4000-8000-000000000002",
  provider: "github" as const,
  cloneUrl: "https://git.example.net/acme/stack.git",
  ref: "main",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  composePath: "compose.yaml",
};

async function fakeClone(params: CheckoutParams) {
  const workingDir = join(params.scratchDir, "source");
  await Deno.mkdir(workingDir, { recursive: true });
  await Deno.writeTextFile(join(workingDir, "compose.yaml"), "services: {}\n");
  return { workingDir, commitSha: params.commitSha };
}

async function inTempDeployment(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "tp-deploy-checkout-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const deps = () => ({
  logSink: createNoopCommandOutputSink(),
  decryptSecrets: undefined,
  checkoutFn: fakeClone,
});

test("a deploy with composeCheckout puts the repository on the host", () =>
  inTempDeployment(async (dir) => {
    await applyDeployComposeCheckout(
      parseEnvironmentDeployPayload({ ...BASE, composeCheckout: CHECKOUT }),
      dir,
      deps(),
    );
    assertEquals(
      (await readComposeCheckoutMarker(dir))?.commitSha,
      CHECKOUT.commitSha,
    );
    assertEquals(
      (await Deno.stat(join(dir, "repo", "compose.yaml"))).isFile,
      true,
    );
  }));

test("a deploy without composeCheckout drops an earlier checkout", () =>
  inTempDeployment(async (dir) => {
    await applyDeployComposeCheckout(
      parseEnvironmentDeployPayload({ ...BASE, composeCheckout: CHECKOUT }),
      dir,
      deps(),
    );
    await applyDeployComposeCheckout(
      parseEnvironmentDeployPayload(BASE),
      dir,
      deps(),
    );
    assertEquals(await readComposeCheckoutMarker(dir), null);
    assertEquals(
      await Deno.stat(join(dir, "repo")).then(() => true, () => false),
      false,
    );
  }));

test("a hostings-only run neither fetches nor drops the checkout", () =>
  inTempDeployment(async (dir) => {
    await applyDeployComposeCheckout(
      parseEnvironmentDeployPayload({ ...BASE, composeCheckout: CHECKOUT }),
      dir,
      deps(),
    );
    await applyDeployComposeCheckout(
      parseEnvironmentDeployPayload({ ...BASE, hostingsOnly: true }),
      dir,
      deps(),
    );
    assertEquals(
      (await readComposeCheckoutMarker(dir))?.commitSha,
      CHECKOUT.commitSha,
    );
  }));
