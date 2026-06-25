export interface BuildInfo {
  commit: string;
  buildId: string;
  builtAt: string;
  channel: string;
}

export const BUILD_INFO: BuildInfo = {
  commit: "dev",
  buildId: "dev",
  builtAt: "",
  channel: "trunk",
};

export function getBuildInfo(): BuildInfo {
  return BUILD_INFO;
}
