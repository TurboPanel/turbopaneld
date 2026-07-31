/**
 * Test-only helpers — do not import from production code.
 */

export {
  closeWithCode,
  framesOfType,
  installTrackingWebSocket,
  lastFrameOfType,
  MockWebSocket,
  parseSentFrames,
} from "./fake-websocket.ts";

export {
  createFakeClock,
  type FakeClock,
  flushMicrotasks,
} from "./fake-clock.ts";

export {
  createTempLayout,
  type TempLayoutDirs,
  type TempLayoutFixture,
  withTempLayout,
} from "./temp-layout.ts";

export {
  challengeResponse,
  createFakeInstanceApi,
  enrollResponse,
  type FakeInstanceApiResponder,
  jwksResponse,
  parseJsonBody,
  permanentAuthErrorResponse,
  permanentEnrollmentErrorResponse,
  serverKeyMismatchResponse,
  sessionResponse,
  staleIdentityErrorResponse,
  toDaemonApiError,
} from "./fake-instance-api.ts";

export {
  computeJwkKid,
  createTestSigningKey,
  signInstanceJwt,
  type TestSigningMaterial,
} from "./jwks-test-helpers.ts";
