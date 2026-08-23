import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/crash-service
 * @coverage 崩溃目录初始化/列举/统计/清理 + 进程类型解析 + 时间维度过期
 * @dependencies electron, fs
 * @remarks mock electron；使用真实 fs + 临时目录
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => path.join(os.tmpdir(), 'wxnn-crash-test-userdata', name))
  },
  shell: {
    openPath: vi.fn().mockResolvedValue('')
  }
}))

// 在 vi.mock 之后导入 electron，使 app/shell 指向 mock 实例便于断言
import { app, shell } from 'electron'

import {
  initCrashDir,
  getCrashDirectory,
  setCrashDirectory,
  listCrashes,
  getCrashStats,
  openCrashDirectory,
  clearAllCrashes,
  enforceCrashLimit
} from './crash-service'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string
let crashDir: string

function makeDump(name: string, content: Buffer = Buffer.alloc(100), mtime?: Date): void {
  const fullPath = path.join(crashDir, name)
  fs.writeFileSync(fullPath, content)
  if (mtime) fs.utimesSync(fullPath, mtime, mtime)
}

function mdmpSignature(): Buffer {
  // MDMP 签名小端序 'P' 'M' 'D' 'M' → 0x50 0x4D 0x44 0x4D
  // 但 ASCII 'MDMP' 是 0x4D 0x44 0x4D 0x50
  // 源码检测：buf.toString('ascii', 0, 4) === 'MDMP' → 字节序为 0x4D 0x44 0x4D 0x50
  return Buffer.from([0x4d, 0x44, 0x4d, 0x50, 0, 0, 0, 0])
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-crash-'))
  crashDir = path.join(tmpRoot, 'crashes')
  fs.mkdirSync(crashDir, { recursive: true })
  setCrashDirectory(crashDir)
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// ============================================================
// initCrashDir
// ============================================================

describe('initCrashDir', () => {
  it('首次调用返回设置的 crashDir 路径', () => {
    expect(initCrashDir()).toBe(crashDir)
  })

  it('目录不存在时自动创建', () => {
    // 源码：initCrashDir 仅在内部 crashDir 为 falsy 时走 app.getPath('userData') 拼接路径并创建目录
    // beforeEach 已通过 setCrashDirectory 设置内部 crashDir 为非空字符串，会导致 initCrashDir 短路返回
    // 此处用 setCrashDirectory('') 把内部 crashDir 置为 falsy，重新触发创建分支
    const freshParent = path.join(tmpRoot, 'fresh-userdata')
    const freshCrashesDir = path.join(freshParent, 'crashes')
    vi.mocked(app.getPath).mockReturnValueOnce(freshParent)
    setCrashDirectory('')
    expect(fs.existsSync(freshCrashesDir)).toBe(false)
    initCrashDir()
    expect(fs.existsSync(freshCrashesDir)).toBe(true)
  })

  it('目录已存在时不抛错', () => {
    expect(() => initCrashDir()).not.toThrow()
  })
})

// ============================================================
// getCrashDirectory
// ============================================================

describe('getCrashDirectory', () => {
  it('返回 setCrashDirectory 设置的路径', () => {
    expect(getCrashDirectory()).toBe(crashDir)
  })
})

// ============================================================
// setCrashDirectory
// ============================================================

describe('setCrashDirectory', () => {
  it('设置后 getCrashDirectory 返回新路径', () => {
    const newDir = path.join(tmpRoot, 'new-crashes')
    setCrashDirectory(newDir)
    expect(getCrashDirectory()).toBe(newDir)
  })
})

// ============================================================
// listCrashes
// ============================================================

describe('listCrashes', () => {
  it('空目录返回空数组', async () => {
    const records = await listCrashes()
    expect(records).toEqual([])
  })

  it('仅识别 .dmp/.dump/.crash 文件，跳过其他扩展名', async () => {
    makeDump('crash1.dmp', mdmpSignature())
    makeDump('crash2.dump', mdmpSignature())
    makeDump('crash3.crash', mdmpSignature())
    makeDump('meta.json', Buffer.from('{}'))
    makeDump('readme.txt', Buffer.from('text'))
    const records = await listCrashes()
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.filename).sort()).toEqual([
      'crash1.dmp',
      'crash2.dump',
      'crash3.crash'
    ])
  })

  it('解析进程类型为渲染进程', async () => {
    makeDump('xxx-1234-renderer.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].processType).toBe('renderer')
  })

  it('解析进程类型为主进程', async () => {
    makeDump('xxx-1234-main.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].processType).toBe('main')
  })

  it('解析进程类型为 GPU 进程', async () => {
    makeDump('xxx-1234-gpu.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].processType).toBe('gpu')
  })

  it('解析进程类型为工具进程', async () => {
    makeDump('xxx-1234-utility.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].processType).toBe('utility')
  })

  it('解析进程类型为插件进程', async () => {
    makeDump('xxx-1234-plugin.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].processType).toBe('plugin')
  })

  it('未知进程名返回"未知进程"', async () => {
    makeDump('xxx-1234-unknown.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].processType).toBe('unknown')
  })

  it('按 mtime 倒序排列（最新在前）', async () => {
    makeDump('old.dmp', mdmpSignature(), new Date('2026-01-01T00:00:00Z'))
    makeDump('new.dmp', mdmpSignature(), new Date('2026-07-01T00:00:00Z'))
    makeDump('mid.dmp', mdmpSignature(), new Date('2026-04-01T00:00:00Z'))
    const records = await listCrashes()
    expect(records.map((r) => r.filename)).toEqual(['new.dmp', 'mid.dmp', 'old.dmp'])
  })

  it('有效 MDMP 签名时 crashReason 为"原生崩溃（Minidump 格式）"', async () => {
    makeDump('crash.dmp', mdmpSignature())
    const records = await listCrashes()
    expect(records[0].crashReason).toBe('原生崩溃（Minidump 格式）')
  })

  it('非 MDMP 签名时 crashReason 为"未知崩溃文件格式"', async () => {
    makeDump('crash.dmp', Buffer.from('XXXX'))
    const records = await listCrashes()
    expect(records[0].crashReason).toBe('未知崩溃文件格式')
  })

  it('配套 .txt 摘要文件包含 Crash reason 时优先解析', async () => {
    makeDump('crash.dmp', Buffer.from('XXXX'))
    fs.writeFileSync(
      path.join(crashDir, 'crash.txt'),
      'Crash reason: EXCEPTION_ACCESS_VIOLATION\nTop frame: foo+0x42'
    )
    const records = await listCrashes()
    expect(records[0].crashReason).toBe('EXCEPTION_ACCESS_VIOLATION')
    expect(records[0].topFrame).toBe('foo+0x42')
  })
})

// ============================================================
// getCrashStats
// ============================================================

describe('getCrashStats', () => {
  it('空目录返回 0/0/null', async () => {
    const stats = await getCrashStats()
    expect(stats).toEqual({ fileCount: 0, totalSize: 0, oldestTime: null })
  })

  it('统计多个 dump 文件的总大小与数量', async () => {
    makeDump('a.dmp', Buffer.alloc(100))
    makeDump('b.dmp', Buffer.alloc(200))
    const stats = await getCrashStats()
    expect(stats.fileCount).toBe(2)
    expect(stats.totalSize).toBe(300)
    expect(stats.oldestTime).not.toBeNull()
  })
})

// ============================================================
// openCrashDirectory
// ============================================================

describe('openCrashDirectory', () => {
  it('shell.openPath 成功（返回空字符串）时返回 success:true', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('')
    const r = await openCrashDirectory()
    expect(r.success).toBe(true)
  })

  it('shell.openPath 失败（返回错误字符串）时返回 success:false', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Failed to open')
    const r = await openCrashDirectory()
    expect(r.success).toBe(false)
    expect(r.message).toContain('Failed to open')
  })

  it('shell.openPath 抛异常时返回 success:false 并包含错误信息', async () => {
    vi.mocked(shell.openPath).mockRejectedValueOnce(new Error('boom'))
    const r = await openCrashDirectory()
    expect(r.success).toBe(false)
    expect(r.message).toContain('boom')
  })
})

// ============================================================
// clearAllCrashes
// ============================================================

describe('clearAllCrashes', () => {
  it('删除所有 .dmp 文件并返回清理数量', async () => {
    makeDump('a.dmp')
    makeDump('b.dmp')
    makeDump('c.dmp')
    const r = await clearAllCrashes()
    expect(r.success).toBe(true)
    expect(r.cleared).toBe(3)
    expect(fs.readdirSync(crashDir)).toHaveLength(0)
  })

  it('配套 .txt 文件一并清理', async () => {
    makeDump('a.dmp')
    fs.writeFileSync(path.join(crashDir, 'a.txt'), 'summary')
    const r = await clearAllCrashes()
    expect(r.cleared).toBe(1)
    expect(fs.existsSync(path.join(crashDir, 'a.txt'))).toBe(false)
  })

  it('空目录返回 cleared:0', async () => {
    const r = await clearAllCrashes()
    expect(r.cleared).toBe(0)
  })
})

// ============================================================
// enforceCrashLimit
// ============================================================

describe('enforceCrashLimit', () => {
  it('空目录返回 evicted:0', async () => {
    const r = await enforceCrashLimit()
    expect(r.evicted).toBe(0)
  })

  it('文件数 ≤ MAX_CRASH_FILES（10）时不删除', async () => {
    // 使用相对当前时间的日期，确保不触发 30 天时间维度过期，仅验证数量维度
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      makeDump(`crash${i}.dmp`, mdmpSignature(), new Date(now - i * 24 * 60 * 60 * 1000))
    }
    const r = await enforceCrashLimit()
    expect(r.evicted).toBe(0)
  })

  it('文件数 > MAX_CRASH_FILES 时删除最旧的', async () => {
    // 所有文件均分布在最近 12 天内，确保不触发 30 天时间维度过期，仅触发数量维度
    const now = Date.now()
    for (let i = 0; i < 12; i++) {
      makeDump(`crash${i}.dmp`, mdmpSignature(), new Date(now - i * 24 * 60 * 60 * 1000))
    }
    const r = await enforceCrashLimit()
    expect(r.evicted).toBe(2) // 12 - 10 = 2
  })

  it('超过 30 天的 dump 文件被时间维度过期清理', async () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    makeDump('old.dmp', mdmpSignature(), oldDate)
    makeDump('new.dmp', mdmpSignature(), new Date())
    const r = await enforceCrashLimit()
    expect(r.evicted).toBe(1)
    expect(fs.existsSync(path.join(crashDir, 'old.dmp'))).toBe(false)
    expect(fs.existsSync(path.join(crashDir, 'new.dmp'))).toBe(true)
  })
})
