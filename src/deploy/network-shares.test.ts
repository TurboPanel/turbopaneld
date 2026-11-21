import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { assertComposePolicy } from "./compose-final-policy.ts";
import {
  describeNetworkShare,
  hasNetworkShares,
  mountOptionPasswords,
  networkSharePasswords,
  redactMountOptions,
  shareHostRefusal,
  splitMountOptions,
} from "./network-shares.ts";
import { collectComposePolicyFindings } from "./compose-final-policy.ts";

const test = Deno.test.bind(Deno);

const DIR = "/srv/tp/deploy/env-1";
const ALLOW = { allowNetworkShares: true, deploymentDir: DIR };

function doc(
  opts: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    services: { web: { image: "alpine" } },
    volumes: { media: { driver_opts: { type: "cifs", ...opts }, ...extra } },
  };
}

function findings(
  opts: Record<string, unknown>,
  options: Record<string, unknown> = ALLOW,
  extra: Record<string, unknown> = {},
): string[] {
  return collectComposePolicyFindings(doc(opts, extra), options);
}

const GOOD = {
  device: "//files.example.net/media/photos",
  o: "username=svc,password=pw1,domain=CORP,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,vers=3.1.1,sec=ntlmssp,iocharset=utf8,ro,noperm,serverino,cache=strict,actimeo=30",
};

test("a share with safe options is allowed when the control plane allows shares", () => {
  assertEquals(findings(GOOD), []);
  assertEquals(
    findings({ ...GOOD }, ALLOW, { driver: "local" }),
    [],
  );
  assertEquals(findings({ ...GOOD, type: "smb3" }), []);
  assertEquals(findings({ ...GOOD, device: "//192.0.2.10/data" }), []);
});

test("a share is still validated under host-level approval", () => {
  const bad = { ...GOOD, o: "username=a,suid" };
  assertEquals(
    findings(bad, { ...ALLOW, hostLevelApproved: true }).length,
    1,
  );
  assertEquals(
    findings(GOOD, { ...ALLOW, hostLevelApproved: true }),
    [],
  );
});

test("without the flag a share is refused and says why", () => {
  for (const options of [{}, { allowNetworkShares: false }]) {
    const found = findings(GOOD, options);
    assertEquals(found.length, 1);
    assertStringIncludes(found[0], "network shares must be allowed");
  }
  assertThrows(
    () => assertComposePolicy(doc(GOOD), {}),
    Error,
    "network shares must be allowed for this server",
  );
});

test("without the flag, host-level approval keeps today's behaviour", () => {
  assertEquals(findings(GOOD, { hostLevelApproved: true }), []);
});

test("other volume types keep the generic refusal", () => {
  const found = collectComposePolicyFindings(
    { volumes: { v: { driver_opts: { type: "nfs", device: ":/x" } } } },
    ALLOW,
  );
  assertEquals(found.length, 1);
  assertStringIncludes(found[0], "something other than plain Docker storage");
});

test("hosts that are this server or metadata are refused by name", () => {
  for (
    const host of [
      "localhost",
      "LOCALHOST",
      "foo.localhost",
      "127.0.0.1",
      "127.1",
      "2130706433",
      "0x7f.0.0.1",
      "0177.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "169.254.10.10",
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[fd00:ec2::254]",
      "[::ffff:127.0.0.1]",
    ]
  ) {
    const found = findings({ ...GOOD, device: `//${host}/share` });
    assertEquals(found.length, 1, host);
    assertStringIncludes(found[0], host);
  }
  assertEquals(shareHostRefusal("files.example.net"), null);
  assertEquals(shareHostRefusal("192.0.2.5"), null);
});

test("a bad device shape is refused", () => {
  for (
    const device of [
      "/srv/share",
      "//host",
      "//host/",
      "//host/../etc",
      "//host/a/./b",
      "nfs.example.net:/x",
      "//host/sh,are",
    ]
  ) {
    assertEquals(findings({ ...GOOD, device }).length, 1, device);
  }
  assertEquals(findings({ type: "cifs" }).length, 1);
});

test("each unsafe option is refused by name and never echoes its value", () => {
  for (
    const token of [
      "suid",
      "dev",
      "exec",
      "vers=1.0",
      "vers=evil",
      "file_mode=0777x",
      "cache=bogus",
      "sec=krb5;x",
      "uid=root",
      "ip=127.0.0.1",
      "addr=127.0.0.1",
      "credentials=/etc/shadow",
      "credentials=relative/path",
      `credentials=${DIR}/../../etc/shadow`,
      "password=",
      "unc=//evil/x",
      "sloppy",
    ]
  ) {
    const found = findings({ ...GOOD, o: `username=a,${token}` });
    assertEquals(found.length, 1, token);
    assertStringIncludes(found[0], token.split("=")[0]);
  }
  const secret = findings({ ...GOOD, o: "password=hunter2,bogus=hunter2" });
  assertEquals(secret.join(" ").includes("hunter2"), false);
});

test("credentials is allowed only inside the deployment directory", () => {
  assertEquals(
    findings({ ...GOOD, o: `credentials=${DIR}/secrets/smb.cred,ro` }),
    [],
  );
  assertEquals(
    findings({ ...GOOD, o: `credentials=${DIR}/secrets/smb.cred` }, {
      allowNetworkShares: true,
    }).length,
    1,
  );
});

test("an addr option goes through the same host check", () => {
  assertEquals(findings({ ...GOOD, o: "addr=192.0.2.9" }), []);
  assertEquals(findings({ ...GOOD, o: "addr=169.254.169.254" }).length, 1);
});

test("extra driver options, a foreign driver and a non-string o are refused", () => {
  assertEquals(findings({ ...GOOD, foo: "bar" }).length, 1);
  assertEquals(findings(GOOD, ALLOW, { driver: "rexray" }).length, 1);
  assertEquals(findings({ ...GOOD, o: 5 }).length, 1);
});

test("the option splitter keeps a doubled comma inside a password", () => {
  assertEquals(splitMountOptions("username=a,password=p,,w,ro"), [
    "username=a",
    "password=p,w",
    "ro",
  ]);
  assertEquals(splitMountOptions(""), [""]);
  assertEquals(mountOptionPasswords("username=a,password=p,,w,ro"), ["p,w"]);
});

test("redaction hides the password value in every spelling", () => {
  assertEquals(
    redactMountOptions("username=a,password=hunter2,ro"),
    "username=a,password=***,ro",
  );
  assertEquals(
    redactMountOptions("pass=hunter2,PWD=x"),
    "pass=***,PWD=***",
  );
  const spec = {
    driver_opts: {
      type: "cifs",
      device: "//files.example.net/m",
      o: "password=hunter2,,tail",
    },
  };
  const line = describeNetworkShare("media", spec);
  assertEquals(line.includes("hunter2"), false);
  assertEquals(line.includes("tail"), false);
  assertStringIncludes(line, "//files.example.net/m");
  assertEquals(networkSharePasswords({ volumes: { media: spec } }), [
    "hunter2,tail",
  ]);
});

test("hasNetworkShares sees only cifs and smb3 volumes", () => {
  assertEquals(hasNetworkShares(doc(GOOD)), true);
  assertEquals(hasNetworkShares(doc({ ...GOOD, type: "SMB3" })), true);
  assertEquals(hasNetworkShares({ volumes: { a: {} } }), false);
  assertEquals(hasNetworkShares({}), false);
  assertEquals(
    hasNetworkShares(doc({ type: "tmpfs", device: "tmpfs" })),
    false,
  );
});
