import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { assertComposePolicy } from "./compose-final-policy.ts";
import {
  assertNetworkSharesFinal,
  describeNetworkShare,
  hasNetworkShares,
  redactMountOptions,
  shareHostRefusal,
  splitMountOptions,
} from "./network-shares.ts";
import { collectComposePolicyFindings } from "./compose-final-policy.ts";
import { loginTokens } from "./network-share-logins.ts";

const test = Deno.test.bind(Deno);

const ALLOW = { allowNetworkShares: true };
const LOGIN = loginTokens({ username: "svc", password: "s3cret" });

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
  o: "username=svc,domain=CORP,uid=1000,gid=1000,file_mode=0644,dir_mode=0755,vers=3.1.1,sec=ntlmssp,iocharset=utf8,ro,noperm,serverino,cache=strict,actimeo=30",
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

test("without the flag, host-level approval does not allow a share", () => {
  assertEquals(findings(GOOD, { hostLevelApproved: true }).length, 1);
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
      "172.17.0.1",
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
      "cred=/run/tp/deployments/p1/e1/smb/other.cred",
      "password=",
      "pass=x",
      "pwd=x",
      "bind",
      "rbind",
      "remount",
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
  assertEquals(secret.length, 2);
});

test("credentials= is refused in every form (the kernel ignores it)", () => {
  for (const o of ["credentials=/etc/shadow", "CREDENTIALS=/x", "cred=/x"]) {
    const found = findings({ ...GOOD, o });
    assertEquals(found.length, 1, o);
    assertStringIncludes(found[0], "ignores it");
  }
});

test("a host-level approval never turns shares on", () => {
  const approved = collectComposePolicyFindings(doc(GOOD), {
    hostLevelApproved: true,
  });
  assertEquals(approved.length, 1);
  assertStringIncludes(approved[0], "network shares must be allowed");
  assertEquals(
    collectComposePolicyFindings(doc(GOOD), {
      hostLevelApproved: true,
      allowNetworkShares: true,
    }),
    [],
  );
});

test("a comma in an option value never survives the checks", () => {
  // `,,` is an empty option.
  assertEquals(findings({ ...GOOD, o: "username=a,,ro" }).length, 1);
  assertEquals(
    findings({ ...GOOD, device: "//files.example.net/a,b" }).length,
    1,
  );
});

test("the final check refuses what the first judge would", () => {
  const ok = { volumes: { media: { driver_opts: { type: "cifs", ...GOOD } } } };
  assertEquals(assertNetworkSharesFinal(ok, ALLOW), undefined);
  assertThrows(
    () => assertNetworkSharesFinal(ok, { allowNetworkShares: false }),
    Error,
    "network shares must be allowed",
  );
  const withLogin = {
    volumes: {
      media: {
        driver_opts: {
          type: "cifs",
          device: GOOD.device,
          o: ["ro", ...LOGIN].join(","),
        },
      },
    },
  };
  // Only the exact tokens the daemon injected are exempt.
  assertEquals(
    assertNetworkSharesFinal(withLogin, {
      allowNetworkShares: true,
      injectedLogins: new Map([["media", LOGIN]]),
    }),
    undefined,
  );
  assertThrows(
    () => assertNetworkSharesFinal(withLogin, ALLOW),
    Error,
    "password",
  );
  assertThrows(
    () =>
      assertNetworkSharesFinal(withLogin, {
        allowNetworkShares: true,
        injectedLogins: new Map([["media", LOGIN.slice(0, 1)]]),
      }),
    Error,
    "password",
  );
  assertThrows(
    () =>
      assertNetworkSharesFinal(ok, {
        allowNetworkShares: true,
        injectedLogins: new Map([["media", LOGIN]]),
      }),
    Error,
    "login is missing",
  );
  const bad = {
    volumes: {
      media: { driver_opts: { type: "cifs", device: GOOD.device, o: "bind" } },
    },
  };
  assertThrows(() => assertNetworkSharesFinal(bad, ALLOW), Error, "bind");
  const nfsLike = {
    volumes: { m: { driver_opts: { type: "smb3", device: "//localhost/x" } } },
  };
  assertThrows(
    () => assertNetworkSharesFinal(nfsLike, ALLOW),
    Error,
    "localhost",
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
