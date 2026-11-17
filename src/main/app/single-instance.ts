/**
 * 单实例锁获取与失败路径处理（R1，2026-11-15 从 lifecycle.ts 前移）
 *
 * 为什么前移：原先锁在 bootstrapApplication 内（index.ts 动态 import Application +
 * 构造 16 个服务之后）才获取。慢机/杀软扫描首实例的数秒加载窗口内，用户第二次双击的
 * 实例可能抢先拿到锁——首实例反被判为「已有实例运行」（实例角色颠倒），且失败实例
 * 会白白加载全部重模块、并继续执行 initialize() 完成段写共享 userData 的
 * boot-ok.marker（污染诊断标记）。现在锁获取发生在 index.ts whenReady 首行、
 * 动态 import 之前，本模块保持轻量依赖（不 import application/lifecycle 链）。
 *
 * 失败路径行为与迁移前逐行等价（F1-F6 各轮修复全部保留）：
 * - 6×1s 重试（F4）：覆盖 before-quit 清理期 DB WAL checkpoint 耗时（2-5s）
 * - 三选项对话框：清理并重启（taskkill /F /T 递归杀 + F3 清死亡证据 + relaunch）/
 *   手动处理（任务管理器）/ 退出
 * - 对话框抛错 → showStartupFailureWithFallback 可见兜底（N3）
 * - 全程零启动打点（F2+F5 赢家专属约束：不碰 gpu-fallback.json / heartbeat.json）
 *
 * B（2026-11-15）：ack 静默让位——健康赢家（运行中/启动中）响应 second-instance 时写
 * 存活标记；输家 6 次重试耗尽后检测到新鲜标记即 app.quit 静默退出，不再弹
 * 「已有实例运行」（修复：窗口已聚焦却又弹报错 = 用户感知异常；慢启动下用户点
 * 「清理并重启」会误杀健康启动实例）。僵尸/挂死进程不写标记 → 三选项框路径不变。
 * 不能在重试期内提前让位：ack 无法区分「健康运行」与「before-quit 退出途中」，
 * 提前退出会破坏 F4「关闭后立即重开」；重试耗尽后锁仍未释放才说明赢家不在退出流程。
 */
import { app, dialog } from 'electron'
import fs from 'fs'
import path from 'path'
import { execFileSync, exec } from 'child_process'
import { t } from '../i18n'
import { diagLog, logStartupError } from '../utils/startup-diagnostic'
import { getForensicsFilePath } from '../utils/forensics-dir'
import { showStartupFailureWithFallback } from './native-load-guard'
import { clearDeathEvidenceForRelaunch } from './exit-forensics'

/** ack 新鲜窗口：覆盖输家 6s 重试 + 对话框调度余量（检查时 age 上限） */
const ACK_FRESH_MS = 15_000
/** 时钟异常保护：ts 晚于当前时间超过该容差视为非法（同机时钟一致，仅防异常） */
const ACK_FUTURE_TOLERANCE_MS = 1_000

function secondInstanceAckPath(): string {
  return getForensicsFilePath('second-instance-ack.json')
}

/**
 * 赢家在 second-instance 事件入口写存活标记（pid 仅供诊断，不参与判定）。
 * fail-open：写失败只影响输家的静默让位判定（退回三选项框），不影响窗口聚焦。
 */
export function writeSecondInstanceAck(): void {
  try {
    fs.writeFileSync(secondInstanceAckPath(), JSON.stringify({ pid: process.pid, ts: Date.now() }))
  } catch {
    // 写失败静默：输家将走既有三选项对话框路径
  }
}

/**
 * G1-F5（审查修复轮）：赢家进入退出流程（before-quit）时删除 ack。
 * 慢退场景（清理总时长 >6s 重试窗）输家不得再按新鲜 ack 静默让位——
 * 否则赢家随后退出，双双消失无提示。删除后输家回退三选项框。fail-open。
 */
export function clearSecondInstanceAck(): void {
  try {
    fs.rmSync(secondInstanceAckPath(), { force: true })
  } catch {
    // 删除失败最坏回退既有 15s 新鲜度判定
  }
}

/**
 * 输家在重试耗尽后判定赢家是否「存活且刚响应」：ack 新鲜 ⇒ 赢家事件循环正在
 * 处理 second-instance（健康运行/启动中）。全部 fail-open：文件缺失/读抛错/
 * JSON 损坏/字段非法/未来时间一律视为无新鲜 ack。
 */
function hasFreshSecondInstanceAck(): boolean {
  try {
    const raw = fs.readFileSync(secondInstanceAckPath(), 'utf8')
    const parsed = JSON.parse(raw) as { ts?: unknown }
    if (typeof parsed?.ts !== 'number' || !Number.isFinite(parsed.ts)) return false
    const now = Date.now()
    if (parsed.ts > now + ACK_FUTURE_TOLERANCE_MS) return false
    return now - parsed.ts <= ACK_FRESH_MS
  } catch {
    return false
  }
}

/**
 * 获取单实例锁；失败时（6 次重试后）走「已有实例运行」三选项对话框流程。
 *
 * @returns true = 当前进程是赢家（持有锁），调用方继续启动主流程；
 *          false = 已走完失败路径（对话框交互 + quit/relaunch 已排程），调用方必须立即早退
 */
export async function acquireSingleInstanceLockOrHandleFailure(): Promise<boolean> {
  // 单实例锁：防止多实例并发操作同一 SQLite 数据库导致竞争
  let gotLock = app.requestSingleInstanceLock()
  diagLog('BOOT', 'requestSingleInstanceLock returned: ' + gotLock)
  if (!gotLock) {
    // P0 修复：旧实例可能正在 before-quit 清理流程中（DB WAL checkpoint 耗时 2-5s），
    // 锁尚未释放。等待 1s 后重试，避免频繁弹出"已有实例运行"对话框。
    // 场景：用户关闭应用后立即重新打开，旧进程仍在 cleanup 中持锁。
    // F4（2026-11-15）：重试 3 次（3s）短于上述清理耗时 2-5s，正常"关闭后立即重开"
    // 也会误弹对话框，用户点"清理并重启"会 taskkill 掉正在正常退出的健康实例。
    // 改为最多 6 次（6s），完整覆盖 5s 强制退出兜底 + 命名互斥量释放延迟。
    for (let retry = 0; retry < 6 && !gotLock; retry++) {
      diagLog('BOOT', `retry ${retry + 1}/6 waiting 1s for lock...`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      gotLock = app.requestSingleInstanceLock()
      diagLog('BOOT', `retry ${retry + 1} gotLock=` + gotLock)
    }
  }
  if (!gotLock) {
    // B（2026-11-15）：重试耗尽后先看赢家是否刚响应过 second-instance——
    // 新鲜 ack = 赢家事件循环活着（健康运行/启动中），静默让位不弹框。
    if (hasFreshSecondInstanceAck()) {
      diagLog('BOOT', 'fresh second-instance ack: winner alive, yielding silently without dialog')
      app.quit()
      return false
    }
    // P0-5：已有实例运行（可能是僵尸进程持锁），提供三选项对话框
    // 修复：原实现静默退出，用户完全不知道为何软件没启动
    // 改用 showMessageBox 提供"清理并重启 / 手动处理 / 退出"三个选项
    diagLog('BOOT', '!gotLock branch: awaiting app.whenReady() before dialog')
    await app.whenReady()
    diagLog('BOOT', '!gotLock branch: app.whenReady() ok, showing dialog')
    try {
      // 诊断：记录 i18n 文本是否成功获取（i18n 在此阶段可能未初始化）
      const titleText = t('main.dialog.instanceRunning.title')
      const msgText = t('main.dialog.instanceRunning.message')
      diagLog('BOOT', `!gotLock dialog i18n: title="${titleText}" msg="${msgText}"`)
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: titleText,
        message: msgText,
        detail: t('main.dialog.instanceRunning.detail'),
        buttons: [
          t('main.dialog.instanceRunning.cleanupButton'),
          t('main.dialog.instanceRunning.manualButton'),
          t('main.dialog.instanceRunning.exitButton')
        ],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      diagLog('BOOT', `!gotLock dialog response: ${result.response}`)

      if (result.response === 0) {
        // 清理并重启：结束除当前进程外的所有同名进程，然后重启
        // 修复1：原 wmic 在 Win11 24H2+ 已移除，回退分支 taskkill /F /IM 会杀死自己
        // 修复2：中文进程名在 PowerShell 5.1 -Command 模式下编码错误，改用 -EncodedCommand
        // 修复3：taskkill 不带 /T 无法杀死 crashpad_handler 子进程，子进程可能持锁
        //        改用 taskkill /F /T /PID 递归杀整个进程树
        // 修复4：延长等待到 2000ms，给 OS 更多时间释放 named mutex
        const appName = path.basename(app.getPath('exe'))
        const currentPid = process.pid
        let killedAny = false
        try {
          // 用 -EncodedCommand 避免 PowerShell 5.1 的中文编码问题
          const psCommand = `Get-CimInstance Win32_Process -Filter "Name='${appName}'" | Where-Object { $_.ProcessId -ne ${currentPid} } | Select-Object -ExpandProperty ProcessId`
          const encoded = Buffer.from(psCommand, 'utf16le').toString('base64')
          const output = execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 10000
          })
          const pids = output
            .split('\n')
            .map((line: string) => line.trim())
            .filter((p: string) => /^\d+$/.test(p))
            .map((p: string) => parseInt(p, 10))

          for (const pid of pids) {
            try {
              // /T 递归杀整个进程树（含 crashpad_handler 等子进程）
              execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
                windowsHide: true,
                timeout: 10000
              })
              killedAny = true
            } catch {
              // 单个进程杀失败忽略（可能已自行退出）
            }
          }
        } catch {
          // 回退：用 -EncodedCommand 调用 Stop-Process，排除当前 PID
          try {
            const psCommand2 = `Get-Process -Name '${appName.replace('.exe', '')}' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne ${currentPid} } | Stop-Process -Force`
            const encoded2 = Buffer.from(psCommand2, 'utf16le').toString('base64')
            execFileSync('powershell', ['-NoProfile', '-EncodedCommand', encoded2], {
              windowsHide: true,
              timeout: 10000
            })
            killedAny = true
          } catch {
            // 两种方案都失败，跳过杀进程，直接重启（新实例会再次尝试获取锁）
          }
        }
        // 等待旧进程完全退出后重启
        // 修复：延长到 2000ms，给 OS 足够时间释放 named mutex 和清理子进程
        // P1 修复：若 taskkill 未杀死任何进程（killedAny=false），不重启
        // 避免新实例再次拿不到锁 → 再次弹窗 → 用户再点"清理并重启" → 无限循环
        if (!killedAny) {
          try {
            await dialog
              .showMessageBox({
                type: 'warning',
                title: t('main.dialog.cleanupFailed.title'),
                message: t('main.dialog.cleanupFailed.message'),
                detail: t('main.dialog.cleanupFailed.detail'),
                buttons: [
                  t('main.dialog.cleanupFailed.openTaskManager'),
                  t('main.dialog.instanceRunning.exitButton')
                ],
                defaultId: 0,
                cancelId: 1,
                noLink: true
              })
              .then((r) => {
                if (r.response === 0) {
                  // 必须显式挂 error 监听：exec 返回的子进程无 error 监听时，
                  // spawn 失败（如 taskmgr 被组策略禁用）会冒泡成 uncaughtException
                  // → 假「启动失败 / 程序已退出」弹窗
                  try {
                    exec('taskmgr', { windowsHide: false }).on('error', (e) => {
                      logStartupError('exec-taskmgr', e)
                    })
                  } catch {}
                }
              })
          } catch (err) {
            // 清理失败框自身抛错时仍要有一次可见提示，绝不静默退出
            showStartupFailureWithFallback(err, {
              stage: 'cleanup-failed-dialog-fallback'
            })
          }
          app.quit()
          return false
        }
        setTimeout(() => {
          // F3（2026-11-15）：重启前清掉被杀进程留下的陈旧心跳——否则 relaunch 后的
          // 新实例会把这次主动杀进程误判成"被原生层杀死"，GPU 兼容阶梯白升一档
          clearDeathEvidenceForRelaunch()
          // 当前进程没有锁（gotLock=false），但安全起见仍尝试释放
          try {
            app.releaseSingleInstanceLock?.()
          } catch {}
          app.relaunch()
          app.exit(0)
        }, 2000)
        return false
      } else if (result.response === 1) {
        // 手动处理：打开任务管理器
        // 同上：必须挂 error 监听，避免 spawn 失败冒泡为 uncaughtException
        try {
          exec('taskmgr', { windowsHide: false }).on('error', (e) => {
            logStartupError('exec-taskmgr', e)
          })
        } catch {}
      }
    } catch (err) {
      // 对话框显示失败时记录到诊断日志，并再尝试一次不依赖 i18n 的可见兜底
      logStartupError('gotLock-false-dialog', err)
      showStartupFailureWithFallback(err, { stage: 'gotLock-false-dialog-fallback' })
    }
    app.quit()
    return false
  }
  return true
}
