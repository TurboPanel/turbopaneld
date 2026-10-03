import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertComposeBuildPolicy,
  type BuildPolicyCode,
  collectBuildPolicyFindings,
  ComposeBuildPolicyError,
  ipScope,
} from "./compose-build-policy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const STAGE = "/state/deployments/p/e/.staging";

/** A resolved model with one service `web` building `build`. */
function model(build: unknown, extra: Record<string, unknown> = {}) {
  return { services: { web: { image: "x", build } }, ...extra };
}

function codes(
  document: Record<string, unknown>,
  exempt: string[] = [],
): BuildPolicyCode[] {
  return collectBuildPolicyFindings(document, {
    stageDir: STAGE,
    exemptSecretNames: new Set(exempt),
  }).map((f) => f.code);
}

const REFUSED: Array<
  [string, unknown, BuildPolicyCode, Record<string, unknown>?]
> = [
  ["network host", { network: "host" }, "build_network_refused"],
  ["a container network", { network: "container:db" }, "build_network_refused"],
  ["privileged", { privileged: true }, "build_privileged_refused"],
  [
    "entitlements",
    { entitlements: ["network.host"] },
    "build_entitlements_refused",
  ],
  ["empty entitlements", { entitlements: [] }, "build_entitlements_refused"],
  ["ssh agent, list", { ssh: ["default"] }, "build_ssh_refused"],
  ["ssh agent, empty path", { ssh: ["default="] }, "build_ssh_refused"],
  ["ssh agent, map", { ssh: { default: "" } }, "build_ssh_refused"],
  ["ssh agent, scalar", { ssh: "github" }, "build_ssh_refused"],
  [
    "a secret file outside",
    { secrets: [{ source: "k", target: "k" }] },
    "build_secret_outside_project",
    { secrets: { k: { file: "/root/.aws/credentials" } } },
  ],
  [
    "a secret file climbing out",
    { secrets: ["k"] },
    "build_secret_outside_project",
    { secrets: { k: { file: `${STAGE}/../../other/k` } } },
  ],
  [
    "a sibling that only shares the prefix",
    { secrets: ["k"] },
    "build_secret_outside_project",
    { secrets: { k: { file: `${STAGE}-evil/k` } } },
  ],
  [
    "extra host on metadata",
    { extra_hosts: ["m=169.254.169.254"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on loopback, colon form",
    { extra_hosts: ["l:127.0.0.53"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on IPv6 loopback, map",
    { extra_hosts: { l: "::1" } },
    "build_extra_host_internal",
  ],
  [
    "extra host on a mapped loopback, map of lists",
    { extra_hosts: { l: ["::ffff:127.0.0.1"] } },
    "build_extra_host_internal",
  ],
  [
    "extra host on link-local IPv6",
    { extra_hosts: ["l=[fe80::1%eth0]"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on AWS IPv6 metadata",
    { extra_hosts: ["m=fd00:ec2::254"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on Alibaba metadata",
    { extra_hosts: ["m=100.100.100.200"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on unspecified",
    { extra_hosts: ["z=0.0.0.0"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on host-gateway",
    { extra_hosts: ["host.docker.internal=host-gateway"] },
    "build_extra_host_internal",
  ],
  [
    "extra host on a name",
    { extra_hosts: ["x=metadata.google.internal"] },
    "build_extra_host_internal",
  ],
  [
    "a remote context on metadata",
    "http://169.254.169.254/latest/",
    "build_context_internal_url",
  ],
  [
    "a remote context on loopback",
    { context: "https://127.0.0.1/x.tar" },
    "build_context_internal_url",
  ],
  [
    "a remote context on RFC 1918",
    { context: "https://192.168.1.10/x.git" },
    "build_context_internal_url",
  ],
  [
    "a remote context on a decimal host",
    { context: "http://2130706433/x" },
    "build_context_internal_url",
  ],
  [
    "a git context on a hex host",
    { context: "git://0x7f.1/x.git" },
    "build_context_internal_url",
  ],
  [
    "a remote context on localhost",
    { context: "https://localhost:8080/x.git" },
    "build_context_internal_url",
  ],
  [
    "a remote context on a single-label name",
    { context: "ssh://gitlab/x.git" },
    "build_context_internal_url",
  ],
  [
    "a git@ context on loopback",
    { context: "git@127.0.0.1:x/y.git" },
    "build_context_internal_url",
  ],
  [
    "an additional context on IPv6 loopback",
    { additional_contexts: { a: "https://[::1]/x" } },
    "build_context_internal_url",
  ],
];

for (const [what, build, code, extra] of REFUSED) {
  test(`build policy refuses ${what}`, () => {
    assertEquals(codes(model(build, extra)), [code]);
  });
}

const ALLOWED: Array<[string, unknown, Record<string, unknown>?]> = [
  ["no build", undefined],
  ["a local context", `${STAGE}/app`],
  ["network none", { network: "none" }],
  ["network default", { network: "default" }],
  ["privileged false", { privileged: false }],
  ["an ssh key path", { ssh: [`key=${STAGE}/k`] }],
  ["an ssh key map", { ssh: { key: `${STAGE}/k` } }],
  [
    "a secret file inside",
    { secrets: [{ source: "k" }] },
    { secrets: { k: { file: `${STAGE}/k.txt` } } },
  ],
  [
    "a relative secret file inside",
    { secrets: ["k"] },
    { secrets: { k: { file: "k.txt" } } },
  ],
  [
    "an environment-sourced secret",
    { secrets: ["k"] },
    { secrets: { k: { environment: "TOKEN" } } },
  ],
  [
    "extra hosts on public and private addresses",
    { extra_hosts: ["a=203.0.113.7", "b:10.1.2.3", "c=[2001:db8::1]"] },
  ],
  ["a public remote context", "https://github.com/example/api.git#main"],
  ["a git@ context on a public host", { context: "git@github.com:x/y.git" }],
  [
    "image and layout additional contexts",
    {
      additional_contexts: {
        a: "docker-image://alpine",
        b: "oci-layout:///srv/oci",
        c: `${STAGE}/vendor`,
      },
    },
  ],
];

for (const [what, build, extra] of ALLOWED) {
  test(`build policy allows ${what}`, () => {
    assertEquals(codes(model(build, extra)), []);
  });
}

test("a secret the daemon rewrote to its run directory is exempt", () => {
  const doc = model({ secrets: ["DB"] }, {
    secrets: { DB: { file: "/run/turbopanel/deployments/p/e/secrets/db" } },
  });
  assertEquals(codes(doc), ["build_secret_outside_project"]);
  assertEquals(codes(doc, ["DB"]), []);
});

test("every rule reports, in service order, and the error carries the codes", () => {
  const doc = {
    services: {
      a: {
        build: {
          network: "host",
          privileged: true,
          entitlements: ["security.insecure"],
          ssh: ["default"],
          extra_hosts: ["gw=host-gateway"],
          context: "http://10.0.0.1/x",
        },
      },
      b: "not a mapping",
      c: { image: "x" },
    },
  };
  const err = assertThrows(
    () => assertComposeBuildPolicy(doc, { stageDir: STAGE }),
    ComposeBuildPolicyError,
  );
  assertEquals(err.codes, [
    "build_network_refused",
    "build_privileged_refused",
    "build_entitlements_refused",
    "build_ssh_refused",
    "build_extra_host_internal",
    "build_context_internal_url",
  ]);
  assert(err.message.includes("[build_network_refused] service a"));
  assert(err.message.includes("whatever the organization allows"));
  assertComposeBuildPolicy({ services: { c: { image: "x" } } }, {
    stageDir: STAGE,
  });
});

test("ipScope classifies literals and rejects non-literals", () => {
  assertEquals(ipScope("8.8.8.8"), "public");
  assertEquals(ipScope("172.20.0.1"), "private");
  assertEquals(ipScope("100.64.0.1"), "private");
  assertEquals(ipScope("fd12::1"), "private");
  assertEquals(ipScope("64:ff9b::7f00:1"), "internal");
  assertEquals(ipScope("::"), "internal");
  assertEquals(ipScope("ff02::1"), "internal");
  assertEquals(ipScope("255.255.255.255"), "internal");
  assertEquals(ipScope("2001:db8::1"), "public");
  for (const bad of ["example.com", "1.2.3", "1.2.3.256", "1::2::3", "g::1"]) {
    assertEquals(ipScope(bad), null, bad);
  }
  assertEquals(ipScope("1:2:3:4:5:6:7:8"), "public");
  assertEquals(ipScope("1:2:3:4:5:6:7"), null);
});
