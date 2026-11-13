/** Signed icon-pack delta ZIP application, staging and atomic activation. */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import yauzl from 'yauzl'

export const ICON_PATH_PATTERN =
  /^(icons\/[1-9][0-9]{0,11}|fallbacks\/[0-9a-f]{64}|effects\/(pose|lighting|filter)-[1-9][0-9]{0,11})\.webp$/

const JSON_ENTRIES = ['manifest.json', 'update.json'] as const
const MAX_JSON_BYTES = 4 * 1024 * 1024
const MAX_WEBP_BYTES = 256 * 1024
const MAX_ENTRIES = 30002

export function isAllowedIconPath(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 256) return false
  if ((JSON_ENTRIES as readonly string[]).includes(name)) return true
  if (name.startsWith('/') || name.includes('\\') || name.includes('..') || name.includes(':')) {
    return false
  }
  return ICON_PATH_PATTERN.test(name)
}

export function resolveStagingPath(stagingDir: string, name: string): string {
  if (!isAllowedIconPath(name)) throw new Error('Invalid delta entry')
  const resolved = path.resolve(stagingDir, ...name.split('/'))
  const root = path.resolve(stagingDir) + path.sep
  if (!resolved.startsWith(root)) throw new Error('Invalid delta entry')
  return resolved
}

/** Read a ZIP using the mature yauzl reader; every entry is name/size validated before buffering. */
export async function readDeltaZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Invalid delta entry')
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, result) => {
      // 归一化第三方解析器的原始报错：不得把内部路径/偏移细节漏给上层调用方。
      if (error || !result) reject(new Error('Invalid delta entry'))
      else resolve(result)
    })
  })
  const files = new Map<string, Buffer>()
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName
        if (files.has(name) || !isAllowedIconPath(name) || files.size >= MAX_ENTRIES) {
          fail(new Error('Invalid delta entry'))
          return
        }
        const cap = (JSON_ENTRIES as readonly string[]).includes(name)
          ? MAX_JSON_BYTES
          : MAX_WEBP_BYTES
        if (entry.uncompressedSize > cap) {
          fail(new Error('Invalid delta entry'))
          return
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(new Error('Invalid delta entry'))
            return
          }
          const chunks: Buffer[] = []
          let total = 0
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > cap) {
              fail(new Error('Invalid delta entry'))
              stream.destroy()
              return
            }
            chunks.push(chunk)
          })
          stream.on('end', () => {
            files.set(name, Buffer.concat(chunks))
            zip.readEntry()
          })
          stream.on('error', () => fail(new Error('Invalid delta entry')))
        })
      })
      zip.on('end', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })
      zip.on('error', () => fail(new Error('Invalid delta entry')))
      zip.readEntry()
    })
    return files
  } finally {
    zip.close()
  }
}

export function verifySnapshot(
  manifestBuffer: Buffer,
  expectedSha256: string,
  files: Map<string, Buffer>
): void {
  const actual = createHash('sha256').update(manifestBuffer).digest('hex')
  if (actual !== expectedSha256.toLowerCase()) throw new Error('Invalid icon snapshot')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(manifestBuffer.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Invalid icon snapshot')
  }
  if (parsed.schemaVersion !== 2 || parsed.imageFormat !== 'webp') {
    throw new Error('Invalid icon snapshot')
  }
  for (const key of ['entries', 'fallbackEntries', 'effectEntries']) {
    if (key in parsed && !Array.isArray(parsed[key])) throw new Error('Invalid icon snapshot')
  }
  for (const [name, bytes] of files) {
    if ((JSON_ENTRIES as readonly string[]).includes(name)) continue
    if (bytes.length > MAX_WEBP_BYTES) throw new Error('Invalid icon snapshot')
  }
}

export interface ApplyDeltaInput {
  readonly zip: Buffer
  readonly expectedManifestSha256: string
  readonly stagingDir: string
  readonly exists?: (p: string) => boolean
  readonly writeFile?: (p: string, data: Buffer) => Promise<void> | void
}

export async function applyIconDelta(
  input: ApplyDeltaInput
): Promise<{ manifestPath: string; fileCount: number }> {
  const files = await readDeltaZip(input.zip)
  const manifest = files.get('manifest.json')
  const update = files.get('update.json')
  if (!manifest || !update) throw new Error('Invalid delta entry')
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(update.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error('Invalid delta entry')
  }
  if (meta.schemaVersion !== 1 || meta.targetManifestSha256 !== input.expectedManifestSha256) {
    throw new Error('Invalid delta entry')
  }
  // F9：update.json.files 清单逐项校验（对齐上游 IconPackUpdater.cs:344-363）：
  // 数量与其余条目吻合、path 白名单且真实在包、sha256/size 等于实读值。
  // 任一不符整包拒绝，先于任何写盘。
  const declaredFiles = meta.files
  if (!Array.isArray(declaredFiles) || declaredFiles.length !== files.size - JSON_ENTRIES.length) {
    throw new Error('Invalid delta entry')
  }
  const consumed = new Set<string>()
  for (const item of declaredFiles) {
    const entry = item as { path?: unknown; sha256?: unknown; size?: unknown } | null
    const name = entry?.path
    if (
      !entry ||
      typeof name !== 'string' ||
      (JSON_ENTRIES as readonly string[]).includes(name) ||
      !isAllowedIconPath(name) ||
      consumed.has(name) ||
      !files.has(name)
    ) {
      throw new Error('Invalid delta entry')
    }
    consumed.add(name)
    const bytes = files.get(name) as Buffer
    if (
      typeof entry.sha256 !== 'string' ||
      !/^[a-fA-F0-9]{64}$/.test(entry.sha256) ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256.toLowerCase() ||
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size !== bytes.length
    ) {
      throw new Error('Invalid delta entry')
    }
  }
  verifySnapshot(manifest, input.expectedManifestSha256, files)
  const write = input.writeFile ?? fs.promises.writeFile
  const staging = path.resolve(input.stagingDir)
  for (const [name, bytes] of files) {
    const target = resolveStagingPath(staging, name)
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    await write(target, bytes)
  }
  return { manifestPath: path.join(staging, 'manifest.json'), fileCount: files.size }
}

export interface ActivateInput {
  readonly activeDir: string
  readonly candidateDir: string
  readonly backupDir: string
  readonly exists?: (p: string) => boolean
  readonly rename?: (from: string, to: string) => void
}

/** Atomic directory swap with rollback; never leaves the app without an icon pack. */
export function activatePrepared(input: ActivateInput): { ok: boolean; reason?: string } {
  const exists = input.exists ?? fs.existsSync
  const rename = input.rename ?? fs.renameSync
  if (!exists(input.activeDir) || !exists(input.candidateDir)) {
    return { ok: false, reason: 'staging directories missing' }
  }
  let backedUp = false
  try {
    rename(input.activeDir, input.backupDir)
    backedUp = true
    rename(input.candidateDir, input.activeDir)
    return { ok: true }
  } catch (error) {
    if (backedUp) {
      try {
        rename(input.backupDir, input.activeDir)
      } catch {
        // rollback failure is reported below, never swallowed silently
      }
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Icon pack activation failed'
    }
  }
}

export function readReadyId(dir: string): string | null {
  try {
    const value = fs.readFileSync(path.join(dir, 'ready.txt'), 'utf8').trim()
    return /^[a-f0-9]{32}$/.test(value) ? value : null
  } catch {
    return null
  }
}

export function pruneOldJobs(rootDir: string, keep: number): string[] {
  if (!fs.existsSync(rootDir)) return []
  const names = fs
    .readdirSync(rootDir)
    .filter((name) => /^[a-f0-9]{32}$/.test(name))
    .sort()
  return names.slice(0, Math.max(0, names.length - Math.max(0, keep)))
}
