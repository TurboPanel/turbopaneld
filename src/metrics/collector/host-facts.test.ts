import { assertEquals } from "@std/assert";
import {
  buildHostFacts,
  cleanFact,
  parseBootId,
  parseLoadavg,
} from "./host-facts.ts";

Deno.test("parseLoadavg keeps the three averages and rejects anything else", () => {
  assertEquals(parseLoadavg("0.48 0.37 0.35 1/306 151909\n"), "0.48 0.37 0.35");
  assertEquals(parseLoadavg("12.00 3 0.01 2/9 1"), "12.00 3 0.01");
  assertEquals(parseLoadavg("0.48 nan 0.35 1/2 3"), undefined);
  assertEquals(parseLoadavg("0.48 0.37"), undefined);
  assertEquals(parseLoadavg(undefined), undefined);
});

Deno.test("parseBootId accepts only a UUID", () => {
  assertEquals(
    parseBootId("6797E9F8-e46d-4460-937e-e89ffdc42054\n"),
    "6797e9f8-e46d-4460-937e-e89ffdc42054",
  );
  assertEquals(parseBootId("not-a-uuid"), undefined);
  assertEquals(parseBootId(undefined), undefined);
});

Deno.test("cleanFact flattens whitespace and control characters and caps the length", () => {
  assertEquals(
    cleanFact("  Intel(R)\tXeon(R)\n  Gold \u0007 6338  "),
    "Intel(R) Xeon(R) Gold 6338",
  );
  assertEquals(cleanFact("x".repeat(500))?.length, 128);
  assertEquals(cleanFact("  \n"), undefined);
  assertEquals(cleanFact(null), undefined);
});

Deno.test("buildHostFacts leaves out what is unknown", () => {
  assertEquals(
    buildHostFacts({
      loadavgText: "0.10 0.20 0.30 1/2 3",
      cpuModel: "AMD EPYC 7763 64-Core Processor",
      bootIdText: "6797e9f8-e46d-4460-937e-e89ffdc42054",
      agentVersion: "0.2.0",
    }),
    {
      loadavg: "0.10 0.20 0.30",
      cpuModel: "AMD EPYC 7763 64-Core Processor",
      bootId: "6797e9f8-e46d-4460-937e-e89ffdc42054",
      agentVersion: "0.2.0",
    },
  );
  assertEquals(
    buildHostFacts({
      loadavgText: undefined,
      cpuModel: null,
      bootIdText: "",
      agentVersion: undefined,
    }),
    undefined,
  );
});
