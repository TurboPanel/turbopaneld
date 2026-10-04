import { assertEquals, assertThrows } from "@std/assert";
import { assertInstanceCertsApplyInputs } from "./public-urls-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

function acme(contactEmail: string, directoryUrl = DIRECTORY) {
  return { contactEmail, directoryUrl };
}

// Road to 0.2.x row r2-acme-email-validation: the daemon holds the ACME
// contact email and directory URL to plain shapes itself, because they reach
// a root-run playbook as key=value extra-vars.
test("a plain contact email and the Let's Encrypt directory are accepted", () => {
  assertInstanceCertsApplyInputs([], acme("ops@example.com"));
  assertInstanceCertsApplyInputs([], acme(""));
  assertInstanceCertsApplyInputs([], acme("first.last+tag@mail.example.co.uk"));
});

test("a contact email that could smuggle an extra-var or a newline is refused", () => {
  for (
    const email of [
      "ops@example.com\nturbopanel_x=1",
      "ops@example.com -e turbopanel_x=1",
      "ops@example.com;rm -rf /",
      "ops\r@example.com",
      "ops example@example.com",
      "@example.com",
      "ops@",
      "ops@localhost",
      ".ops@example.com",
      "ops.@example.com",
      "ops@exa mple.com",
      "ops@example.com,evil@example.com",
      "o$(id)ps@example.com",
    ]
  ) {
    assertThrows(
      () => assertInstanceCertsApplyInputs([], acme(email)),
      Error,
      "refusing ACME contact email",
      email,
    );
  }
});

test("an ACME directory URL must be https, plain and free of dot segments", () => {
  for (
    const directory of [
      "http://acme.example.com/directory",
      "https://",
      "https://acme.example.com/../admin",
      "https://acme.example.com/./directory",
      "https://acme.example.com/dir ectory",
      "https://acme.example.com/directory\nx=1",
      "ftp://acme.example.com/directory",
    ]
  ) {
    assertThrows(
      () =>
        assertInstanceCertsApplyInputs([], acme("ops@example.com", directory)),
      Error,
      "refusing ACME directory URL",
      directory,
    );
  }
  assertEquals(
    assertInstanceCertsApplyInputs(
      [],
      acme("", "https://acme.example.com/directory"),
    ),
    undefined,
  );
});
