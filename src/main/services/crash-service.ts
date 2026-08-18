import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app, shell } from 'electron'

// T13：崩溃 dump 文件保留份数上限（建议 ≤ 20 份，避免磁盘占用膨胀）
// P2-2：从 20 调整为 10（够用且节省空间）
const MAX_CRASH_FILES = 10
// P2-2：dump 文件时间维度过期（30 天），超过自动清理
const MAX_CRASH_AGE_MS = 30 * 24 * 60 * 60 * 1000

// T13：崩溃记录元信息（不读 dump 二进制内容，仅展示文件信息）
// P2-1：新增 crashReason / topFrame 字段（从 minidump 头部解析或配套 .txt 读取）
export interface CrashRecord {
  filename: string
  filePath: string
  size: number
  mtime: string
  // 从文件名解析的进程类型（renderer / main / gpu 等）
  processType: string
  // P2-1：崩溃原因（从配套 .txt 摘要或 dump 文件头解析，可能为空）
  crashReason?: string
  // P2-1：顶层调用栈帧（解析失败的 dump 此字段为空）
  topFrame?: string
}

let crashDir: string | null = null

/**
 * T13：初始化崩溃目录，返回路径
 * 必须在 app.whenReady 之后调用（依赖 app.getPath('userData')）
 * 自定义目录：applyCustomDirectories 已通过 setCrashDirectory 设置最终路径
 */
export function initCrashDir(): string {
  if (crashDir) return crashDir
  crashDir = path.join(app.getPath('userData'), 'crashes')
  try {
    fs.mkdirSync(crashDir, { recursive: true })
  } catch {
    // 目录创建失败不抛错，后续操作会回退到空列表
  }
  return crashDir
}

/**
 * T13：获取崩溃目录路径
 */
export function getCrashDirectory(): string {
  if (!crashDir) initCrashDir()
  return crashDir as string
}

/**
 * 自定义目录支持：设置崩溃目录路径
 * 必须在 initCrashDir() 之前调用（由 applyCustomDirectories 触发）
 * 注意：crashReporter 实际写入路径由 app.setPath('crashDumps') 控制，
 * 此函数仅设置 crash-service 读取/列举 dump 文件的目录，两者需保持一致
 */
export function setCrashDirectory(dir: string): void {
  crashDir = dir
}

/**
 * T13：从崩溃 dump 文件名解析进程类型
 * Electron crashpad 文件名格式通常为 `xxx-<pid>-renderer.dmp` 或 `xxx-<pid>-main.dmp`
 */
function parseProcessType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.includes('renderer')) return '渲染进程'
  if (lower.includes('main')) return '主进程'
  if (lower.includes('gpu')) return 'GPU 进程'
  if (lower.includes('utility')) return '工具进程'
  if (lower.includes('plugin')) return '插件进程'
  return '未知进程'
}

/**
 * P2-1：解析 minidump 文件头获取崩溃原因和顶层调用栈
 *
 * Minidump 文件格式（参考 google-breakpad）：
 *   - 前 4 字节：签名 'MDMP' (0x504D444D)
 *   - 4-5 字节：版本
 *   - 6-7 字节：流数量
 *   - 8-11 字节：流目录 RVA
 *   - 后续为各种流（SystemInfo / Thread / Module / Exception 等）
 *
 * 完整解析需引入 minidump-stackwalk 等重量级库，此处仅做轻量解析：
 *   1. 优先尝试读取配套的 .txt 摘要文件（Crashpad 在 dump 旁边生成）
 *   2. 解析 dump 文件头验证有效性（签名检查）
 *   3. 解析失败时返回 undefined，UI 显示"无法解析"
 *
 * 业务决策：不引入 minidump-stackwalk 等依赖，避免打包体积膨胀和跨平台问题
 */
async function parseCrashDump(
  filePath: string
): Promise<{ crashReason?: string; topFrame?: string }> {
  const result: { crashReason?: string; topFrame?: string } = {}

  // 1. 优先读取配套 .txt 摘要文件（Crashpad 自动生成）
  // 文件名规则：xxx.dmp → xxx.txt 或 xxx.dmp.txt
  try {
    const txtPath1 = filePath.replace(/\.dmp$/i, '.txt')
    const txtPath2 = filePath + '.txt'
    for (const txtPath of [txtPath1, txtPath2]) {
      try {
        const content = await fsp.readFile(txtPath, 'utf-8')
        // Crashpad 摘要文件通常包含 "Crash reason:" 等关键行
        const reasonMatch = content.match(/Crash reason:\s*(.+)/i)
        if (reasonMatch) {
          result.crashReason = reasonMatch[1].trim()
        }
        const frameMatch =
          content.match(/Top frame:\s*(.+)/i) || content.match(/Frame 0[^\n]*\n\s*(.+)/i)
        if (frameMatch) {
          result.topFrame = frameMatch[1].trim().slice(0, 200)
        }
        if (result.crashReason || result.topFrame) return result
        break // 找到 txt 但无关键字，跳过 dump 头解析
      } catch {
        // 该路径 .txt 不存在，尝试下一个
      }
    }
  } catch {}

  // 2. 解析 dump 文件头验证签名（仅校验是否为有效 minidump）
  try {
    const fd = await fsp.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(4)
      await fd.read(buf, 0, 4, 0)
      // MDMP 签名：0x504D444D（小端序 'P' 'M' 'D' 'M'）
      if (buf.toString('ascii', 0, 4) === 'MDMP') {
        if (!result.crashReason) result.crashReason = '原生崩溃（Minidump 格式）'
      } else {
        result.crashReason = '未知崩溃文件格式'
      }
    } finally {
      await fd.close()
    }
  } catch {
    // dump 文件读取失败，不影响列表展示
  }

  return result
}

/**
 * T13：列出所有崩溃记录（按修改时间倒序）
 * P2-1：每条记录尝试解析 dump 头获取 crashReason / topFrame
 */
export async function listCrashes(): Promise<CrashRecord[]> {
  const dir = getCrashDirectory()
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const records: CrashRecord[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    // 仅识别 .dmp / .dump / .crash 等崩溃文件，跳过 crashpad 自身的元数据文件
    const ext = path.extname(entry.name).toLowerCase()
    if (!['.dmp', '.dump', '.crash'].includes(ext)) continue
    const fullPath = path.join(dir, entry.name)
    try {
      const stat = await fsp.stat(fullPath)
      const record: CrashRecord = {
        filename: entry.name,
        filePath: fullPath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        processType: parseProcessType(entry.name)
      }
      // P2-1：解析 dump 获取崩溃原因（失败不影响列表展示）
      try {
        const parsed = await parseCrashDump(fullPath)
        record.crashReason = parsed.crashReason
        record.topFrame = parsed.topFrame
      } catch {
        // 解析失败时 record.crashReason 留空，UI 显示"无法解析"
      }
      records.push(record)
    } catch {
      // 文件被并发删除等情况下跳过
    }
  }

  // 按修改时间倒序
  records.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return records
}

/**
 * T13：获取崩溃目录统计信息
 */
export async function getCrashStats(): Promise<{
  fileCount: number
  totalSize: number
  oldestTime: string | null
}> {
  const records = await listCrashes()
  const totalSize = records.reduce((sum, r) => sum + r.size, 0)
  const oldestTime = records.length > 0 ? records[records.length - 1].mtime : null
  return {
    fileCount: records.length,
    totalSize,
    oldestTime
  }
}

/**
 * T13：打开崩溃目录（系统资源管理器）
 */
export async function openCrashDirectory(): Promise<{ success: boolean; message: string }> {
  try {
    const result = await shell.openPath(getCrashDirectory())
    // shell.openPath 失败时返回错误字符串，成功时返回空字符串
    if (result) {
      return { success: false, message: `无法打开目录: ${result}` }
    }
    return { success: true, message: '已打开崩溃目录' }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * T13：清空所有崩溃记录
 */
export async function clearAllCrashes(): Promise<{
  success: boolean
  cleared: number
  message: string
}> {
  const records = await listCrashes()
  let cleared = 0
  for (const record of records) {
    try {
      await fsp.unlink(record.filePath)
      cleared++
      // P2-1：同时清理配套 .txt 摘要文件
      const txtPath = record.filePath.replace(/\.dmp$/i, '.txt')
      if (txtPath !== record.filePath) {
        try {
          await fsp.unlink(txtPath)
        } catch {}
      }
    } catch {
      // 文件已被删除或权限不足，跳过
    }
  }
  return {
    success: true,
    cleared,
    message: `已清理 ${cleared} 个崩溃记录`
  }
}

/**
 * T13：限制崩溃文件数量，超出上限时删除最旧的
 * 应在应用启动时调用，避免崩溃目录无限膨胀
 * P2-2：新增时间维度过期清理（30 天）
 */
export async function enforceCrashLimit(): Promise<{ evicted: number }> {
  const records = await listCrashes()
  if (records.length === 0) return { evicted: 0 }

  const now = Date.now()
  const toDelete: CrashRecord[] = []

  // 1. 时间维度过期：超过 30 天的 dump 直接删除
  for (const record of records) {
    const age = now - new Date(record.mtime).getTime()
    if (age > MAX_CRASH_AGE_MS) {
      toDelete.push(record)
    }
  }

  // 2. 数量维度：超过 MAX_CRASH_FILES 的删除最旧的
  // 先过滤掉已被时间维度选中的，避免重复
  const remaining = records.filter((r) => !toDelete.includes(r))
  if (remaining.length > MAX_CRASH_FILES) {
    // records 已按时间倒序，末尾是最旧的
    toDelete.push(...remaining.slice(MAX_CRASH_FILES))
  }

  let evicted = 0
  for (const record of toDelete) {
    try {
      await fsp.unlink(record.filePath)
      evicted++
      // P2-1：同时清理配套 .txt 摘要文件
      const txtPath = record.filePath.replace(/\.dmp$/i, '.txt')
      if (txtPath !== record.filePath) {
        try {
          await fsp.unlink(txtPath)
        } catch {}
      }
    } catch {
      // 跳过
    }
  }
  return { evicted }
}
