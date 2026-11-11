import { assertEquals } from "@std/assert";
import { withPostgresRootCert } from "./db-url-ca.ts";

/** Sonar only recognizes `test()`; see `config-injection.test.ts`. */
const test = Deno.test.bind(Deno);

const PATH = "/srv/users/a/.turbopanel-hosting/managed-ca.pem";

test("both verify modes get the root certificate", () => {
  for (const mode of ["verify-ca", "verify-full"]) {
    const url = `postgresql://h:5432/db?sslmode=${mode}`;
    assertEquals(withPostgresRootCert(url, PATH), `${url}&sslrootcert=${PATH}`);
  }
  assertEquals(
    withPostgres("postgres://h/db?sslmode=verify-full&x=1"),
    `postgres://h/db?sslmode=verify-full&x=1&sslrootcert=${PATH}`,
  );
});

function withPostgres(url: string): string {
  return withPostgresRootCert(url, PATH);
}

test("other modes, other schemes and an existing root certificate are untouched", () => {
  const untouched = [
    "postgresql://h/db?sslmode=require",
    "postgresql://h/db",
    "mysql://h/db?ssl-mode=VERIFY_CA",
    "postgresql://h/db?sslmode=verify-full&sslrootcert=/x.pem",
    "not a url",
  ];
  for (const url of untouched) assertEquals(withPostgres(url), url);
});

test("an empty query and a fragment are handled", () => {
  assertEquals(
    withPostgres("postgresql://h/db?"),
    "postgresql://h/db?",
  );
  assertEquals(
    withPostgres("postgresql://h/db?sslmode=verify-ca#frag"),
    `postgresql://h/db?sslmode=verify-ca&sslrootcert=${PATH}#frag`,
  );
});

test("a path with a space or a percent sign is encoded", () => {
  assertEquals(
    withPostgresRootCert(
      "postgresql://h/db?sslmode=verify-full",
      "/a b/100%/ca.pem",
    ),
    "postgresql://h/db?sslmode=verify-full&sslrootcert=/a%20b/100%25/ca.pem",
  );
});
