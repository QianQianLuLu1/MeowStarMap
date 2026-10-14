// @core-change: runtime-status 快照随 runtime-types 展平同步头注字段清单（scanner? →
//               scannerStatus?/installation?/lastScan?），无 IPC 通道与行为变更
//               （历史：sync-integration 阶段2 新增本 handler，把内嵌 NikkiSync Runtime
//               的运行时状态与协议 DTO 查询面暴露给渲染进程，零字段转换）。
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { NikkiSyncRuntimeHandle } from '../../nikkisync/runtime-types'
import { wrapHandlerNoArgs, wrapHandlerRaw } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { isAssetType } from '../../../shared/sync/protocol'

/**
 * NikkiSync 内嵌运行时只读 IPC handler（整合阶段 2）。
 *
 * - `nikkisync:runtime-status`：状态机快照（state/dbPath/linkReady/tables/scannerStatus?/installation?/lastScan?/error?/hint?）
 * - `nikkisync:start-scan`：触发上游扫描（缺省全量；带 `path` 走上游按 uid 收敛的增量；
 *   带 `gameRoot` 且与当前根不同则由状态机重建会话）
 * - `nikkisync:get-assets`：分页查询，响应体 `{items, nextCursor?, libraryRevision}` 与
 *   上游 `GET /v1/assets` 同形（游标沿用上游 base64url `{t,id}` 编码）
 * - `nikkisync:get-asset-detail`：`mapAssetDetail` 结果原样返回
 * - `nikkisync:get-resource`：`mode:'meta'` 给 `MediaResource`；`mode:'path'` 给上游落库的
 *   绝对路径原值（渲染层据此经既有 media:// 协议读取文件）
 *
 * 铁律：本文件**不做数据格式转换**，响应体逐字来自上游 `SyncReadRepository` +
 * `server/row-mappers.js`；只做参数校验与错误分类映射。
 * 错误消息为英文（src/** 中文硬编码护栏为 error），本地化由渲染层 i18n 完成。
 */

const scanSchema = z.object({
  gameRoot: z.string().trim().min(1).max(512).optional(),
  path: z.string().trim().min(1).max(1024).optional()
})

// 与上游 LocalSyncServer.listAssets 同界：limit 1..500，缺省 100
const listSchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(256).optional(),
  type: z
    .string()
    .min(1)
    .max(32)
    .refine((value) => isAssetType(value), { message: 'type is invalid' })
    .optional(),
  afterRevision: z.number().int().min(0).optional(),
  includeDeleted: z.boolean().optional()
})

const assetIdSchema = z.string().trim().min(1).max(128)

const resourceSchema = z.object({
  assetId: z.string().trim().min(1).max(128),
  resourceId: z.string().trim().min(1).max(128),
  mode: z.enum(['meta', 'path']).default('meta')
})

function requireRuntime(ctx: HandlerContext): NikkiSyncRuntimeHandle {
  if (!ctx.nikkisyncRuntime) {
    throw AppError.preconditionFailed('nikkisync runtime is not assembled yet')
  }
  return ctx.nikkisyncRuntime
}

/**
 * 上游/状态机抛出的原始错误 → IPC 错误码：
 * 「未就绪」是可恢复前置条件失败，「不存在」是 404 语义，其余归一为内部错误并保留原因。
 */
function toAppError(error: unknown, scope: string): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return AppError.notFound(`nikkisync ${scope}: ${message}`)
  if (/not ready|unavailable/i.test(message)) return AppError.preconditionFailed(message)
  return AppError.internal(`nikkisync ${scope} failed: ${message}`)
}

/** 统一「校验 + 调用 + 错误分类」的查询包装（避免五个 handler 各写一遍 try/catch）。 */
async function parseAndRun<S extends z.ZodTypeAny, R>(
  schema: S,
  raw: unknown,
  scope: string,
  run: (input: z.output<S>) => Promise<R>
): Promise<R> {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
      .join('; ')
    throw AppError.validation(`invalid nikkisync request: ${detail}`)
  }
  try {
    return await run(parsed.data)
  } catch (error) {
    throw toAppError(error, scope)
  }
}

export function registerNikkiSyncHandlers(ctx: HandlerContext): void {
  ipcMain.handle(
    'nikkisync:runtime-status',
    wrapHandlerNoArgs(ctx, () => {
      try {
        return requireRuntime(ctx).status()
      } catch (error) {
        throw toAppError(error, 'status')
      }
    })
  )

  ipcMain.handle(
    'nikkisync:start-scan',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(scanSchema, args[0], 'scan', (input) =>
        runtime.scan({
          ...(input.gameRoot === undefined ? {} : { gameRoot: input.gameRoot }),
          ...(input.path === undefined ? {} : { path: input.path })
        })
      )
    })
  )

  ipcMain.handle(
    'nikkisync:get-assets',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(listSchema, args[0], 'query', (input) =>
        runtime.listAssets({
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.afterRevision === undefined ? {} : { afterRevision: input.afterRevision }),
          ...(input.includeDeleted === undefined ? {} : { includeDeleted: input.includeDeleted })
        })
      )
    })
  )

  ipcMain.handle(
    'nikkisync:get-asset-detail',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      const parsed = assetIdSchema.safeParse(args[0])
      if (!parsed.success) {
        throw AppError.validation('invalid assetId: must be a non-empty string (<=128)')
      }
      try {
        return await runtime.getAssetDetail(parsed.data)
      } catch (error) {
        throw toAppError(error, 'query')
      }
    })
  )

  ipcMain.handle(
    'nikkisync:get-resource',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(resourceSchema, args[0], 'query', (input) =>
        runtime.getResource(input.assetId, input.resourceId, input.mode)
      )
    })
  )
}
