import { assertEquals } from "@std/assert";
import {
  exportIssuedCertificate,
  MAX_ISSUED_CHAIN_CERTIFICATES,
  parseCertExport,
} from "./acme-export.ts";

const test = Deno.test.bind(Deno);

const CERT = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUZm9yIHRlc3RzIG9ubHk=
-----END CERTIFICATE-----`;
const KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGZvciB0ZXN0cyBvbmx5
-----END PRIVATE KEY-----`;

test("parseCertExport splits one chain and one key", () => {
  const parsed = parseCertExport(`${CERT}\n${CERT}\n${KEY}\n`);
  assertEquals(parsed?.certificatePem, `${CERT}\n${CERT}\n`);
  assertEquals(parsed?.privateKeyPem, `${KEY}\n`);
});

test("parseCertExport accepts an EC or RSA key label", () => {
  const ec = KEY.replaceAll("PRIVATE KEY", "EC PRIVATE KEY");
  assertEquals(parseCertExport(`${CERT}\n${ec}\n`)?.privateKeyPem, `${ec}\n`);
});

test("parseCertExport refuses empty output, no key, two keys, a stray block", () => {
  assertEquals(parseCertExport(""), null);
  assertEquals(parseCertExport(`${CERT}\n`), null);
  assertEquals(parseCertExport(`${KEY}\n`), null);
  assertEquals(parseCertExport(`${CERT}\n${KEY}\n${KEY}\n`), null);
  const other = CERT.replaceAll("CERTIFICATE", "PUBLIC KEY");
  assertEquals(parseCertExport(`${CERT}\n${other}\n${KEY}\n`), null);
});

test("parseCertExport refuses a chain longer than the cap", () => {
  const chain = Array(MAX_ISSUED_CHAIN_CERTIFICATES + 1).fill(CERT).join("\n");
  assertEquals(parseCertExport(`${chain}\n${KEY}\n`), null);
});

test("exportIssuedCertificate asks tp-host for exactly one hostname", async () => {
  const calls: string[][] = [];
  const pair = await exportIssuedCertificate("shop.example.com", (_c, args) => {
    calls.push(args);
    return Promise.resolve({
      success: true,
      stdout: `${CERT}\n${KEY}`,
      stderr: "",
    });
  });
  assertEquals(pair?.privateKeyPem, `${KEY}\n`);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.slice(-2), ["cert-export", "shop.example.com"]);
});

test("exportIssuedCertificate returns null when the helper fails or throws, without echoing output", async () => {
  assertEquals(
    await exportIssuedCertificate(
      "a.example.com",
      () => Promise.resolve({ success: false, stdout: KEY, stderr: KEY }),
    ),
    null,
  );
  assertEquals(
    await exportIssuedCertificate(
      "a.example.com",
      () => Promise.reject(new Error(KEY)),
    ),
    null,
  );
  assertEquals(
    await exportIssuedCertificate(
      "a.example.com",
      () => Promise.resolve({ success: true, stdout: "", stderr: "" }),
    ),
    null,
  );
});
