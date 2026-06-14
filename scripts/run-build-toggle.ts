#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-run
import { runBuildToggle } from '../src/orchestration/ansible.ts'

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`
  for (const arg of Deno.args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length)
    }
  }
  return undefined
}

const uiMode = parseArg('ui-mode')
const instanceRunMode = parseArg('instance-run-mode')
const forceBuild = parseArg('force-build') === 'true'

if (uiMode !== 'dev' && uiMode !== 'static') {
  console.error('Missing or invalid --ui-mode=dev|static')
  Deno.exit(1)
}

if (instanceRunMode !== 'source' && instanceRunMode !== 'compiled') {
  console.error('Missing or invalid --instance-run-mode=source|compiled')
  Deno.exit(1)
}

await runBuildToggle({
  uiMode,
  instanceRunMode,
  forceBuild,
})
