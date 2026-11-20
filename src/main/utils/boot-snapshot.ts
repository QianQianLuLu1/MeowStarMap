/**
 * 启动环境快照（P4 诊断日志体系完善）——一次性记录本次运行的完整环境事实
 *
 * 依赖声明：boot-id / forensics-dir（零 electron 叶子）；node process 全局
 * 启动说明：由 index.ts whenReady 赢家路径调用一次，logger.info('[Boot] environment snapshot', …)
 * 错误处理：取证根解析失败 ⇒ 对应字段 null（fail-open），绝不向启动链冒泡
 * 参数校验：input 可选；userDataPath/appliedSwitches 缺省为 null/[]
 * 基础测试用例：boot-snapshot.test.ts（正常全字段 / 边界无入参 / 异常字段在场不抛）
 *
 * 背景：上轮闪屏排查无法确认故障机的命令行开关与环境差异——argv/开关/env 从未落日志。
 * 用户已明确授权：诊断日志不脱敏，env 全量记录（仅本次启动一条，体积可控）。
 */
import { BOOT_ID } from './boot-id'
import { getForensicsRoot, getForensicsRootSource } from './forensics-dir'

export interface BootSnapshotInput {
  userDataPath?: string
  appliedSwitches?: string[]
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

export function buildBootSnapshot(input: BootSnapshotInput = {}): Record<string, unknown> {
  return {
    bootId: BOOT_ID,
    pid: process.pid,
    argv: process.argv,
    appliedSwitches: input.appliedSwitches ?? [],
    env: { ...process.env },
    versions: { ...process.versions },
    userData: input.userDataPath ?? null,
    forensicsRoot: safe(() => getForensicsRoot()),
    forensicsSource: safe(() => getForensicsRootSource())
  }
}
