import { assertEquals } from "@std/assert";
import { ORCHESTRATE_HELPER } from "./assets.ts";
import {
  galaxyDockerRoleHelperInvocation,
  playbooksNeedRootHelper,
  privilegedPlaybookInvocation,
} from "./privileged.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("playbooksNeedRootHelper: managed + unprivileged only", () => {
  assertEquals(
    playbooksNeedRootHelper({ installMode: "production", uid: 9999 }),
    true,
  );
  // root (the installer's run-installer verb) runs ansible-playbook directly
  assertEquals(
    playbooksNeedRootHelper({ installMode: "production", uid: 0 }),
    false,
  );
  // development keeps `become` (the dev user holds full sudo)
  assertEquals(
    playbooksNeedRootHelper({ installMode: "development", uid: 1000 }),
    false,
  );
  // an unknown uid on a managed host is treated as unprivileged
  assertEquals(
    playbooksNeedRootHelper({ installMode: "production", uid: null }),
    true,
  );
});

test("privilegedPlaybookInvocation routes managed hosts through sudo -n tp-orchestrate playbook", () => {
  const args = ["-i", "localhost,", "-c", "local", "-e", "a=b", "/x/p.yml"];
  assertEquals(
    privilegedPlaybookInvocation("/v/ansible-playbook", args, {
      installMode: "production",
      uid: 9999,
    }),
    {
      bin: "sudo",
      args: ["-n", "--", ORCHESTRATE_HELPER, "playbook", ...args],
    },
  );
  assertEquals(
    privilegedPlaybookInvocation("/v/ansible-playbook", args, {
      installMode: "development",
      uid: 1000,
    }),
    { bin: "/v/ansible-playbook", args },
  );
});

test("the helper lives inside the orchestration tree, never under a daemon-writable path", () => {
  assertEquals(ORCHESTRATE_HELPER.endsWith("/scripts/tp-orchestrate"), true);
  assertEquals(galaxyDockerRoleHelperInvocation(), {
    bin: "sudo",
    args: ["-n", "--", ORCHESTRATE_HELPER, "galaxy-docker-role"],
  });
});
