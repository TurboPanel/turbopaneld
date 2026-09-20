import { assertEquals } from "@std/assert";
import {
  DEV_CONVERGE_OPTIONS_ENV,
  devConvergeExtraVars,
  devConvergeOptionsExtraArgs,
  devConvergeOptionsMaterial,
  parseDevConvergeOptions,
  resolveDevConvergeOptions,
} from "./dev-converge-options.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseDevConvergeOptions keeps boolean stems and sorts them", () => {
  const options = parseDevConvergeOptions(JSON.stringify({
    optionalServices: {
      website: true,
      dbstudio: false,
      mailpit: true,
    },
  }));
  assertEquals(Object.keys(options.optionalServices), [
    "dbstudio",
    "mailpit",
    "website",
  ]);
  assertEquals(options.optionalServices.website, true);
  assertEquals(options.optionalServices.dbstudio, false);
});

test("parseDevConvergeOptions drops junk instead of coercing it", () => {
  const options = parseDevConvergeOptions(JSON.stringify({
    optionalServices: {
      ui: "true",
      "Bad-Key": true,
      "": true,
      redis_insight: 1,
      stripe_listen: true,
    },
    unrelated: { ui: true },
  }));
  assertEquals(options, { optionalServices: { stripe_listen: true } });
});

test("parseDevConvergeOptions never throws on a missing or malformed payload", () => {
  assertEquals(parseDevConvergeOptions(undefined), { optionalServices: {} });
  assertEquals(parseDevConvergeOptions("   "), { optionalServices: {} });
  assertEquals(parseDevConvergeOptions("not json"), { optionalServices: {} });
  assertEquals(parseDevConvergeOptions("[1,2]"), { optionalServices: {} });
  assertEquals(parseDevConvergeOptions('{"optionalServices":[true]}'), {
    optionalServices: {},
  });
  assertEquals(parseDevConvergeOptions('{"optionalServices":null}'), {
    optionalServices: {},
  });
});

test("resolveDevConvergeOptions reads the payload from the env bag", () => {
  assertEquals(DEV_CONVERGE_OPTIONS_ENV, "TURBOPANEL_DEV_CONVERGE_OPTIONS");
  const bag: Record<string, string | undefined> = {
    TURBOPANEL_DEV_CONVERGE_OPTIONS: '{"optionalServices":{"ui":false}}',
  };
  assertEquals(
    resolveDevConvergeOptions({ get: (key) => bag[key] }),
    { optionalServices: { ui: false } },
  );
  assertEquals(
    resolveDevConvergeOptions({ get: () => undefined }),
    { optionalServices: {} },
  );
});

test("devConvergeExtraVars prefixes every stem with turbopanel_optional_", () => {
  const options = parseDevConvergeOptions(
    '{"optionalServices":{"ui":true,"redis_insight":false}}',
  );
  assertEquals(devConvergeExtraVars(options), {
    turbopanel_optional_redis_insight: false,
    turbopanel_optional_ui: true,
  });
});

test("devConvergeOptionsExtraArgs emits a single JSON -e object or nothing", () => {
  assertEquals(
    devConvergeOptionsExtraArgs(parseDevConvergeOptions(undefined)),
    [],
  );
  const args = devConvergeOptionsExtraArgs(
    parseDevConvergeOptions(
      '{"optionalServices":{"stripe_listen":true,"dbstudio":false}}',
    ),
  );
  assertEquals(args.length, 2);
  assertEquals(args[0], "-e");
  assertEquals(JSON.parse(args[1]), {
    turbopanel_optional_dbstudio: false,
    turbopanel_optional_stripe_listen: true,
  });
});

test("devConvergeOptionsMaterial is canonical (sorted, one line per stem)", () => {
  const a = devConvergeOptionsMaterial(
    parseDevConvergeOptions(
      '{"optionalServices":{"ui":true,"dbstudio":false}}',
    ),
  );
  const b = devConvergeOptionsMaterial(
    parseDevConvergeOptions(
      '{"optionalServices":{"dbstudio":false,"ui":true}}',
    ),
  );
  assertEquals(a, "optional_dbstudio=false\noptional_ui=true");
  assertEquals(a, b);
  assertEquals(
    devConvergeOptionsMaterial(parseDevConvergeOptions(undefined)),
    "",
  );
});
