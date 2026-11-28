import { assertEquals } from "@std/assert";
import {
  SERVER_AND_CLIENT_CERT,
  SERVER_ONLY_CERT,
} from "../testing/tunnel-peer-certs.ts";
import {
  certificateAllowsClientAuth,
  planPeerClientAuth,
} from "./tunnel-peer-cert.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("a certificate that lists client authentication is fit to be shown", () => {
  assertEquals(certificateAllowsClientAuth(SERVER_AND_CLIENT_CERT), true);
});

test("a server-only, unreadable or empty certificate is not fit", () => {
  assertEquals(certificateAllowsClientAuth(SERVER_ONLY_CERT), false);
  assertEquals(
    certificateAllowsClientAuth(
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    ),
    false,
  );
  assertEquals(certificateAllowsClientAuth(""), false);
});

test("no request keeps the receiving side as it was and shows a fit certificate", () => {
  assertEquals(planPeerClientAuth(undefined, SERVER_AND_CLIENT_CERT), {
    presentCertificate: true,
    warnings: [],
  });
  assertEquals(planPeerClientAuth(undefined, SERVER_ONLY_CERT), {
    presentCertificate: false,
    warnings: [],
  });
  assertEquals(planPeerClientAuth(undefined, undefined), {
    presentCertificate: false,
    warnings: [],
  });
});

test("verify and require are kept when the certificate is fit", () => {
  for (const mode of ["verify", "require"] as const) {
    assertEquals(planPeerClientAuth(mode, SERVER_AND_CLIENT_CERT), {
      presentCertificate: true,
      clientAuth: mode,
      warnings: [],
    });
  }
});

test("require falls back to verify, and says so, when this server cannot show a certificate", () => {
  const plan = planPeerClientAuth("require", SERVER_ONLY_CERT);
  assertEquals(plan.clientAuth, "verify");
  assertEquals(plan.presentCertificate, false);
  assertEquals(plan.warnings.length, 1);
  assertEquals(planPeerClientAuth("verify", SERVER_ONLY_CERT).warnings, []);
});
