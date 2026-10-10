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
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

// ---- 共享控制态（vi.hoisted 提升，mock 工厂内可引用） ----
const ctl = vi.hoisted(() => ({
  /** 抽帧结果模式 */
  mode: 'ok' as
    'ok' | 'fail' | 'zeroByte' | 'retryThenOk' | 'hang' | 'partialThenFail' | 'blankBlankThenFail',
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
  statsStdevQueue: [] as number[],
  /** sharp toFile 写盘失败注入（N2 原子落盘用例）：先写部分字节再抛错，模拟撕裂写 */
  sharpFail: false,
  /** sharpFail 时预写的部分字节数 */
  sharpPartialBytes: 8,
  /** sharp toFile 实际收到的目标路径（断言「临时文件 → rename」原子替换） */
  toFileTargets: [] as string[]
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
  ctl.sharpFail = false
  ctl.sharpPartialBytes = 8
  ctl.toFileTargets = []
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
      if (ctl.mode === 'fail' || ctl.mode === 'partialThenFail') {
        willFail = true
      } else if (ctl.mode === 'retryThenOk') {
        // 第一次（seek 0）失败，第二次（seek 1）成功
        willFail = ctl.seeks.length <= 1
      } else if (ctl.mode === 'blankBlankThenFail') {
        // N4：0s/1s 成功（写入文件，由 statsStdevQueue 判定纯色），3s（超出短视频时长）失败
        willFail = ctl.seeks.length > 2
      }
      setTimeout(() => {
        if (willFail) {
          // N2：partialThenFail 模拟「半截文件已落盘再报错」的撕裂写场景
          if (ctl.mode === 'partialThenFail') {
            try {
              fs.mkdirSync(path.dirname(ctl.outputPath), { recursive: true })
              fs.writeFileSync(ctl.outputPath, Buffer.alloc(32, 0x33))
              ctl.written.push(ctl.outputPath)
            } catch {
              /* 忽略 */
            }
          }
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
const maybeLogSpawnErrorMock = vi.fn()
vi.mock('../utils/spawn-error-log', () => ({
  maybeLogSpawnError: (...args: unknown[]) => maybeLogSpawnErrorMock(...args)
}))
vi.mock('../utils/ffmpeg-paths', () => ({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' }))
vi.mock('sharp', () => ({
  default: (input?: string) => {
    ctl.sharpCalls.push(input ?? '')
    // toFile 真实写盘：自愈用例需要据此断言 _low 副本被刷新（而非仅被删除）
    const toFile = (p: string) => {
      ctl.toFileTargets.push(p)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      // N2：注入撕裂写——先落半截字节再中断
      if (ctl.sharpFail) {
        fs.writeFileSync(p, Buffer.alloc(ctl.sharpPartialBytes, 0x33))
        return Promise.reject(new Error('sharp 写盘中断（mock）'))
      }
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

  it('ffmpeg error 路径：每次 error 都将原始错误交给 maybeLogSpawnError 落盘诊断', async () => {
    maybeLogSpawnErrorMock.mockClear()
    resetCtl('fail')
    await gen.generate(sourceVideo)
    // 阶梯 3 个位点全部失败 → 3 次 error，均带来源标签
    expect(maybeLogSpawnErrorMock).toHaveBeenCalledTimes(3)
    expect(maybeLogSpawnErrorMock.mock.calls.every((c) => c[0] === 'thumbnail-generator')).toBe(
      true
    )
    expect(maybeLogSpawnErrorMock.mock.calls[0][1]).toBeInstanceOf(Error)
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

  it('GamePlayPhotos HQ 路径但原生 LQ 缺失 → 转入自适应分支，源文件也不存在时仍返回 null', async () => {
    // 改前语义「推导不出原生 LQ 即 return null、绝不生成」已放宽（round2 N4）：本机真实库里
    // GamePlayPhotos 下「非 HQ 目录」的行（NikkiPhotos_LowQuality / CloudPhotos / 视频封面等）
    // 共 79 行因此恒无出图入口。现改为「读不到原生 LQ → 探测自身尺寸 → 低清引用自身 / 否则生成」。
    // 本例连源文件都不存在：允许发生一次 header 探测，但生成阶段被 pathExists 拦下 → 仍 null、仍零落盘。
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
    // 不抽帧、不落任何缓存文件（header 探测不算解码，toFileTargets 才是生成证据）
    expect(ctl.seeks).toHaveLength(0)
    expect(ctl.written).toHaveLength(0)
    expect(ctl.toFileTargets).toHaveLength(0)
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

/**
 * 原子落盘回归（fix-thumbnail-display-and-latency N2）。
 *
 * 缺陷：缩略图直接写最终路径、无 temp+rename——渲染进程经 media:// 流式读取可能读到
 * 半截 JPEG（裂图）；主进程按需生成、media-worker 批量、白帧自愈三方对同一
 * ${hash}.jpg 无跨进程互斥，并发写同名文件放大撕裂概率。
 * 修复：先写同目录 `.tmp-` 临时文件，成功后 rename 原子替换；任何失败清理临时文件，
 * 最终路径要么是旧完整文件、要么是新完整文件。
 */
describe('ThumbnailGenerator 原子落盘（N2）', () => {
  let gen: ThumbnailGenerator
  let tmpCacheDir: string

  const hashOf = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

  beforeEach(() => {
    gen = new ThumbnailGenerator()
    tmpCacheDir = path.join(
      os.tmpdir(),
      'wxnn-thumb-gen-test',
      `cache-atomic-${process.pid}-${Math.random().toString(36).slice(2)}`
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

  const noTmpResidue = () => fs.readdirSync(tmpCacheDir).filter((n) => n.includes('.tmp-'))

  it('异常：图片 sharp 写盘中断 → 最终缩略图路径不得残留半截文件', async () => {
    const buf = Buffer.alloc(512, 0x00)
    const src = path.join(tmpCacheDir, 'broken.png')
    fs.writeFileSync(src, buf)
    resetCtl('ok')
    ctl.sharpFail = true
    const result = await gen.generate(src)
    expect(result).toBeNull()
    expect(fs.existsSync(path.join(tmpCacheDir, `${hashOf(buf)}.jpg`))).toBe(false)
    expect(noTmpResidue()).toHaveLength(0)
  })

  it('正常：图片成功路径 sharp 写入 .tmp- 临时文件后原子替换，最终路径完整', async () => {
    const buf = Buffer.alloc(512, 0x00)
    const src = path.join(tmpCacheDir, 'ok.png')
    fs.writeFileSync(src, buf)
    resetCtl('ok')
    const result = await gen.generate(src)
    const finalPath = path.join(tmpCacheDir, `${hashOf(buf)}.jpg`)
    expect(result).toBe(finalPath)
    expect(fs.existsSync(finalPath)).toBe(true)
    // toFile 的写入目标必须是临时路径，而非最终路径
    expect(ctl.toFileTargets[0]).toContain('.tmp-')
    expect(ctl.toFileTargets[0]).not.toBe(finalPath)
    expect(noTmpResidue()).toHaveLength(0)
  })

  it('异常：ffmpeg 抽帧部分字节写入后 error → 最终路径不得残留半截文件', async () => {
    resetCtl('partialThenFail')
    const buf = Buffer.alloc(1024, 0x00)
    const src = path.join(tmpCacheDir, 'torn.mp4')
    fs.writeFileSync(src, buf)
    const result = await gen.generate(src)
    expect(result).toBeNull()
    expect(fs.existsSync(path.join(tmpCacheDir, `${hashOf(buf)}.jpg`))).toBe(false)
    expect(noTmpResidue()).toHaveLength(0)
  })

  it('契约：ffmpeg error 的临时文件清理必须在 generate 落定前完成（不得 fire-and-forget）', async () => {
    // 上一条用例只断言「最终不残留」，删掉 unlink 的 await 仍能靠调度侥幸通过（本机实测
    // 间歇性失败）：generator 的 'error' / 超时分支历史上写成 `void removeTempFileQuietly(...)`，
    // reject 与 unlink 并发，generate 返回时临时文件可能仍在缓存目录里，
    // 由 enforceCacheLimit / getCacheStats / 启动孤儿清理按「缓存目录内的多余文件」承担后果。
    // 这里把 unlink 的真实删除照常执行、只在其后追加一个宏任务延迟，使「清理未被 await」必然可见。
    resetCtl('partialThenFail')
    const src = path.join(tmpCacheDir, 'torn2.mp4')
    fs.writeFileSync(src, Buffer.alloc(1024, 0x00))

    const realUnlink = fsp.unlink
    const spy = vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
      // 推迟「真实删除」本身：清理若未被 await，generate 返回时半截临时文件必然还在
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      await realUnlink(target)
    })

    try {
      const result = await gen.generate(src)
      expect(result).toBeNull()
      expect(noTmpResidue()).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('正常：视频成功路径 ffmpeg 输出 .tmp- 临时文件后原子替换', async () => {
    resetCtl('ok', 64)
    const result = await gen.generate(sourceVideoPath(tmpCacheDir))
    expect(result).not.toBeNull()
    expect(fs.existsSync(result as string)).toBe(true)
    expect(ctl.written[0]).toContain('.tmp-')
    expect(ctl.written[0]).not.toBe(result)
    expect(noTmpResidue()).toHaveLength(0)
  })

  it('N4 短视频兜底：0s/1s 均纯色且 3s 超出时长失败 → 保留已有帧，不标损坏', async () => {
    // 缺陷：时长 <3s 且片头淡入的视频，阶梯 0s/1s 抽到纯色帧继续前进，
    // 末位点 3s seek 超出时长 → ffmpeg 空输出抛错 → 整个 generate 判失败并
    // markCorrupted → 文件从图库消失，且 thumbnail 恒 NULL 每轮批量反复重试。
    // 修复：末位点失败但此前已有成功帧时保留该帧返回（降级优于失败）。
    resetCtl('blankBlankThenFail', 64)
    ctl.statsStdevQueue = [0, 0] // 0s、1s 均判定为纯色 → 推进到 3s
    const markSpy = vi.fn()
    gen.setCorruptedMarker(markSpy, null)
    const result = await gen.generate(sourceVideoPath(tmpCacheDir))
    expect(ctl.seeks).toEqual([0, 1, 3])
    expect(result).not.toBeNull()
    expect(fs.existsSync(result as string)).toBe(true)
    expect(markSpy).not.toHaveBeenCalled()
  })
})

/** 在指定缓存目录内构造一个存在的「视频」源文件（与主 describe 的 beforeEach 同构） */
function sourceVideoPath(dir: string): string {
  const p = path.join(dir, 'sample.mp4')
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, Buffer.alloc(1024, 0x00))
  }
  return p
}

// ============================================================================
// N8 微项（fix-thumbnail-display-and-latency）
// ============================================================================
describe('N8：主进程与 worker 降级 hash 公式一致', () => {
  // 缺陷：内容 hash 读取失败时，主进程降级公式缺 size（${filePath}:${mtime}）、
  // worker 含 size（${filePath}:${mtime}:${size}）——同一文件在两侧得到不同
  // 缩略图文件名，缓存互不命中、重复生成。统一为含 size 的形态。
  it('两侧降级 hash 公式均为 `${filePath}:${mtime}:${size}`', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf-8')
    const generatorSrc = read('src/main/thumbnail/generator.ts')
    const workerSrc = read('src/main/media-worker/worker-entry.ts')
    expect(generatorSrc).toContain('`${filePath}:${mtime}:${size}`')
    expect(workerSrc).toContain('`${filePath}:${mtime}:${size}`')
    // 旧的主进程缺 size 形态不得残留
    expect(generatorSrc).not.toContain('.update(`${filePath}:${mtime}`)')
  })
})
