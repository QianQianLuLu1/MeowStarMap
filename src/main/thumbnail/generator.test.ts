/**
 * ThumbnailGenerator 视频抽帧加固单测（plan: fix-gallery-video-thumbnail）
 *
 * 覆盖 extractVideoFrame / extractVideoFrameAtSeek 的成功、ffmpeg error、
 * 0 字节输出、超时、0s→1s 重试成功、参数非法等路径。
 *
 * 通过对 fluent-ffmpeg 的 run 处理器在「成功」态下向捕获到的 output 路径
 * 真实写入一个非空 JPG 文件，使 end 之后的 fsp.stat 校验通过；
 * 在「失败首帧」态下，第 1 次（seek 0）触发 error、第 2 次（seek 1）写文件成功，
 * 验证重试逻辑生效。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ---- 共享控制态（vi.hoisted 提升，mock 工厂内可引用） ----
const ctl = vi.hoisted(() => ({
  /** 抽帧结果模式 */
  mode: 'ok' as 'ok' | 'fail' | 'zeroByte' | 'retryThenOk' | 'hang',
  /** 单次 writeFile 的字节数（zeroByte 模式强制 0） */
  outputSize: 64,
  /** 已捕获的 output 路径（run 时写入） */
  outputPath: '' as string,
  /** 记录每次 run 的 seekInput 值，用于断言 0s→1s 重试顺序 */
  seeks: [] as number[],
  /** 已写入的 output 路径集合（供断言） */
  written: [] as string[],
  /** sharp 解码调用记录（入参路径），用于断言豁免路径未触发底层解码 */
  sharpCalls: [] as string[]
}))

// 重置控制态
function resetCtl(mode: typeof ctl.mode = 'ok', size = 64) {
  ctl.mode = mode
  ctl.outputSize = size
  ctl.outputPath = ''
  ctl.seeks = []
  ctl.written = []
  ctl.sharpCalls = []
}

// ---- electron（仅提供 userData 路径） ----
vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) =>
      path.join(os.tmpdir(), 'wxnn-thumb-gen-test', `run-${process.pid}-${Date.now()}`)
  }
}))

// ---- fluent-ffmpeg：受控链式 mock，run 时按 ctl.mode 行为 ----
vi.mock('fluent-ffmpeg', () => {
  const createCommand = (): Record<string, unknown> => {
    const handlers: Record<string, (err?: Error) => void> = {}
    const cmd: Record<string, unknown> = {}
    const chain = (): Record<string, unknown> => cmd
    cmd.setFfmpegPath = chain
    cmd.seekInput = (s: number) => {
      ctl.seeks.push(s)
      return cmd
    }
    cmd.frames = chain
    cmd.output = (p: string) => {
      ctl.outputPath = p
      return cmd
    }
    cmd.outputOptions = chain
    cmd.on = (event: string, cb: (err?: Error) => void) => {
      handlers[event] = cb
      return cmd
    }
    cmd.kill = () => undefined
    cmd.run = () => {
      // hang 模式：不触发任何回调，用于超时保护测试
      if (ctl.mode === 'hang') {
        return
      }
      // 决定本次 run 的行为（写入字节数由 ctl.mode 在 setTimeout 内判定，无需单独标志）
      let willFail = false
      if (ctl.mode === 'fail') {
        willFail = true
      } else if (ctl.mode === 'retryThenOk') {
        // 第一次（seek 0）失败，第二次（seek 1）成功
        willFail = ctl.seeks.length <= 1
      }
      setTimeout(() => {
        if (willFail) {
          handlers.error?.(new Error('ffmpeg 抽帧失败（mock）'))
          return
        }
        try {
          const size = ctl.mode === 'zeroByte' ? 0 : ctl.outputSize
          fs.mkdirSync(path.dirname(ctl.outputPath), { recursive: true })
          fs.writeFileSync(ctl.outputPath, Buffer.alloc(size, 0xff))
          ctl.written.push(ctl.outputPath)
          handlers.end?.()
        } catch (e) {
          handlers.error?.(e instanceof Error ? e : new Error(String(e)))
        }
      }, 0)
    }
    return cmd
  }
  return { default: () => createCommand() }
})

// ---- 其余依赖全部 no-op / 纯函数 ----
vi.mock('../utils/process-registry', () => ({
  trackFfmpegCommand: (command: unknown) => command,
  untrackFfmpegCommand: () => undefined,
  killAllProcesses: () => undefined
}))
vi.mock('../utils/ffmpeg-paths', () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }))
vi.mock('sharp', () => ({
  default: (input?: string) => {
    ctl.sharpCalls.push(input ?? '')
    return {
      resize: () => ({ jpeg: () => ({ toFile: () => Promise.resolve({ size: 10 }) }) }),
      jpeg: () => ({ toFile: () => Promise.resolve({ size: 10 }) })
    }
  }
}))
vi.mock('../utils/concurrency', () => ({
  createConcurrencyLimiter: () => (task: () => Promise<unknown>) => task()
}))
vi.mock('../utils/file-utils', () => ({
  pathExists: (p: string) => Promise.resolve(fs.existsSync(p))
}))
vi.mock('../utils/media-constants', () => ({
  isVideoExt: (ext: string) => ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)
}))
vi.mock('../utils/constants', () => ({
  CACHE_METADATA_FILENAME: 'access-times.json'
}))
vi.mock('../utils/logger', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  }
}))
vi.mock('../i18n', () => ({
  t: (key: string, _params?: Record<string, unknown>) => key
}))

import { ThumbnailGenerator } from './generator'

describe('ThumbnailGenerator 视频抽帧加固', () => {
  let gen: ThumbnailGenerator
  let tmpCacheDir: string
  let sourceVideo: string

  beforeEach(async () => {
    resetCtl('ok')
    gen = new ThumbnailGenerator()
    // 使用真实临时目录作为缓存目录，便于 stat 校验落盘文件
    tmpCacheDir = path.join(
      os.tmpdir(),
      'wxnn-thumb-gen-test',
      `cache-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(tmpCacheDir, { recursive: true })
    gen.setDir(tmpCacheDir)
    // 构造一个存在的「视频」源文件（generate 会先 pathExists + stat）
    sourceVideo = path.join(tmpCacheDir, 'sample.mp4')
    fs.writeFileSync(sourceVideo, Buffer.alloc(1024, 0x00))
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpCacheDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('成功路径：0s 抽帧落盘非空文件，generate 返回缩略图路径', async () => {
    resetCtl('ok', 64)
    const result = await gen.generate(sourceVideo)
    expect(result).not.toBeNull()
    expect(typeof result).toBe('string')
    expect(fs.existsSync(result as string)).toBe(true)
    expect(fs.statSync(result as string).size).toBeGreaterThan(0)
  })

  it('ffmpeg error 路径：两次抽帧均失败，generate 返回 null 并标记损坏', async () => {
    resetCtl('fail')
    const markSpy = vi.fn()
    gen.setCorruptedMarker(markSpy, null)
    const result = await gen.generate(sourceVideo)
    expect(result).toBeNull()
    expect(markSpy).toHaveBeenCalledTimes(1)
    // 失败兜底：不会留下伪缩略图文件（即使 hash 命中也只在成功分支写）
  })

  it('0 字节输出路径：end 后 stat 校验失败，generate 返回 null', async () => {
    resetCtl('zeroByte', 0)
    const markSpy = vi.fn()
    gen.setCorruptedMarker(markSpy, null)
    const result = await gen.generate(sourceVideo)
    expect(result).toBeNull()
    expect(markSpy).toHaveBeenCalledTimes(1)
  })

  it('重试成功路径：0s 失败但 1s 成功，最终返回有效缩略图', async () => {
    resetCtl('retryThenOk', 64)
    const result = await gen.generate(sourceVideo)
    expect(result).not.toBeNull()
    expect(fs.existsSync(result as string)).toBe(true)
    // 断言按顺序尝试了 0s 然后 1s
    expect(ctl.seeks).toEqual([0, 1])
    expect(ctl.written.length).toBe(1)
  })

  it('参数校验：seek 越界被拒，合法边界 0 不被校验拦截', async () => {
    const call = (videoPath: string, outPath: string, seek: number) =>
      (
        gen as unknown as {
          extractVideoFrameAtSeek: (a: string, b: string, s: number) => Promise<void>
        }
      ).extractVideoFrameAtSeek(videoPath, outPath, seek)
    // 负数 seek 应被参数校验直接拒绝
    await expect(call(sourceVideo, path.join(tmpCacheDir, 'x.jpg'), -5)).rejects.toThrow(
      /seekSeconds/
    )
    // 超过上限（>60s）也应被拒绝
    await expect(call(sourceVideo, path.join(tmpCacheDir, 'x2.jpg'), 999)).rejects.toThrow(
      /seekSeconds/
    )
    // 空 videoPath 应被参数校验拒绝
    await expect(call('', path.join(tmpCacheDir, 'x3.jpg'), 0)).rejects.toThrow(/videoPath/)
    // 合法边界 0 不被校验拦截（mock 会写文件 → 成功 resolve，非校验错误）
    resetCtl('ok', 32)
    await expect(call(sourceVideo, path.join(tmpCacheDir, 'y.jpg'), 0)).resolves.toBeUndefined()
  })

  it('超时保护：ffmpeg 永不回调时，30s 后 reject（ffmpegFrameTimeout）', async () => {
    vi.useFakeTimers()
    resetCtl('hang')
    // 先创建断言并立即挂上 rejection 处理器，避免定时器触发时尚未挂处理器的告警
    const assertion = expect(
      (
        gen as unknown as {
          extractVideoFrameAtSeek: (a: string, b: string, s: number) => Promise<void>
        }
      ).extractVideoFrameAtSeek(sourceVideo, path.join(tmpCacheDir, 'z.jpg'), 2)
    ).rejects.toThrow(/ffmpegFrameTimeout/)
    // 推进 30s，触发超时 reject
    await vi.advanceTimersByTimeAsync(30000)
    await assertion
    vi.useRealTimers()
  })
})

describe('ThumbnailGenerator GamePlayPhotos 原生缩略图豁免', () => {
  let gen: ThumbnailGenerator
  let tmpCacheDir: string

  beforeEach(() => {
    resetCtl('ok')
    gen = new ThumbnailGenerator()
    tmpCacheDir = path.join(
      os.tmpdir(),
      'wxnn-thumb-gen-test',
      `cache-gp-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(tmpCacheDir, { recursive: true })
    gen.setDir(tmpCacheDir)
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpCacheDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('GamePlayPhotos HQ 路径 → 早退返回原生 LQ 路径，零解码/零写盘', async () => {
    // 源文件故意不存在：若误入原生成逻辑，pathExists 检查会返回 null，
    // 因此非 null 且等于原生 LQ 路径即可证明早退生效
    const hqPath =
      'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality\\p.jpg'
    const result = await gen.generate(hqPath)
    expect(result).toBe(
      'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\NikkiPhotos_LowQuality\\p.jpg'
    )
    // 底层解码/写盘函数未被调用：sharp 零调用、ffmpeg 零抽帧、缓存目录无缩略图产物
    expect(ctl.sharpCalls).toHaveLength(0)
    expect(ctl.seeks).toHaveLength(0)
    expect(ctl.written).toHaveLength(0)
    expect(fs.readdirSync(tmpCacheDir).filter((n) => n.endsWith('.jpg'))).toHaveLength(0)
  })

  it('GamePlayPhotos 非 HQ 路径（视频子目录）→ 早退返回原路径兜底', async () => {
    const videoPath = 'D:\\Game\\X6Game\\Saved\\GamePlayPhotos\\123456789\\xxx\\v.mp4'
    const result = await gen.generate(videoPath)
    expect(result).toBe(videoPath)
    expect(ctl.sharpCalls).toHaveLength(0)
    expect(ctl.seeks).toHaveLength(0)
  })

  it('正斜杠形态的 HQ 路径同样命中豁免（大小写不敏感）', async () => {
    const hqPath = 'd:/game/x6game/saved/gameplayphotos/123456789/nikkiPhotos_HighQuality/p.jpg'
    const result = await gen.generate(hqPath)
    expect(result).toBe(
      'd:/game/x6game/saved/gameplayphotos/123456789/NikkiPhotos_LowQuality/p.jpg'
    )
    expect(ctl.sharpCalls).toHaveLength(0)
  })

  it('回归：普通路径仍走原生成逻辑（图片经 sharp 解码产出缓存路径）', async () => {
    const src = path.join(tmpCacheDir, 'normal.jpg')
    fs.writeFileSync(src, Buffer.alloc(512, 0x00))
    const result = await gen.generate(src)
    // 进入原分支：返回缓存目录内的缩略图路径，且底层 sharp 解码被调用
    expect(result).not.toBeNull()
    expect(String(result)).toContain(tmpCacheDir)
    expect(ctl.sharpCalls).toContain(src)
  })
})
