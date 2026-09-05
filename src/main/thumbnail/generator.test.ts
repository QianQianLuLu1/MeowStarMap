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
import crypto from 'crypto'

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
  sharpCalls: [] as string[],
  /**
   * sharp.stats() 返回的通道 stdev。默认 50（有内容、非纯色），
   * 保证既有用例的抽帧行为与纯色判定引入前完全一致。
   */
  statsStdev: 50,
  /** stdev 序列：非空时按序消费，用于构造「首个位点纯色、后续位点有内容」场景 */
  statsStdevQueue: [] as number[]
}))

// 重置控制态
function resetCtl(mode: typeof ctl.mode = 'ok', size = 64) {
  ctl.mode = mode
  ctl.outputSize = size
  ctl.outputPath = ''
  ctl.seeks = []
  ctl.written = []
  ctl.sharpCalls = []
  ctl.statsStdev = 50
  ctl.statsStdevQueue = []
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
    // toFile 真实写盘：自愈用例需要据此断言 _low 副本被刷新（而非仅被删除）
    const toFile = (p: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, Buffer.alloc(16, 0xff))
      return Promise.resolve({ size: 16 })
    }
    const nextStdev = (): number =>
      ctl.statsStdevQueue.length ? (ctl.statsStdevQueue.shift() as number) : ctl.statsStdev
    const stats = () => Promise.resolve({ channels: [{ stdev: nextStdev() }] })
    return {
      // resize 之后既可继续 toFile（缩放链路），也可取 stats（纯色判定链路）
      resize: () => ({ jpeg: () => ({ toFile }), stats }),
      jpeg: () => ({ toFile }),
      stats
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

  it('纯白首帧 → 继续 1s 抽帧（纯色帧不再被当作抽帧成功）', async () => {
    // 0s 抽帧成功但判定为纯色 → 应继续 1s；1s 判定为有内容 → 停止
    resetCtl('ok', 64)
    ctl.statsStdevQueue = [0, 50]
    const result = await gen.generate(sourceVideo)
    expect(result).not.toBeNull()
    expect(ctl.seeks).toEqual([0, 1])
  })

  it('三个位点全为纯白 → 保留最后一帧，不报错、不标损坏', async () => {
    resetCtl('ok', 64)
    ctl.statsStdevQueue = [0, 0, 0]
    const markSpy = vi.fn()
    gen.setCorruptedMarker(markSpy, null)
    const result = await gen.generate(sourceVideo)
    // 阶梯跑满 0s → 1s → 3s，末帧保留（降级优于失败）
    expect(ctl.seeks).toEqual([0, 1, 3])
    expect(result).not.toBeNull()
    expect(markSpy).not.toHaveBeenCalled()
  })

  it('缓存命中但为纯白帧 → 自愈重建标准帧并刷新 _low 副本', async () => {
    // 复刻 generator.getFileHash 的算法：源文件为 1024 字节全 0
    const fileHash = crypto
      .createHash('sha256')
      .update(Buffer.alloc(1024, 0x00))
      .digest('hex')
      .slice(0, 16)
    const cached = path.join(tmpCacheDir, `${fileHash}.jpg`)
    const cachedLow = path.join(tmpCacheDir, `${fileHash}_low.jpg`)
    fs.writeFileSync(cached, Buffer.alloc(64, 0xff)) // 体积 < 4096：可通过体积闸门
    fs.writeFileSync(cachedLow, Buffer.alloc(64, 0x00)) // 旧低清副本，自愈后应被刷新

    resetCtl('ok', 64)
    ctl.statsStdev = 0 // 判定为纯色
    const result = await gen.generate(sourceVideo)
    // 命中缓存未直接返回：触发了一次重建抽帧
    expect(ctl.seeks.length).toBeGreaterThan(0)
    expect(result).toBe(cached)
    // 低清副本被刷新（不再是旧的 64 字节全 0）
    expect(fs.readFileSync(cachedLow).equals(Buffer.alloc(64, 0x00))).toBe(false)
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

  it('GamePlayPhotos HQ 路径且原生 LQ 存在 → 早退返回 LQ 路径，零解码/零写盘', async () => {
    // 在临时目录构造真实的 GamePlayPhotos 目录结构：仅创建 LQ 文件（早退只校验 LQ 存在）
    const gpRoot = path.join(tmpCacheDir, 'X6Game', 'Saved', 'GamePlayPhotos', '123456789')
    const hqPath = path.join(gpRoot, 'NikkiPhotos_HighQuality', 'p.jpg')
    const lqPath = path.join(gpRoot, 'NikkiPhotos_LowQuality', 'p.jpg')
    fs.mkdirSync(path.dirname(lqPath), { recursive: true })
    fs.writeFileSync(lqPath, Buffer.alloc(32, 0xff))

    const result = await gen.generate(hqPath)
    expect(result).toBe(lqPath)
    // 底层解码/写盘函数未被调用：sharp 零调用、ffmpeg 零抽帧、缓存目录无缩略图产物（_low/_high/.jpg）
    expect(ctl.sharpCalls).toHaveLength(0)
    expect(ctl.seeks).toHaveLength(0)
    expect(ctl.written).toHaveLength(0)
    expect(fs.readdirSync(tmpCacheDir).filter((n) => n.endsWith('.jpg'))).toHaveLength(0)
  })

  it('GamePlayPhotos HQ 路径但原生 LQ 缺失 → 早退返回 null（不生成、不回退原路径）', async () => {
    // LQ 文件故意不创建：评审修正后的早退语义——原生缩略图失效时返回 null
    // （维持“失败返回 null”旧语义），绝不回退原路径、绝不触发常规生成流程
    const hqPath = path.join(
      tmpCacheDir,
      'X6Game',
      'Saved',
      'GamePlayPhotos',
      '123456789',
      'NikkiPhotos_HighQuality',
      'missing-lq.jpg'
    )
    const result = await gen.generate(hqPath)
    expect(result).toBeNull()
    // 同样零解码/零写盘：不回退到常规生成流程（该路径禁用生成是硬性需求）
    expect(ctl.sharpCalls).toHaveLength(0)
    expect(ctl.seeks).toHaveLength(0)
    expect(ctl.written).toHaveLength(0)
  })

  it('GamePlayPhotos 视频子目录 → 不适用图片豁免，走正常 seek 阶梯抽帧生成（fix-gameplayphotos-video-thumbnail-null 节点2）', async () => {
    // 回归背景：Videos/ 子树的视频没有原生低清缩略图，历史上被图片豁免一并拦死（generate 恒返回
    // null），导致批量补算/重复页按需生成全部拿不到缩略图，「缓存/重复文件」板块视频纯白占位。
    // 真实游戏文件扩展名为大写 .Mp4：豁免判定必须先小写化再判 isVideoExt。
    // 注：无 Saved 变体（\X6Game\GamePlayPhotos\）不被 isGamePlayPhotosPath 命中、本就放行，
    // 其排除属批量 SQL 范畴（见 worker-entry.test.ts 节点3 用例）。
    resetCtl('ok', 64)
    const gpVideoDir = path.join(
      tmpCacheDir,
      'X6Game',
      'Saved',
      'GamePlayPhotos',
      '123456789',
      'Videos',
      '1001'
    )
    fs.mkdirSync(gpVideoDir, { recursive: true })
    const videoPath = path.join(gpVideoDir, '1001.Mp4')
    fs.writeFileSync(videoPath, Buffer.alloc(1024, 0x00))

    const result = await gen.generate(videoPath)
    // 必须产出缓存目录内的缩略图文件（0s 首帧非纯色，一次抽帧成功）
    expect(result).not.toBeNull()
    expect(String(result)).toContain(tmpCacheDir)
    expect(fs.existsSync(result as string)).toBe(true)
    expect(ctl.seeks).toEqual([0])
    // 视频原文件不经 sharp 解码（ffmpeg 抽帧链路）；sharp 仅用于从标准帧缩放 _low 副本
    expect(ctl.sharpCalls).not.toContain(videoPath)
  })

  it('正斜杠形态的 HQ 路径（LQ 存在）同样命中豁免（大小写不敏感）', async () => {
    const gpRoot = path.join(tmpCacheDir, 'game', 'x6game', 'saved', 'gameplayphotos', '987654321')
    const hqPath = `${gpRoot}/nikkiPhotos_HighQuality/p.jpg`.replace(/\\/g, '/')
    const lqPath = path.join(gpRoot, 'NikkiPhotos_LowQuality', 'p.jpg')
    fs.mkdirSync(path.dirname(lqPath), { recursive: true })
    fs.writeFileSync(lqPath, Buffer.alloc(16, 0xff))
    const result = await gen.generate(hqPath)
    // 早退保留原路径的分隔符形态（正斜杠进正斜杠出）
    expect(result).toBe(lqPath.replace(/\\/g, '/'))
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
