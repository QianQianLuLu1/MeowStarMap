/**
 * @layer L3
 * @module src/main/thumbnail/generator — GamePlayPhotos 图片豁免的自适应分支（round2 N4）
 *
 * 取证（真实 userData 副本）：79 个 thumbnail=NULL 图片行**全部**位于 GamePlayPhotos 下，
 * 且**全部不在** NikkiPhotos_HighQuality 目录里；而 generateLocked 的豁免只认
 * 「HQ → 兄弟 LQ」一个方向，推导不出即 return null 并禁止生成。这些行因此没有任何出图入口
 * ——重复/缓存板块 20~40 张卡片永久停在骨架，与渲染层风暴无关。
 *
 * 自适应修法（用户确认）：
 * - 源图本身已是低清变体（长边 ≤ 512）→ 直接引用自身，零解码、零新文件；
 * - 其余（3311×1485 云照片、3840×2160 视频封面等）→ 放行走正常生成（实测单张 12~25ms）。
 * HQ → 原生 LQ 的既有短路保持不变（避免与游戏原生缩略图重复存储，这是该豁免的本意）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const ctl = vi.hoisted(() => ({
  /** sharp(input).metadata() 返回的尺寸 */
  width: 3311,
  height: 1485,
  /** 被调用过 metadata 的输入路径 */
  metadataCalls: [] as string[],
  /** 被调用过 toFile 的目标路径（长度即「是否触发解码」） */
  toFileTargets: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'wxnn-thumb-gpp-test', `run-${process.pid}`)
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

vi.mock('sharp', () => ({
  default: Object.assign(
    (input: string) => {
      const chain: Record<string, unknown> = {}
      chain.metadata = () => {
        ctl.metadataCalls.push(input)
        return Promise.resolve({ width: ctl.width, height: ctl.height, format: 'jpeg' })
      }
      for (const method of ['resize', 'jpeg', 'toFormat', 'rotate', 'flatten', 'extract']) {
        chain[method] = () => chain
      }
      chain.toFile = (target: string) => {
        ctl.toFileTargets.push(target)
        // 真实落盘一个非空文件，满足 writeFileAtomic 的 rename 与后续 stat
        fs.writeFileSync(target, Buffer.alloc(64, 0xff))
        return Promise.resolve({ path: target, size: 64 })
      }
      chain.toBuffer = () => Promise.resolve(Buffer.alloc(64, 0xff))
      return chain
    },
    { cache: vi.fn(), concurrency: vi.fn(), versions: {} }
  )
}))

import { ThumbnailGenerator } from './generator'

/** 与生成器一致的内容 hash 口径（前 1MB sha256 前 16 位） */
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

const GAME_SIGNATURE = path.join('X6Game', 'Saved', 'GamePlayPhotos', '114077271')

describe('ThumbnailGenerator GamePlayPhotos 图片豁免自适应（round2 N4）', () => {
  let gen: ThumbnailGenerator
  let workDir = ''
  let gameRoot = ''

  beforeEach(() => {
    ctl.width = 3311
    ctl.height = 1485
    ctl.metadataCalls = []
    ctl.toFileTargets = []
    gen = new ThumbnailGenerator()
    workDir = path.join(
      os.tmpdir(),
      'wxnn-thumb-gpp-test',
      `case-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    gameRoot = path.join(workDir, GAME_SIGNATURE)
    fs.mkdirSync(gameRoot, { recursive: true })
    gen.setDir(path.join(workDir, 'thumbnails'))
  })

  afterEach(() => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  /** 在指定子目录建一个真实存在的图片文件（内容仅用于 hash） */
  function makeImage(relDir: string, name: string): string {
    const dir = path.join(gameRoot, relDir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, Buffer.from(`fake-jpeg:${relDir}:${name}`, 'utf8'))
    return file
  }

  it('正常：GamePlayPhotos 非 HQ 目录的大图 → 不再恒 null，放行走正常生成', async () => {
    const big = makeImage(path.join('CloudPhotos'), '669191461_Low.jpeg')
    ctl.width = 3311
    ctl.height = 1485

    const result = await gen.generate(big)

    expect(result).toBe(path.join(workDir, 'thumbnails', `${contentHash16(big)}.jpg`))
    expect(ctl.toFileTargets.length, '大图应触发一次生成').toBeGreaterThan(0)
  })

  it('正常：源图本身已是低清变体（长边 ≤ 512）→ 直接引用自身，零解码', async () => {
    const small = makeImage(path.join('CloudPhotos', 'Temp'), '1124176602_low_s128.jpeg')
    ctl.width = 128
    ctl.height = 128

    const result = await gen.generate(small)

    expect(result).toBe(small)
    expect(ctl.toFileTargets).toHaveLength(0)
    expect(fs.existsSync(path.join(workDir, 'thumbnails'))).toBe(false)
  })

  it('边界：HQ 原图且原生 LQ 存在 → 仍返回原生 LQ 路径（既有短路不回归）', async () => {
    const native = makeImage(path.join('NikkiPhotos_LowQuality'), 'photo_a.jpeg')
    const hq = makeImage(path.join('NikkiPhotos_HighQuality'), 'photo_a.jpeg')
    void native

    const result = await gen.generate(hq)

    expect(result).toBe(native)
    expect(ctl.toFileTargets).toHaveLength(0)
  })

  it('边界：HQ 原图但原生 LQ 缺失 → 不再返回 null，放行走生成', async () => {
    const hq = makeImage(path.join('NikkiPhotos_HighQuality'), 'missing_partner.jpeg')
    ctl.width = 3840
    ctl.height = 2160

    const result = await gen.generate(hq)

    expect(result).toBe(path.join(workDir, 'thumbnails', `${contentHash16(hq)}.jpg`))
    expect(ctl.toFileTargets.length).toBeGreaterThan(0)
  })

  it('兼容：非 GamePlayPhotos 路径行为不变（仍走生成，不做 metadata 探测）', async () => {
    // 注意：必须落在游戏目录特征之外——workDir/X6Game/Saved/GamePlayPhotos 的上一级仍是豁免路径
    const outside = path.join(workDir, 'normal.jpeg')
    fs.writeFileSync(outside, Buffer.from('fake-jpeg:outside', 'utf8'))
    ctl.width = 3840
    ctl.height = 2160

    const result = await gen.generate(outside)

    expect(result).toBe(path.join(workDir, 'thumbnails', `${contentHash16(outside)}.jpg`))
    expect(
      ctl.metadataCalls.filter((p) => p === outside),
      '非豁免路径不应探测尺寸'
    ).toHaveLength(0)
  })

  it('边界：低清判定依赖的尺寸探测失败 → 保守走生成，不返回 null', async () => {
    const odd = makeImage(path.join('Videos', 'clip'), 'clip_cover.jpeg')
    // metadata 返回 0 尺寸（损坏/不可解析）：不得短路成自身，也不得吞掉生成
    ctl.width = 0
    ctl.height = 0

    const result = await gen.generate(odd)

    expect(result).toBe(path.join(workDir, 'thumbnails', `${contentHash16(odd)}.jpg`))
  })
})
