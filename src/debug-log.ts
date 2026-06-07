const DEBUG_LOG_PATH = '/opt/turbopanel/platform/turbopanel/.cursor/debug-f89c14.log'
const DEBUG_ENDPOINT =
  'http://localhost:7686/ingest/1326dc58-69fc-4780-871a-d504ad5cb2c6'

export async function agentDebugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = 'pre-fix',
): Promise<void> {
  const payload = {
    sessionId: 'f89c14',
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  }
  const line = `${JSON.stringify(payload)}\n`

  // #region agent log
  await Promise.allSettled([
    fetch(DEBUG_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Debug-Session-Id': 'f89c14',
      },
      body: JSON.stringify(payload),
    }),
    Deno.writeTextFile(DEBUG_LOG_PATH, line, { append: true }),
  ])
  // #endregion
}

export async function readParentComm(): Promise<string> {
  try {
    const stat = await Deno.readTextFile('/proc/self/stat')
    const ppid = Number(stat.split(' ')[3])
    return (await Deno.readTextFile(`/proc/${ppid}/comm`)).trim()
  } catch {
    return 'unknown'
  }
}

export async function probeLogDirectory(
  logDir: string,
): Promise<Record<string, unknown>> {
  const probePath = `${logDir}/.debug-write-probe`
  const result: Record<string, unknown> = {
    logDir,
    dirExists: false,
    dirWritable: false,
    daemonLogExists: false,
    daemonLogSize: null as number | null,
    probeWriteOk: false,
    probeError: null as string | null,
  }

  try {
    const dirStat = await Deno.stat(logDir)
    result.dirExists = dirStat.isDirectory
  } catch (err) {
    result.probeError = err instanceof Error ? err.message : String(err)
    return result
  }

  try {
    await Deno.writeTextFile(probePath, `probe ${Date.now()}\n`, { append: true })
    result.dirWritable = true
    result.probeWriteOk = true
    await Deno.remove(probePath)
  } catch (err) {
    result.probeError = err instanceof Error ? err.message : String(err)
  }

  try {
    const logStat = await Deno.stat(`${logDir}/daemon.log`)
    result.daemonLogExists = logStat.isFile
    result.daemonLogSize = logStat.size
  } catch {
    result.daemonLogExists = false
  }

  return result
}
