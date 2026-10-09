import { assertEquals } from "@std/assert";
import {
  parseSwitchoverPromoteFailureCode,
  switchoverPromoteErrorMessage,
} from "./switchover-promote-error.ts";

const test = Deno.test.bind(Deno);

test("switchoverPromoteErrorMessage and parseSwitchoverPromoteFailureCode round-trip", () => {
  for (
    const code of [
      "gtid_wait_timeout",
      "gtid_wait_error",
      "promote_started",
    ] as const
  ) {
    const message = switchoverPromoteErrorMessage(code, "detail text");
    assertEquals(parseSwitchoverPromoteFailureCode(message), code);
  }
  assertEquals(parseSwitchoverPromoteFailureCode(undefined), null);
  assertEquals(parseSwitchoverPromoteFailureCode("plain failure"), null);
});
