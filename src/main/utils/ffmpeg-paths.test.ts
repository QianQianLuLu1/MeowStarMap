/**
 * @layer L1
 * @module src/main/utils/ffmpeg-paths
 * @coverage resolveAsarUnpackedPath/ffmpegPath/ffprobePath
 * @dependencies mock: ffmpeg-static, ffprobe-static, fs, ./startup-diagnostic, ./path-safety
 * @remarks mock 二进制依赖后的路径解析逻辑测试；PE 结构校验用例模拟截断/损坏二进制场景
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 控制 ffmpeg-static 默认导出
let mockFfmpegStaticPath: string | undefined = '/fake/app.asar/ffmpeg.exe'
// ffprobe-static 的 default.path；置为 null 模拟“模块整体缺失”（default 为 undefined）
let mockFfprobeStaticPath: string | undefined | null = '/fake/app.asar/ffprobe.exe'

// 控制 hasValidPeStructure 返回值，默认合法 PE
let mockHasValidPeStructure = true

vi.mock('ffmpeg-static', () => ({
  get default() {
    return mockFfmpegStaticPath
  }
}))

vi.mock('ffprobe-static', () => ({
  get default() {
    return mockFfprobeStaticPath === null ? undefined : { path: mockFfprobeStaticPath }
  }
}))

// 简化 fs mock：只需 existsSync，对 /fake/ 路径返回 true
vi.mock('fs', () => {
  const existsSync = (p: string) => p.includes('/fake/')
  return {
    default: { existsSync },
    existsSync
  }
})

// 直接控制 path-safety 的 hasValidPeStructure，避免依赖真实 fs 操作
vi.mock('./path-safety', () => ({
  hasValidPeStructure: () => mockHasValidPeStructure,
  hasNonAsciiPath: () => false,
  hasWindowsExecutableHeader: () => true,
  resolveSafeBinaryPath: (c: string, f: string) => c || f,
  ensureWritableDir: () => true
}))

vi.mock('./startup-diagnostic', () => ({
  diagLog: vi.fn(),
  logStartupError: vi.fn()
}))

import { diagLog } from './startup-diagnostic'

// 由于 ffmpegPath/ffprobePath 在模块加载时已计算，需通过 vi.resetModules 隔离
async function loadModule() {
  const mod = await import('./ffmpeg-paths')
  return mod
}

describe('ffmpeg-paths', () => {
  beforeEach(() => {
    mockFfmpegStaticPath = '/fake/app.asar/ffmpeg.exe'
    mockFfprobeStaticPath = '/fake/app.asar/ffprobe.exe'
    mockHasValidPeStructure = true
    vi.mocked(diagLog).mockClear()
    vi.resetModules()
  })
  describe('resolveAsarUnpackedPath', () => {
    it('将 app.asar 替换为 app.asar.unpacked', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const input = 'C:\\app\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'
      const result = resolveAsarUnpackedPath(input)
      expect(result).toBe(
        'C:\\app\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe'
      )
    })

    it('Unix 风格路径分隔符也能替换', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const input = '/app/resources/app.asar/node_modules/ffmpeg-static/ffmpeg'
      const result = resolveAsarUnpackedPath(input)
      expect(result).toBe('/app/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg')
    })

    it('字符串结尾的 app.asar 也能替换', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const result = resolveAsarUnpackedPath('/path/to/app.asar')
      expect(result).toBe('/path/to/app.asar.unpacked')
    })

    it('不替换 app.asar.backup 等子串（前向断言）', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const input = '/path/to/app.asar.backup/file'
      const result = resolveAsarUnpackedPath(input)
      expect(result).toBe('/path/to/app.asar.backup/file')
    })

    it('不替换 app.asarxxx 等无分隔符的子串', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const input = '/path/to/app.asarxxx/file'
      const result = resolveAsarUnpackedPath(input)
      expect(result).toBe('/path/to/app.asarxxx/file')
    })

    it('多个 app.asar 出现全部替换', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const input = '/app.asar/foo/app.asar/bar'
      const result = resolveAsarUnpackedPath(input)
      expect(result).toBe('/app.asar.unpacked/foo/app.asar.unpacked/bar')
    })

    it('不含 app.asar 的路径原样返回', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      const input = '/normal/path/ffmpeg.exe'
      const result = resolveAsarUnpackedPath(input)
      expect(result).toBe('/normal/path/ffmpeg.exe')
    })

    it('空字符串原样返回', async () => {
      const { resolveAsarUnpackedPath } = await loadModule()
      expect(resolveAsarUnpackedPath('')).toBe('')
    })
  })

  describe('ffmpegPath', () => {
    it('使用 ffmpeg-static 路径并替换 asar', async () => {
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('/fake/app.asar.unpacked/ffmpeg.exe')
    })

    it('ffmpeg-static 返回 undefined 时回退到 "ffmpeg"', async () => {
      mockFfmpegStaticPath = undefined
      vi.resetModules()
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
    })
  })

  describe('ffprobePath', () => {
    it('使用 ffprobe-static.path 并替换 asar', async () => {
      const { ffprobePath } = await loadModule()
      expect(ffprobePath).toBe('/fake/app.asar.unpacked/ffprobe.exe')
    })

    it('ffprobe-static.path 为 undefined 时回退到 "ffprobe"', async () => {
      mockFfprobeStaticPath = undefined
      vi.resetModules()
      const { ffprobePath } = await loadModule()
      expect(ffprobePath).toBe('ffprobe')
    })

    it('ffprobe-static 模块整体 undefined 时回退到 "ffprobe"', async () => {
      // null 使 mock 工厂的 default getter 返回 undefined，模拟模块整体缺失；
      // 不用 vi.doMock/doUnmock：doUnmock 会让后续用例拿到真实 ffprobe-static，造成跨用例污染
      mockFfprobeStaticPath = null
      vi.resetModules()
      const { ffprobePath } = await loadModule()
      expect(ffprobePath).toBe('ffprobe')
    })
  })

  describe('PE 结构预检（截断/损坏二进制防护）', () => {
    const FFMPEG_RESOLVED = '/fake/app.asar.unpacked/ffmpeg.exe'
    const FFPROBE_RESOLVED = '/fake/app.asar.unpacked/ffprobe.exe'

    it('合法 PE 二进制采用本地路径且不记日志（正常）', async () => {
      mockHasValidPeStructure = true
      const { ffmpegPath, ffprobePath } = await loadModule()
      expect(ffmpegPath).toBe(FFMPEG_RESOLVED)
      expect(ffprobePath).toBe(FFPROBE_RESOLVED)
      expect(diagLog).not.toHaveBeenCalled()
    })

    it('截断/损坏 PE（hasValidPeStructure=false）回退 PATH 并记录诊断日志', async () => {
      mockHasValidPeStructure = false
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
      // 模块加载时 ffmpegPath 和 ffprobePath 都会触发诊断日志
      expect(diagLog).toHaveBeenCalledTimes(2)
      expect(vi.mocked(diagLog).mock.calls[0][0]).toBe('FFMPEG')
      expect(String(vi.mocked(diagLog).mock.calls[0][1])).toContain(FFMPEG_RESOLVED)
    })

    it('截断 PE 对 ffprobe 同样回退', async () => {
      mockHasValidPeStructure = false
      const { ffprobePath } = await loadModule()
      expect(ffprobePath).toBe('ffprobe')
      expect(diagLog).toHaveBeenCalledTimes(2) // ffmpeg 和 ffprobe 各记一次
    })

    it('非 Windows 平台跳过 PE 预检，任何二进制仍采用本地路径（平台门控）', async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      try {
        mockHasValidPeStructure = false // 即使在 linux 上 PE 校验会返回 false，也不应触发回退
        const { ffmpegPath } = await loadModule()
        expect(ffmpegPath).toBe(FFMPEG_RESOLVED)
        expect(diagLog).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    })

    it('本地路径含非 ASCII + 合法 PE → 仍采用绝对路径（不再降级）', async () => {
      // 核心行为反转：对照实验证明非 ASCII 路径本身能正常 spawn，
      // 旧的 hasNonAsciiPath 降级是有害的过度防御，已移除
      mockFfmpegStaticPath = '/fake/中文目录/ffmpeg.exe'
      mockHasValidPeStructure = true
      vi.resetModules()
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('/fake/中文目录/ffmpeg.exe')
    })

    it('本地路径含非 ASCII + 截断 PE → 回退到裸命令', async () => {
      mockFfmpegStaticPath = '/fake/中文目录/ffmpeg.exe'
      mockHasValidPeStructure = false
      vi.resetModules()
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
    })
  })
})
