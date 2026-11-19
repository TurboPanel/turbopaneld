import { assertEquals } from "@std/assert";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import { releasesForManifest } from "./deploy-environment.ts";

const test = Deno.test.bind(Deno);

const payloadWith = (commitSha: string) =>
  ({
    sourceMaterial: [{
      sourceId: "src-1",
      composeServiceName: "web",
      releaseServiceId: "svc-web",
      provider: "github",
      cloneUrl: "https://example.test/repo.git",
      ref: "main",
      commitSha,
      releaseId: "rel-new",
      build: { kind: "native" },
    }],
  }) as unknown as EnvironmentDeployPayload;

test("a release row leaves commitSha out when only a branch name is known", () => {
  const [row] = releasesForManifest(payloadWith("main"));
  assertEquals(row?.releaseId, "rel-new");
  assertEquals("commitSha" in (row ?? {}), false);
});

test("a release row keeps a resolved payload commit id", () => {
  const sha = "c".repeat(40);
  const [row] = releasesForManifest(payloadWith(sha));
  assertEquals(row?.commitSha, sha);
});
