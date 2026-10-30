/**
 * N1（plan: 2026-09-30-fix-thumbnail-skeleton-reveal）视频抽帧独立限流测试
 *
 * 根因：主进程视频 ffmpeg 抽帧与图片 sharp 解码共用 decodeLimiter（generator.ts:509/485），
 * 慢视频走 0/1/3s seek 阶梯（每次 30s 超时）最长占用解码通道 90s，把可视区
 * 按需生成的图片全部堵在队列后（用户可见"数十秒白屏"）。
 *
 * 与 generator.test.ts 的差异：该文件把 createConcurrencyLimiter mock 成直通，
 * 本文件使用**真实限流器**并把 os.cpus 钳到 1 核（DECODE_CONCURRENCY = 2），
 * 用受控门控挡住**两个**视频的抽帧——两个视频占满全部 2 个图片解码槽位，
 * 此后发起的图片生成必须等待视频完成（现状）或完全不排队（修复后）。
 * - 共享 limiter（现状）：视频占满 2 槽 → 图片被堵 → 断言超时失败（红）
 * - 独立 videoLimiter（修复后，并发 2）：视频不占图片解码槽 → 两张图片立即完成（绿）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ---- 共享控制态（vi.hoisted 提升，mock 工厂内可引用） ----
const ctl = vi.hoisted(() => ({
  /** 已进入 ffmpeg run 的视频数（证明视频已持有解码许可） */
  videoRunCount: 0,
  /** 共享门控 promise：resolve 后所有等待中的 ffmpeg run 才写盘并触发 end */
  gate: Promise.resolve(),
  /** 解除门控 */
  releaseVideo: () => undefined
}))

function resetVideoGate() {
  ctl.videoRunCount = 0
  ctl.gate = new Promise<void>((resolve) => {
    ctl.releaseVideo = resolve
  })
}

/**
 * mock 写盘白名单根：beforeEach 设为本次用例的 tmpCacheDir（已 resolve），
 * mock（ffmpeg/sharp）只允许把产物写进该目录内，防止动态路径越界。
 */
let writeRoot = ''
function isInsideWriteRoot(p: string): boolean {
  if (!writeRoot) return false
  const resolved = path.resolve(p)
  return resolved === writeRoot || resolved.startsWith(writeRoot + path.sep)
}

// ---- os：钳到 1 核，使 DECODE_CONCURRENCY = 1 × 2 = 2 ----
// 本文件自带的 vi.mock('os') 会遮蔽装置轴 3b（importOriginal 给回的是未 mock 的原形），
// 所以必须把装置形态组合进来：否则 os.tmpdir() 在这里仍是真宿主值，而 TEMP/TMP 已被装置删除
// ⇒ 回落到 Windows 兜底字面量，electron mock 拼出的 userData 会以反斜杠形态混进 posix 绑定。
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { ciLinuxOsOverrides } = await import('../../../tests/mocks/ci-linux-os')
  const oneCore = () => [0]
  const merged = { ...actual, ...ciLinuxOsOverrides(), cpus: oneCore }
  return { ...merged, default: merged }
})

// ---- electron（仅提供 userData 路径） ----
vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) =>
      path.join(os.tmpdir(), 'wxnn-thumb-gen-limiter-test', `run-${process.pid}-${Date.now()}`)
  }
}))

// ---- fluent-ffmpeg：门控 mock——run 启动后等待共享门控才成功写盘 ----
vi.mock('fluent-ffmpeg', () => {
  const createCommand = (): Record<string, unknown> => {
    const handlers: Record<string, (err?: Error) => void> = {}
    const cmd: Record<string, unknown> = {}
    let outputPath = ''
    const chain = (): Record<string, unknown> => cmd
    cmd.setFfmpegPath = chain
    cmd.seekInput = () => cmd
    cmd.frames = chain
    cmd.output = (p: string) => {
      outputPath = p
      return cmd
    }
    cmd.outputOptions = chain
    cmd.on = (event: string, cb: (err?: Error) => void) => {
      handlers[event] = cb
      return cmd
    }
    cmd.kill = () => undefined
    cmd.run = () => {
      ctl.videoRunCount++
      void ctl.gate.then(() => {
        // 白名单守卫：产物只允许写入用例缓存目录内，越界按抽帧失败处理
        if (!outputPath || !isInsideWriteRoot(outputPath)) {
          handlers.error?.(new Error('ffmpeg mock 产物路径越出白名单根（测试守卫）'))
          return
        }
        try {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true })
          fs.writeFileSync(outputPath, Buffer.alloc(64, 0xff))
          handlers.end?.()
        } catch (e) {
          handlers.error?.(e instanceof Error ? e : new Error(String(e)))
        }
      })
    }
    return cmd
  }
  return { default: () => createCommand() }
})

// ---- sharp：真实写盘 + stdev 50（非纯色，抽帧 ladder 一次成功） ----
vi.mock('sharp', () => ({
  default: (_input?: string) => {
    const toFile = (p: string) => {
      if (!isInsideWriteRoot(p)) {
        return Promise.reject(new Error('sharp mock 产物路径越出白名单根（测试守卫）'))
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.alloc(16, 0xff))
      return Promise.resolve({ size: 16 })
    }
    const stats = () => Promise.resolve({ channels: [{ stdev: 50 }] })
    return {
      resize: () => ({ jpeg: () => ({ toFile }), stats }),
      jpeg: () => ({ toFile }),
      stats
    }
  }
}))

// ---- 其余依赖 no-op / 纯函数（与 generator.test.ts 对齐） ----
vi.mock('../utils/process-registry', () => ({
  trackFfmpegCommand: (command: unknown) => command,
  untrackFfmpegCommand: () => undefined,
  killAllProcesses: () => undefined
}))
vi.mock('../utils/spawn-error-log', () => ({ maybeLogSpawnError: () => undefined }))
vi.mock('../utils/ffmpeg-paths', () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }))
vi.mock('../utils/file-utils', () => ({
  pathExists: (p: string) => Promise.resolve(fs.existsSync(p))
}))
vi.mock('../utils/media-constants', () => ({
  isVideoExt: (ext: string) => ['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext)
}))
vi.mock('../utils/constants', () => ({ CACHE_METADATA_FILENAME: 'access-times.json' }))
vi.mock('../utils/logger', () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined
  }
}))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

// 注意：不 mock ../utils/concurrency —— 本文件必须使用真实并发限制器
import { ThumbnailGenerator } from './generator'

describe('N1 视频抽帧独立限流（plan: fix-thumbnail-skeleton-reveal）', () => {
  let gen: ThumbnailGenerator
  let tmpCacheDir: string
  let sourceVideos: string[]
  let sourceImg1: string
  let sourceImg2: string

  beforeEach(() => {
    resetVideoGate()
    gen = new ThumbnailGenerator()
    tmpCacheDir = path.resolve(
      os.tmpdir(),
      'wxnn-thumb-gen-limiter-test',
      `cache-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(tmpCacheDir, { recursive: true })
    writeRoot = tmpCacheDir
    gen.setDir(tmpCacheDir)
    sourceVideos = ['sample-1.mp4', 'sample-2.mp4'].map((name) => {
      const p = path.join(tmpCacheDir, name)
      fs.writeFileSync(p, Buffer.alloc(1024, 0x00))
      return p
    })
    sourceImg1 = path.join(tmpCacheDir, 'img-1.jpg')
    fs.writeFileSync(sourceImg1, Buffer.alloc(1024, 0x11))
    sourceImg2 = path.join(tmpCacheDir, 'img-2.jpg')
    fs.writeFileSync(sourceImg2, Buffer.alloc(1024, 0x22))
  })

  afterEach(() => {
    // 释放可能仍被门控挡住的 ffmpeg run，避免悬挂任务跨用例
    ctl.releaseVideo()
    writeRoot = ''
    try {
      fs.rmSync(tmpCacheDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('慢视频抽帧不占用图片解码许可：视频占满解码通道时图片仍能立即生成', async () => {
    // 1. 发起两个视频生成，并等待两者都真正进入 ffmpeg run（各自持有解码许可、被门控挡住）。
    //    断言值 2 同时固定了 videoLimiter 的并发度（VIDEO_DECODE_CONCURRENCY=2 实现细节）：
    //    若未来将视频并发改为 1 或按核数自适应，需同步调整本用例的门控策略
    const videoPromises = sourceVideos.map((v) => gen.generate(v))
    await vi.waitFor(() => expect(ctl.videoRunCount).toBe(2))

    // 2. 两个视频占满解码通道期间，并发发起两张图片的按需生成
    const img1Promise = gen.generate(sourceImg1)
    const img2Promise = gen.generate(sourceImg2)

    // 3. 核心断言：两张图片都必须在视频完成前返回。
    //    共享 limiter（现状）时 2 个视频占满全部槽位、图片在队列中被堵 → 超时抛错（红）
    let timeoutId: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all([img1Promise, img2Promise]),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('图片生成被慢视频堵在共享解码队列（decodeLimiter）')),
          800
        )
      })
    ]).finally(() => clearTimeout(timeoutId))

    // 4. 释放视频门控，确认四个任务最终都成功返回有效路径
    ctl.releaseVideo()
    const [video1Path, video2Path] = await Promise.all(videoPromises)
    const img1Path = await img1Promise
    const img2Path = await img2Promise
    expect(video1Path).toBeTruthy()
    expect(video2Path).toBeTruthy()
    expect(img1Path).toBeTruthy()
    expect(img2Path).toBeTruthy()
  })
})
