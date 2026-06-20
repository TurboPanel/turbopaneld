const encoder = new TextEncoder()

function formatParts(parts: unknown[]): string {
  return parts.map((part) => String(part)).join(' ')
}

function splitMessageLines(message: string): string[] {
  const normalized = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return lines.length > 0 ? lines : ['']
}

function formatStructuredLine(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  component: string,
  message: string,
): string {
  return `${new Date().toISOString()} ${level} ${component}  ${message}\n`
}

export function log(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  component: string,
  ...parts: unknown[]
): void {
  const message = formatParts(parts)
  const out = level === 'INFO' || level === 'DEBUG' ? Deno.stdout : Deno.stderr

  for (const line of splitMessageLines(message)) {
    out.writeSync(encoder.encode(formatStructuredLine(level, component, line)))
  }
}

export function logInfo(component: string, ...parts: unknown[]): void {
  log('INFO', component, ...parts)
}

export function logDebug(component: string, ...parts: unknown[]): void {
  log('DEBUG', component, ...parts)
}

export function logWarn(component: string, ...parts: unknown[]): void {
  log('WARN', component, ...parts)
}

export function logError(component: string, ...parts: unknown[]): void {
  log('ERROR', component, ...parts)
}
