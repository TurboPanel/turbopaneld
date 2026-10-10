/**
 * Import for its side effect in a test file that drives a whole environment
 * deploy: the hosting Caddy's privileged commands (validate, enable, reload)
 * have no host to run on there, and every one of them answers success. The
 * vendored binary, `tpedge` account, and ingress guard are treated as ready so
 * `ensureHostingCaddyRuntime` never runs ansible or downloads into `/opt`.
 */
import {
  setHostingCaddyAccountCheckForTest,
  setHostingCaddyBinaryPresentForTest,
  setIngressGuardCheckForTest,
} from "../deploy/ensure-hosting-caddy.ts";
import { setIngressHostCommandForTest } from "../deploy/ingress.ts";

setIngressHostCommandForTest(() =>
  Promise.resolve({ success: true, stderr: "" })
);
setHostingCaddyAccountCheckForTest(() => Promise.resolve(true));
setIngressGuardCheckForTest(() => Promise.resolve(true));
setHostingCaddyBinaryPresentForTest(() => Promise.resolve(true));
