/**
 * G6：上游 windows-app.ts 落盘的 5 个聚合诊断文件在本仓的等价实现。
 *
 * P6（用户已明确批准反转原脱敏契约）：诊断不脱敏——绝对路径、UID、sha256、
 * 设备标识等全量原样写入，便于故障机诊断包直接定位问题；原 sanitizeAggregate
 * 脱敏层已删除，调用点直传原始聚合数据。写入失败仍是 best-effort（不中断
 * 启动/扫描），但必须返回可判定的 `{ok:false}` 而不是静默吞掉。
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
    // P6：原始聚合数据直传（不脱敏）；非对象载荷收敛为空对象，保持文件形状稳定
    const aggregate =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}
    const body = JSON.stringify({
      generatedAt: new Date().toISOString(),
      ...aggregate
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
