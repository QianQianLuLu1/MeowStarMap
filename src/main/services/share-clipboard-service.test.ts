import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import fs from 'fs'
import { clipboard } from 'electron'
import { execFile } from 'child_process'

/**
 * Slice 7a：share-clipboard-service 同步 fs API 异步化 — characterization tests
 *
 * 目的：在 P2-5 重构（同步 fs API → 异步 fs.promises API）前固化现有行为，作为安全网。
 * 重构原则：行为等价，仅改变 fs 调用的同步/异步形式，不改变过滤逻辑、返回值结构、错误处理。
 *
 * 测试接缝（seam）：
 *   - 公共导出：copyFilesToClipboard, filterValidPaths, findExeInDir
 *   - 通过 mock fs / electron / child_process 观察行为，不依赖内部实现
 *
 * 边界场景：
 *   - filterValidPaths：空数组 / 全存在 / 全不存在 / 混合 / 路径是目录
 *   - findExeInDir：空目录 / 目录不存在 / 是文件非目录 / 第一个 exe 存在 / 第二个 exe 存在 / 都不存在
 *   - copyFilesToClipboard：空数组 / 全不存在 / 全存在 / 混合 / powershell 失败 / stat 抛错
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

// mock electron：仅 stub 测试所需的 clipboard + app（logger 依赖 app）
vi.mock('electron', () => ({
  clipboard: {
    writeBuffer: vi.fn()
  },
  app: {
    getPath: vi.fn(() => '/tmp/test-userdata'),
    getVersion: vi.fn(() => '2.5.0')
  }
}))

// mock fs：同时提供同步和异步 stub，兼容重构前后的调用
// 注意：logger.ts 内部调用 fs.mkdirSync（initLogger）+ fs.promises.appendFile（写日志），
// 需在 mock 中提供，否则 logger.info/error 会抛 TypeError
vi.mock('fs', () => {
  return {
    default: {
      statSync: vi.fn(),
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      promises: {
        stat: vi.fn(),
        access: vi.fn(),
        appendFile: vi.fn().mockResolvedValue(undefined),
        readdir: vi.fn().mockResolvedValue([]),
        unlink: vi.fn().mockResolvedValue(undefined)
      }
    }
  }
})

// mock child_process：execFile 返回可控结果
vi.mock('child_process', () => ({
  execFile: vi.fn()
}))

// ============================================================
// Import after mock
// ============================================================
import { copyFilesToClipboard, filterValidPaths, findExeInDir } from './share-clipboard-service'

// ============================================================
// Helpers
// ============================================================

/** 模拟 fs.Stats 的 isFile/isDirectory 返回 */
function mockStats(
  isFile: boolean,
  isDirectory: boolean
): { isFile: () => boolean; isDirectory: () => boolean } {
  return { isFile: () => isFile, isDirectory: () => isDirectory }
}

/** 每次 execFile 调用中 child.stdin.end 收到的载荷（stdin 传入的路径 Base64 列表），按调用顺序存放 */
let stdinPayloads: string[]

/** mock execFile：powershell 调用成功，并记录 stdin 载荷 */
function mockPowershellSuccess(): void {
  stdinPayloads = []
  vi.mocked(execFile).mockImplementation(((_cmd, _args, _opts, cb) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as (
      err: Error | null,
      stdout?: string
    ) => void
    callback(null, '', '')
    return {
      stdin: {
        end: (data?: string) => {
          if (typeof data === 'string') stdinPayloads.push(data)
          return undefined
        }
      }
    } as never
  }) as never)
}

type ExecFileCall = [string, string[], { timeout: number; windowsHide: boolean }]

/** 解码第 N 次 execFile 调用的 -EncodedCommand 参数（UTF-16LE Base64 → 脚本文本） */
function decodeEncodedCommand(callIndex = 0): string {
  const [, args] = vi.mocked(execFile).mock.calls[callIndex] as unknown as ExecFileCall
  const idx = args.indexOf('-EncodedCommand')
  expect(idx).toBeGreaterThanOrEqual(0)
  return Buffer.from(args[idx + 1], 'base64').toString('utf16le')
}

/** 解码第 N 次 execFile 调用的 stdin 载荷 → 路径数组 */
function decodeStdinPaths(callIndex = 0): string[] {
  return stdinPayloads[callIndex]
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => Buffer.from(line.trim(), 'base64').toString('utf8'))
}

beforeEach(() => {
  vi.clearAllMocks()
  // 默认 clipboard.writeBuffer 不抛错（保留 mock 以断言新实现不再调用它）
  vi.mocked(clipboard.writeBuffer).mockImplementation(() => {})
  // 默认 powershell 调用成功（copyFilesToClipboard 成功路径测试的公共前置）
  mockPowershellSuccess()
})

// ============================================================
// filterValidPaths — 异步版本测试
// ============================================================

describe('filterValidPaths', () => {
  it('空数组返回空 valid + 0 skipped', async () => {
    const r = await filterValidPaths([])
    expect(r).toEqual({ valid: [], skipped: 0 })
    expect(fs.promises.stat).not.toHaveBeenCalled()
  })

  it('全部文件存在且是文件类型', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const r = await filterValidPaths(['C:\\a.jpg', 'C:\\b.jpg'])
    expect(r.valid).toEqual(['C:\\a.jpg', 'C:\\b.jpg'])
    expect(r.skipped).toBe(0)
    expect(fs.promises.stat).toHaveBeenCalledTimes(2)
  })

  it('文件不存在（stat 抛 ENOENT）→ skipped++', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT') as never)
    const r = await filterValidPaths(['C:\\missing.jpg'])
    expect(r.valid).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('路径是目录（isFile=false）→ skipped++', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(false, true) as never)
    const r = await filterValidPaths(['C:\\dir'])
    expect(r.valid).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('混合：存在 / 不存在 / 目录 → 仅保留文件', async () => {
    vi.mocked(fs.promises.stat)
      .mockResolvedValueOnce(mockStats(true, false) as never) // C:\a.jpg 文件
      .mockRejectedValueOnce(new Error('ENOENT') as never) // C:\missing.jpg 不存在
      .mockResolvedValueOnce(mockStats(false, true) as never) // C:\dir 目录
    const r = await filterValidPaths(['C:\\a.jpg', 'C:\\missing.jpg', 'C:\\dir'])
    expect(r.valid).toEqual(['C:\\a.jpg'])
    expect(r.skipped).toBe(2)
  })

  it('stat 抛非 ENOENT 错误（如 EACCES）→ skipped++', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error('EACCES: permission denied') as never)
    const r = await filterValidPaths(['C:\\locked.jpg'])
    expect(r.valid).toEqual([])
    expect(r.skipped).toBe(1)
  })

  it('单个文件存在 → valid 长度为 1', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const r = await filterValidPaths(['C:\\single.jpg'])
    expect(r.valid).toHaveLength(1)
    expect(r.skipped).toBe(0)
  })
})

// ============================================================
// findExeInDir — 异步版本测试
// ============================================================

describe('findExeInDir', () => {
  it('空目录字符串返回 null（不查 fs）', async () => {
    const r = await findExeInDir('', ['app.exe'])
    expect(r).toBeNull()
    expect(fs.promises.stat).not.toHaveBeenCalled()
  })

  it('目录不存在（stat 抛错）→ null', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT') as never)
    const r = await findExeInDir('C:\\nonexistent', ['app.exe'])
    expect(r).toBeNull()
  })

  it('路径是文件不是目录（isDirectory=false）→ null', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const r = await findExeInDir('C:\\file.txt', ['app.exe'])
    expect(r).toBeNull()
  })

  it('目录存在且第一个 exe 存在 → 返回完整路径', async () => {
    // 第一次 stat 检查目录 → isDirectory=true
    vi.mocked(fs.promises.stat).mockResolvedValueOnce(mockStats(false, true) as never)
    // access 检查第一个 exe → 不抛错
    vi.mocked(fs.promises.access).mockResolvedValueOnce(undefined as never)
    const r = await findExeInDir('C:\\app', ['app.exe', 'other.exe'])
    expect(r).toBe(path.join('C:\\app', 'app.exe'))
  })

  it('目录存在但第一个 exe 不存在，第二个存在 → 返回第二个路径', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValueOnce(mockStats(false, true) as never)
    vi.mocked(fs.promises.access)
      .mockRejectedValueOnce(new Error('ENOENT') as never) // app.exe 不存在
      .mockResolvedValueOnce(undefined as never) // other.exe 存在
    const r = await findExeInDir('C:\\app', ['app.exe', 'other.exe'])
    expect(r).toBe(path.join('C:\\app', 'other.exe'))
  })

  it('目录存在但所有 exe 都不存在 → null', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(false, true) as never)
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT') as never)
    const r = await findExeInDir('C:\\app', ['app.exe', 'other.exe'])
    expect(r).toBeNull()
  })

  it('空 exeNames 数组 → null（不查 access）', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(false, true) as never)
    const r = await findExeInDir('C:\\app', [])
    expect(r).toBeNull()
  })
})

// ============================================================
// copyFilesToClipboard — 异步版本测试
// ============================================================

describe('copyFilesToClipboard', () => {
  // 写入路径依赖 process.platform === 'win32'（非 win32 走"平台不支持"分支）
  // copyFilesToClipboard 的成功路径测试需 mock process.platform
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  it('空数组 → 失败，count=0, skipped=0，不调用 powershell', async () => {
    const r = await copyFilesToClipboard([])
    expect(r).toEqual({
      success: false,
      count: 0,
      skipped: 0,
      message: '未选择任何文件'
    })
    expect(execFile).not.toHaveBeenCalled()
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
  })

  it('null/undefined → 失败', async () => {
    expect(await copyFilesToClipboard(null as unknown as string[])).toMatchObject({
      success: false,
      count: 0
    })
    expect(await copyFilesToClipboard(undefined as unknown as string[])).toMatchObject({
      success: false,
      count: 0
    })
    expect(execFile).not.toHaveBeenCalled()
  })

  it('全部文件不存在 → 失败，skipped=N，不调用 powershell', async () => {
    vi.mocked(fs.promises.stat).mockRejectedValue(new Error('ENOENT') as never)
    const r = await copyFilesToClipboard(['C:\\a.jpg', 'C:\\b.jpg'])
    expect(r.success).toBe(false)
    expect(r.count).toBe(0)
    expect(r.skipped).toBe(2)
    expect(r.message).toContain('不可访问')
    expect(execFile).not.toHaveBeenCalled()
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()
  })

  it('回归修复（2026-09-30）：成功复制必须经 PowerShell SetFileDropList 写入标准 CF_HDROP，不得使用 clipboard.writeBuffer', async () => {
    // 旧实现缺陷：clipboard.writeBuffer('CF_HDROP') 经 RegisterClipboardFormat 只会注册
    // 同名自定义格式（0xC000+），永不命中标准 CF_HDROP(15)，微信/QQ Ctrl+V 无内容
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)

    const r = await copyFilesToClipboard(['C:\\photos\\a.jpg'])

    expect(r.success).toBe(true)
    expect(clipboard.writeBuffer).not.toHaveBeenCalled()

    expect(execFile).toHaveBeenCalledTimes(1)
    const call = vi.mocked(execFile).mock.calls[0] as unknown as ExecFileCall
    expect(call[0].toLowerCase()).toMatch(/powershell\.exe$/)
    expect(call[1].slice(0, 4)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand'
    ])
    expect(call[2]).toMatchObject({ timeout: 10000, windowsHide: true })

    const script = decodeEncodedCommand(0)
    expect(script).toContain('System.Windows.Forms')
    expect(script).toContain('SetFileDropList')
    expect(decodeStdinPaths(0)).toEqual(['C:\\photos\\a.jpg'])
  })

  it('全部文件存在 → 成功，count=N, skipped=0，stdin 含全部路径', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const r = await copyFilesToClipboard(['C:\\a.jpg', 'C:\\b.jpg'])
    expect(r.success).toBe(true)
    expect(r.count).toBe(2)
    expect(r.skipped).toBe(0)
    expect(r.message).toContain('已复制 2 个文件')
    expect(decodeStdinPaths(0)).toEqual(['C:\\a.jpg', 'C:\\b.jpg'])
  })

  it('混合存在与不存在 → 成功，count=M, skipped=K，stdin 只含有效路径', async () => {
    vi.mocked(fs.promises.stat)
      .mockResolvedValueOnce(mockStats(true, false) as never)
      .mockRejectedValueOnce(new Error('ENOENT') as never)
      .mockResolvedValueOnce(mockStats(true, false) as never)
    const r = await copyFilesToClipboard(['C:\\a.jpg', 'C:\\missing.jpg', 'C:\\c.jpg'])
    expect(r.success).toBe(true)
    expect(r.count).toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.message).toContain('跳过 1')
    expect(decodeStdinPaths(0)).toEqual(['C:\\a.jpg', 'C:\\c.jpg'])
  })

  it('powershell 调用失败/超时 → 失败，message 含复制失败', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    vi.mocked(execFile).mockImplementation(((_cmd, _args, _opts, cb) => {
      const callback = (typeof _opts === 'function' ? _opts : cb) as (
        err: Error | null,
        stdout?: string
      ) => void
      callback(new Error('command timed out'), '')
      return { stdin: { end: () => undefined } } as never
    }) as never)
    const r = await copyFilesToClipboard(['C:\\a.jpg'])
    expect(r.success).toBe(false)
    expect(r.count).toBe(0)
    expect(r.message).toContain('复制失败')
    expect(r.message).toContain('command timed out')
  })

  it('边界：中文/空格/单引号路径经 stdin Base64 往返无损，且不进入命令行', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const weirdPath = "D:\\无限暖暖 相册\\照片 'a'&1.jpg"

    const r = await copyFilesToClipboard([weirdPath])

    expect(r.success).toBe(true)
    expect(decodeStdinPaths(0)).toEqual([weirdPath])
    // 路径不进入命令行参数，杜绝引号转义与注入面
    const call = vi.mocked(execFile).mock.calls[0] as unknown as ExecFileCall
    expect(call[1].join(' ')).not.toContain(weirdPath)
  })

  it('单个文件存在 → 成功', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const r = await copyFilesToClipboard(['C:\\single.jpg'])
    expect(r.success).toBe(true)
    expect(r.count).toBe(1)
    expect(r.skipped).toBe(0)
  })

  it('返回值结构完整（success/count/skipped/message）', async () => {
    vi.mocked(fs.promises.stat).mockResolvedValue(mockStats(true, false) as never)
    const r = await copyFilesToClipboard(['C:\\a.jpg'])
    expect(r).toHaveProperty('success')
    expect(r).toHaveProperty('count')
    expect(r).toHaveProperty('skipped')
    expect(r).toHaveProperty('message')
    expect(typeof r.success).toBe('boolean')
    expect(typeof r.count).toBe('number')
    expect(typeof r.skipped).toBe('number')
    expect(typeof r.message).toBe('string')
  })
})
