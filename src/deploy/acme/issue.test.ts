import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../../paths/layout.ts";
import { createFakeCa, FAKE_CA_DIRECTORY } from "../../testing/fake-acme-ca.ts";
import type { CommandResult } from "../instance-acme-http01.ts";
import { sweepTenantAcme, tenantAcmeSocketPath } from "../tenant-acme-issue.ts";
import { acmeAccountPath } from "./account-store.ts";
import { AcmeError, LocalAcmeError } from "./client.ts";
import { Http01Answers, withHttp01Answers } from "./http01.ts";
import {
  checkIssuedLeaf,
  daemonAcmeDirectoryUrl,
  type DaemonIssueDeps,
  type DaemonIssueRequest,
  issueCertificateOverHttp01 as issueOn,
  plainDaemonAcmeFailure,
  RATE_LIMITED_REASON,
} from "./issue.ts";
import type { ChallengeSolver } from "./order.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function layoutUnder(root: string): LayoutPaths {
  return {
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    logDir: join(root, "log"),
    runDir: join(root, "run"),
  } as LayoutPaths;
}

function request(over: Partial<DaemonIssueRequest> = {}): DaemonIssueRequest {
  return {
    requestId: "req_1",
    names: ["example.com", "www.example.com"],
    directory: "staging",
    contactEmail: "ops@example.com",
    ...over,
  };
}

/** The entry point on this request's proof socket, as the order path will call it. */
function issueCertificateOverHttp01(
  layout: LayoutPaths,
  req: DaemonIssueRequest,
  deps: DaemonIssueDeps,
) {
  return issueOn(
    layout,
    req,
    tenantAcmeSocketPath(layout, req.requestId),
    deps,
  );
}

const okRun = (): Promise<CommandResult> =>
  Promise.resolve({ ok: true, stdout: "", stderr: "" });

/** Answers served in memory, read straight by the fake authority. */
function memoryServe(answers: Http01Answers): DaemonIssueDeps["serveAnswers"] {
  return <T>(
    _socket: string,
    _run: unknown,
    work: (solver: ChallengeSolver) => Promise<T>,
  ) => work(answers.solver);
}

/** An authority that reads the in-memory answers, and the deps that point an order at it. */
async function answeringCa(
  answers: Http01Answers,
  options: Parameters<typeof createFakeCa>[0] = {},
) {
  const ca = await createFakeCa({
    http01: (_n, token) =>
      Promise.resolve(
        answers.answer(`/.well-known/acme-challenge/${token}`).body,
      ),
    ...options,
  });
  const deps: DaemonIssueDeps = {
    fetch: ca.fetch,
    directoryUrl: FAKE_CA_DIRECTORY,
    serveAnswers: memoryServe(answers),
  };
  return { ca, deps };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-issue-" });
  try {
    await Deno.mkdir(join(root, "run"), { recursive: true });
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** GET a challenge path over the request's proof socket, as the web server would. */
async function socketGet(
  socket: string,
  token: string,
): Promise<string | null> {
  const conn = await Deno.connect({ transport: "unix", path: socket });
  try {
    await conn.write(
      new TextEncoder().encode(
        `GET /.well-known/acme-challenge/${token} HTTP/1.1\r\nHost: x\r\n\r\n`,
      ),
    );
    let text = "";
    for await (const chunk of conn.readable) {
      text += new TextDecoder().decode(chunk);
    }
    const [head = "", body = ""] = text.split("\r\n\r\n");
    return head.startsWith("HTTP/1.1 200") ? body : null;
  } catch {
    return null;
  }
}

test("an order over the real proof socket issues one certificate for every name", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    const socket = tenantAcmeSocketPath(layout, "req_1");
    const grants: string[][] = [];
    const ca = await createFakeCa({
      http01: (_name, token) => socketGet(socket, token),
      renewalWindow: {
        start: new Date("2026-12-01T00:00:00Z"),
        end: new Date("2026-12-02T00:00:00Z"),
      },
    });
    const outcome = await issueCertificateOverHttp01(layout, request(), {
      fetch: ca.fetch,
      directoryUrl: FAKE_CA_DIRECTORY,
      run: (program, args) => {
        grants.push([program, ...args]);
        return okRun();
      },
      sleep: () => Promise.resolve(),
    });
    if (!outcome.ok) throw new TypeError(outcome.reason);
    assertEquals(ca.issued, [["example.com", "www.example.com"]]);
    assertEquals(outcome.notAfterIso, "2027-01-01T00:00:00.000Z");
    // The serial keeps its leading zero (RFC 9773).
    assertEquals(outcome.renewal.certId, "AQIDBAUGBwgJCgsMDQ4PEBESExQ.AIdlQwE");
    assertEquals(outcome.renewal.window, {
      startIso: "2026-12-01T00:00:00.000Z",
      endIso: "2026-12-02T00:00:00.000Z",
    });
    assertEquals(outcome.renewal.retryAfterMs, 21_600_000);
    assertEquals(ca.renewalAsked, ["AQIDBAUGBwgJCgsMDQ4PEBESExQ.AIdlQwE"]);
    // The socket was opened to the web server, then removed.
    assert(grants.some((argv) => argv.includes("setfacl")), String(grants));
    assertEquals(await exists(socket), false);
    // The account stays for the next order; the certificate key is not on disk.
    const saved = await Deno.readTextFile(
      acmeAccountPath(layout, FAKE_CA_DIRECTORY, "ops@example.com"),
    );
    assertStringIncludes(saved, "https://ca.test/acct/");
    assert(!saved.includes(outcome.privateKeyPem.split("\n")[1] ?? "-"));
    assertEquals(ca.log.filter((e) => e.path === "/acct").length, 1);
  });
});

test("the second order reuses the account", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    const answers = new Http01Answers();
    const { ca, deps } = await answeringCa(answers);
    const first = await issueCertificateOverHttp01(layout, request(), deps);
    const second = await issueCertificateOverHttp01(
      layout,
      request({ names: ["other.example.com"] }),
      deps,
    );
    assert(first.ok && second.ok);
    assertEquals(ca.accounts.size, 1);
    assertEquals(ca.log.filter((e) => e.path === "/acct").length, 1);
    // No renewal information offered: the identifier is still handed back.
    assertEquals(second.renewal.window, null);
    assert(second.renewal.certId);
  });
});

test("a closed account is forgotten so the next order makes a new one", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    const answers = new Http01Answers();
    const { ca, deps } = await answeringCa(answers);
    assert((await issueCertificateOverHttp01(layout, request(), deps)).ok);
    ca.deactivateAccounts();
    const failed = await issueCertificateOverHttp01(layout, request(), deps);
    assertEquals(failed.ok, false);
    if (!failed.ok) assertEquals(failed.code, "account_gone");
    assertEquals(
      await exists(
        acmeAccountPath(layout, FAKE_CA_DIRECTORY, "ops@example.com"),
      ),
      false,
    );
    assert((await issueCertificateOverHttp01(layout, request(), deps)).ok);
    assertEquals(ca.accounts.size, 2);
  });
});

test("a rate limit is reported in the words the control plane waits on", async () => {
  await withRoot(async (root) => {
    const ca = await createFakeCa({ rateLimitOrders: "120" });
    const outcome = await issueCertificateOverHttp01(
      layoutUnder(root),
      request(),
      {
        fetch: ca.fetch,
        directoryUrl: FAKE_CA_DIRECTORY,
        serveAnswers: memoryServe(new Http01Answers()),
      },
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertEquals(outcome.code, "rate_limited");
    assertEquals(outcome.reason, RATE_LIMITED_REASON);
    assertStringIncludes(outcome.reason, "rate limited");
    assertEquals(outcome.retryAfterMs, 120_000);
  });
});

test("a failed check names the name in plain words", async () => {
  await withRoot(async (root) => {
    const ca = await createFakeCa({ http01: () => Promise.resolve(null) });
    const outcome = await issueCertificateOverHttp01(
      layoutUnder(root),
      request(),
      {
        fetch: ca.fetch,
        directoryUrl: FAKE_CA_DIRECTORY,
        serveAnswers: memoryServe(new Http01Answers()),
      },
    );
    assertEquals(outcome.ok, false);
    if (outcome.ok) return;
    assertStringIncludes(
      outcome.reason,
      "example.com: Let's Encrypt could not validate",
    );
    assert(!outcome.reason.includes("Connection refused"), outcome.reason);
  });
});

test("a leaf that leaves out a name is refused", async () => {
  await withRoot(async (root) => {
    const answers = new Http01Answers();
    const { deps } = await answeringCa(answers, {
      dropName: "www.example.com",
    });
    const outcome = await issueCertificateOverHttp01(
      layoutUnder(root),
      request(),
      deps,
    );
    assertEquals(outcome.ok, false);
  });
});

test("names are checked against the leaf as ordered, folded", async () => {
  await withRoot(async (root) => {
    const { ca, deps } = await answeringCa(new Http01Answers());
    const outcome = await issueCertificateOverHttp01(
      layoutUnder(root),
      request({ names: ["Example.com.", " www.example.com"] }),
      deps,
    );
    if (!outcome.ok) throw new TypeError(outcome.reason);
    assertEquals(ca.issued, [["example.com", "www.example.com"]]);
  });
});

test("the request's directory picks one of the two Let's Encrypt directories", () => {
  assertEquals(
    daemonAcmeDirectoryUrl("production"),
    "https://acme-v02.api.letsencrypt.org/directory",
  );
  assertEquals(
    daemonAcmeDirectoryUrl("staging"),
    "https://acme-staging-v02.api.letsencrypt.org/directory",
  );
});

test("every failure has a plain sentence", () => {
  const cases: [AcmeError, string][] = [
    [new AcmeError("caa", "x", null, 403), "CAA"],
    [new AcmeError("dns", "x", null, 400), "DNS"],
    [new AcmeError("tls", "x", null, 403), "port 80"],
    [new AcmeError("unreachable", "x"), "network"],
    [new AcmeError("timeout", "x"), "in time"],
    [new AcmeError("account_gone", "x"), "account was closed"],
    [new AcmeError("foreign_address", "x"), "outside its own site"],
    [new AcmeError("rejected_name", "x", null, 400), "public domain"],
    // An authority's refusal without a status still never shows its raw text.
    [new AcmeError("rejected_name", "raw detail"), "public domain"],
    [new LocalAcmeError("unsupported", "ours, plain"), "ours, plain"],
    [
      new AcmeError("malformed", "invalid contact mailto", null, 400),
      "contact",
    ],
    [new AcmeError("malformed", "bad json", null, 400), "retried later"],
    [new AcmeError("server", "x", null, 500), "retried later"],
  ];
  for (const [err, words] of cases) {
    assertStringIncludes(plainDaemonAcmeFailure(err).reason, words, err.code);
  }
  const local = plainDaemonAcmeFailure(new Error("EACCES writing a file"));
  assertEquals(local.code, "unknown");
  assertStringIncludes(local.reason, "this server could not run");
});

test("a leaf that cannot be read or does not match its key is refused", async () => {
  let message = "";
  try {
    checkIssuedLeaf("not a certificate", "", ["example.com"]);
  } catch (err) {
    message = err instanceof Error ? err.message : "";
  }
  assertEquals(message, "the certificate could not be read");
  // Two orders give two leaves with different keys.
  await withRoot(async (root) => {
    const answers = new Http01Answers();
    const { deps } = await answeringCa(answers);
    const a = await issueCertificateOverHttp01(
      layoutUnder(root),
      request(),
      deps,
    );
    const b = await issueCertificateOverHttp01(
      layoutUnder(root),
      request(),
      deps,
    );
    if (!a.ok || !b.ok) throw new TypeError("both orders should succeed");
    let mismatch = "";
    try {
      checkIssuedLeaf(a.certificatePem, b.privateKeyPem, ["example.com"]);
    } catch (err) {
      mismatch = err instanceof Error ? err.message : "";
    }
    assertEquals(mismatch, "the certificate does not match its key");
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

test("the start-up sweep keeps the account and clears only the request files", async () => {
  await withRoot(async (root) => {
    const layout = layoutUnder(root);
    const path = acmeAccountPath(layout, FAKE_CA_DIRECTORY, "ops@example.com");
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, "{}");
    const requests = join(root, "state", "tenant-acme", "requests");
    await Deno.mkdir(requests, { recursive: true });
    await sweepTenantAcme(layout, {
      run: okRun,
      stopUnit: () => Promise.resolve(null),
    });
    assertEquals(await exists(path), true);
    assertEquals(await exists(requests), false);
  });
});

test("a peer that sends nothing does not hold up the next check", async () => {
  await withRoot(async (root) => {
    const socket = tenantAcmeSocketPath(layoutUnder(root), "req_2");
    const body = await withHttp01Answers(socket, okRun, async (solver) => {
      await solver.present({ name: "a.example", token: "tok", value: "tok.k" });
      const silent = await Deno.connect({ transport: "unix", path: socket });
      try {
        return await socketGet(socket, "tok");
      } finally {
        silent.close();
      }
    });
    assertEquals(body, "tok.k");
  });
});
