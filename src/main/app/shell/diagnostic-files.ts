/**
 * G6：上游 windows-app.ts 落盘的 5 个聚合诊断文件在本仓的等价实现。
 *
 * 只写聚合计数/阶段/白名单 code；绝不把本机绝对路径、UID、sha256、原始异常文本
 * 写进文件（交接文档明确要求诊断与分享时使用整理过的字段）。写入失败是
 * best-effort（不中断启动/扫描），但必须返回可判定的 `{ok:false}` 而不是静默吞掉。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DIAGNOSTIC_FILE_NAMES = [
  'metadata-status.json',
  'scan-status.json',
  'startup-error.log',
  'game-discovery.log',
  'startup-service-timings.json'
] as const

export type DiagnosticFileName = (typeof DIAGNOSTIC_FILE_NAMES)[number]

/** 敏感串判据：Windows/POSIX 绝对路径、纯数字 UID、64 位 hex 摘要。 */
const SENSITIVE_STRING =
  /(?:^[A-Za-z]:[\\/]|^\\\\|^\/(?:Users|home)\/|[\\/]Users[\\/]|^\d{6,20}$|^[a-fA-F0-9]{64}$)/

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return undefined
  if (typeof value === 'string') return SENSITIVE_STRING.test(value) ? undefined : value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1)).filter((item) => item !== undefined)
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const clean = sanitizeValue(item, depth + 1)
      if (clean !== undefined) out[key] = clean
    }
    return out
  }
  return undefined
}

/** 递归剔除敏感串，返回可直接 JSON 序列化的聚合对象。 */
export function sanitizeAggregate(payload: unknown): Record<string, unknown> {
  const clean = sanitizeValue(payload, 0)
  return typeof clean === 'object' && clean !== null && !Array.isArray(clean)
    ? (clean as Record<string, unknown>)
    : {}
}

export interface DiagnosticWriteResult {
  readonly ok: boolean
  readonly reason?: string
}

export interface DiagnosticFsDeps {
  writeFileSync?: (file: string, data: string) => void
  renameSync?: (from: string, to: string) => void
  unlinkSync?: (file: string) => void
}

/**
 * 原子写一个聚合诊断文件（tmp + rename）。文件名单项白名单，禁止目录穿越。
 * 任何异常都返回 `{ok:false, reason}`，调用方按需 warn，不中断主流程。
 */
export function writeAggregateDiagnostic(
  dir: string,
  name: string,
  payload: unknown,
  deps: DiagnosticFsDeps = {}
): DiagnosticWriteResult {
  if (
    typeof name !== 'string' ||
    !(DIAGNOSTIC_FILE_NAMES as readonly string[]).includes(name) ||
    name !== path.basename(name)
  ) {
    throw new Error('Invalid diagnostic name')
  }
  const write = deps.writeFileSync ?? fs.writeFileSync
  const rename = deps.renameSync ?? fs.renameSync
  const unlink = deps.unlinkSync ?? fs.unlinkSync
  const target = path.join(dir, name)
  const temp = `${target}.tmp`
  try {
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      ...sanitizeAggregate(payload)
    })
    write(temp, name.endsWith('.log') ? `${body}\n` : body)
    rename(temp, target)
    return { ok: true }
  } catch (error) {
    try {
      unlink(temp)
    } catch {
      // best-effort cleanup; the original failure is returned below.
    }
    return { ok: false, reason: error instanceof Error ? error.message : 'diagnostic write failed' }
  }
}
