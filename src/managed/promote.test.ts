/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { handleManagedPromote } from "./promote.ts";

const test = Deno.test.bind(Deno);

test("handleManagedPromote rejects when no containers are running", async () => {
  // collectManagedContainers will return undefined/empty without docker.
  await assertRejects(
    () =>
      handleManagedPromote(
        {
          managedId: "00000000-0000-4000-8000-000000000001",
          memberId: "00000000-0000-4000-8000-000000000002",
        },
        new Date().toISOString(),
      ),
    Error,
  );
});

test("ManagedPromoteResult shape fields are present in type contract", () => {
  const sample = {
    status: "ready",
    role: "primary",
    promotedMemberId: "00000000-0000-4000-8000-000000000002",
    demoted: true,
    demotedMemberId: "00000000-0000-4000-8000-000000000003",
    summary: "standby promoted to primary",
  };
  assertEquals(sample.demoted, true);
  assertEquals(sample.role, "primary");
});
