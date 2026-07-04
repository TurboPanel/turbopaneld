export interface BuildInfo {
  commit: string;
  buildId: string;
  builtAt: string;
  channel: string;
}

export const BUILD_INFO: BuildInfo = {
  commit: "6a9c55f",
  buildId: "test-20260703-153052-6a9c55f",
  builtAt: "2026-07-03T15:30:52Z",
  channel: "trunk",
};

export function getBuildInfo(): BuildInfo {
  return BUILD_INFO;
}
