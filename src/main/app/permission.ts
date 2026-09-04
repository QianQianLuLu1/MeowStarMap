/**
 * 管理员权限提升与重启工具。
 *
 * 需求：访问 GamePlayPhotos 返回「权限不足」时，自动弹提示并请求以管理员身份重启程序；
 * 打包 manifest 已配置 requireAdministrator（package.json build.win.requestedExecutionLevel），
 * 安装版始终以管理员身份运行，从根上规避权限问题；本模块负责运行时兜底提示与重启。
 *
 * 五要素：
 * - 依赖声明：electron（app/dialog/shell）、child_process.spawn；无新增 npm 依赖。
 * - 启动说明：请求时惰性调用，不自动运行。
 * - 错误处理：提权重启失败降级为普通 relaunch；弹窗异常被 try/catch 吞掉。
 * - 参数校验：无入参。
 * - 基础测试：见 __tests__/permission.test.ts（幂等 prompt、打包/开发分支）。
 */
/* eslint-disable no-restricted-syntax -- 管理员提升提示为诊断/错误消息，无需 i18n */
import { app, dialog } from 'electron'
import { spawn } from 'child_process'
import { logger } from '../utils/logger'

// 幂等保护：单次会话只提示一次，避免扫描多个目录时重复弹窗
let prompted = false

/** 以管理员身份重启当前程序（安装版走 UAC 提升，开发版直接 relaunch） */
export async function requestAdminRelaunch(): Promise<void> {
  if (!app.isPackaged) {
    app.relaunch()
    app.quit()
    return
  }
  const exe = process.execPath
  let child: ReturnType<typeof spawn>
  try {
    // 通过 PowerShell Start-Process -Verb RunAs 触发 UAC 提升后启动新实例；
    // 以独立实参传入，避免 -Command 内字符串插值带来的引号/注入与转义问题。
    // detached + stdio:'ignore' + unref 使子进程独立于父进程事件循环，
    // 父进程 quit 后子进程仍存活并完成 UAC 提升启动新实例。
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Start-Process', '-FilePath', exe, '-Verb', 'RunAs'],
      { detached: true, windowsHide: true, stdio: 'ignore' }
    )
  } catch {
    // 同步异常（参数非法等极少情形）：降级普通重启
    app.relaunch()
    app.quit()
    return
  }
  // spawn 失败（PowerShell 被组策略禁用 / PATH 被裁剪 / 安全软件拦截）以异步
  // 'error' 事件抛出，try/catch 捕获不到；必须在此监听并降级为普通 relaunch，
  // 否则 error 事件冒泡为 uncaughtException → reportEarlyFatal → app.exit(1)，
  // 与"降级重启"的设计意图完全相反。degraded 标志防止 error 多次触发重复 relaunch。
  let degraded = false
  child.on('error', (err) => {
    if (degraded) return
    degraded = true
    logger.error('[Permission] 提权重启失败（PowerShell 不可用），降级为普通重启', err)
    app.relaunch()
    app.quit()
  })
  child.unref()
  app.quit()
}

/**
 * 弹窗提示用户以管理员身份重启；用户确认后调用 requestAdminRelaunch。
 * 已提示过则直接跳过（幂等）。
 */
export async function promptAdminRelaunch(): Promise<void> {
  if (prompted) return
  prompted = true
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '需要管理员权限',
      message: '访问游戏相册目录被拒绝（权限不足）。是否以管理员身份重启程序后重试扫描？',
      buttons: ['以管理员身份重启', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (response === 0) {
      await requestAdminRelaunch()
    }
  } catch {
    // 弹窗异常不阻断扫描主流程
  }
}

/** 仅供测试重置幂等标志 */
export function __resetPermissionPrompt(): void {
  prompted = false
}
