// 全局活跃子进程注册表
// 修复：before-quit 时未 kill ffmpeg/ffprobe/PowerShell 子进程，
// 这些子进程会保持 Node.js 事件循环活跃，导致进程不退出 → 持有单实例锁 → 下次启动失败
// 维护一个全局 Set，before-quit 时统一 kill 所有活跃子进程
import type { ChildProcess } from 'child_process'

const activeProcesses = new Set<ChildProcess>()

// fluent-ffmpeg 的 command 对象内部 spawn 了 ChildProcess，但未直接暴露
// 通过 trackFfmpegCommand 注册 command 对象（具备 .kill() 方法）
interface Killable {
  kill(signal?: string): unknown
}

// P1-A2：扩展接口支持事件监听，使 trackFfmpegCommand 能自动绑定 end/error 清理
interface KillableCommand extends Killable {
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (err: unknown) => void): unknown
}

const killableCommands = new Set<Killable>()

// P1-A2：兜底清理定时器时长。子进程被 SIGKILL 强杀未触发 close/exit 事件时，
// 60 秒后强制从注册表移除，避免永久留存导致内存泄漏
const PROCESS_CLEANUP_TIMEOUT_MS = 60_000

/** 注册一个 ChildProcess，返回原对象便于链式调用 */
export function trackProcess<T extends ChildProcess>(child: T): T {
  activeProcesses.add(child)
  // A5：兜底清理定时器，在 close/exit/error 任一事件触发时清除，避免 setTimeout 持有 child 引用 60 秒
  const cleanupTimer = setTimeout(() => activeProcesses.delete(child), PROCESS_CLEANUP_TIMEOUT_MS)
  const cleanup = (): void => {
    activeProcesses.delete(child)
    clearTimeout(cleanupTimer)
  }
  child.once('close', cleanup)
  child.once('exit', cleanup)
  child.once('error', cleanup)
  return child
}

/** 注册一个 fluent-ffmpeg command（或任何具备 kill() 的对象） */
export function trackFfmpegCommand<T extends KillableCommand>(command: T): T {
  killableCommands.add(command)
  // P1-A2：自动绑定 end/error 事件清理，避免调用方遗漏 untrackFfmpegCommand
  // 注意：调用方已有的 untrackFfmpegCommand 调用保留为冗余清理，delete 不存在的值是安全的
  command.on('end', () => killableCommands.delete(command))
  command.on('error', () => killableCommands.delete(command))
  return command
}

export function untrackFfmpegCommand(command: Killable): void {
  killableCommands.delete(command)
}

/** before-quit 调用：kill 所有活跃子进程，防止进程挂起 */
export function killAllProcesses(signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const child of activeProcesses) {
    try {
      if (!child.killed) child.kill(signal)
    } catch {}
  }
  activeProcesses.clear()

  for (const cmd of killableCommands) {
    try {
      cmd.kill(signal)
    } catch {}
  }
  killableCommands.clear()
}

/** P0-6：获取活跃子进程诊断信息（用于退出诊断日志） */
export function getProcessRegistryStats(): {
  childProcessCount: number
  ffmpegCommandCount: number
} {
  return {
    childProcessCount: activeProcesses.size,
    ffmpegCommandCount: killableCommands.size
  }
}
