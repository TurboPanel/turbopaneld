import { runStreamingLines } from './exec.ts'

/** ISO-8601 timestamp emitted by ansible.posix.jsonl. */
export type AnsibleEventTimestamp = string

export interface AnsibleDuration {
  start: string
  end?: string
}

export interface AnsiblePlayInfo {
  name: string
  id: string
  path: string
  duration: AnsibleDuration
}

export interface AnsibleTaskInfo {
  name: string
  id: string
  path: string
  duration: AnsibleDuration
}

/** Per-host task result payload (shape varies by module). */
export type AnsibleHostResult = Record<string, unknown> & {
  action?: string
  changed?: boolean
  failed?: boolean
  skipped?: boolean
  unreachable?: boolean
  msg?: string
}

export interface AnsiblePlaybookStats {
  [host: string]: Record<string, number>
}

/** Base fields present on every JSONL line from ansible.posix.jsonl. */
export interface AnsibleEventBase {
  _event: string
  _timestamp: AnsibleEventTimestamp
}

export interface AnsiblePlayStartEvent extends AnsibleEventBase {
  _event: 'v2_playbook_on_play_start'
  play: AnsiblePlayInfo
  tasks: unknown[]
}

export interface AnsibleTaskStartEvent extends AnsibleEventBase {
  _event:
    | 'v2_playbook_on_task_start'
    | 'v2_playbook_on_handler_task_start'
    | 'v2_runner_on_start'
  task: AnsibleTaskInfo
  hosts: Record<string, AnsibleHostResult>
}

export interface AnsibleTaskResultEvent extends AnsibleEventBase {
  _event:
    | 'v2_runner_on_ok'
    | 'v2_runner_on_failed'
    | 'v2_runner_on_unreachable'
    | 'v2_runner_on_skipped'
  task: AnsibleTaskInfo
  hosts: Record<string, AnsibleHostResult>
}

export interface AnsiblePlayStatsEvent extends AnsibleEventBase {
  _event: 'v2_playbook_on_stats'
  stats: AnsiblePlaybookStats
  custom_stats: Record<string, unknown>
  global_custom_stats: Record<string, unknown>
}

/** Forward-compatible fallback for callback events not yet modeled. */
export interface AnsibleUnknownEvent extends AnsibleEventBase {
  [key: string]: unknown
}

/**
 * Serializable Ansible playbook event union parsed from ansible.posix.jsonl stdout.
 *
 * **Streaming seam:** downstream consumers (dev console, future HTTP/WebSocket control
 * surfaces) should import this module and subscribe via `onEvent` / `runPlaybookStreaming`.
 * Payloads are JSON-serializable and stable enough to relay over APIs or WS without
 * re-parsing raw ansible stdout.
 */
export type AnsibleEvent =
  | AnsiblePlayStartEvent
  | AnsibleTaskStartEvent
  | AnsibleTaskResultEvent
  | AnsiblePlayStatsEvent
  | AnsibleUnknownEvent

export type AnsibleEventHandler = (event: AnsibleEvent) => void

/** Parse one JSONL stdout line from ansible.posix.jsonl; returns null for blank/non-JSON lines. */
export function parseAnsibleJsonlLine(line: string): AnsibleEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record._event !== 'string' || typeof record._timestamp !== 'string') {
      return null
    }
    return record as AnsibleEvent
  } catch {
    return null
  }
}

export interface PlaybookStreamingOptions {
  cwd?: string
  env?: Record<string, string>
  onEvent: AnsibleEventHandler
}

/**
 * Run ansible-playbook with stdout parsed as JSONL task events.
 *
 * Stderr remains inherited so human-oriented Ansible warnings still reach journald.
 */
export async function runPlaybookStreaming(
  ansiblePlaybookBin: string,
  args: string[],
  options: PlaybookStreamingOptions,
): Promise<void> {
  const result = await runStreamingLines(ansiblePlaybookBin, args, {
    cwd: options.cwd,
    env: options.env,
    onStdoutLine: (line) => {
      const event = parseAnsibleJsonlLine(line)
      if (event) options.onEvent(event)
    },
  })

  if (!result.success) {
    throw new Error(
      `ansible-playbook failed (exit ${result.code}): ${ansiblePlaybookBin} ${args.join(' ')}`,
    )
  }
}
