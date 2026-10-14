// @core-change: sync-integration 阶段4：新增批量资源/增量变更/套装服装搜索/档案统计 5 条只读通道
//               （历史：阶段2 建成本 handler 的状态与协议 DTO 查询面，阶段3 增同步服务 6 条；
//               三个阶段都只增通道，本文件始终零字段转换）。
import { ipcMain } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { NikkiSyncRuntimeHandle } from '../../nikkisync/runtime-types'
import { wrapHandlerNoArgs, wrapHandlerRaw } from '../validator'
import { AppError } from '../../../shared/errors/app-error'
import { isAssetType } from '../../../shared/sync/protocol'
import type { NikkiSyncServerStatusInfo } from '../../../shared/types/electron-api'

/**
 * NikkiSync 内嵌运行时 IPC handler（整合阶段 2 只读查询 + 阶段 3 同步服务）。
 *
 * 查询面（阶段 2）：
 * - `nikkisync:runtime-status`：状态机快照（state/dbPath/linkReady/tables/scannerStatus?/installation?/lastScan?/sync?/error?/hint?）
 * - `nikkisync:start-scan`：触发上游扫描（缺省全量；带 `path` 走上游按 uid 收敛的增量；
 *   带 `gameRoot` 且与当前根不同则由状态机重建会话）
 * - `nikkisync:get-assets`：分页查询，响应体 `{items, nextCursor?, libraryRevision}` 与
 *   上游 `GET /v1/assets` 同形（游标沿用上游 base64url `{t,id}` 编码）
 * - `nikkisync:get-asset-detail`：`mapAssetDetail` 结果原样返回
 * - `nikkisync:get-resource`：`mode:'meta'` 给 `MediaResource`；`mode:'path'` 给上游落库的
 *   绝对路径原值（渲染层据此经既有 media:// 协议读取文件）
 *
 * 查询面扩容（阶段 4，为图库数据层切换而加；同样逐字转发上游仓储/索引，本文件不加工）：
 * - `nikkisync:get-resource-records`：一页资产一次往返取回全部资源，避免 500 次单查
 * - `nikkisync:get-changes`：`GET /v1/changes` 的本地等价调用，`fullResyncRequired`
 *   判据照抄上游 `LocalSyncServer.listChanges`（`after < minimum - 1`）
 * - `nikkisync:search-suits` / `nikkisync:search-clothing`：转发上游 `SuitSearchIndex` /
 *   `ClothingSearchIndex`（两者与 `row-mappers` 一样是 `dist/src/server/**` 深入口）；
 *   `query` 原串下传（trim 归上游），但全空白在本层即拒——否则会为一个无意义查询
 *   摊平整库资产
 * - `nikkisync:profile-stats`：转发上游 `ProfileStatsIndex.buildProfileStats`
 *
 * 服务面（阶段 3，全部复用上游 `LocalSyncServer`，本仓不实现任何 HTTP/TLS/WS/mDNS）：
 * - `nikkisync:server-status`：运行状态 + 端口 + TLS 指纹 + 已配对数；未装配 ⇒ `available:false`
 * - `nikkisync:start-server` / `nikkisync:stop-server`：启停（端口/mdns 变更由状态机重建会话）
 * - `nikkisync:get-pairing-code`：一次性配对二维码内容（NS1 七段，TTL 5 分钟、单次消费）
 * - `nikkisync:get-paired-devices` / `nikkisync:revoke-device`：设备管理（读/软删 NikkiSync 的 paired_devices）
 *
 * 铁律：本文件**不做数据格式转换**，资产响应体逐字来自上游 `SyncReadRepository` +
 * `server/row-mappers.js`；设备列表是管理视图（非协议 DTO），只做敏感列裁剪。
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

/**
 * 阶段 4：批量资源记录。`assetIds` 上界与 `listSchema.limit` 同界（500），
 * 否则单个 IPC 请求会放大成上千次上游查询。
 */
const resourceRecordsSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(128)).min(1).max(500),
  mode: z.enum(['meta', 'path']).default('meta')
})

// after 必填（上游 listChanges 缺该参数即 400）；limit 上界同上游 listChangesAfter 缺省 1000
const changesSchema = z.object({
  after: z.number().int().min(0),
  limit: z.number().int().min(1).max(1000).default(1000)
})

/**
 * 阶段 4：搜索入参。刻意**不** `.trim()`——零转换要求把原串交给上游
 * （`searchSuitLibrary` 内部自行 trim），但全空白必须在本层就拒掉：
 * 一旦放行，`buildSearchSource` 会为一次无意义查询摊平整库资产。
 */
const searchSchema = z.object({
  query: z.string().min(1).max(128).regex(/\S/, 'query must contain a non-whitespace character')
})

// 阶段 3：启停入参。端口界与上游 listen 一致（1..65535，0 是「交给系统分配」，
// 不由 UI 指定）；两键都可省略 ⇒ 沿用当前构造期固化的配置。
const syncStartSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  mdnsEnabled: z.boolean().optional()
})

// 与上游 paired_devices.device_id（TEXT PRIMARY KEY，手机侧生成）同量级
const deviceIdSchema = z.string().trim().min(1).max(128)

/** 句柄未装配时的状态（不抛错：UI 据此显示「同步服务不可用」而非崩一次 toast）。 */
const UNAVAILABLE_SERVER_STATUS: NikkiSyncServerStatusInfo = {
  available: false,
  running: false,
  host: '',
  port: 0,
  mdnsEnabled: false
}

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
  // 「未就绪 / 未建链 / 服务没起来」都是可恢复的前置条件失败：
  // 后者是上游 createPairingPayload 的原生文案（'Server must be started before ...'）
  if (/not ready|unavailable|must be started|not running/i.test(message)) {
    return AppError.preconditionFailed(message)
  }
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

  // ---- 阶段 4：查询面扩容（批量资源 / 增量变更 / 搜索 / 统计），全部零转换 ----

  ipcMain.handle(
    'nikkisync:get-resource-records',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(resourceRecordsSchema, args[0], 'resource-records', (input) =>
        runtime.listResourceRecords(input.assetIds, input.mode)
      )
    })
  )

  ipcMain.handle(
    'nikkisync:get-changes',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(changesSchema, args[0], 'changes', (input) =>
        runtime.listChanges(input.after, input.limit)
      )
    })
  )

  ipcMain.handle(
    'nikkisync:search-suits',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(searchSchema, args[0], 'search-suits', (input) =>
        runtime.searchSuits(input.query)
      )
    })
  )

  ipcMain.handle(
    'nikkisync:search-clothing',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(searchSchema, args[0], 'search-clothing', (input) =>
        runtime.searchClothing(input.query)
      )
    })
  )

  ipcMain.handle(
    'nikkisync:profile-stats',
    wrapHandlerNoArgs(ctx, async () => {
      const runtime = requireRuntime(ctx)
      try {
        return await runtime.profileStats()
      } catch (error) {
        throw toAppError(error, 'profile-stats')
      }
    })
  )

  // ---- 阶段 3：同步服务（全部复用上游 LocalSyncServer）----

  ipcMain.handle(
    'nikkisync:server-status',
    wrapHandlerNoArgs(ctx, () => {
      // 与移植面 sync:getStatus 同口径：句柄未装配时给 available:false，不抛错
      if (!ctx.nikkisyncRuntime) return UNAVAILABLE_SERVER_STATUS
      return { available: true as const, ...ctx.nikkisyncRuntime.syncStatus() }
    })
  )

  ipcMain.handle(
    'nikkisync:start-server',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(syncStartSchema, args[0], 'start-server', async (input) => {
        const status = await runtime.startSyncServer({
          ...(input.port === undefined ? {} : { port: input.port }),
          ...(input.mdnsEnabled === undefined ? {} : { mdnsEnabled: input.mdnsEnabled })
        })
        if (!status.running) {
          // 状态机刻意不外抛（启动失败不得崩主进程），因此这里按状态合成语义化错误
          const reason = status.error ?? 'unknown failure'
          if (reason === 'PORT_IN_USE') {
            throw AppError.preconditionFailed(
              `sync server could not listen on port ${status.port}: PORT_IN_USE`
            )
          }
          throw AppError.internal(`nikkisync sync server failed to start: ${reason}`)
        }
        return { available: true as const, ...status }
      })
    })
  )

  ipcMain.handle(
    'nikkisync:stop-server',
    wrapHandlerNoArgs(ctx, async () => {
      const runtime = requireRuntime(ctx)
      try {
        return { available: true as const, ...(await runtime.stopSyncServer()) }
      } catch (error) {
        throw toAppError(error, 'stop-server')
      }
    })
  )

  ipcMain.handle(
    'nikkisync:get-pairing-code',
    wrapHandlerNoArgs(ctx, async () => {
      const runtime = requireRuntime(ctx)
      try {
        // 服务未运行时上游原生抛错 ⇒ toAppError 归一为 preconditionFailed
        return await runtime.pairingCode()
      } catch (error) {
        throw toAppError(error, 'pairing-code')
      }
    })
  )

  ipcMain.handle(
    'nikkisync:get-paired-devices',
    wrapHandlerNoArgs(ctx, async () => {
      const runtime = requireRuntime(ctx)
      try {
        return await runtime.listPairedDevices()
      } catch (error) {
        throw toAppError(error, 'paired-devices')
      }
    })
  )

  ipcMain.handle(
    'nikkisync:revoke-device',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      const parsed = deviceIdSchema.safeParse(args[0])
      if (!parsed.success) {
        throw AppError.validation('invalid deviceId: must be a non-empty string (<=128)')
      }
      try {
        return await runtime.revokeDevice(parsed.data)
      } catch (error) {
        throw toAppError(error, 'revoke-device')
      }
    })
  )
}
