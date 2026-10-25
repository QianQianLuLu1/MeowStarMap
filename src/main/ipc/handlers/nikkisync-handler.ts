// @core-change: K3 新增 nikkisync:resolve-game-version 游戏版本推断通道（纯本地静态表查询）。
//               （历史：阶段2-4 建查询与服务面、K2 增同意开关两通道——历次授权原因见各节点提交。）
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
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

/**
 * K2：同意开关入参。`policyVersion` 由页面从 get-metadata-consent 的展示值原串带回
 * （上游 `MetadataOnlineConsent.setEnabled` 逐字比对策略版本，防「看旧文案点新同意」）。
 */
const consentSetSchema = z.object({
  enabled: z.boolean(),
  policyVersion: z.string().min(1).max(64)
})

/**
 * K3：版本推断入参。只做长度界，**不做日期格式校验**——ISO 8601 之外的输入
 * 原样下传由上游判缺省返回两键缺省，与「纯查询无副作用」一致。
 */
const gameVersionSchema = z.object({
  capturedAt: z.string().min(1).max(64).optional()
})

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

/**
 * K2：同意开关的原始错误 → IPC 错误码。上游 `setEnabled` 的 policyVersion 不匹配
 * 抛中文原生文案——**不透传渲染层**（§6 通用规则）：含 CJK 的消息一律改写为
 * 英文可诊断提示（src/** 禁硬编码中文，因此按 CJK 字符区间判别而非匹配原文）。
 */
function consentErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/[\u4e00-\u9fff]/.test(message)) {
    return AppError.validation(
      'metadata consent rejected the request (upstream policy check failed); re-read the disclosure and retry'
    )
  }
  return toAppError(error, 'metadata-consent')
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

/**
 * 扫描成功 ⇒ 通知发起方「资产库变了」（阶段 4 的图库自动刷新入口）。
 *
 * 只在扫描成功返回后发：扫描失败时库可能处于中间态，此时通知反而会让 UI 刷出半截结果。
 * 发送本身失败（窗口已关、CLI/探针没有 sender）一律静默——绝不能因为一次通知失败
 * 就把已经成功的扫描判成失败。
 */
function notifyLibraryChanged(event: IpcMainInvokeEvent): void {
  try {
    const sender = (event as { sender?: { send?: (channel: string) => void } })?.sender
    sender?.send?.('nikkisync:library-changed')
  } catch {
    // 通知是尽力而为：没有任何可恢复动作，也不改变扫描结果
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
    wrapHandlerRaw(ctx, async (args, _ctx, event) => {
      const runtime = requireRuntime(ctx)
      const result = await parseAndRun(scanSchema, args[0], 'scan', (input) =>
        runtime.scan({
          ...(input.gameRoot === undefined ? {} : { gameRoot: input.gameRoot }),
          ...(input.path === undefined ? {} : { path: input.path })
        })
      )
      notifyLibraryChanged(event)
      return result
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

  // ---- K2：在线解析同意（上游 MetadataOnlineConsent 的读写面）----

  ipcMain.handle(
    'nikkisync:get-metadata-consent',
    wrapHandlerNoArgs(ctx, () => {
      const runtime = requireRuntime(ctx)
      try {
        return runtime.metadataConsentState()
      } catch (error) {
        throw consentErrorToAppError(error)
      }
    })
  )

  ipcMain.handle(
    'nikkisync:set-metadata-consent',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      const parsed = consentSetSchema.safeParse(args[0] ?? {})
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
          .join('; ')
        throw AppError.validation(`invalid nikkisync metadata consent request: ${detail}`)
      }
      try {
        // 前置校验策略版本：上游 setEnabled 抛中文原生文案，本层先行拦截给出英文
        // 错误（§6「上游中文串不透传」）；竞态下上游仍可能抛出，由 CJK 兜底分支改写
        const current = runtime.metadataConsentState()
        if (parsed.data.enabled && parsed.data.policyVersion !== current.policyVersion) {
          throw AppError.validation(
            `metadata consent policy version mismatch (expected ${current.policyVersion}); re-read the disclosure and retry`
          )
        }
        // 关闭（撤回）时上游 setEnabled(false) 内部即 abortPending：在途出站请求一并中止
        return runtime.setMetadataConsent(parsed.data.enabled, parsed.data.policyVersion)
      } catch (error) {
        throw consentErrorToAppError(error)
      }
    })
  )

  // ---- K3：游戏版本推断（上游 GameVersionCalendar 静态表，纯本地无出站）----

  ipcMain.handle(
    'nikkisync:resolve-game-version',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(gameVersionSchema, args[0] ?? {}, 'resolve-game-version', (input) =>
        // ISO 8601 之外的输入原样下传由上游判缺省、不抛错（纯查询无副作用）
        runtime.resolveGameVersion(input.capturedAt)
      )
    })
  )
}
