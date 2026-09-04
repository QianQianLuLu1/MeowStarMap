import { ipcMain } from 'electron'
import type { HandlerContext } from '../handler-context'
import { wrapHandlerNoArgs } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { calculateFileHash } from '../../utils/file-utils'
import { pickBestId } from '../../utils/duplicate-scoring'
import { markDuplicates } from '../../services/thumbnail-phash-service'
import { MediaRepository } from '../../database/media-repository'
import { taskRegistry } from '../../utils/task-registry'
import { ProgressThrottle } from '../../utils/progress-throttle'
import { EtaCalculator } from '../../utils/eta-calculator'
import type { TaskProgress } from '../../../shared/types/progress'
import type { DuplicateItem } from '../../../shared/types/duplicate'
import { logger } from '../../utils/logger'
import { t } from '../../i18n'

/**
 * 重复检测域 IPC handler
 *
 * 覆盖：sha256 内容 hash 重复检测 / 手动重复标记 / 已标记重复分组查询。
 * findDuplicates 注册到 TaskRegistry，支持 task:cancel + 进度推送。
 */
export function registerDuplicateHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  // 数据库写操作进程拆分：传入 workerBridge 与 dbPath，写方法走独立 utilityProcess
  const getRepo = (): MediaRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new MediaRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  // F-S10：重复文件检测——基于完整 sha256 内容 hash 分组
  ipcMain.handle(
    'media:findDuplicates',
    wrapHandlerNoArgs(ctx, async () => {
      const rows = getRepo().getDuplicateCandidates()

      // 性能重构 v3 改造项三：注册到 TaskRegistry，支持 task:cancel + 进度推送
      const taskId = `duplicate-find-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const startedAt = Date.now()
      const controller = taskRegistry.register(taskId)
      const progressThrottle = new ProgressThrottle(200)
      const etaCalculator = new EtaCalculator(10)

      const pushProgress = (current: number, total: number, message: string) => {
        if (controller.signal.aborted) return
        const safeTotal = total > 0 ? total : Math.max(current, 1)
        const { etaMs, perSec } = etaCalculator.push(current, safeTotal)
        const p: TaskProgress = {
          taskId,
          taskType: 'duplicate',
          phase: 'processing',
          current,
          total: safeTotal,
          percent: Math.min(100, Math.floor((current / safeTotal) * 100)),
          processedPerSec: perSec,
          etaMs,
          message,
          startedAt,
          canCancel: true
        }
        progressThrottle.push(p)
      }

      const pushTerminal = (phase: 'done' | 'cancelled' | 'error', message: string) => {
        progressThrottle.push({
          taskId,
          taskType: 'duplicate',
          phase,
          current: 0,
          total: 0,
          percent: phase === 'done' ? 100 : 0,
          message,
          startedAt,
          canCancel: false
        })
      }

      try {
        // 第一轮：按 file_size 分组
        const sizeGroups = new Map<number, typeof rows>()
        for (const row of rows) {
          if (row.file_size <= 0) continue
          const group = sizeGroups.get(row.file_size)
          if (group) {
            group.push(row)
          } else {
            sizeGroups.set(row.file_size, [row])
          }
        }

        // 性能重构 v3：检测到取消立即返回，保留已处理结果
        if (controller.signal.aborted) {
          pushTerminal('cancelled', t('main.duplicate.message.cancelled'))
          return {
            success: true,
            duplicates: [],
            bestItemIds: [],
            totalGroups: 0,
            totalFiles: 0,
            wastedBytes: 0,
            scannedFiles: rows.length,
            cancelled: true
          }
        }

        // 第二轮：对 size 重复的组逐个计算完整 sha256
        const hashGroups = new Map<string, DuplicateItem[]>()
        const totalToHash = Array.from(sizeGroups.values()).reduce(
          (sum, g) => sum + (g.length >= 2 ? g.length : 0),
          0
        )
        let hashed = 0
        for (const group of sizeGroups.values()) {
          if (group.length < 2) continue
          for (const row of group) {
            // 取消检查：在 sha256 计算前检查（sha256 是单文件 IO，粒度合适）
            if (controller.signal.aborted) {
              pushTerminal('cancelled', t('main.duplicate.message.cancelled'))
              return {
                success: true,
                duplicates: [],
                bestItemIds: [],
                totalGroups: 0,
                totalFiles: 0,
                wastedBytes: 0,
                scannedFiles: rows.length,
                cancelled: true
              }
            }
            try {
              const hash = await calculateFileHash(row.file_path)
              const item: DuplicateItem = {
                id: row.id,
                file_path: row.file_path,
                file_name: row.file_name,
                file_type: row.file_type,
                file_size: row.file_size,
                modified_at: row.modified_at,
                width: row.width,
                height: row.height,
                is_favorite: row.is_favorite === 1,
                rating: row.rating,
                thumbnail: row.thumbnail ?? null
              }
              const hashGroup = hashGroups.get(hash)
              if (hashGroup) {
                hashGroup.push(item)
              } else {
                hashGroups.set(hash, [item])
              }
            } catch (err) {
              logger.warn(`[Duplicates] hash 计算失败，跳过: ${row.file_path}`, err)
            }
            hashed++
            // 每 5 个文件推送一次进度（progressThrottle 内部还会节流到 5 FPS）
            if (hashed % 5 === 0) {
              pushProgress(
                hashed,
                totalToHash,
                t('main.duplicate.progress.hashing', { current: hashed, total: totalToHash })
              )
            }
          }
        }
        // 尾部进度推送（保证最后状态被 UI 收到）
        pushProgress(hashed, totalToHash, t('main.duplicate.progress.hashDoneGrouping'))

        const duplicateGroups = Array.from(hashGroups.values())
          .filter((g) => g.length > 1)
          .map((group) => {
            const sorted = [...group].sort(
              (a, b) => new Date(b.modified_at).getTime() - new Date(a.modified_at).getTime()
            )
            return sorted
          })
          .sort((a, b) => b[0].file_size * (b.length - 1) - a[0].file_size * (a.length - 1))

        const bestItemIds = duplicateGroups.map((g) => pickBestId(g))

        const totalFiles = duplicateGroups.reduce((sum, g) => sum + g.length, 0)
        const wastedBytes = duplicateGroups.reduce(
          (sum, g) => sum + g[0].file_size * (g.length - 1),
          0
        )
        pushTerminal('done', t('main.duplicate.progress.done', { count: duplicateGroups.length }))
        return {
          success: true,
          duplicates: duplicateGroups,
          bestItemIds,
          totalGroups: duplicateGroups.length,
          totalFiles,
          wastedBytes,
          scannedFiles: rows.length
        }
      } finally {
        taskRegistry.unregister(taskId)
        progressThrottle.dispose()
        etaCalculator.reset()
      }
    })
  )

  // P1-01：手动触发重复标记
  ipcMain.handle(
    'media:markDuplicates',
    wrapHandlerNoArgs(ctx, async () => {
      const result = await markDuplicates(ctx)
      return { success: true, message: t('main.duplicate.message.markDone'), ...result }
    })
  )

  // P1-01：查询当前已标记的重复分组
  ipcMain.handle(
    'duplicate:listGroups',
    wrapHandlerNoArgs(ctx, async () => {
      const repo = getRepo()
      const dupRows = repo.getDuplicateGroupRows()

      // 按 original_id 聚合
      const groupMap = new Map<number, typeof dupRows>()
      for (const row of dupRows) {
        const arr = groupMap.get(row.original_id)
        if (arr) arr.push(row)
        else groupMap.set(row.original_id, [row])
      }

      // 查询每组 original_id 对应的"推荐保留"文件
      const originalIds = Array.from(groupMap.keys())
      const originalRows = repo.getOriginalsByIds(originalIds)
      const originalMap = new Map(originalRows.map((r) => [r.id, r]))

      const toDupItem = (r: (typeof originalRows)[number] | (typeof dupRows)[number]) => ({
        id: r.id,
        file_path: r.file_path,
        file_name: r.file_name,
        file_type: r.file_type,
        file_size: r.file_size,
        modified_at: r.modified_at,
        width: r.width,
        height: r.height,
        is_favorite: Boolean(r.is_favorite),
        rating: r.rating,
        thumbnail: r.thumbnail ?? null
      })

      const groups = originalIds.map((oid) => ({
        originalId: oid,
        original: originalMap.has(oid) ? toDupItem(originalMap.get(oid)!) : null,
        duplicates: (groupMap.get(oid) || []).map(toDupItem)
      }))

      return { groups, totalGroups: groups.length }
    })
  )
}
