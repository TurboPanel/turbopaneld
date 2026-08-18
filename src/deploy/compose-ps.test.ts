import { assertEquals } from "@std/assert";
import {
  parseComposePsEntries,
  readComposePsContainer,
  readComposePsLabels,
} from "./compose-ps.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseComposePsEntries returns empty for blank stdout", () => {
  assertEquals(parseComposePsEntries(""), []);
  assertEquals(parseComposePsEntries("   \n  "), []);
});

test("parseComposePsEntries accepts a JSON array of container summaries", () => {
  const entries = parseComposePsEntries(JSON.stringify([
    { ID: "abc", Name: "web-1", Service: "web", State: "running" },
    ["not-a-record"],
    null,
  ]));
  assertEquals(entries.length, 1);
  assertEquals(entries[0]?.Service, "web");
});

test("parseComposePsEntries wraps a single JSON object", () => {
  const entries = parseComposePsEntries(JSON.stringify({
    ID: "abc",
    Name: "web-1",
    Service: "web",
    State: "running",
  }));
  assertEquals(entries.length, 1);
  assertEquals(entries[0]?.Name, "web-1");
});

test("parseComposePsEntries parses NDJSON and rejects a broken line", () => {
  const ok = parseComposePsEntries(
    `${
      JSON.stringify({
        ID: "a",
        Name: "n",
        Service: "s",
        State: "running",
      })
    }\n\n${
      JSON.stringify({
        ID: "b",
        Name: "n2",
        Service: "s2",
        State: "exited",
      })
    }\n`,
  );
  assertEquals(ok.length, 2);

  assertEquals(
    parseComposePsEntries('{"ID":"a"}\nnot-json\n{"ID":"b"}'),
    [],
  );
});

test("readComposePsContainer requires ID Name Service State strings", () => {
  assertEquals(
    readComposePsContainer({
      ID: "cid",
      Name: "cname",
      Service: "web",
      State: "running",
    }, "service"),
    {
      composeServiceName: "web",
      containerId: "cid",
      containerName: "cname",
      status: "running",
      role: "service",
    },
  );

  assertEquals(
    readComposePsContainer({
      ID: "",
      Name: "cname",
      Service: "web",
      State: "running",
    }, "service"),
    null,
  );
  assertEquals(
    readComposePsContainer({
      ID: "cid",
      Name: "cname",
      Service: "web",
      State: 1,
    }, "ingress"),
    null,
  );
});

test("readComposePsLabels accepts object map and comma-separated strings", () => {
  assertEquals(readComposePsLabels({}), {});
  assertEquals(readComposePsLabels({ Labels: null }), {});
  assertEquals(readComposePsLabels({ Labels: 12 }), {});
  assertEquals(readComposePsLabels({ Labels: "" }), {});

  assertEquals(
    readComposePsLabels({
      Labels: {
        "turbopanel.role": "ingress",
        ignored: 1,
        "com.turbopanel.service": "svc",
      },
    }),
    {
      "turbopanel.role": "ingress",
      "com.turbopanel.service": "svc",
    },
  );

  assertEquals(
    readComposePsLabels({
      Labels: "turbopanel.role=ingress,com.turbopanel.service=svc,bad,=empty",
    }),
    {
      "turbopanel.role": "ingress",
      "com.turbopanel.service": "svc",
    },
  );
});
