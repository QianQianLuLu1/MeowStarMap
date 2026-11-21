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
let mockDiagLogPath = ''
vi.mock('../utils/startup-diagnostic', () => ({
  getStartupLogPathValue: vi.fn(() => mockStartupLogPath),
  getDiagLogPathValue: vi.fn(() => mockDiagLogPath),
  logStartupError: vi.fn()
}))

// 用户面诊断目录（chromium-debug.log / diag.log 的真实落点）
let mockDiagDir = ''
vi.mock('../utils/user-diag-path', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/user-diag-path')>('../utils/user-diag-path')
  return { ...actual, getUserFacingDiagDir: vi.fn(() => mockDiagDir) }
})

// GPU 状态探针（诊断包 system-info 的 gpu 段来源；动态 import 同样被拦截）
const { collectGpuStatusMock } = vi.hoisted(() => ({ collectGpuStatusMock: vi.fn() }))
vi.mock('../app/gpu-status', () => ({ collectGpuStatus: collectGpuStatusMock }))

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
  getLogStats,
  DIAG_LOG_TAIL_BYTES
} from './log-service'
import { shell, app } from 'electron'
import { getStartupLogPathValue } from '../utils/startup-diagnostic'
// 真 logger 的目录注入缝：见下方 beforeEach 里的 setLogDirectory 用法
import { setLogDirectory } from '../utils/logger'
import {
  setForensicsEnvProvider,
  getForensicsRoot,
  FORENSICS_ROOT_FILE_NAMES
} from '../utils/forensics-dir'

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
// 取证根（install 态）：导出读取侧的单一真相源，所有取证文件落这里
let mockForensicsRoot = ''

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-log-'))
  mockLogDir = path.join(tmpRoot, 'logs')
  fs.mkdirSync(mockLogDir, { recursive: true })
  // 把真 logger 的目录钉到本次临时目录：`log-service.ts` 里有一处
  // `require('../utils/logger')`（走的是 actual 而不是本文件的 mock 桩），
  // 一旦导出链路里某个分支调 `logger.error`，`writeLog` 会 `if (!logDir) initLogger()`，
  // 而 initLogger 用 `app.getPath('userData')` = `/mock/userData` 真去 mkdir。
  // 开发机上 `\mock\userData\logs` 是盘符相对路径、建得起来（还在盘根留下垃圾目录），
  // CI 的容器里 `/` 不可写 ⇒ EACCES 直接冒成用例失败。改走注入缝，两侧都不碰盘根。
  setLogDirectory(mockLogDir)
  mockStartupLogPath = path.join(tmpRoot, 'startup-errors.log')
  fs.writeFileSync(mockStartupLogPath, '[STAGE: boot] simulated startup failure', 'utf-8')
  mockDiagDir = path.join(tmpRoot, 'diag')
  fs.mkdirSync(mockDiagDir, { recursive: true })
  // 取证环境注入 install 态：exe 在 tmpRoot\install 下 → 取证根=tmpRoot\install\Diagnostics。
  // 打包态真实布局的复现缝——此前 provider 未注册恒走回退，导出读写错位被掩盖。
  mockForensicsRoot = path.join(tmpRoot, 'install', 'Diagnostics')
  fs.mkdirSync(mockForensicsRoot, { recursive: true })
  mockDiagLogPath = path.join(mockForensicsRoot, 'diag.log')
  setForensicsEnvProvider(() => ({
    isPackaged: true,
    defaultApp: false,
    exePath: path.join(tmpRoot, 'install', 'app.exe')
  }))
  // 每个测试前失效缓存
  invalidateFaultsCache()
})

afterEach(() => {
  setForensicsEnvProvider(null)
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

  // ---------- 原生 FATAL 取证补位（2026-11-02 问题设备转储归因缺口） ----------
  //
  // 判据落点说明：这三例判「服务把哪些文件放进打包源目录」，不判 zip 字节。
  // 缘由（2026-11-02 实测归因）：archiver 在自己的模块里 `var fs = require('fs')`
  // （node_modules/archiver/lib/core.js:8），属外部化 CJS，不经过 `npm run test:ci-linux`
  // 装置的第 4 轴 fs 翻译（该失真在 tests/ci-linux.setup.ts 头注释里已显式记账）。
  // 于是装置态真跑 archiver 只会得到空包（22B 的 EOCD），而真宿主（win/linux）能正常收条目
  // ——同一断言在两侧读数不同，属装置失真而非产品缺陷。打包动作本身由
  // zip-archive.test.ts（走 createArchive 注入缝）判，两侧同样成立。

  /** 收集本次导出放进打包源目录的文件名（copyFile 的 dst 与 writeFile 的 file 两条写入路径） */
  function stagedNames(
    copySpy: { mock: { calls: unknown[][] } },
    writeSpy: { mock: { calls: unknown[][] } }
  ): string[] {
    return [
      ...copySpy.mock.calls.map((c) => path.basename(String(c[1]))),
      ...writeSpy.mock.calls.map((c) => path.basename(String(c[0])))
    ]
  }

  it('F2. 诊断包纳入 chromium-debug.log / diag.log / gpu-fallback.json', async () => {
    fs.writeFileSync(
      path.join(mockForensicsRoot, 'chromium-debug.log'),
      "[x:1101/220603.443:FATAL:gpu_data_manager_impl_private.cc:417] GPU process isn't usable.\n",
      'utf-8'
    )
    fs.writeFileSync(path.join(mockForensicsRoot, 'diag.log'), '[GPU] simulated', 'utf-8')
    fs.writeFileSync(
      path.join(mockForensicsRoot, 'gpu-fallback.json'),
      '{"compatLevel":2}',
      'utf-8'
    )
    const getPathMock = vi.mocked(app.getPath)
    getPathMock.mockImplementation((name: string) =>
      name === 'userData' ? userData : `/mock/${name}`
    )
    // 透传式 spy：不改变行为，只记录目标文件名
    const copySpy = vi.spyOn(fs.promises, 'copyFile')
    const writeSpy = vi.spyOn(fs.promises, 'writeFile')

    try {
      const target = path.join(tmpRoot, 'f2.zip')
      const r = await exportLogsAsZip(target)
      expect(r.success).toBe(true)
      expect(fs.readFileSync(target).subarray(0, 2).toString('latin1')).toBe('PK')

      const staged = stagedNames(copySpy, writeSpy)
      expect(staged).toContain('chromium-debug.log')
      expect(staged).toContain('diag.log')
      expect(staged).toContain('gpu-fallback.json')
      expect(staged).toContain('startup-errors.log') // 既有内容不得丢
      expect(staged).toContain('manifest.json')
    } finally {
      copySpy.mockRestore()
      writeSpy.mockRestore()
      getPathMock.mockImplementation((name: string) => `/mock/${name}`)
    }
  })

  it('F3. 边界：chromium-debug.log 不存在 → 导出不失败，其余文件照收', async () => {
    fs.writeFileSync(path.join(mockForensicsRoot, 'diag.log'), '[GPU] only diag', 'utf-8')
    const target = path.join(tmpRoot, 'f3.zip')
    const copySpy = vi.spyOn(fs.promises, 'copyFile')
    const writeSpy = vi.spyOn(fs.promises, 'writeFile')

    try {
      const r = await exportLogsAsZip(target)

      expect(r.success).toBe(true)
      const staged = stagedNames(copySpy, writeSpy)
      expect(staged).not.toContain('chromium-debug.log')
      expect(staged).toContain('diag.log')
    } finally {
      copySpy.mockRestore()
      writeSpy.mockRestore()
    }
  })

  it('F4. 异常：chromium-debug.log 超上限 → 只截尾部，不整文件复制', async () => {
    const big = Buffer.concat([
      Buffer.alloc(3 * 1024 * 1024, 0x61), // 3MB 旧内容（应被丢掉）
      Buffer.from('FATAL-TAIL-MARKER\n', 'utf-8')
    ])
    fs.writeFileSync(path.join(mockForensicsRoot, 'chromium-debug.log'), big)
    const writes: { dst: string; buf: Buffer }[] = []
    const realWrite = fs.promises.writeFile.bind(fs.promises)
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(async (file: unknown, data: unknown, ...rest: unknown[]) => {
        // 临时诊断目录在导出结束后会被清掉，故必须在写入发生时就把内容取出来判定
        writes.push({
          dst: String(file),
          buf: Buffer.isBuffer(data) ? data : Buffer.from(String(data))
        })
        return (realWrite as never)(file as never, data as never, ...(rest as never[]))
      })

    try {
      const target = path.join(tmpRoot, 'f4.zip')
      const r = await exportLogsAsZip(target)
      expect(r.success).toBe(true)

      const tailWrite = writes.find((w) => path.basename(w.dst) === 'chromium-debug.log')
      expect(tailWrite, '超大原生日志应走截尾写入而非 copyFile').toBeTruthy()
      expect(tailWrite!.buf.byteLength).toBeLessThanOrEqual(DIAG_LOG_TAIL_BYTES)
      // 保留的是尾部（FATAL 写在文件末尾），不是头部
      expect(tailWrite!.buf.subarray(-20).toString('latin1')).toContain('FATAL-TAIL-MARKER')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('F5. 异常：单个原生日志被占用 → 只丢那一份，.old 与 diag.log 照收', async () => {
    // 本机实况：防护软件把刚落地/历史的日志与 asar 抓成 EBUSY 是常态，不是罕见分支
    fs.writeFileSync(path.join(mockForensicsRoot, 'chromium-debug.log'), 'FATAL gpu not usable\n')
    fs.writeFileSync(path.join(mockForensicsRoot, 'chromium-debug.log.old'), 'previous run tail\n')
    fs.writeFileSync(path.join(mockForensicsRoot, 'diag.log'), '[GPU] diag\n')
    const target = path.join(tmpRoot, 'f5.zip')
    const realCopy = fs.promises.copyFile.bind(fs.promises)
    const copySpy = vi
      .spyOn(fs.promises, 'copyFile')
      .mockImplementation(async (src: unknown, dst: unknown, ...rest: unknown[]) => {
        if (path.basename(String(src)) === 'chromium-debug.log') {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        }
        return (realCopy as never)(src as never, dst as never, ...(rest as never[]))
      })
    const writeSpy = vi.spyOn(fs.promises, 'writeFile')

    try {
      const r = await exportLogsAsZip(target)

      expect(r.success).toBe(true)
      const staged = stagedNames(copySpy, writeSpy)
      // 被占用的那一份收不进来可以接受，但它后面的两份不得一起消失
      expect(staged).toContain('chromium-debug.log.old')
      expect(staged).toContain('diag.log')
    } finally {
      copySpy.mockRestore()
      writeSpy.mockRestore()
    }
  })

  // ---------- T10 花屏取证补全：GPU 段 / gpu-pref.json / manifest 如实化 ----------

  describe('诊断包取证补全（GPU 段 / gpu-pref / manifest 如实）', () => {
    const GPU_SUMMARY = {
      hwAccel: 'off(crash-fallback)',
      activeGpu: 'ANGLE (Intel, Iris Xe)',
      gpus: [{ vendor: 'Intel', device: 'Iris Xe', active: true }],
      fallback: { compatLevel: 2 },
      discrete: { mode: 'high-performance', registry: 'set' }
    }

    beforeEach(() => {
      collectGpuStatusMock.mockResolvedValue(GPU_SUMMARY)
    })

    /** 导出并捕获 writeFile 内容（临时诊断目录导出后即清理，须在写入时取内容） */
    async function exportWithCapture(target: string) {
      const writes: Array<{ dst: string; buf: Buffer }> = []
      const realWrite = fs.promises.writeFile.bind(fs.promises)
      const writeSpy = vi
        .spyOn(fs.promises, 'writeFile')
        .mockImplementation(async (file: unknown, data: unknown, ...rest: unknown[]) => {
          writes.push({
            dst: String(file),
            buf: Buffer.isBuffer(data) ? data : Buffer.from(String(data))
          })
          return (realWrite as never)(file as never, data as never, ...(rest as never[]))
        })
      const copySpy = vi.spyOn(fs.promises, 'copyFile')
      try {
        const r = await exportLogsAsZip(target)
        return { r, writes, staged: stagedNames(copySpy, writeSpy) }
      } finally {
        writeSpy.mockRestore()
        copySpy.mockRestore()
      }
    }

    function readJson(
      writes: Array<{ dst: string; buf: Buffer }>,
      name: string
    ): Record<string, unknown> | null {
      const w = writes.find((x) => path.basename(x.dst) === name)
      return w ? (JSON.parse(w.buf.toString('utf-8')) as Record<string, unknown>) : null
    }

    it('system-info.json 含 gpu 段（探针摘要原样嵌入）', async () => {
      const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'gpu.zip'))
      expect(r.success).toBe(true)
      const info = readJson(writes, 'system-info.json')
      expect(info?.gpu).toEqual(GPU_SUMMARY)
    })

    it('GPU 探针 reject ⇒ 导出仍成功且 gpu=null（fail-open）', async () => {
      collectGpuStatusMock.mockRejectedValue(new Error('gpu info unavailable'))
      const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'gpu-fail.zip'))
      expect(r.success).toBe(true)
      const info = readJson(writes, 'system-info.json')
      expect(info?.gpu).toBeNull()
    })

    it('gpu-pref.json 存在时入包', async () => {
      fs.writeFileSync(
        path.join(mockForensicsRoot, 'gpu-pref.json'),
        '{"hardwareAcceleration":false}'
      )
      const { r, staged } = await exportWithCapture(path.join(tmpRoot, 'pref.zip'))
      expect(r.success).toBe(true)
      expect(staged).toContain('gpu-pref.json')
    })

    it('manifest 如实：chromium-debug.log 缺席 ⇒ contents 不含、missing 含；diag.log 在位 ⇒ contents 含', async () => {
      fs.writeFileSync(path.join(mockForensicsRoot, 'diag.log'), '[GPU] diag', 'utf-8')
      const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'manifest-missing.zip'))
      expect(r.success).toBe(true)
      const manifest = readJson(writes, 'manifest.json')
      const contents = manifest?.contents as string[]
      const missing = (manifest?.missing as Array<{ name: string; reason: string }>).map(
        (m) => m.name
      )
      expect(contents).not.toContain('chromium-debug.log')
      expect(missing).toContain('chromium-debug.log')
      expect(contents).toContain('diag.log')
      expect(missing).not.toContain('diag.log')
    })

    it('manifest 如实：chromium-debug.log 在位 ⇒ contents 含、missing 不含', async () => {
      fs.writeFileSync(path.join(mockForensicsRoot, 'chromium-debug.log'), 'FATAL tail\n', 'utf-8')
      const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'manifest-present.zip'))
      expect(r.success).toBe(true)
      const manifest = readJson(writes, 'manifest.json')
      const contents = manifest?.contents as string[]
      const missing = (manifest?.missing as Array<{ name: string; reason: string }>).map(
        (m) => m.name
      )
      expect(contents).toContain('chromium-debug.log')
      expect(missing).not.toContain('chromium-debug.log')
    })

    // ---------- 2026-11-21 审查修复轮：logs/crashes 目录缺席登记 ----------
    //
    // 此前两段复制整段 catch {} 静默：logDir/crashDir 不可读时包内目录为空，
    // manifest 仍声称 contents 含 logs/（chromium/diag/根级文件均有 unreadable 登记，
    // 唯独最核心的主日志无声缺席）。修复：缺席不建目录，missing 如实登记。

    it('审查修复轮：logs 目录不可读 ⇒ 不建目录、missing 登记 logs/（reason=unreadable）', async () => {
      fs.writeFileSync(path.join(mockLogDir, 'app.log'), 'evidence', 'utf-8')
      const realReaddir = fs.promises.readdir.bind(fs.promises)
      const readdirSpy = vi
        .spyOn(fs.promises, 'readdir')
        .mockImplementation(async (dir: unknown, ...rest: unknown[]) => {
          if (String(dir) === mockLogDir) throw new Error('EACCES: logs dir locked')
          return (realReaddir as never)(dir as never, ...(rest as never[]))
        })
      try {
        const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'logs-locked.zip'))
        expect(r.success).toBe(true)
        const manifest = readJson(writes, 'manifest.json')
        const contents = manifest?.contents as string[]
        const missing = manifest?.missing as Array<{ name: string; reason: string }>
        expect(contents, '缺席目录不得声称在包').not.toContain('logs/')
        const logsMissing = missing.find((m) => m.name === 'logs/')
        expect(logsMissing?.reason, '主日志缺席必须可从 manifest 判定').toBe('unreadable')
      } finally {
        readdirSpy.mockRestore()
      }
    })

    it('审查修复轮：crashes 目录纳入期望清单 ⇒ 未配置崩溃目录时 missing 如实登记 absent', async () => {
      // getCrashDirectoryAsync 经 require('./crash-service') 动态装配，vitest ESM 下
      // require 抛错走 catch → null（fail-open，见 getCrashDirectoryAsync 注释）：
      // 装置里只能复现「未配置崩溃目录」形态；「已配置但不可读」形态与 logs/ 用例
      // 同构（同一代码形状），由 logs/ 用例覆盖 unreadable 分支。
      const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'crash-absent.zip'))
      expect(r.success).toBe(true)
      const manifest = readJson(writes, 'manifest.json')
      const missing = manifest?.missing as Array<{ name: string; reason: string }>
      expect(
        missing.find((m) => m.name === 'crashes/')?.reason,
        '崩溃目录缺席必须可从 manifest 判定'
      ).toBe('absent')
    })

    it('审查修复轮：截尾复制遇轮转竞态（stat 后文件缩小）⇒ 按实读字节数截断，无 NUL 填充尾巴', async () => {
      // 走 copyBounded 截尾路径：.old 原生日志 > DIAG_LOG_TAIL_BYTES
      const big = Buffer.alloc(3 * 1024 * 1024, 0x61) // 'a' 填充，便于区分 NUL
      fs.writeFileSync(path.join(mockForensicsRoot, 'chromium-debug.log.old'), big)
      // 模拟 stat 与 read 之间文件被轮转缩小：read 的 bytesRead 比 stat 少 16 字节
      const realOpen = fs.promises.open.bind(fs.promises)
      const openSpy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (file: unknown, flags: unknown, ...rest: unknown[]) => {
          const handle = (await (realOpen as never)(
            file as never,
            flags as never,
            ...(rest as never[])
          )) as fs.promises.FileHandle
          return new Proxy(handle, {
            get(target, prop, receiver) {
              if (prop === 'read') {
                return async (buf: Buffer, off: number, len: number, pos: number) => {
                  const res = await target.read(buf, off, len, pos)
                  return { ...res, bytesRead: Math.max(0, res.bytesRead - 16) }
                }
              }
              const value = Reflect.get(target, prop, receiver)
              return typeof value === 'function'
                ? (value as (...a: unknown[]) => unknown).bind(target)
                : value
            }
          })
        })
      try {
        const { r, writes } = await exportWithCapture(path.join(tmpRoot, 'shrink-race.zip'))
        expect(r.success).toBe(true)
        const tailWrite = writes.find((w) => path.basename(w.dst) === 'chromium-debug.log.old')
        expect(tailWrite, '超大原生日志应走截尾写入').toBeTruthy()
        expect(tailWrite!.buf.byteLength).toBe(DIAG_LOG_TAIL_BYTES - 16)
        expect(
          tailWrite!.buf.subarray(-16).every((b) => b === 0x61),
          '尾部 16 字节应是真实内容而非 NUL 填充'
        ).toBe(true)
      } finally {
        openSpy.mockRestore()
      }
    })
  })

  // ---------- 2026-11-17 收口补全：打包态读写同源复现 ----------
  //
  // 此前读取侧从 Documents/userData 取 chromium/diag/gpu 文件，而写入端全在取证根
  // （打包态=安装目录\Diagnostics）→ 导出包系统性缺项。provider 未注册时恒走回退，
  // 缺口被掩盖；本组用例注入 install 态复现真实打包布局。

  it('打包态复现：全部取证文件从取证根收齐，manifest 1.3 且 missing 为空', async () => {
    for (const name of FORENSICS_ROOT_FILE_NAMES) {
      fs.writeFileSync(path.join(mockForensicsRoot, name), `evidence-${name}`, 'utf-8')
    }
    fs.mkdirSync(path.join(mockForensicsRoot, 'nikkisync'), { recursive: true })
    fs.writeFileSync(
      path.join(mockForensicsRoot, 'nikkisync', 'scan-status.json'),
      '{"ok":true}',
      'utf-8'
    )
    fs.writeFileSync(path.join(mockLogDir, 'scan-log.jsonl'), '{"scan":1}', 'utf-8')

    const writes: Array<{ dst: string; buf: Buffer }> = []
    const realWrite = fs.promises.writeFile.bind(fs.promises)
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(async (file: unknown, data: unknown, ...rest: unknown[]) => {
        writes.push({
          dst: String(file),
          buf: Buffer.isBuffer(data) ? data : Buffer.from(String(data))
        })
        return (realWrite as never)(file as never, data as never, ...(rest as never[]))
      })
    const copySpy = vi.spyOn(fs.promises, 'copyFile')

    try {
      const r = await exportLogsAsZip(path.join(tmpRoot, 'install-full.zip'))
      expect(r.success).toBe(true)
      const staged = stagedNames(copySpy, writeSpy)
      for (const name of FORENSICS_ROOT_FILE_NAMES) {
        expect(staged, `打包态导出缺取证文件: ${name}`).toContain(name)
      }
      expect(staged).toContain('scan-status.json')
      expect(staged).toContain('scan-log.jsonl')
      expect(staged).toContain('startup-errors.log')

      // 暂存目录固定落取证根（不再随 logDir 漂移）
      const tmpPrefix = path.join(mockForensicsRoot, 'diagnostic-tmp-')
      expect(copySpy.mock.calls.some((c) => String(c[1]).startsWith(tmpPrefix))).toBe(true)

      const manifestWrite = writes.find((w) => path.basename(w.dst) === 'manifest.json')
      const manifest = JSON.parse(manifestWrite!.buf.toString('utf-8')) as {
        diagnosticVersion: string
        contents: string[]
        missing: Array<{ name: string; reason: string }>
      }
      expect(manifest.diagnosticVersion).toBe('1.3')
      // 审查修复轮起 crashes/ 纳入期望清单如实登记：测试环境未配置崩溃目录 ⇒ absent
      expect(manifest.missing).toEqual([{ name: 'crashes/', reason: 'absent' }])
      expect(manifest.contents).toContain('nikkisync/')

      // system-info 携带取证根与候选来源（install/fallback 可判）
      const infoWrite = writes.find((w) => path.basename(w.dst) === 'system-info.json')
      const info = JSON.parse(infoWrite!.buf.toString('utf-8')) as {
        forensics?: { root: string; source: string }
      }
      expect(info.forensics?.root).toBe(getForensicsRoot())
      expect(info.forensics?.source).toBe('install')
    } finally {
      writeSpy.mockRestore()
      copySpy.mockRestore()
    }
    // 导出结束后暂存目录必须清理，取证根不留 diagnostic-tmp-* 残留
    expect(
      fs.readdirSync(mockForensicsRoot).filter((n) => n.startsWith('diagnostic-tmp-'))
    ).toEqual([])
  })

  it('边界：nikkisync 诊断缺席 ⇒ 导出仍成功，manifest.missing 如实登记', async () => {
    const writes: Array<{ dst: string; buf: Buffer }> = []
    const realWrite = fs.promises.writeFile.bind(fs.promises)
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(async (file: unknown, data: unknown, ...rest: unknown[]) => {
        writes.push({
          dst: String(file),
          buf: Buffer.isBuffer(data) ? data : Buffer.from(String(data))
        })
        return (realWrite as never)(file as never, data as never, ...(rest as never[]))
      })
    try {
      const r = await exportLogsAsZip(path.join(tmpRoot, 'no-nikkisync.zip'))
      expect(r.success).toBe(true)
      const manifestWrite = writes.find((w) => path.basename(w.dst) === 'manifest.json')
      const manifest = JSON.parse(manifestWrite!.buf.toString('utf-8')) as {
        missing: Array<{ name: string; reason: string }>
      }
      expect(manifest.missing.map((m) => m.name)).toContain('nikkisync/')
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('R-a2：同毫秒两次导出的暂存目录必须不同（Date.now 固定复现碰撞）', async () => {
    // 暂存目录名仅用 Date.now() 时，同毫秒并发导出共用同一目录：
    // 先完成者的 cleanupTmpDir 会把后完成者正在打包的暂存整个删掉。
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const realMkdir = fs.promises.mkdir.bind(fs.promises)
    const tmpDirs: string[] = []
    const mkdirSpy = vi
      .spyOn(fs.promises, 'mkdir')
      .mockImplementation(async (p: unknown, ...rest: unknown[]) => {
        const s = String(p)
        if (
          path.dirname(s) === mockForensicsRoot &&
          path.basename(s).startsWith('diagnostic-tmp-')
        ) {
          tmpDirs.push(s)
        }
        return (realMkdir as never)(p as never, ...(rest as never[]))
      })
    try {
      const r1 = await exportLogsAsZip(path.join(tmpRoot, 'same-ms-1.zip'))
      const r2 = await exportLogsAsZip(path.join(tmpRoot, 'same-ms-2.zip'))
      expect(r1.success).toBe(true)
      expect(r2.success).toBe(true)
      expect(tmpDirs.length).toBe(2)
      expect(tmpDirs[0]).not.toBe(tmpDirs[1])
    } finally {
      mkdirSpy.mockRestore()
      nowSpy.mockRestore()
    }
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

// ============================================================
// describe: P2 诊断包 1.3 增强（feedback / filePath / fallback / highlights）
// ============================================================

describe('exportLogsAsZip — 诊断包 1.3', () => {
  interface Captured {
    dst: string
    buf: Buffer
  }

  async function exportCapture(
    target: string,
    options?: { description?: string; attachLogs?: boolean; attachSystemInfo?: boolean }
  ) {
    const writes: Captured[] = []
    const realWrite = fs.promises.writeFile.bind(fs.promises)
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(async (file: unknown, data: unknown, ...rest: unknown[]) => {
        writes.push({
          dst: String(file),
          buf: Buffer.isBuffer(data) ? data : Buffer.from(String(data))
        })
        return (realWrite as never)(file as never, data as never, ...(rest as never[]))
      })
    const copySpy = vi.spyOn(fs.promises, 'copyFile')
    try {
      const r = await exportLogsAsZip(target, options)
      const staged = [
        ...copySpy.mock.calls.map((c) => path.basename(String(c[1]))),
        ...writes.map((w) => path.basename(w.dst))
      ]
      return { r, writes, staged }
    } finally {
      writeSpy.mockRestore()
      copySpy.mockRestore()
    }
  }

  function readJson(writes: Captured[], name: string): Record<string, unknown> | null {
    const w = writes.find((x) => path.basename(x.dst) === name)
    return w ? (JSON.parse(w.buf.toString('utf-8')) as Record<string, unknown>) : null
  }

  it('成功返回 filePath = 目标路径', async () => {
    const target = path.join(tmpRoot, 'fp.zip')
    const { r } = await exportCapture(target)
    expect(r.success).toBe(true)
    expect(r.filePath).toBe(target)
  })

  it('options.description 写入 feedback.txt（含勾选值）', async () => {
    const { r, writes, staged } = await exportCapture(path.join(tmpRoot, 'fb.zip'), {
      description: '闪屏复现描述',
      attachLogs: true,
      attachSystemInfo: false
    })
    expect(r.success).toBe(true)
    expect(staged).toContain('feedback.txt')
    const fb = writes.find((w) => path.basename(w.dst) === 'feedback.txt')
    expect(fb!.buf.toString('utf-8')).toContain('闪屏复现描述')
    expect(fb!.buf.toString('utf-8')).toContain('attachSystemInfo: false')
  })

  it('边界：无 options ⇒ 不产生 feedback.txt', async () => {
    const { r, staged } = await exportCapture(path.join(tmpRoot, 'no-fb.zip'))
    expect(r.success).toBe(true)
    expect(staged).not.toContain('feedback.txt')
  })

  it('manifest 1.3：bootId 在场，missing 为 {name,reason}[] 且缺席原因如实', async () => {
    const { r, writes } = await exportCapture(path.join(tmpRoot, 'm13.zip'))
    expect(r.success).toBe(true)
    const m = readJson(writes, 'manifest.json')
    expect(m?.diagnosticVersion).toBe('1.3')
    expect(typeof m?.bootId).toBe('string')
    const missing = m?.missing as Array<{ name: string; reason: string }>
    expect(missing.find((x) => x.name === 'chromium-debug.log')?.reason).toBe('absent')
  })

  it('diag.log.old 入包（轮转历史不丢）', async () => {
    fs.writeFileSync(path.join(mockForensicsRoot, 'diag.log.old'), 'rotated-history', 'utf-8')
    const { r, staged } = await exportCapture(path.join(tmpRoot, 'diag-old.zip'))
    expect(r.success).toBe(true)
    expect(staged).toContain('diag.log.old')
  })

  it('chromium 截断 ⇒ highlights 保留头部 FATAL/exit_code 原文', async () => {
    const big = Buffer.concat([
      Buffer.from('FATAL:head-gpu exit_code=65539\n', 'utf-8'),
      Buffer.alloc(3 * 1024 * 1024, 0x61),
      Buffer.from('TAIL-MARKER\n', 'utf-8')
    ])
    fs.writeFileSync(path.join(mockForensicsRoot, 'chromium-debug.log'), big)
    const { r, writes } = await exportCapture(path.join(tmpRoot, 'hl.zip'))
    expect(r.success).toBe(true)
    const hl = writes.find((w) => path.basename(w.dst) === 'chromium-debug.highlights.txt')
    expect(hl, '截断时应生成 highlights 文件').toBeTruthy()
    expect(hl!.buf.toString('utf-8')).toContain('FATAL:head-gpu exit_code=65539')
  })

  it('应急落点收入 fallback/ 且 manifest.fallbackSources 登记来源', async () => {
    const emergDir = path.join(tmpRoot, 'emergency')
    fs.mkdirSync(emergDir, { recursive: true })
    fs.writeFileSync(path.join(emergDir, 'MeowStarMap-diag.log'), 'emerg-diag', 'utf-8')
    const appDataDir = path.join(tmpRoot, 'appdata')
    fs.mkdirSync(path.join(appDataDir, 'meow-star-map', 'logs'), { recursive: true })
    fs.writeFileSync(path.join(appDataDir, 'meow-star-map', 'logs', 'main.log'), 'emerg-main')
    const tmpSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(emergDir)
    const oldAppData = process.env.APPDATA
    process.env.APPDATA = appDataDir
    try {
      const { r, staged, writes } = await exportCapture(path.join(tmpRoot, 'fallback.zip'))
      expect(r.success).toBe(true)
      expect(staged).toContain('tmp-diag.log')
      expect(staged).toContain('appdata-main.log')
      const m = readJson(writes, 'manifest.json')
      const sources = m?.fallbackSources as Record<string, string>
      expect(sources['tmp-diag.log']).toBe(path.join(emergDir, 'MeowStarMap-diag.log'))
    } finally {
      tmpSpy.mockRestore()
      if (oldAppData === undefined) delete process.env.APPDATA
      else process.env.APPDATA = oldAppData
    }
  })

  it('nikkisync-userdata：userData/nikkisync 两 JSON 跨目录收集', async () => {
    const ud = path.join(tmpRoot, 'userData-p2')
    fs.mkdirSync(path.join(ud, 'nikkisync'), { recursive: true })
    fs.writeFileSync(path.join(ud, 'nikkisync', 'network-repair-journal.json'), '{"j":1}')
    fs.writeFileSync(path.join(ud, 'nikkisync', 'hotspot-state.json'), '{"h":1}')
    const getPathMock = vi.mocked(app.getPath)
    getPathMock.mockImplementation((name: string) => (name === 'userData' ? ud : `/mock/${name}`))
    try {
      const { r, staged } = await exportCapture(path.join(tmpRoot, 'nsud.zip'))
      expect(r.success).toBe(true)
      expect(staged).toContain('network-repair-journal.json')
      expect(staged).toContain('hotspot-state.json')
    } finally {
      getPathMock.mockImplementation((name: string) => `/mock/${name}`)
    }
  })
})
