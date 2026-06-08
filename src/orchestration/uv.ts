import { encodeHex } from '@std/encoding/hex'
import { join } from '@std/path'
import { run } from './exec.ts'
import {
  RUNTIME_BIN_DIR,
  resolveUvTarget,
  UV_BIN,
  UV_VERSION,
  UVX_BIN,
  uvDownloadUrl,
} from './paths.ts'

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/** Returns the installed uv version string (e.g. "0.11.19") or null if not present. */
async function installedUvVersion(): Promise<string | null> {
  if (!(await fileExists(UV_BIN))) return null
  try {
    const result = await run(UV_BIN, ['--version'], { stream: false })
    if (!result.success) return null
    // Output looks like: "uv 0.11.19"
    const match = result.stdout.trim().match(/uv\s+(\S+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return encodeHex(new Uint8Array(digest))
}

/**
 * Ensure the vendored uv binary exists at the pinned version.
 *
 * Idempotent: if `bin/uv` already reports {@link UV_VERSION}, this is a no-op.
 * Otherwise it downloads the matching release tarball, verifies its SHA-256 against
 * the published `.sha256` sibling, extracts it, and installs `uv` + `uvx`.
 */
export async function ensureUv(): Promise<void> {
  const current = await installedUvVersion()
  if (current === UV_VERSION) {
    console.log(`[orchestration] uv ${UV_VERSION} already installed`)
    return
  }
  if (current) {
    console.log(
      `[orchestration] uv ${current} found, replacing with pinned ${UV_VERSION}`,
    )
  }

  const { asset } = resolveUvTarget()
  const url = uvDownloadUrl(asset)
  console.log(`[orchestration] downloading uv ${UV_VERSION} from ${url}`)

  const [archiveBytes, expectedSha] = await Promise.all([
    fetchBytes(url),
    fetchSha256(`${url}.sha256`),
  ])

  const actualSha = await sha256Hex(archiveBytes)
  if (actualSha !== expectedSha) {
    throw new Error(
      `uv archive checksum mismatch.\n  expected: ${expectedSha}\n  actual:   ${actualSha}`,
    )
  }
  console.log('[orchestration] uv archive checksum verified')

  await Deno.mkdir(RUNTIME_BIN_DIR, { recursive: true })
  await extractUv(archiveBytes, asset)

  const version = await installedUvVersion()
  if (version !== UV_VERSION) {
    throw new Error(
      `uv install verification failed: expected ${UV_VERSION}, got ${version ?? 'none'}`,
    )
  }
  console.log(`[orchestration] uv ${UV_VERSION} installed at ${UV_BIN}`)
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

async function fetchSha256(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(
      `Failed to download checksum ${url}: ${res.status} ${res.statusText}`,
    )
  }
  // Format is "<hex>  <filename>".
  const text = await res.text()
  const hex = text.trim().split(/\s+/)[0]?.toLowerCase()
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`Unexpected checksum content from ${url}: "${text.trim()}"`)
  }
  return hex
}

/**
 * Extract `uv` and `uvx` from the release tarball into the runtime bin dir.
 *
 * The archive unpacks to a single `uv-<triple>/` directory; we untar into a temp
 * dir (system `tar` is always present on Linux) then move the two binaries into
 * place so partial state is never left in `bin/`.
 */
async function extractUv(archiveBytes: Uint8Array, asset: string): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: 'turbopanel-uv-' })
  try {
    const archivePath = join(tmpDir, asset)
    await Deno.writeFile(archivePath, archiveBytes)

    const result = await run('tar', ['-xzf', archivePath, '-C', tmpDir], {
      stream: false,
    })
    if (!result.success) {
      throw new Error(`Failed to extract uv archive: ${result.stderr.trim()}`)
    }

    // Tarball name is "uv-<triple>.tar.gz"; the inner dir is "uv-<triple>".
    const innerDir = join(tmpDir, asset.replace(/\.tar\.gz$/, ''))
    for (const [src, dst] of [
      [join(innerDir, 'uv'), UV_BIN],
      [join(innerDir, 'uvx'), UVX_BIN],
    ] as const) {
      await Deno.copyFile(src, dst)
      await Deno.chmod(dst, 0o755)
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {})
  }
}
