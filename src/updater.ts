import { DAEMON_ROOT } from './orchestration/paths.ts'

/**
 * Self-update the daemon checkout when its commit drifts from the instance's.
 *
 * The instance reports the canonical commit (its own daemon checkout HEAD) over
 * the `/ws` connection and via `GET /api/daemon/version`. When ours differs we
 * fast-forward to `origin/<trunk>`. Because the daemon runs under
 * `deno run --watch` (under systemd), changed files trigger an automatic
 * relaunch -- no explicit restart is needed here.
 */

const TRUNK_BRANCH = Deno.env.get('TURBOPANEL_TRUNK_BRANCH')?.trim() || 'trunk'

let updating = false

async function git(
  args: string[],
  opts: { capture?: boolean } = {},
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const command = new Deno.Command('git', {
    args: ['-C', DAEMON_ROOT, ...args],
    stdout: opts.capture ? 'piped' : 'inherit',
    stderr: opts.capture ? 'piped' : 'inherit',
  })
  const out = await command.output()
  const decoder = new TextDecoder()
  return {
    success: out.success,
    stdout: opts.capture ? decoder.decode(out.stdout).trim() : '',
    stderr: opts.capture ? decoder.decode(out.stderr).trim() : '',
  }
}

function short(commit: string): string {
  return commit.slice(0, 12)
}

/** The daemon checkout's current HEAD, or null if git is unavailable. */
export async function getLocalCommit(): Promise<string | null> {
  const result = await git(['rev-parse', 'HEAD'], { capture: true })
  return result.success ? result.stdout : null
}

/** Fast-forward the checkout to `origin/<trunk>`. Returns true on success. */
export async function syncToTrunk(): Promise<boolean> {
  console.log(`[updater] fetching origin ${TRUNK_BRANCH}`)
  const fetched = await git(['fetch', 'origin', TRUNK_BRANCH])
  if (!fetched.success) {
    console.error('[updater] git fetch failed')
    return false
  }

  const reset = await git(['reset', '--hard', `origin/${TRUNK_BRANCH}`])
  if (!reset.success) {
    console.error('[updater] git reset failed')
    return false
  }

  const commit = await getLocalCommit()
  console.log(
    `[updater] checkout now at ${commit ? short(commit) : 'unknown'}; ` +
      'Deno --watch will relaunch the daemon',
  )
  return true
}

/**
 * Compare the instance's expected commit against our checkout and update on
 * mismatch. Re-entrancy is guarded so overlapping WS pushes and poll ticks don't
 * fire concurrent `git` operations.
 */
export async function maybeUpdate(
  instanceCommit: string | undefined,
): Promise<void> {
  if (!instanceCommit || instanceCommit === 'unknown') return
  if (updating) return

  const local = await getLocalCommit()
  if (!local) {
    console.warn(
      '[updater] could not resolve local commit; skipping update check',
    )
    return
  }
  if (local === instanceCommit) return

  console.log(
    `[updater] commit drift detected: local ${short(local)} != instance ${
      short(instanceCommit)
    }`,
  )

  updating = true
  try {
    await syncToTrunk()
  } catch (err) {
    console.error(
      '[updater] update failed:',
      err instanceof Error ? err.message : err,
    )
  } finally {
    updating = false
  }
}
