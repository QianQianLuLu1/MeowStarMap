/**
 * N0.5 官方服装图标包资产门禁（一次性工具，可重跑）。
 *
 * 来源：NikkiSync v1.0.40-public-beta.2 的 MomoCamera-PC-1.0.40.exe 内嵌
 * `NikkiSync.Icons.Full.zip`（.NET single-file 资源，非公开独立资产）。
 * 本脚本只做「校验 → 解包 → 落位」，不实现任何图标加载/更新逻辑：
 * 运行时加载 100% 复用上游 `LocalClothingIconPack.loadLocalClothingIconPack()`。
 *
 * 用法：
 *   npx tsx scripts/extract-nikkisync-icon-pack.ts --exe <path/to/exe>
 *   npx tsx scripts/extract-nikkisync-icon-pack.ts --exe <path/to/exe> --apply
 *
 * 铁律：任一 SHA / `unzip -t` / manifest 校验失败即退出码 1，不落位半套资源。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ICON_PACK_EXE_SHA256 =
  '7d4aad76d9fe7355cea9d695cf7e67f32be09dfe0e4b1e9d65533953932bf250'
export const ICON_PACK_ZIP_SHA256 =
  'ddd70fbf87ebeb9722e37365a76a5d159951f1104c2e378578316e884e840b4f'
export const ICON_PACK_MANIFEST_SHA256 =
  'c39e0f672867c7ee59fe9f7865510d95a0f2bbbf6d47f56a21f9a95e134752f0'
export const ICON_PACK_ZIP_SIZE = 77678905
export const ICON_PACK_MIN_ENTRIES = 9000
export const CLOTHING_ICONS_DIR_SEGMENTS = [
  'resources',
  'nikkisync',
  'pc',
  'clothing-icons'
] as const

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ZIP_LOCAL_HEADER = Buffer.from('PK\x03\x04', 'latin1')
const ZIP_EOCD = Buffer.from('PK\x05\x06', 'latin1')

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

const allIndexes = (buffer: Buffer, needle: Buffer): number[] => {
  const found: number[] = []
  let from = 0
  for (;;) {
    const at = buffer.indexOf(needle, from)
    if (at < 0) break
    found.push(at)
    from = at + 1
  }
  return found
}

/**
 * 从 PE 字节里定位内嵌 ZIP：优先按已知长度精确切片 + SHA 复核；
 * 若起始位置有前缀偏移，则回退用 EOCD 推导实际结束位置。
 * 两种路径都必须通过 expectedSha，否则返回 undefined（不静默接受错误字节）。
 */
export function carveZipFromBuffer(
  buffer: Buffer,
  expectedSize: number,
  expectedSha: string
): Buffer | undefined {
  if (expectedSize <= 0 || buffer.length < expectedSize) return undefined
  // 271 MiB 的 PE 里可能有很多 PK 头（ZIP 内每个文件也有一个），限制 SHA 计算次数防病态耗时。
  const MAX_HASH_ATTEMPTS = 256
  let attempts = 0
  for (const start of allIndexes(buffer, ZIP_LOCAL_HEADER)) {
    if (attempts >= MAX_HASH_ATTEMPTS) break
    const end = start + expectedSize
    if (end > buffer.length) break

    const exact = buffer.subarray(start, end)
    attempts += 1
    if (sha256(exact) === expectedSha) return exact

    const eocd = buffer.indexOf(ZIP_EOCD, Math.max(start, end - 256))
    if (eocd < 0 || eocd + 22 > buffer.length) continue
    const derivedEnd = eocd + 22 + buffer.readUInt16LE(eocd + 20)
    if (derivedEnd - start !== expectedSize || derivedEnd > buffer.length) continue
    const derived = buffer.subarray(start, derivedEnd)
    attempts += 1
    if (sha256(derived) === expectedSha) return derived
  }
  return undefined
}

interface IconManifest {
  schemaVersion?: unknown
  imageFormat?: unknown
  entries?: Array<{ id?: unknown; sha256?: unknown; file?: unknown }>
  effectEntries?: unknown[]
}

/** 纯校验：SHA → JSON → schema → 条目下限，任一不满足即抛业务错误。 */
export function verifyIconPackManifest(root: string, expectedSha: string): number {
  const bytes = fs.readFileSync(path.join(root, 'manifest.json'))
  const actualSha = sha256(bytes)
  if (actualSha !== expectedSha) {
    throw new Error(`Icon pack manifest sha256 mismatch: ${actualSha}`)
  }
  const manifest = JSON.parse(bytes.toString('utf8')) as IconManifest
  if (manifest.schemaVersion !== 2 || manifest.imageFormat !== 'webp') {
    throw new Error('Icon pack schemaVersion must be 2 with webp imageFormat')
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length < ICON_PACK_MIN_ENTRIES) {
    throw new Error(
      `Icon pack entries below minimum: ${Array.isArray(manifest.entries) ? manifest.entries.length : 'missing'}`
    )
  }
  return manifest.entries.length
}

const findManifestRoot = (root: string): string => {
  if (fs.existsSync(path.join(root, 'manifest.json'))) return root
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(root, entry.name)
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate
  }
  throw new Error('Icon pack zip has no manifest.json at its root or first-level directory')
}

export const verifySampleIcons = (root: string): number => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
  ) as IconManifest
  // F5：manifest 是外部输入，条目路径越出包根（../、绝对路径）必须拒绝，
  // 不能让 path.join 直接拼出包外文件再当图标读取。
  const rootPrefix = path.resolve(root) + path.sep
  let checked = 0
  for (const entry of manifest.entries ?? []) {
    if (checked >= 10) break
    if (typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') continue
    const file = path.resolve(root, entry.file)
    if (!file.startsWith(rootPrefix)) {
      throw new Error(`Icon pack path escapes root: ${entry.file}`)
    }
    if (!fs.existsSync(file)) throw new Error(`Icon pack sample icon missing: ${entry.file}`)
    if (sha256(fs.readFileSync(file)) !== entry.sha256) {
      throw new Error(`Icon pack sample icon sha256 mismatch: ${entry.file}`)
    }
    checked += 1
  }
  return checked
}

interface CliArgs {
  exe?: string
  apply: boolean
}

/** 逐文件递归拷贝：不依赖 fs.cpSync（当前运行时该 API 可能不落盘），逐件失败立即上抛。
 * F5：先清空目标目录，保证不同版本 ZIP 重跑不会残留旧图标（脚本自称「可重跑」）。 */
export const copyTree = (src: string, dest: string): void => {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    } else {
      throw new Error(`Icon pack tree has unsupported entry: ${from}`)
    }
  }
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  const args: CliArgs = { apply: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--exe' && argv[i + 1]) {
      args.exe = argv[i + 1]
      i += 1
    } else if (argv[i] === '--apply') {
      args.apply = true
    }
  }
  return args
}

/** F5：Windows / CI 未必带系统 unzip，探测不到就回退 Windows 内置 tar（bsdtar 支持 zip）。
 * 探测器可注入，便于单测覆盖「unzip 缺席」分支，不引入新的 zip 依赖。 */
const hasUnzip = (command: string): boolean => {
  try {
    const result = spawnSync(command, ['-v'], { stdio: 'ignore' })
    return result.status === 0 && result.error === undefined
  } catch {
    return false
  }
}

export function resolveUnzipCommand(
  probe: (command: string) => boolean = hasUnzip
): 'unzip' | 'tar' {
  return probe('unzip') ? 'unzip' : 'tar'
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!args.exe) {
    console.error('[icon-pack] --exe <path> is required')
    process.exit(1)
  }
  const exePath = path.resolve(args.exe)
  if (!fs.existsSync(exePath)) {
    console.error(`[icon-pack] exe not found: ${exePath}`)
    process.exit(1)
  }

  const exeBytes = fs.readFileSync(exePath)
  const exeSha = sha256(exeBytes)
  if (exeSha !== ICON_PACK_EXE_SHA256) {
    console.error(`[icon-pack] exe sha256 mismatch: ${exeSha}`)
    process.exit(1)
  }

  const zipBytes = carveZipFromBuffer(exeBytes, ICON_PACK_ZIP_SIZE, ICON_PACK_ZIP_SHA256)
  if (!zipBytes) {
    console.error('[icon-pack] embedded icon zip not found (size+sha did not match)')
    process.exit(1)
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nikkisync-icon-pack-extract-'))
  try {
    const zipPath = path.join(work, 'icons.zip')
    fs.writeFileSync(zipPath, zipBytes)
    const tool = resolveUnzipCommand()
    const testArgs = tool === 'unzip' ? ['-t', zipPath] : ['-tf', zipPath]
    execFileSync(tool, testArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    const extracted = path.join(work, 'extracted')
    fs.mkdirSync(extracted)
    const extractArgs =
      tool === 'unzip' ? ['-q', '-o', zipPath, '-d', extracted] : ['-xf', zipPath, '-C', extracted]
    execFileSync(tool, extractArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    const packRoot = findManifestRoot(extracted)
    const entries = verifyIconPackManifest(packRoot, ICON_PACK_MANIFEST_SHA256)
    const samples = verifySampleIcons(packRoot)
    for (const segment of ['icons', 'effects']) {
      const dir = path.join(packRoot, segment)
      if (!fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length === 0) {
        throw new Error(`Icon pack ${segment}/ directory is missing or empty`)
      }
    }

    const target = path.join(projectRoot, ...CLOTHING_ICONS_DIR_SEGMENTS)
    console.log(
      `[icon-pack] exeSha=${exeSha} zipSha=${ICON_PACK_ZIP_SHA256} ` +
        `zipBytes=${zipBytes.length} manifestSha=${ICON_PACK_MANIFEST_SHA256} ` +
        `entries=${entries} samplesVerified=${samples} apply=${args.apply}`
    )
    if (args.apply) {
      copyTree(packRoot, target)
      // 自检：打印成功不等于落盘成功，缺 manifest 即视为门禁失败并上抛。
      if (!fs.existsSync(path.join(target, 'manifest.json'))) {
        throw new Error(`Icon pack staging failed: manifest not found at ${target}`)
      }
      const stagedFiles = fs
        .readdirSync(path.join(target, 'icons'))
        .filter((name) => name.endsWith('.webp')).length
      console.log(`[icon-pack] applied to ${target} (icons=${stagedFiles})`)
    } else {
      console.log('[icon-pack] dry-run only (pass --apply to stage the pack)')
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

const invokedDirectly = (): boolean => {
  const self = path.resolve(fileURLToPath(import.meta.url))
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
  return self.toLowerCase() === entry.toLowerCase()
}

if (invokedDirectly()) main()
