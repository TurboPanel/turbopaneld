import { assertEquals } from "@std/assert";
import {
  LABEL_SERVICE_ID,
  LABEL_SYSTEM_COMPONENT,
  legacyLabelKey,
  readLabel,
  traefikLabelConstraint,
} from "./labels.ts";

const test = Deno.test.bind(Deno);

test("labels are written under io.turbopanel and the old prefix is derived", () => {
  assertEquals(LABEL_SERVICE_ID, "io.turbopanel.service");
  assertEquals(legacyLabelKey(LABEL_SERVICE_ID), "com.turbopanel.service");
  assertEquals(
    legacyLabelKey(LABEL_SYSTEM_COMPONENT),
    "com.turbopanel.system.component",
  );
  assertEquals(legacyLabelKey("turbopanel.role"), "turbopanel.role");
});

test("readLabel prefers the new label and falls back to the old prefix", () => {
  assertEquals(
    readLabel({ "io.turbopanel.service": "n" }, LABEL_SERVICE_ID),
    "n",
  );
  assertEquals(
    readLabel({ "com.turbopanel.service": "o" }, LABEL_SERVICE_ID),
    "o",
  );
  assertEquals(
    readLabel(
      { "io.turbopanel.service": "n", "com.turbopanel.service": "o" },
      LABEL_SERVICE_ID,
    ),
    "n",
  );
  assertEquals(readLabel({}, LABEL_SERVICE_ID), undefined);
  assertEquals(readLabel(undefined, LABEL_SERVICE_ID), undefined);
});

test("a Traefik constraint matches either prefix", () => {
  assertEquals(
    traefikLabelConstraint(LABEL_SERVICE_ID, "x"),
    "(Label(`io.turbopanel.service`,`x`) || Label(`com.turbopanel.service`,`x`))",
  );
});
