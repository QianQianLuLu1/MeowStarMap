import { describe, expect, it } from 'vitest'
import { shellExecOptions, isElevatedScriptArgs } from './shell-exec'

const b64 = (script: string): string => Buffer.from(script, 'utf16le').toString('base64')
const argsOf = (script: string): string[] => [
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  b64(script)
]

describe('shell-exec 子进程选项（M5：超时/缓冲分层）', () => {
  it('查询 60s、提权 300s（UAC 用户思考时间）、maxBuffer 统一 16MB', () => {
    expect(shellExecOptions('query')).toEqual({ timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    expect(shellExecOptions('elevated')).toEqual({ timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
  })
  it('isElevatedScriptArgs：Start-Process 包装 ⇒ elevated，普通脚本 ⇒ query', () => {
    expect(isElevatedScriptArgs(argsOf('Start-Process powershell.exe -Verb RunAs -Wait'))).toBe(
      true
    )
    expect(isElevatedScriptArgs(argsOf('Get-NetFirewallRule | ConvertTo-Json'))).toBe(false)
  })
  it('边界：空 args / 非 EncodedCommand 形态 / 畸形 base64 ⇒ query 不抛', () => {
    expect(isElevatedScriptArgs([])).toBe(false)
    expect(isElevatedScriptArgs(['-Command', 'Get-Date'])).toBe(false)
    expect(isElevatedScriptArgs(['-EncodedCommand', '!!!not-base64!!!'])).toBe(false)
  })
})
