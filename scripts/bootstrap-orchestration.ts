#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env
import { bootstrapOrchestrationRuntime } from '../src/orchestration/ansible.ts'
import { ensureOrchestrationTree } from '../src/orchestration/bundle-extract.ts'
import { ensurePython } from '../src/orchestration/python.ts'
import { ensureUv } from '../src/orchestration/uv.ts'

try {
  await ensureOrchestrationTree()
  await ensureUv()
  await ensurePython()
  await bootstrapOrchestrationRuntime()
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[bootstrap] ${message}`)
  Deno.exit(1)
}
