import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  validateDeployHostings,
  validateDeployPathPrefix,
} from "./deploy-validation.ts";

describe("daemon deploy-validation parity", () => {
  it("matches instance pathPrefix rules", () => {
    assertEquals(validateDeployPathPrefix("/metrics"), true);
    assertEquals(validateDeployPathPrefix("metrics"), false);
  });

  it("rejects invalid hostnames", () => {
    const error = validateDeployHostings([{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: ["bad hostname"],
    }]);
    assertEquals(typeof error, "string");
  });
});
