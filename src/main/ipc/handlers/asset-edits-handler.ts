// @core-change: 阶段4 新增 asset-edits 叠加层 2 条通道（按 asset_id 列表读取 / 写入用户编辑）
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import { wrapHandler } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import {
  AssetEditsRepository,
  type AssetEditsPatch,
  type AssetEditsRow
} from '../../database/asset-edits-repository'
import type { AssetEditsInfo } from '../../../shared/types/electron-api'
import { t } from '../../i18n'

/**
 * 资产编辑叠加层 IPC handler（sync-integration 阶段 4）。
 *
 * 职责边界：`asset_edits` 存的是**本 App 专有**的用户编辑（收藏/评分/标签/备注/
 * 分类/套装/场景/隐藏），按 NikkiSync 的 `asset_id` 归键。它不属于 NikkiSync 协议
 * DTO，因此本文件**允许**塑形（0/1 → boolean、tags JSON 文本 → string[]），
 * 但字段语义必须与 `media_files` 完全同口径 —— 同一份渲染层代码要在两个数据源下
 * 读出同样的结果，否则「切换数据源」就变成「切换行为」。
 *
 * 通道命名用 kebab-case（与 handlers/AGENTS.md 的 `<domain>:<action>` 一致）。
 */

const assetIdSchema = z.string().trim().min(1).max(128)

// 与 nikkisync:get-assets 的 limit 上界同界：一次最多问一页
const listSchema = z.tuple([z.array(assetIdSchema).max(500)])

// 评分界与 `media:rate` 一致（0..5）。刻意用裸 `z` 而不是 validator 的 `schemas.rating`：
// 本文件的 schema 在模块顶层求值，而 `ipc-setup.test.ts` 对 validator 的 mock 只给了
// `wrapHandler`——引用 `schemas` 会让整条 import 链在装载期即抛（同目录 nikkisync-handler 同做法）。
const patchSchema = z.object({
  isFavorite: z.boolean().optional(),
  rating: z.number().int().min(0).max(5).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  notes: z.string().max(5000).optional(),
  categoryId: z.number().int().min(1).nullable().optional(),
  outfit: z.string().trim().max(128).nullable().optional(),
  sceneCategory: z.string().trim().max(64).nullable().optional(),
  sceneTime: z.string().trim().max(32).nullable().optional(),
  isHidden: z.boolean().optional()
})

const setSchema = z.tuple([z.object({ assetId: assetIdSchema, patch: patchSchema })])

/** tags 列的历史脏数据不能把整页列表带崩：解析失败一律降级为空数组。 */
function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

/** raw 行 → 跨进程形态（布尔折叠、蛇形转驼峰，与 media handler 同口径）。 */
function shapeRow(row: AssetEditsRow): AssetEditsInfo {
  return {
    assetId: row.asset_id,
    isFavorite: row.is_favorite === 1,
    rating: row.rating,
    tags: parseTags(row.tags),
    notes: row.notes,
    categoryId: row.category_id,
    outfit: row.outfit,
    sceneCategory: row.scene_category,
    sceneTime: row.scene_time,
    isHidden: row.is_hidden === 1,
    deletedAt: row.deleted_at,
    updatedAt: row.updated_at
  }
}

export function registerAssetEditsHandlers(ctx: HandlerContext): void {
  // 每次调用动态获取 Repository（db 可能在初始化/重连时变化）
  const getRepo = (): AssetEditsRepository => {
    const db = ctx.dbManager.getDatabase()
    if (!db) throw AppError.preconditionFailed(t('main.error.databaseNotInit'))
    return new AssetEditsRepository(db, ctx.dbManager.getWorkerBridge(), ctx.dbManager.getDbPath())
  }

  ipcMain.handle(
    'asset-edits:list',
    wrapHandler(ctx, listSchema, async ([assetIds]) => {
      if (assetIds.length === 0) return { edits: [] as AssetEditsInfo[] }
      const repo = getRepo()
      return { edits: repo.listByAssetIds(assetIds).map(shapeRow) }
    })
  )

  ipcMain.handle(
    'asset-edits:set',
    wrapHandler(ctx, setSchema, async ([{ assetId, patch }]) => {
      const repo = getRepo()
      // 写入时刻由主进程生成：渲染层不参与，避免客户端时钟漂移污染排序与冲突判定
      const payload: AssetEditsPatch = { ...patch, updatedAt: new Date().toISOString() }
      await repo.upsert(assetId, payload)
      const saved = repo.getOne(assetId)
      return { edit: saved ? shapeRow(saved) : null }
    })
  )
}
