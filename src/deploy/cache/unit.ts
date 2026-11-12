/**
 * The systemd unit of one project cache.
 *
 * `tp-host` does not check this text line by line: it rebuilds the whole unit
 * from the few values that vary (id, account, patch release, memory ceiling,
 * port) and refuses any difference, so nothing can ride along. Keep the two in
 * step (`tp_cache_unit_text` in orchestration/scripts/tp-host); a test feeds
 * this rendering through `tp-host` and refuses every one-line change to it.
 */

import { principalHardeningLines, principalSliceName } from "../native/unit.ts";
import type { LayoutPaths } from "../../paths/layout.ts";
import {
  cacheBinaryPath,
  cacheConfigDir,
  cacheConfigPath,
  cacheDataDir,
  cacheRuntimeDirectory,
} from "./runtime.ts";

const MIB = 1024 * 1024;

/**
 * The unit's `MemoryMax`: twice `maxmemory` plus 32 MiB, because the default
 * snapshot forks and copies pages on write.
 */
export function cacheMemoryMaxBytes(maxMemoryMb: number): number {
  return maxMemoryMb * 2 * MIB + 32 * MIB;
}

export type CacheUnitParams = {
  id: string;
  username: string;
  /** Pinned patch release, such as `8.1.11`. */
  patch: string;
  maxMemoryMb: number;
  /** Loopback port; set only for port access. */
  port?: number;
};

export function renderCacheUnit(
  layout: Pick<
    LayoutPaths,
    "runtimesDir" | "configDir" | "principalHomeRoot"
  >,
  params: CacheUnitParams,
): string {
  const { id, username } = params;
  const data = cacheDataDir(layout, username, id);
  const lines = [
    "[Unit]",
    `Description=TurboPanel project cache ${id}`,
    "After=network.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=notify",
    `ExecStart=${cacheBinaryPath(layout, params.patch)} ${
      cacheConfigPath(layout, id)
    }`,
    `User=${username}`,
    `Group=${username}`,
    `Slice=${principalSliceName(username)}`,
    `MemoryMax=${cacheMemoryMaxBytes(params.maxMemoryMb)}`,
    "TasksMax=64",
    "UMask=0077",
    `WorkingDirectory=${data}`,
    `ReadWritePaths=${data}`,
    `TemporaryFileSystem=${layout.configDir}:ro`,
    `BindReadOnlyPaths=${cacheConfigDir(layout, id)}`,
    `RuntimeDirectory=${cacheRuntimeDirectory(id).slice("/run/".length)}`,
    "RuntimeDirectoryMode=0700",
    ...principalHardeningLines(),
    "PrivateDevices=yes",
    "MemoryDenyWriteExecute=yes",
    "RestrictNamespaces=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "IPAddressDeny=any",
  ];
  if (params.port !== undefined) {
    lines.push("IPAddressAllow=127.0.0.1", `Environment=PORT=${params.port}`);
  }
  lines.push(
    "TimeoutStartSec=300",
    "TimeoutStopSec=120",
    "Restart=always",
    "RestartSec=2",
    "RestartSteps=10",
    "RestartMaxDelaySec=120",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  );
  return lines.join("\n");
}
