/**
 * 取证目录强制统一接线 + 历史分散残留归集迁移（2026-11-17 收口补全）。
 *
 * logDir / crashDir 不再提供自定义：本函数在启动阶段 2（DB 就绪后、initLogger /
 * crashReporter.start 之前）把日志与崩溃目录一律接到 forensics-dir 单一真相源，
 * 并把旧位置（userData\logs、userData\crashes、历史自定义值、旧 Documents 取证根、
 * userData 根的 scan-log.jsonl、userData\nikkisync 的 5 个诊断文件）的历史文件迁入。
 *
 * 迁移全部 skipExisting:true——本次启动 index.ts / exit-forensics 已写的新鲜证据
 * （chromium-debug.log / heartbeat.json 等）不得被旧文件覆盖；被占用文件 rename
 * 失败按 migrateDirFiles 既有逻辑记 failed 跳过，不阻塞启动。
 * 回退态下旧 Documents 根 == 统一根，migrateDirFiles 同路径跳过自动处理。
 */
import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import type { AppContext } from './app-context'
import {
  getForensicsRoot,
  getForensicsLogsDir,
  FORENSICS_ROOT_FILE_NAMES
} from '../utils/forensics-dir'
import { getUserFacingDiagDir } from '../utils/user-diag-path'
import { migrateDirFiles, MIGRATE_PATTERNS, ensureDir } from '../utils/dir-manager'
import { setLogDirectory, logger } from '../utils/logger'
import { setCrashDirectory } from '../services/crash-service'
import { logStartupError } from '../utils/startup-diagnostic'
import { DIAGNOSTIC_FILE_NAMES } from './shell/diagnostic-files'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function exactNamesPattern(names: readonly string[]): RegExp {
  return new RegExp(`^(?:${names.map(escapeRegExp).join('|')})$`)
}

/**
 * 历史版本写在 userData 根级的 6 个取证文件（FORENSICS_ROOT_FILE_NAMES 的子集，
 * 与 index.ts / gpu-fallback / gpu-preference / exit-forensics / single-instance 的
 * 历史写入名逐一核对）。diag.log / startup-errors.log / chromium-debug.log 历史上
 * 落 Documents 链（legacyRoot），不在 userData 根级，故不在此列。
 */
const LEGACY_USERDATA_ROOT_FILE_NAMES = [
  'gpu-fallback.json',
  'gpu-pref.json',
  'heartbeat.json',
  'last-exit.json',
  'boot-ok.marker',
  'second-instance-ack.json'
] as const

/**
 * R-a3：把 userData 根级的历史取证文件迁到取证根（skipExisting 语义，复用
 * migrateDirFiles：rename 移源、目标存在则跳过并保留源、失败 fail-open）。
 *
 * 供 index.ts 在 recordBootLevel 之前接线（首轮计划 §二#1）：升级首启时旧版
 * gpu-fallback.json 档位与 gpu-pref.json 用户偏好（显式关闭硬件加速）必须先于
 * GPU 决策到达取证根，否则被静默架空。零 electron：userData 路径经入参注入，
 * 可在模块加载期调用；幂等（二次调用源已清 / skipExisting，moved=0）。
 *
 * 注意：与 migrateDirFiles 一致为异步（fs.promises，避免阻塞事件循环），
 * 接线方须在 recordBootLevel 前 await 本函数完成。
 */
export async function migrateLegacyUserDataRoot(userDataDir: string): Promise<void> {
  try {
    if (!userDataDir) return
    const root = getForensicsRoot()
    if (userDataDir === root) return
    await migrateDirFiles(userDataDir, root, exactNamesPattern(LEGACY_USERDATA_ROOT_FILE_NAMES), {
      skipExisting: true
    })
  } catch (err) {
    logStartupError('migrateLegacyUserDataRoot', err)
  }
}

export async function unifyForensicsDirs(ctx: AppContext): Promise<void> {
  const root = getForensicsRoot()
  const logsDir = getForensicsLogsDir()
  const userData = app.getPath('userData')
  const legacyRoot = getUserFacingDiagDir()
  const opts = { skipExisting: true }

  try {
    ensureDir(root)
    ensureDir(logsDir)

    // R-a1：迁移前先判定「新根心跳在位」——必须是本次启动已写的新鲜证据，
    // 不能把下方白名单迁入的陈旧心跳误当新鲜信号（迁移后判定会毒化保护边界）
    const freshHeartbeatInPlace = fs.existsSync(path.join(root, 'heartbeat.json'))

    const legacyLogDir = ctx.dbManager.getSetting<string>('logDir', '')
    const legacyCrashDir = ctx.dbManager.getSetting<string>('crashDir', '')
    let moved = 0
    const tally = (r: { moved: number }): void => {
      moved += r.moved
    }

    // 日志类 → root\logs
    tally(
      await migrateDirFiles(path.join(userData, 'logs'), logsDir, MIGRATE_PATTERNS.logDir, opts)
    )
    if (legacyLogDir) {
      tally(await migrateDirFiles(legacyLogDir, logsDir, MIGRATE_PATTERNS.logDir, opts))
    }
    tally(
      await migrateDirFiles(path.join(legacyRoot, 'logs'), logsDir, MIGRATE_PATTERNS.logDir, opts)
    )
    tally(await migrateDirFiles(userData, logsDir, /^scan-log\.jsonl$/, opts))

    // 崩溃 dump → root（与 index.ts 早期 app.setPath('crashDumps', root) 同落点）
    tally(
      await migrateDirFiles(path.join(userData, 'crashes'), root, MIGRATE_PATTERNS.crashDir, opts)
    )
    if (legacyCrashDir) {
      tally(await migrateDirFiles(legacyCrashDir, root, MIGRATE_PATTERNS.crashDir, opts))
    }
    tally(await migrateDirFiles(legacyRoot, root, MIGRATE_PATTERNS.crashDir, opts))

    // 根级取证文件白名单（仅文件名精确匹配，不误收其他文件）
    tally(
      await migrateDirFiles(legacyRoot, root, exactNamesPattern(FORENSICS_ROOT_FILE_NAMES), opts)
    )

    // NikkiSync 仅 5 个聚合诊断文件 → root\nikkisync（nikkisync.db 等数据文件绝不迁移）
    tally(
      await migrateDirFiles(
        path.join(userData, 'nikkisync'),
        path.join(root, 'nikkisync'),
        exactNamesPattern(DIAGNOSTIC_FILE_NAMES),
        opts
      )
    )

    // R-a1：install 态（root!==legacyRoot）且新根新鲜心跳在位 → 清除旧根被
    // skipExisting 保留的陈旧死亡证据。否则日后安装目录 ACL 变化回落 fallback 态
    // （根==legacyRoot）时，模块加载期 recordBootLevel 会读到陈旧心跳（pid 已死 +
    // last-exit 缺失/不匹配）误判 native → GPU 阶梯白升档且 fallbackActive 持久化。
    // 死亡证据是瞬态取证文件（非用户数据）；逐文件 fail-open，不阻塞启动。
    // 同路径（root===legacyRoot）分支绝不删：旧根即统一根本体。
    if (root !== legacyRoot && freshHeartbeatInPlace) {
      for (const name of ['heartbeat.json', 'last-exit.json']) {
        try {
          fs.rmSync(path.join(legacyRoot, name), { force: true })
        } catch {
          // 删除失败（占用/权限）不影响启动；残留最多延迟到下次迁移再清
        }
      }
    }

    if (moved > 0) {
      logger.info(`[Forensics] 历史取证文件归集 ${moved} 个到 ${root}`)
    }

    // 清键：历史自定义值已作迁移源消费完毕；统一目录每次由 forensics-dir 现算，
    // 绝不把解析结果写回 settings（install↔fallback 切换时会与现算根分叉）
    ctx.dbManager.setSetting('logDir', '')
    ctx.dbManager.setSetting('crashDir', '')
  } catch (err) {
    logStartupError('unifyForensicsDirs.migrate', err)
  }

  // 接线独立于迁移成败：即使迁移失败，日志/崩溃目录也必须统一到取证根
  try {
    setLogDirectory(logsDir)
    app.setPath('crashDumps', root)
    setCrashDirectory(root)
  } catch (err) {
    logStartupError('unifyForensicsDirs.wire', err)
  }
}
