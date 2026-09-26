/**
 * @layer L1
 * @module src/main/utils/ffmpeg-paths
 * @coverage resolveAsarUnpackedPath/ffmpegPath/ffprobePath
 * @dependencies mock: ffmpeg-static, ffprobe-static, fs, ./startup-diagnostic
 * @remarks mock 二进制依赖后的路径解析逻辑测试；PE 魔数校验用例模拟杀软占位文件场景
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 控制 ffmpeg-static 默认导出
let mockFfmpegStaticPath: string | undefined = '/fake/app.asar/ffmpeg.exe'
// ffprobe-static 的 default.path；置为 null 模拟"模块整体缺失"（default 为 undefined）
let mockFfprobeStaticPath: string | undefined | null = '/fake/app.asar/ffprobe.exe'

// 按路径定制"文件头内容"：未登记的 /fake/ 路径默认视为合法 MZ PE；
// 登记 Buffer.alloc(0) 模拟 0 字节占位，登记文本 Buffer 模拟杀软替换的占位文件
const fakeFileHeaders = new Map<string, Buffer>()

function fakeHeaderFor(p: string): Buffer {
  const hit = fakeFileHeaders.get(p)
  return hit ?? Buffer.from([0x4d, 0x5a, 0x90, 0x00])
}

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

// 实现用 fs.existsSync 校验二进制真实落盘（ffmpeg-paths.ts:35），
// PE 魔数预检（hasWindowsExecutableHeader）再用 statSync/openSync/readSync/closeSync。
// 测试假路径 /fake/... 在磁盘上不存在，须 mock 全套 fs：对 /fake/ 路径返回登记的文件头。
let currentFdPath = ''
vi.mock('fs', () => {
  const existsSync = (p: string) => p.includes('/fake/')
  return {
    default: {
      existsSync,
      statSync: (p: string) => {
        if (!existsSync(p)) {
          throw Object.assign(new Error(`ENOENT: no such file: ${p}`), { code: 'ENOENT' })
        }
        const header = fakeHeaderFor(p)
        return { isFile: () => true, size: header.length }
      },
      openSync: (p: string) => {
        currentFdPath = p
        return 7
      },
      readSync: (_fd: number, buffer: Buffer) => {
        const header = fakeHeaderFor(currentFdPath)
        const n = Math.min(2, header.length)
        header.copy(buffer, 0, 0, n)
        return n
      },
      closeSync: () => {}
    },
    existsSync
  }
})

vi.mock('./startup-diagnostic', () => ({
  diagLog: vi.fn(),
  logStartupError: vi.fn()
}))

import { diagLog } from './startup-diagnostic'

// 由于 ffmpegPath/ffprobePath 在模块加载时已计算，需通过 vi.isolateModules 隔离
async function loadModule() {
  const mod = await import('./ffmpeg-paths')
  return mod
}

describe('ffmpeg-paths', () => {
  beforeEach(() => {
    mockFfmpegStaticPath = '/fake/app.asar/ffmpeg.exe'
    mockFfprobeStaticPath = '/fake/app.asar/ffprobe.exe'
    fakeFileHeaders.clear()
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

  describe('PE 魔数预检（spawn EFTYPE 防护）', () => {
    const FFMPEG_RESOLVED = '/fake/app.asar.unpacked/ffmpeg.exe'
    const FFPROBE_RESOLVED = '/fake/app.asar.unpacked/ffprobe.exe'

    it('ffmpeg 二进制为文本占位文件时回退 PATH 并记录诊断日志（异常）', async () => {
      fakeFileHeaders.set(FFMPEG_RESOLVED, Buffer.from('blocked by your antivirus', 'utf8'))
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
      expect(diagLog).toHaveBeenCalledTimes(1)
      expect(vi.mocked(diagLog).mock.calls[0][0]).toBe('FFMPEG')
      expect(String(vi.mocked(diagLog).mock.calls[0][1])).toContain(FFMPEG_RESOLVED)
    })

    it('ffmpeg 二进制为 0 字节占位时回退 PATH（异常）', async () => {
      fakeFileHeaders.set(FFMPEG_RESOLVED, Buffer.alloc(0))
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
    })

    it('ffprobe 二进制为文本占位文件时同样回退并记录（异常）', async () => {
      fakeFileHeaders.set(FFPROBE_RESOLVED, Buffer.from('quarantined', 'utf8'))
      const { ffprobePath } = await loadModule()
      expect(ffprobePath).toBe('ffprobe')
      expect(diagLog).toHaveBeenCalledTimes(1)
      expect(String(vi.mocked(diagLog).mock.calls[0][1])).toContain(FFPROBE_RESOLVED)
    })

    it('合法 MZ 二进制仍采用本地路径且不记日志（正常/回归）', async () => {
      const { ffmpegPath, ffprobePath } = await loadModule()
      expect(ffmpegPath).toBe(FFMPEG_RESOLVED)
      expect(ffprobePath).toBe(FFPROBE_RESOLVED)
      expect(diagLog).not.toHaveBeenCalled()
    })

    it('恰 2 字节 MZ 头的二进制视为有效（边界）', async () => {
      fakeFileHeaders.set(FFMPEG_RESOLVED, Buffer.from([0x4d, 0x5a]))
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe(FFMPEG_RESOLVED)
    })

    it('非 MZ 开头的二进制回退 PATH（边界）', async () => {
      fakeFileHeaders.set(FFMPEG_RESOLVED, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
    })

    it('非 Windows 平台跳过 PE 预检，ELF 二进制仍采用本地路径（平台门控）', async () => {
      // EFTYPE（Win32 错误 193）是 Windows 特有错误，PE 预检仅应在 win32 生效；
      // Linux/macOS 的 bundled 二进制是 ELF，不应被误判回退
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      try {
        fakeFileHeaders.set(FFMPEG_RESOLVED, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
        const { ffmpegPath } = await loadModule()
        expect(ffmpegPath).toBe(FFMPEG_RESOLVED)
        expect(diagLog).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      }
    })

    it('本地路径含非 ASCII 时仍优先回退（既有行为回归）', async () => {
      mockFfmpegStaticPath = '/fake/中文目录/ffmpeg.exe'
      vi.resetModules()
      const { ffmpegPath } = await loadModule()
      expect(ffmpegPath).toBe('ffmpeg')
    })
  })
})
