import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/log-service
 * @coverage listFaults / listFaultsPaged / invalidateFaultsCache / getFaultDetail /
 *           openLogDirectory / exportLogsAsZip / clearAllLogs / getLogStats
 * @dependencies electron.shell, logger(getLogDirectory + FaultRecord), crash-service, startup-diagnostic, utils/zip-archive
 * @remarks 使用真实 fs + 临时日志目录；Mock electron.shell + startup-diagnostic。
 *          导出用例断言真实 zip 产物（不再 mock 子进程）
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
    getName: vi.fn(() => 'wxnn-test'),
    getPath: vi.fn((name: string) => `/mock/${name}`)
  }
}))

// crash-service mock（被 exportLogsAsZip 动态 require）
vi.mock('./crash-service', () => ({
  getCrashDirectory: vi.fn(() => '')
}))

// startup-diagnostic mock：导出时会复制启动日志，须指向临时目录避免污染真实用户目录
let mockStartupLogPath = ''
vi.mock('../utils/startup-diagnostic', () => ({
  getStartupLogPathValue: vi.fn(() => mockStartupLogPath),
  logStartupError: vi.fn()
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
import { getStartupLogPathValue } from '../utils/startup-diagnostic'

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

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-log-'))
  mockLogDir = path.join(tmpRoot, 'logs')
  fs.mkdirSync(mockLogDir, { recursive: true })
  mockStartupLogPath = path.join(tmpRoot, 'startup-errors.log')
  fs.writeFileSync(mockStartupLogPath, '[STAGE: boot] simulated startup failure', 'utf-8')
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
  })

  it('正常：进程内打包生成非空 zip（不再依赖 tar.exe）', async () => {
    fs.writeFileSync(path.join(mockLogDir, 'app.log'), 'log-line', 'utf-8')
    writeFaultsFile('faults-2026-07-19.jsonl', [makeFault('a', '2026-07-19T10:00:00Z')])
    const target = path.join(tmpRoot, 'out.zip')

    const r = await exportLogsAsZip(target)

    expect(r.success).toBe(true)
    expect(r.message).toContain('诊断包已导出')
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
    // zip 魔数 PK
    expect(fs.readFileSync(target).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  it('正常：大写 .ZIP 扩展名也接受', async () => {
    const target = path.join(tmpRoot, 'out.ZIP')

    const r = await exportLogsAsZip(target)

    expect(r.success).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
  })

  it('正常：启动日志从 getStartupLogPathValue() 复制（路径单一真相源）', async () => {
    const r = await exportLogsAsZip(path.join(tmpRoot, 'out.zip'))

    expect(r.success).toBe(true)
    expect(getStartupLogPathValue).toHaveBeenCalled()
  })

  it('异常：目标父目录不存在时返回 success=false', async () => {
    const r = await exportLogsAsZip(path.join(tmpRoot, 'missing-dir', 'out.zip'))
    expect(r.success).toBe(false)
    expect(r.message.length).toBeGreaterThan(0)
  })

  it('边界：日志目录为空时仍导出成功（含 manifest/system-info）', async () => {
    const target = path.join(tmpRoot, 'empty.zip')

    const r = await exportLogsAsZip(target)

    expect(r.success).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
  })

  it('边界：启动日志文件不存在时导出仍成功', async () => {
    fs.rmSync(mockStartupLogPath, { force: true })
    const target = path.join(tmpRoot, 'no-startup-log.zip')

    const r = await exportLogsAsZip(target)

    expect(r.success).toBe(true)
  })

  it('边界：日志复制失败时仍导出成功（含 manifest/system-info）', async () => {
    const copySpy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValue(new Error('copy denied'))
    const target = path.join(tmpRoot, 'partial.zip')

    const r = await exportLogsAsZip(target)

    copySpy.mockRestore()
    expect(r.success).toBe(true)
    expect(fs.statSync(target).size).toBeGreaterThan(0)
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
