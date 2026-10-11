import { assertEquals } from "@std/assert";
import {
  switchoverAbortReactivateBlockedReason,
} from "./switchover-abort-guard.ts";
import { switchoverPromoteErrorMessage } from "./engines/switchover-promote-error.ts";

const test = Deno.test.bind(Deno);

const BASE = {
  managedId: "managed_switchover_guard",
  action: "start" as const,
  reactivateAfterSwitchoverAbort: true,
  engine: "mariadb" as const,
};

test("switchoverAbortReactivateBlockedReason requires control-plane safe confirmation", () => {
  assertEquals(
    switchoverAbortReactivateBlockedReason(BASE),
    "switchover: control plane did not confirm the target never promoted",
  );
  assertEquals(
    switchoverAbortReactivateBlockedReason({
      ...BASE,
      switchoverAbortPromoteSafe: true,
    }),
    null,
  );
});

test("switchoverAbortReactivateBlockedReason refuses completed or promote_started targets", () => {
  assertEquals(
    switchoverAbortReactivateBlockedReason({
      ...BASE,
      switchoverAbortPromoteSafe: true,
      switchoverTargetPromoteCompleted: true,
    }),
    "switchover: target promotion already completed",
  );
  assertEquals(
    switchoverAbortReactivateBlockedReason({
      ...BASE,
      switchoverAbortPromoteSafe: true,
      switchoverTargetPromoteError: switchoverPromoteErrorMessage(
        "promote_started",
        "detail",
      ),
    }),
    "switchover: target promotion already started",
  );
  assertEquals(
    switchoverAbortReactivateBlockedReason({
      ...BASE,
      switchoverAbortPromoteSafe: true,
      switchoverTargetPromoteError: switchoverPromoteErrorMessage(
        "gtid_wait_timeout",
        "detail",
      ),
    }),
    null,
  );
});
