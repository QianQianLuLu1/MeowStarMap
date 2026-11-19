/**
 * 外壳子进程选项分层（审查修复 M5）：查询 60s、UAC 提权 300s（用户思考时间），
 * maxBuffer 统一 16MB（防火墙全量枚举 JSON 可超默认 1MB）。纯函数，供 handler 与单测共用。
 */

export type ShellExecKind = 'query' | 'elevated'

export function shellExecOptions(kind: ShellExecKind): { timeout: number; maxBuffer: number } {
  return {
    timeout: kind === 'elevated' ? 300_000 : 60_000,
    maxBuffer: 16 * 1024 * 1024
  }
}

/** 解码 EncodedCommand 判定是否 UAC 自提权包装（Start-Process powershell），决定超时档。 */
export function isElevatedScriptArgs(args: string[]): boolean {
  const idx = args.indexOf('-EncodedCommand')
  if (idx < 0 || idx + 1 >= args.length) return false
  try {
    const script = Buffer.from(args[idx + 1], 'base64').toString('utf16le')
    return /Start-Process\s+powershell/i.test(script)
  } catch {
    return false
  }
}
