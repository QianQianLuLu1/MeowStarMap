import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/log-service
 * @coverage listFaults / listFaultsPaged / invalidateFaultsCache / getFaultDetail /
 *           openLogDirectory / exportLogsAsZip / clearAllLogs / getLogStats
 * @dependencies electron.shell, logger(getLogDirectory + FaultRecord), crash-service, process-registry, child_process.spawn
 * @remarks 使用真实 fs + 临时日志目录；Mock electron.shell + spawn
 */

// ============================================================
// Mock 声明（hoisted）
// ============================================================

let mockLogDir = ''

vi.mock('../utils/logger', async () => {
  const actual = await vi.importActual<typeof import('../utils/logger')>('../utils/logger')
  return {
    ...actual,
    getLogDirectory: vi.fn(() => mockLogDir)
  }
})

vi.mock('electron', () => ({
  shell: {
    openPath: vi.fn()
  },
  app: {
    getVersion: vi.fn(() => '1.0.0-test'),
    getName: vi.fn(() => 'wxnn-test')
  }
}))

// crash-service mock（被 exportLogsAsZip 动态 require）
vi.mock('./crash-service', () => ({
  getCrashDirectory: vi.fn(() => '')
}))

// process-registry mock（trackProcess 直接返回传入的 child）
vi.mock('../utils/process-registry', () => ({
  trackProcess: vi.fn((child: unknown) => child),
  untrackFfmpegCommand: vi.fn()
}))

// child_process.spawn mock：构造一个伪 EventEmitter
const mockSpawnChild = () => {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  return {
    stderr: { on: (ev: string, cb: (...a: unknown[]) => void) => (handlers[`stderr_${ev}`] = cb) },
    stdout: { on: (ev: string, cb: (...a: unknown[]) => void) => (handlers[`stdout_${ev}`] = cb) },
    on: (ev: string, cb: (...a: unknown[]) => void) => (handlers[ev] = cb),
    _handlers: handlers,
    _emitStderr: function (data: string) {
      this._handlers.stderr_data?.(data)
    },
    _emitStdout: function (data: string) {
      this._handlers.stdout_data?.(data)
    },
    _emitError: function (err: Error) {
      this._handlers.error?.(err)
    },
    _emitClose: function (code: number) {
      this._handlers.close?.(code)
    }
  }
}

let lastSpawnArgs: unknown[] | null = null
let lastSpawnChild: ReturnType<typeof mockSpawnChild> | null = null
vi.mock('child_process', () => ({
  spawn: vi.fn((...args: unknown[]) => {
    lastSpawnArgs = args
    lastSpawnChild = mockSpawnChild()
    return lastSpawnChild
  })
}))

// ============================================================
// Import after mock
// ============================================================
import {
  listFaults,
  listFaultsPaged,
  invalidateFaultsCache,
  getFaultDetail,
  openLogDirectory,
  exportLogsAsZip,
  clearAllLogs,
  getLogStats
} from './log-service'
import { shell } from 'electron'
import { spawn } from 'child_process'

// ============================================================
// Helpers
// ============================================================

interface FaultJson {
  id: string
  timestamp: string
  type: string
  summary: string
  detail: string
  file: string
  appVersion: string
  electronVersion: string
  nodeVersion: string
  platform: string
  osVersion: string
  pid: number
  uptime: number
}

function writeFaultsFile(filename: string, faults: FaultJson[]): void {
  const content = faults.map((f) => JSON.stringify(f)).join('\n')
  fs.writeFileSync(path.join(mockLogDir, filename), content, 'utf-8')
}

function makeFault(id: string, timestamp: string): FaultJson {
  return {
    id,
    timestamp,
    type: 'manual',
    summary: `summary-${id}`,
    detail: `detail-${id}`,
    file: 'test.ts',
    appVersion: '1.0.0',
    electronVersion: '28.0.0',
    nodeVersion: '20.0.0',
    platform: 'win32',
    osVersion: '10.0',
    pid: 1234,
    uptime: 100
  }
}

let tmpRoot: string

// 等待 spawn 被调用并返回 child mock 对象
// 源码 exportLogsAsZip 在调用 spawn 之前有大量 fs.promises 异步操作，
// 单次 setImmediate 等待不足以让 spawn 被调用，所以使用 vi.waitFor 轮询
async function waitForSpawn(): Promise<ReturnType<typeof mockSpawnChild>> {
  await vi.waitFor(() => {
    expect(spawn).toHaveBeenCalled()
  })
  return lastSpawnChild!
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-log-'))
  mockLogDir = path.join(tmpRoot, 'logs')
  fs.mkdirSync(mockLogDir, { recursive: true })
  // 每个测试前失效缓存
  invalidateFaultsCache()
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ============================================================
// describe: listFaults
// ============================================================

describe('listFaults', () => {
  it('空目录返回空数组', async () => {
    const r = await listFaults()
    expect(r).toEqual([])
  })

  it('单文件单条故障返回单元素数组', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])

    const r = await listFaults()
    expect(r.length).toBe(1)
    expect(r[0].id).toBe('a')
  })

  it('多文件多条故障按 timestamp 倒序合并', async () => {
    writeFaultsFile('faults-2026-07-18.jsonl', [
      makeFault('old1', '2026-07-18T10:00:00Z'),
      makeFault('old2', '2026-07-18T11:00:00Z')
    ])
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('new', '2026-07-19T09:00:00Z')])

    const r = await listFaults()
    expect(r.map((f) => f.id)).toEqual(['new', 'old2', 'old1'])
  })

  it('损坏 JSON 行被跳过不影响其他记录', async () => {
    const content =
      JSON.stringify(makeFault('valid', '2026-07-19T10:00:00Z')) +
      '\n{invalid json}\n' +
      JSON.stringify(makeFault('valid2', '2026-07-19T11:00:00Z'))
    fs.writeFileSync(path.join(mockLogDir, 'faults-2026-07-19.jsonl'), content, 'utf-8')

    const r = await listFaults()
    expect(r.map((f) => f.id)).toEqual(['valid2', 'valid'])
  })

  it('仅读取 faults-*.jsonl，忽略其他文件', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('fault', '2026-07-19T10:00:00Z')])
    fs.writeFileSync(path.join(mockLogDir, 'app-2026-07-19.log'), 'some-log-line', 'utf-8')
    fs.writeFileSync(
      path.join(mockLogDir, 'other.jsonl'),
      JSON.stringify(makeFault('other', '2026-07-19T10:00:00Z')),
      'utf-8'
    )

    const r = await listFaults()
    expect(r.length).toBe(1)
    expect(r[0].id).toBe('fault')
  })

  it('缓存命中：连续两次调用返回相同数据', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])

    const r1 = await listFaults()
    const r2 = await listFaults()
    expect(r1).toEqual(r2)
    expect(r1.length).toBe(1)
  })

  // 源码实际行为：缓存命中时返回副本（[...faultsCache]），修改副本不影响后续调用
  // 第一次调用因缓存未命中返回原数组引用，所以这里在缓存命中场景下验证副本语义
  it('缓存返回的是副本：修改不影响后续调用', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])

    // 第一次调用填充缓存
    await listFaults()
    // 第二次调用命中缓存，返回的是副本
    const r1 = await listFaults()
    r1.push(makeFault('b', '2026-07-19T11:00:00Z'))

    const r2 = await listFaults()
    expect(r2.length).toBe(1)
  })

  it('文件变更后缓存自动失效重新读取', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    const r1 = await listFaults()
    expect(r1.length).toBe(1)

    // 追加新故障
    writeFaultsFile('faults-2026-07-19.jsonl', [
      makeFault('a', '2026-07-19T10:00:00Z'),
      makeFault('b', '2026-07-19T11:00:00Z')
    ])

    const r2 = await listFaults()
    expect(r2.length).toBe(2)
  })

  it('日志目录不存在时返回空数组', async () => {
    mockLogDir = path.join(tmpRoot, 'no-such-dir')

    const r = await listFaults()
    expect(r).toEqual([])
  })
})

// ============================================================
// describe: listFaultsPaged
// ============================================================

describe('listFaultsPaged', () => {
  beforeEach(() => {
    // 准备 5 条故障
    const faults: FaultJson[] = []
    for (let i = 0; i < 5; i++) {
      faults.push(makeFault(`id${i}`, `2026-07-19T${10 + i}:00:00Z`))
    }
    writeFaultsFile('faults-2026-07-19.jsonl', faults)
  })

  it('offset=0 limit=2 返回前 2 条 + total=5 + hasMore=true', async () => {
    const r = await listFaultsPaged(0, 2)
    expect(r.total).toBe(5)
    expect(r.hasMore).toBe(true)
    expect(r.faults.length).toBe(2)
    // 倒序：最新在前
    expect(r.faults[0].id).toBe('id4')
    expect(r.faults[1].id).toBe('id3')
  })

  it('offset=4 limit=2 返回最后 1 条 + hasMore=false', async () => {
    const r = await listFaultsPaged(4, 2)
    expect(r.total).toBe(5)
    expect(r.hasMore).toBe(false)
    expect(r.faults.length).toBe(1)
    expect(r.faults[0].id).toBe('id0')
  })

  it('默认参数 offset=0 limit=50 返回全部', async () => {
    const r = await listFaultsPaged()
    expect(r.total).toBe(5)
    expect(r.faults.length).toBe(5)
    expect(r.hasMore).toBe(false)
  })

  it('offset 超出范围返回空 faults 数组', async () => {
    const r = await listFaultsPaged(100, 10)
    expect(r.total).toBe(5)
    expect(r.faults).toEqual([])
    expect(r.hasMore).toBe(false)
  })

  it('offset + limit == total 时 hasMore=false', async () => {
    const r = await listFaultsPaged(3, 2)
    expect(r.total).toBe(5)
    expect(r.faults.length).toBe(2)
    expect(r.hasMore).toBe(false)
  })
})

// ============================================================
// describe: invalidateFaultsCache
// ============================================================

describe('invalidateFaultsCache', () => {
  it('调用后下一次 listFaults 重新读取文件', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    const r1 = await listFaults()
    expect(r1.length).toBe(1)

    // 修改文件但不调用 invalidate（依赖 mtime 失效）
    // 直接调用 invalidate 强制失效
    invalidateFaultsCache()

    writeFaultsFile('faults-2026-07-19.jsonl', [
      makeFault('a', '2026-07-19T10:00:00Z'),
      makeFault('b', '2026-07-19T11:00:00Z')
    ])

    const r2 = await listFaults()
    expect(r2.length).toBe(2)
  })
})

// ============================================================
// describe: getFaultDetail
// ============================================================

describe('getFaultDetail', () => {
  it('存在的 id 返回对应 FaultRecord', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [
      makeFault('a', '2026-07-19T10:00:00Z'),
      makeFault('b', '2026-07-19T11:00:00Z')
    ])

    const r = await getFaultDetail('b')
    expect(r).not.toBeNull()
    expect(r!.id).toBe('b')
    expect(r!.summary).toBe('summary-b')
  })

  it('不存在的 id 返回 null', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])

    const r = await getFaultDetail('nonexistent')
    expect(r).toBeNull()
  })

  it('空日志目录返回 null', async () => {
    const r = await getFaultDetail('any')
    expect(r).toBeNull()
  })
})

// ============================================================
// describe: openLogDirectory
// ============================================================

describe('openLogDirectory', () => {
  it('openPath 返回空字符串时返回 success=true', async () => {
    vi.mocked(shell.openPath).mockResolvedValue('')

    const r = await openLogDirectory()
    expect(r.success).toBe(true)
    expect(r.message).toBe('已打开日志目录')
  })

  it('openPath 返回错误字符串时返回 success=false', async () => {
    vi.mocked(shell.openPath).mockResolvedValue('Error: path not found')

    const r = await openLogDirectory()
    expect(r.success).toBe(false)
    expect(r.message).toContain('Error: path not found')
  })

  it('openPath 抛异常时返回 success=false 与异常消息', async () => {
    vi.mocked(shell.openPath).mockRejectedValue(new Error('shell crashed'))

    const r = await openLogDirectory()
    expect(r.success).toBe(false)
    expect(r.message).toBe('shell crashed')
  })

  it('openPath 抛非 Error 类型时使用 String 转换', async () => {
    vi.mocked(shell.openPath).mockRejectedValue('string-error')

    const r = await openLogDirectory()
    expect(r.success).toBe(false)
    expect(r.message).toBe('string-error')
  })
})

// ============================================================
// describe: exportLogsAsZip
// ============================================================

describe('exportLogsAsZip', () => {
  it('目标路径非 .zip 扩展名时返回 success=false', async () => {
    const r = await exportLogsAsZip(path.join(tmpRoot, 'output.txt'))
    expect(r.success).toBe(false)
    expect(r.message).toContain('必须是 .zip 文件')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('大写 .ZIP 扩展名也接受', async () => {
    const target = path.join(tmpRoot, 'out.ZIP')
    // 预先生成输出文件，让 close(code=0) 后 stat 校验通过
    fs.writeFileSync(target, Buffer.from('fake-zip-content'))

    const promise = exportLogsAsZip(target)
    // 源码在 spawn 之前有大量 fs.promises 异步操作，需轮询等待 spawn 被调用
    const child = await waitForSpawn()
    child._emitClose(0)

    const r = await promise
    expect(r.success).toBe(true)
    expect(r.message).toContain('诊断包已导出')
  })

  it('tar.exe 成功（code=0）+ 输出文件非空时返回 success=true', async () => {
    const target = path.join(tmpRoot, 'out.zip')
    // 预先生成输出文件
    fs.writeFileSync(target, Buffer.from('fake-zip-content'))

    const promise = exportLogsAsZip(target)
    const child = await waitForSpawn()
    child._emitClose(0)

    const r = await promise
    expect(r.success).toBe(true)
    expect(r.message).toContain('诊断包已导出')
  })

  it('tar.exe 成功但输出文件为空时返回 success=false', async () => {
    const target = path.join(tmpRoot, 'out.zip')
    // 不创建输出文件，让 fs.promises.stat 抛 ENOENT 触发"目标文件未生成"分支

    const promise = exportLogsAsZip(target)
    const child = await waitForSpawn()
    child._emitClose(0)

    const r = await promise
    expect(r.success).toBe(false)
    expect(r.message).toContain('目标文件未生成')
  })

  it('tar.exe 退出码非 0 时返回 success=false 与 stderr', async () => {
    const target = path.join(tmpRoot, 'out.zip')
    fs.writeFileSync(target, Buffer.from('x'))

    const promise = exportLogsAsZip(target)
    const child = await waitForSpawn()
    child._emitStderr('tar: error occurred')
    child._emitClose(2)

    const r = await promise
    expect(r.success).toBe(false)
    expect(r.message).toContain('退出码 2')
    expect(r.message).toContain('tar: error occurred')
  })

  it('tar.exe 启动失败（error 事件）时返回 success=false', async () => {
    const target = path.join(tmpRoot, 'out.zip')

    const promise = exportLogsAsZip(target)
    const child = await waitForSpawn()
    child._emitError(new Error('spawn ENOENT'))

    const r = await promise
    expect(r.success).toBe(false)
    expect(r.message).toContain('启动 tar.exe 失败')
    expect(r.message).toContain('spawn ENOENT')
  })

  it('调用 spawn 时使用 tar.exe 命令与 zip 格式', async () => {
    const target = path.join(tmpRoot, 'out.zip')
    fs.writeFileSync(target, Buffer.from('x'))

    const promise = exportLogsAsZip(target)
    const child = await waitForSpawn()
    child._emitClose(0)
    await promise

    expect(spawn).toHaveBeenCalled()
    expect(lastSpawnArgs![0]).toBe('tar.exe')
    expect(lastSpawnArgs![1]).toContain('-c')
    expect(lastSpawnArgs![1]).toContain('--format=zip')
    expect(lastSpawnArgs![1]).toContain('-f')
    expect(lastSpawnArgs![1]).toContain(target)
  })
})

// ============================================================
// describe: clearAllLogs
// ============================================================

describe('clearAllLogs', () => {
  it('清空目录下所有 .log 与 .jsonl 文件', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    fs.writeFileSync(path.join(mockLogDir, 'app.log'), 'log-line', 'utf-8')
    fs.writeFileSync(path.join(mockLogDir, 'notes.txt'), 'keep-me', 'utf-8')

    const r = await clearAllLogs()
    expect(r.success).toBe(true)
    expect(r.cleared).toBe(2)
    expect(fs.existsSync(path.join(mockLogDir, 'faults-2026-07-19.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(mockLogDir, 'app.log'))).toBe(false)
    expect(fs.existsSync(path.join(mockLogDir, 'notes.txt'))).toBe(true)
  })

  it('空目录返回 cleared=0', async () => {
    const r = await clearAllLogs()
    expect(r.success).toBe(true)
    expect(r.cleared).toBe(0)
  })

  it('清空后失效 listFaults 缓存', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    await listFaults()
    // 清空
    await clearAllLogs()

    const r = await listFaults()
    expect(r).toEqual([])
  })

  it('单个文件删除失败时不影响其他文件清理', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    fs.writeFileSync(path.join(mockLogDir, 'app.log'), 'log-line', 'utf-8')

    // mock unlink 让 faults 文件删除失败，app.log 正常删除
    const realUnlink = fs.promises.unlink
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p: fs.PathLike) => {
      if (String(p).endsWith('faults-2026-07-19.jsonl')) {
        throw new Error('permission denied')
      }
      return realUnlink(p)
    })

    const r = await clearAllLogs()
    expect(r.success).toBe(true)
    expect(r.cleared).toBe(1) // 只清掉了 app.log

    unlinkSpy.mockRestore()
  })
})

// ============================================================
// describe: getLogStats
// ============================================================

describe('getLogStats', () => {
  it('空目录返回全零统计', async () => {
    const r = await getLogStats()
    expect(r.faultCount).toBe(0)
    expect(r.totalSize).toBe(0)
    expect(r.fileCount).toBe(0)
    expect(r.oldestTimestamp).toBeNull()
  })

  it('单 faults jsonl 文件返回正确行数 + 文件大小', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [
      makeFault('a', '2026-07-19T10:00:00Z'),
      makeFault('b', '2026-07-19T11:00:00Z')
    ])

    const r = await getLogStats()
    expect(r.faultCount).toBe(2)
    expect(r.fileCount).toBe(1)
    expect(r.totalSize).toBeGreaterThan(0)
    expect(r.oldestTimestamp).not.toBeNull()
  })

  it('仅 .log 文件不计入 faultCount', async () => {
    fs.writeFileSync(path.join(mockLogDir, 'app.log'), 'line1\nline2\nline3', 'utf-8')

    const r = await getLogStats()
    expect(r.faultCount).toBe(0)
    expect(r.fileCount).toBe(1)
  })

  it('多文件统计 fileCount 与 totalSize 累加', async () => {
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    fs.writeFileSync(path.join(mockLogDir, 'app.log'), 'log', 'utf-8')
    fs.writeFileSync(path.join(mockLogDir, 'other.txt'), 'ignored', 'utf-8')

    const r = await getLogStats()
    expect(r.fileCount).toBe(2) // 只统计 .log + .jsonl
    expect(r.totalSize).toBeGreaterThan(0)
  })

  it('oldestTimestamp 反映最早文件 mtime', async () => {
    const oldPath = path.join(mockLogDir, 'old.log')
    fs.writeFileSync(oldPath, 'old', 'utf-8')
    // 设置旧时间戳（1 小时前）
    const oldTime = new Date(Date.now() - 3600 * 1000)
    fs.utimesSync(oldPath, oldTime, oldTime)

    const newPath = path.join(mockLogDir, 'new.log')
    fs.writeFileSync(newPath, 'new', 'utf-8')

    const r = await getLogStats()
    expect(r.oldestTimestamp).not.toBeNull()
    const oldest = new Date(r.oldestTimestamp!).getTime()
    // 最早时间应接近 oldTime（允许 5 秒误差）
    expect(Math.abs(oldest - oldTime.getTime())).toBeLessThan(5000)
  })

  it('日志目录不存在时返回默认值', async () => {
    mockLogDir = path.join(tmpRoot, 'no-such-dir')

    const r = await getLogStats()
    expect(r.faultCount).toBe(0)
    expect(r.totalSize).toBe(0)
    expect(r.fileCount).toBe(0)
    expect(r.oldestTimestamp).toBeNull()
  })
})
