import { DAEMON_ROOT } from './orchestration/paths.ts'

/** Accumulator for an in-flight dev-sync transfer (base64 chunks by index). */
export interface DevSyncState {
  chunks: string[]
  totalChunks: number
}

export function newDevSyncState(totalChunks: number): DevSyncState {
  return { chunks: new Array<string>(totalChunks).fill(''), totalChunks }
}

/**
 * Unpack a gzipped tarball of a daemon build over the current checkout.
 *
 * The instance excludes .git, .env, orchestration/runtime, orchestration/roles,
 * cloudflared/tunnels, and node_modules, so a sync swaps source without
 * clobbering the host-specific instance URL config, ansible runtime, or tunnel
 * tokens. Requires the daemon's broad `--allow-run` / `--allow-write`.
 */
export async function applyDevSyncTarball(bytes: Uint8Array): Promise<void> {
  const tmp = await Deno.makeTempFile({ suffix: '.tgz' })
  try {
    await Deno.writeFile(tmp, bytes)
    const command = new Deno.Command('tar', {
      args: ['-xzf', tmp, '-C', DAEMON_ROOT],
      stdout: 'piped',
      stderr: 'piped',
    })
    const out = await command.output()
    if (!out.success) {
      throw new Error(`tar extract failed: ${new TextDecoder().decode(out.stderr).trim()}`)
    }

    // Warm Deno's module cache so the restarted process starts fast.
    const cache = new Deno.Command('deno', {
      args: ['cache', 'main.ts'],
      cwd: DAEMON_ROOT,
      stdout: 'piped',
      stderr: 'piped',
    })
    const cacheOut = await cache.output()
    if (!cacheOut.success) {
      console.warn(
        '[dev-sync] deno cache warning:',
        new TextDecoder().decode(cacheOut.stderr).trim(),
      )
    }
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
}
