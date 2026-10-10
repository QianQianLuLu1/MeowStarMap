/**
 * @layer L3
 * @module src/main/thumbnail/generator — resolveExistingThumbnail（round2 N3 启动重绑定）
 *
 * 为什么需要这个方法（本机真实数据取证，非推测）：
 * 153 个图片行里 62 行 thumbnail 为 NULL。按「缓存文件是否已在磁盘」逐行复核（hash 口径
 * 与 getFileHash 一致：sha256(前 1MB) 前 16 hex），**只有 2 行命中现行缓存目录**，
 * 另 33 行只命中缓存目录迁盘前的旧目录（generator 不读那里，遗留问题登记为 DEBT-031），
 * 17 行的源文件已被启动器删除。命中缓存的行进入板块时原本只能走按需生成，而该路径
 * 此前还被读守卫误拦，于是卡片长期停在骨架上。
 *
 * 启动重绑定只做「已有缓存 → 写回引用」，**绝不触发生成**：否则启动会变成一遍全库 hash
 * 加解码风暴（这正是 DEBT-026 长期没被做掉的风险面）。因此本组用例的核心断言是「零解码」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

/** sharp 调用记录：resolveExistingThumbnail 不得触发任何一次解码 */
const sharpCtl = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'wxnn-thumb-rebind-test', `run-${process.pid}`)
  }
}))

vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fault: vi.fn(),
    initLogger: vi.fn()
  }
}))
vi.mock('../../utils/ffmpeg-paths', () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }))
vi.mock('../../utils/process-registry', () => ({
  trackFfmpegCommand: vi.fn(),
  untrackFfmpegCommand: vi.fn()
}))
vi.mock('../../utils/spawn-error-log', () => ({ maybeLogSpawnError: vi.fn() }))
vi.mock('fluent-ffmpeg', () => ({
  default: { ffmpeg: () => ({ on: () => ({ on: () => ({ run: () => undefined }) }) }) }
}))

// sharp 桩：任何调用都被记录并抛错，保证「命中缓存即返回」的路径不产生解码
vi.mock('sharp', () => ({
  default: Object.assign(
    (input: string) => {
      sharpCtl.calls.push(input)
      const chain: Record<string, unknown> = {}
      for (const method of ['resize', 'jpeg', 'toFormat', 'extract', 'rotate', 'flatten']) {
        chain[method] = () => chain
      }
      chain.toFile = () => Promise.reject(new Error('不应触发解码'))
      chain.stats = () => Promise.reject(new Error('不应触发解码'))
      chain.toBuffer = () => Promise.reject(new Error('不应触发解码'))
      return chain
    },
    { cache: vi.fn(), concurrency: vi.fn(), versions: {} }
  )
}))

import { ThumbnailGenerator } from './generator'

/** 与生成器一致的口径：文件前 1MB 的 sha256 取前 16 位 */
function contentHash16(filePath: string): string {
  const buffer = Buffer.alloc(1024 * 1024)
  const fd = fs.openSync(filePath, 'r')
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return crypto
      .createHash('sha256')
      .update(buffer.subarray(0, bytesRead))
      .digest('hex')
      .slice(0, 16)
  } finally {
    fs.closeSync(fd)
  }
}

describe('ThumbnailGenerator.resolveExistingThumbnail（round2 N3）', () => {
  let gen: ThumbnailGenerator
  let workDir = ''
  let sourceFile = ''

  beforeEach(() => {
    sharpCtl.calls = []
    gen = new ThumbnailGenerator()
    workDir = path.join(
      os.tmpdir(),
      'wxnn-thumb-rebind-test',
      `case-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(workDir, { recursive: true })
    gen.setDir(path.join(workDir, 'thumbnails'))
    sourceFile = path.join(workDir, 'a.jpeg')
    fs.writeFileSync(sourceFile, Buffer.from('fake-jpeg-bytes-for-hash', 'utf8'))
  })

  afterEach(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('正常：缓存文件已存在 → 返回该路径，且零解码、零写盘', async () => {
    const cacheDir = path.join(workDir, 'thumbnails')
    fs.mkdirSync(cacheDir, { recursive: true })
    const cached = path.join(cacheDir, `${contentHash16(sourceFile)}.jpg`)
    fs.writeFileSync(cached, Buffer.from('cached-thumb', 'utf8'))
    const before = fs.readdirSync(cacheDir).sort().join(',')

    const resolved = await gen.resolveExistingThumbnail(sourceFile)

    expect(resolved).toBe(cached)
    // 核心：只读判定不得进入 sharp 解码链路（否则启动即全库解码风暴）
    expect(sharpCtl.calls).toHaveLength(0)
    expect(fs.readdirSync(cacheDir).sort().join(',')).toBe(before)
  })

  it('边界：缓存不存在 → 返回 null，且不生成任何缩略图文件', async () => {
    const resolved = await gen.resolveExistingThumbnail(sourceFile)
    expect(resolved).toBeNull()
    expect(sharpCtl.calls).toHaveLength(0)
    expect(fs.existsSync(path.join(workDir, 'thumbnails'))).toBe(false)
  })

  it('异常：源文件不存在 → 返回 null', async () => {
    const missing = path.join(workDir, 'missing.jpeg')
    expect(await gen.resolveExistingThumbnail(missing)).toBeNull()
    expect(sharpCtl.calls).toHaveLength(0)
  })

  it('边界：非法入参（空串 / 非字符串 / 相对路径）→ 直接 null，不碰文件系统', async () => {
    expect(await gen.resolveExistingThumbnail('')).toBeNull()
    expect(await gen.resolveExistingThumbnail('   ' as string)).toBeNull()
    expect(await gen.resolveExistingThumbnail(undefined as unknown as string)).toBeNull()
    expect(await gen.resolveExistingThumbnail(123 as unknown as string)).toBeNull()
    expect(await gen.resolveExistingThumbnail('relative/a.jpeg')).toBeNull()
    expect(sharpCtl.calls).toHaveLength(0)
  })

  it('边界：目录不是文件（同名录径）→ 返回 null 而非抛错', async () => {
    const dirAsFile = path.join(workDir, 'folder.jpeg')
    fs.mkdirSync(dirAsFile, { recursive: true })
    expect(await gen.resolveExistingThumbnail(dirAsFile)).toBeNull()
  })
})
