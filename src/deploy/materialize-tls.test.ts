import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { EnvironmentDeployPayload } from "../instance/commands/contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  hostnameTlsMap,
  materializeTlsCertificates,
} from "./materialize-tls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TLS_ID = "00000000-0000-4000-8000-0000000000aa";
const CERT_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const KEY_PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n";

test({
  name: "materializeTlsCertificates writes PEMs and returns written tlsIds",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const written = await materializeTlsCertificates(
        layout,
        [{
          tlsId: TLS_ID,
          certificatePem: CERT_PEM,
          privateKeyEnvelope: "tpdaemon.v1.fake",
        }],
        (envelopes) => {
          assertEquals(envelopes, ["tpdaemon.v1.fake"]);
          return Promise.resolve([KEY_PEM]);
        },
      );
      assertEquals([...written], [TLS_ID]);
      assertEquals(
        await Deno.readTextFile(join(layout.tlsDir, TLS_ID, "fullchain.pem")),
        CERT_PEM,
      );
      assertEquals(
        await Deno.readTextFile(join(layout.tlsDir, TLS_ID, "privkey.pem")),
        KEY_PEM,
      );
      assertEquals(
        (await Deno.stat(join(layout.tlsDir, TLS_ID, "fullchain.pem"))).mode! &
          0o777,
        0o640,
      );
      assertEquals(
        (await Deno.stat(join(layout.tlsDir, TLS_ID, "privkey.pem"))).mode! &
          0o777,
        0o600,
      );
    });
  },
});

test({
  name: "materializeTlsCertificates returns empty for empty material",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      const written = await materializeTlsCertificates(
        layout,
        [],
        () => Promise.resolve([]),
      );
      assertEquals(written.size, 0);
    });
  },
});

test({
  name: "materializeTlsCertificates rejects decrypt length mismatch",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          materializeTlsCertificates(
            layout,
            [{
              tlsId: TLS_ID,
              certificatePem: CERT_PEM,
              privateKeyEnvelope: "tpdaemon.v1.fake",
            }],
            () => Promise.resolve([]),
          ),
        Error,
        "unexpected length",
      );
    });
  },
});

test({
  name: "materializeTlsCertificates rejects unsafe tlsId and empty plaintext",
  permissions: { read: true, write: true },
  fn: async () => {
    await withTempLayout(async (fixture) => {
      const layout = resolveLayout(fixture.env, {
        skipDiscovery: true,
        forceMode: "production",
      });
      await assertRejects(
        () =>
          materializeTlsCertificates(
            layout,
            [{
              tlsId: "not-a-uuid",
              certificatePem: CERT_PEM,
              privateKeyEnvelope: "tpdaemon.v1.fake",
            }],
            () => Promise.resolve([KEY_PEM]),
          ),
        Error,
        "unsupported characters",
      );
      await assertRejects(
        () =>
          materializeTlsCertificates(
            layout,
            [{
              tlsId: TLS_ID,
              certificatePem: CERT_PEM,
              privateKeyEnvelope: "tpdaemon.v1.fake",
            }],
            () => Promise.resolve([null]),
          ),
        Error,
        "failed to decrypt",
      );
    });
  },
});

test("hostnameTlsMap maps hostnames to tlsId (last write wins)", () => {
  const payload = {
    hostings: [
      {
        hostingId: "h1",
        serviceId: "s1",
        composeServiceName: "web",
        hostnames: ["a.example.test", "b.example.test"],
        tlsId: TLS_ID,
      },
      {
        hostingId: "h2",
        serviceId: "s2",
        composeServiceName: "api",
        hostnames: ["b.example.test"],
        tlsId: "00000000-0000-4000-8000-0000000000bb",
      },
      {
        hostingId: "h3",
        serviceId: "s3",
        composeServiceName: "other",
        hostnames: ["c.example.test"],
      },
    ],
  } as EnvironmentDeployPayload;

  const map = hostnameTlsMap(payload);
  assertEquals(map.get("a.example.test"), TLS_ID);
  assertEquals(
    map.get("b.example.test"),
    "00000000-0000-4000-8000-0000000000bb",
  );
  assertEquals(map.has("c.example.test"), false);
});
