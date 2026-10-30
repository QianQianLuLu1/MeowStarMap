/**
 * 视频缩略图 spawn EFTYPE 降级集成测试（节点7，plan: fix-spawn-eftype-crash）
 *
 * 与 generator.test.ts 的区别：该文件模块级 vi.mock('fluent-ffmpeg') 用手写链式桩，
 * 无法 exercising 真实 _spawnFfmpeg → spawn 同步抛错路径；本测试使用**真实 fluent-ffmpeg +
 * 真实 installFfmpegSpawnGuard()**，仅 monkey-patch node 内置 child_process.spawn 令其同步抛 EFTYPE，
 * 复现「Windows 损坏 ffmpeg 二进制」现场。
 *
 * 验证目标：垫片生效后，视频缩略图生成链路（generate → extractVideoFrame seek 阶梯 →
 * .run() → availableFormats 能力探测 → _spawnFfmpeg → spawn 抛 EFTYPE）优雅降级为
 * 返回 null（generator.ts 解码失败分支 markCorrupted + return null），
 * 错误经 .on('error') 正常回流，process 无 uncaughtException 泄漏。
 *
 * 红灯特征（未装垫片时）：EFTYPE 在 async@0.2.10 的 setImmediate 宏任务内同步抛出，
 * .on('error') 永不到达 → generate 的 Promise 悬挂直至测试超时 + uncaughtException 泄漏。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

/**
 * 打桩对象必须是**真内置单例**，不能是 `import childProcess from 'child_process'`：
 * 装置（`npm run test:ci-linux`）的轴 8 交给测试图的是真命名空间的**副本**，而 fluent-ffmpeg
 * 作为外部化 CJS，顶层 `var spawn = require('child_process').spawn` 捕获的是真单例那一份
 * ⇒ 桩打在副本上等于没打（实测真 spawn 被调用，`/fake/ffmpeg.exe` 给异步 ENOENT 而不是这里
 * 要的同步 EFTYPE）。`vi.mock` 拦不到 createRequire；真宿主与 CI 上两者本是同一个对象。
 */
const childProcess = createRequire(import.meta.url)(
  'child_process'
) as typeof import('child_process')

// ---- 共享控制态 ----
const ctl = vi.hoisted(() => ({
  /** sharp 解码调用记录（断言视频链路不经 sharp 解码原片） */
  sharpCalls: [] as string[]
}))

/** 构造现场同款 EFTYPE 错误（Windows 损坏二进制的同步 spawn 失败） */
function makeEftypeError(): Error {
  return Object.assign(new Error('spawn EFTYPE'), {
    code: 'EFTYPE',
    errno: -4028,
    syscall: 'spawn'
  })
}

// ---- monkey-patch node 内置 child_process.spawn ----
// fluent-ffmpeg 是外部化 CJS，processor.js 顶层 `var spawn = require('child_process').spawn`
// 在模块求值时即捕获引用，vi.mock('child_process') 拦不到；故直接补丁内置单例的 spawn 属性，
// 并保证补丁先于任何 fluent-ffmpeg 加载（shim / generator 一律在补丁之后动态 import）。
// spawn 一律同步抛 EFTYPE，等价于现场损坏二进制的 CreateProcess 失败。

// ---- electron（仅提供 userData 路径） ----
vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) =>
      path.join(os.tmpdir(), 'wxnn-thumb-eftype-test', `run-${process.pid}-${Date.now()}`)
  }
}))

// ---- 其余重依赖按 generator.test.ts 同款脚手架 mock（fluent-ffmpeg 除外：必须真实） ----
vi.mock('../utils/process-registry', () => ({
  trackFfmpegCommand: (command: unknown) => command,
  untrackFfmpegCommand: () => undefined,
  killAllProcesses: () => undefined
}))
const maybeLogSpawnErrorMock = vi.fn()
vi.mock('../utils/spawn-error-log', () => ({
  maybeLogSpawnError: (...args: unknown[]) => maybeLogSpawnErrorMock(...args)
}))
vi.mock('../utils/ffmpeg-paths', () => ({ ffmpegPath: '/fake/ffmpeg.exe', ffprobePath: 'ffprobe' }))
vi.mock('sharp', () => ({
  default: (input?: string) => {
    ctl.sharpCalls.push(input ?? '')
    const toFile = (p: string) => {
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

// ---- monkey-patch + 动态加载（顺序至关重要）----
// 必须先补丁 child_process.spawn，再动态 import shim / generator；
// 若用静态 import，vitest 会将 import 提升到补丁之前执行，fluent-ffmpeg 将捕获真实 spawn，
// 导致真 spawn('/fake/ffmpeg.exe') 异步 ENOENT（而非同步 EFTYPE），垫片根本不被触发。
const realSpawn = childProcess.spawn
;(childProcess as unknown as { spawn: unknown }).spawn = () => {
  throw makeEftypeError()
}

// 先装垫片（包裹 _spawnFfmpeg），再加载真实 generator（共享同一 fluent-ffmpeg 实例/prototype）。
// 模拟 4 个进程入口「任何 ffmpeg .run() 之前」的早期安装时序。
// 红灯验证：临时注释 installFfmpegSpawnGuard() → 本文件必须失败（generate 悬挂超时 / uncaughtException 泄漏）。
const { installFfmpegSpawnGuard } = await import('../utils/fluent-ffmpeg-shim')
installFfmpegSpawnGuard()
const { ThumbnailGenerator } = await import('./generator')

afterAll(() => {
  ;(childProcess as unknown as { spawn: unknown }).spawn = realSpawn
})

describe('视频缩略图 spawn EFTYPE 优雅降级（真实 fluent-ffmpeg 链路）', () => {
  let gen: import('./generator').ThumbnailGenerator
  let tmpCacheDir: string
  let sourceVideo: string
  let uncaughtSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ctl.sharpCalls = []
    maybeLogSpawnErrorMock.mockClear()
    uncaughtSpy = vi.fn()
    process.on('uncaughtException', uncaughtSpy)

    gen = new ThumbnailGenerator()
    tmpCacheDir = path.join(
      os.tmpdir(),
      'wxnn-thumb-eftype-test',
      `cache-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    fs.mkdirSync(tmpCacheDir, { recursive: true })
    gen.setDir(tmpCacheDir)
    sourceVideo = path.join(tmpCacheDir, 'sample.mp4')
    fs.writeFileSync(sourceVideo, Buffer.alloc(1024, 0x00))
  })

  afterEach(() => {
    process.removeListener('uncaughtException', uncaughtSpy)
    try {
      fs.rmSync(tmpCacheDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('spawn 同步抛 EFTYPE → generate 返回 null、标记损坏、无 uncaughtException 泄漏', async () => {
    const markSpy = vi.fn()
    gen.setCorruptedMarker(markSpy, null)

    const result = await gen.generate(sourceVideo)

    // 优雅降级：解码失败分支 markCorrupted + return null（generator.ts:502-533）
    expect(result).toBeNull()
    expect(markSpy).toHaveBeenCalledTimes(1)
    expect(markSpy.mock.calls[0][0]).toBe(sourceVideo)
    // seek 阶梯 3 个位点全部收到 error 事件并落盘诊断（.on('error') 正常到达）
    expect(maybeLogSpawnErrorMock).toHaveBeenCalledTimes(3)
    expect(maybeLogSpawnErrorMock.mock.calls.every((c) => c[0] === 'thumbnail-generator')).toBe(
      true
    )
    expect((maybeLogSpawnErrorMock.mock.calls[0][1] as NodeJS.ErrnoException).code).toBe('EFTYPE')
    // 核心断言：错误未逃逸到进程级（未装垫片时此处必然泄漏 spawn EFTYPE）
    expect(uncaughtSpy).not.toHaveBeenCalled()
    // 视频原片不经 sharp 解码（走 ffmpeg 抽帧链路）
    expect(ctl.sharpCalls).not.toContain(sourceVideo)
  }, 15000)
})
