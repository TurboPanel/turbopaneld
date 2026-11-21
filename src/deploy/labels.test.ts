import { assertEquals } from "@std/assert";
import { LABEL_SERVICE_ID, traefikLabelConstraint } from "./labels.ts";

const test = Deno.test.bind(Deno);

test("labels are written under io.turbopanel", () => {
  assertEquals(LABEL_SERVICE_ID, "io.turbopanel.service");
});

test("a Traefik constraint matches the one current label", () => {
  assertEquals(
    traefikLabelConstraint(LABEL_SERVICE_ID, "x"),
    "Label(`io.turbopanel.service`,`x`)",
  );
});
