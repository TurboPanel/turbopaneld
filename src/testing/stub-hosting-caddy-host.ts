/**
 * Import for its side effect in a test file that drives a whole environment
 * deploy: the hosting Caddy's privileged commands (validate, enable, reload)
 * have no host to run on there, and every one of them answers success.
 */
import { setIngressHostCommandForTest } from "../deploy/ingress.ts";

setIngressHostCommandForTest(() =>
  Promise.resolve({ success: true, stderr: "" })
);
