/**
 * @layer L1
 * @module src/main/utils/ffmpeg-paths
 * @coverage resolveAsarUnpackedPath/ffmpegPath/ffprobePath
 * @dependencies mock: ffmpeg-static, ffprobe-static
 * @remarks mock 二进制依赖后的路径解析逻辑测试
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 控制 ffmpeg-static 默认导出
let mockFfmpegStaticPath: string | undefined = '/fake/app.asar/ffmpeg.exe'
let mockFfprobeStaticPath: string | undefined = '/fake/app.asar/ffprobe.exe'

vi.mock('ffmpeg-static', () => ({
  get default() {
    return mockFfmpegStaticPath
  }
}))

vi.mock('ffprobe-static', () => ({
  get default() {
    return { path: mockFfprobeStaticPath }
  }
}))

// 实现用 fs.existsSync 校验二进制真实落盘（ffmpeg-paths.ts:35），
// 测试假路径 /fake/... 在磁盘上不存在，须 mock existsSync 对 /fake/ 路径返回 true
vi.mock('fs', () => ({
  default: { existsSync: (p: string) => p.includes('/fake/') },
  existsSync: (p: string) => p.includes('/fake/')
}))

// 由于 ffmpegPath/ffprobePath 在模块加载时已计算，需通过 vi.isolateModules 隔离
async function loadModule() {
  const mod = await import('./ffmpeg-paths')
  return mod
}

describe('ffmpeg-paths', () => {
  beforeEach(() => {
    mockFfmpegStaticPath = '/fake/app.asar/ffmpeg.exe'
    mockFfprobeStaticPath = '/fake/app.asar/ffprobe.exe'
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

    it('ffprobe-static 整体 undefined 时回退到 "ffprobe"', async () => {
      // 由于 mock 工厂使用 getter，模拟 path 不存在
      vi.doMock('ffprobe-static', () => ({ default: {} }))
      vi.resetModules()
      const { ffprobePath } = await loadModule()
      expect(ffprobePath).toBe('ffprobe')
      vi.doUnmock('ffprobe-static')
    })
  })
})
