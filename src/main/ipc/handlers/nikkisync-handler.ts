// @core-change: admit-directory 新增盘根/UNC 根形态闸（isBareDirectoryRoot，整盘/根目录
//               不得登记为同步照片源，含 // 与 /// 等裸分隔符根），未装配 runtime 的
//               set/reset 生效失败补回 applyError:'runtime-unavailable'，生效失败分类判据
//               由宽正则 /not found/i 收紧为与 runtime-manager 同源的 installNotfoundMessage。
import fs from 'node:fs'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { HandlerContext } from '../handler-context'
import type { NikkiSyncRuntimeHandle } from '../../nikkisync/runtime-types'
// 生效失败分类判据与 runtime-manager 同源（该常量是其状态机判定 degraded 的同一把尺）
import { installNotfoundMessage } from '../../nikkisync/runtime-manager'
import { assertFileReadPath, pathGuard, wrapHandlerNoArgs, wrapHandlerRaw } from '../validator'
import { isSensitivePath } from '../../utils/ipc-validate'
import { AppError } from '../../../shared/errors/app-error'
import { isAssetType } from '../../../shared/sync/protocol'
import type {
  NikkiSyncGameRootApplyResult,
  NikkiSyncServerStatusInfo,
  NikkiSyncSyncAccountPreviewInfo
} from '../../../shared/types/electron-api'

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
 *   判据与上游 `LocalSyncServer.listChanges` 逐字一致：`after < accounts.revision()` 或
 *   `after < minimum - 1`（账号作用域变更会 bump revision ⇒ 客户端强制全量重同步）
 * - `nikkisync:search-suits` / `nikkisync:search-clothing`：转发上游 `SuitSearchIndex` /
 *   `ClothingSearchIndex`（两者与 `row-mappers` 一样是 `dist/src/server/**` 深入口）；
 *   `query` 原串下传（trim 归上游），但全空白在本层即拒——否则会为一个无意义查询
 *   摊平整库资产
 * - `nikkisync:profile-stats`：转发上游 `ProfileStatsIndex.buildProfileStats`
 *
 * 服务面（阶段 3，全部复用上游 `LocalSyncServer`，本仓不实现任何 HTTP/TLS/WS/mDNS）：
 * - `nikkisync:server-status`：运行状态 + 端口 + TLS 指纹 + 已配对数；未装配 ⇒ `available:false`
 * - `nikkisync:start-server` / `nikkisync:stop-server`：启停（端口/mdns 变更由状态机重建会话）
 * - `nikkisync:get-pairing-code`：一次性配对二维码内容（单 host = NS1 七段；注入多 host =
 *   `nikki-sync://pair?` 新格式并回填 `hosts`，K5），TTL 5 分钟、单次消费
 * - `nikkisync:get-paired-devices` / `nikkisync:revoke-device`：设备管理（读/软删 NikkiSync 的 paired_devices）
 *
 * 铁律：资产响应体逐字来自上游 `SyncReadRepository` + `server/row-mappers.js`，**不做裁剪**
 * （含 `sourcePath` / `sourceFolder`）；仅管理视图做两处收窄——设备列表剔敏感列、
 * 账号分组的 label 剔除（中文文案，改由渲染层按 uid + i18n 生成）与样例缩略图三键投影。
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

/**
 * K6：目录预检入参。必须绝对路径（Windows 盘符 / UNC / POSIX 根起始）；
 * 上限 16 由上游 `too_many_directories` 承担，zod 不重复设（避免双真相源）。
 */
const inspectDirectorySchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(value), {
      message: 'path must be absolute'
    }),
  // 1.0.27：上游 `inspect` 只接受 `spinning_momo`（`other` 只供 setSource）
  source: z.enum(['spinning_momo']).optional()
})

const directoryIdSchema = z.string().trim().min(1).max(128)

/** K9：目录来源标注入参（上游 `setSource` 取值域，非法值上游抛 invalid_source）。 */
const directorySourceSchema = z.object({
  id: directoryIdSchema,
  source: z.enum(['spinning_momo', 'other'])
})

/** 绝对路径字符串（Windows 盘符 / UNC / POSIX 根起始），max 为长度上界。 */
const absolutePath = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => /^([A-Za-z]:[\\/]|\\\\|\/)/.test(value), {
      message: 'path must be absolute'
    })

/**
 * 照片根目录写入入参。长度上界与 `scanSchema.gameRoot` 同界（512）——两处最终都把
 * 该串交给上游 ScannerService，界必须一致；绝对路径要求与 inspectDirectorySchema 同款。
 */
const gameRootSetSchema = z.object({ path: absolutePath(512) })

/** K6 手输预检入参：与 inspectDirectorySchema 同界（4096），通过后登记 pathGuard 交回 inspect。 */
const admitDirectorySchema = z.object({ path: absolutePath(4096) })

/** K9：账号样例缩略图入参（资产 id 界与查询面一致）。 */
const accountPreviewSchema = z.object({ assetId: assetIdSchema })

/**
 * K9：账号选择保存入参。数量界与上游一致（1..200 由上游判定，本层只挡超大载荷）；
 * **刻意不做 UID 正则**——上游 `validKey` 是单真相源，非法值映射 VALIDATION_ERROR。
 */
const accountSelectionSchema = z.object({
  uids: z.array(z.string().max(64)).max(200).nullable()
})

/**
 * K8：整理队列条目 id。与上游 `DeletionQueue.approveMany` 的校验**同规同界**
 * （`/^[a-zA-Z0-9-]{16,64}$/`），形态错误在本层即拒，语义错误（not_pending 等）交上游。
 */
const organizerIdSchema = z.string().regex(/^[a-zA-Z0-9-]{16,64}$/)

/**
 * K8：批量批准入参。ids 界与上游一致（1..500）；**刻意不去重**——重复 id 由上游
 * `invalid_ids` 承担（单一真相源），本层去重反而会破坏「委托参数逐字透传」口径。
 */
const organizerApproveSchema = z.object({
  ids: z.array(organizerIdSchema).min(1).max(500)
})

/**
 * K8：上游四错误短码 → IPC 错误码（逐码注释，映射表唯一真相源）。
 * 形态类（队列项不在可决定态 / ids 非法）→ VALIDATION_ERROR；
 * 会话态类（手机租约过期可重试）→ PRECONDITION_FAILED；拆除中 → CANCELED。
 */
const ORGANIZER_ERROR_CODES: Record<string, 'validation' | 'precondition' | 'canceled'> = {
  not_pending: 'validation', // 队列项不存在或已不在可决定状态（已被处理/已过期）
  invalid_ids: 'validation', // 批量 ids 形态非法（正则/重复/上限——上游单真相源）
  phone_offline: 'precondition', // 手机 45s 租约过期：重连后需重新确认，可重试
  stopping: 'canceled' // 会话正在拆除（stop/重建），动作被取消
}

function organizerErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = message.trim().split(/[\s:]+/)[0]
  const mapped = code ? ORGANIZER_ERROR_CODES[code] : undefined
  if (mapped === 'validation') {
    return AppError.validation(`organizer request rejected: ${code}`)
  }
  if (mapped === 'precondition') {
    return AppError.preconditionFailed(`organizer state rejected: ${code}`)
  }
  if (mapped === 'canceled') {
    return AppError.canceled(`organizer action canceled: ${code}`)
  }
  return toAppError(error, 'organizer')
}

/**
 * K8：开关门。三通道先读 `nikkisync.organizerEnabled`（渲染层白名单键，默认 false），
 * false ⇒ PRECONDITION_FAILED——破坏性能力的显式开关，错误文案指向同步服务页开关。
 */
function requireOrganizerEnabled(ctx: HandlerContext): void {
  const enabled = ctx.dbManager.getSetting<boolean>('nikkisync.organizerEnabled', false)
  if (enabled !== true) {
    throw AppError.preconditionFailed(
      'organizer is disabled: enable it via the nikkisync.organizerEnabled switch on the sync service page'
    )
  }
}

/**
 * K6：上游九错误短码 → IPC 错误码（逐码注释，映射表唯一真相源）。
 * 输入形态类（路径/层级/覆盖问题）→ VALIDATION_ERROR；会话状态类（可重试/需重预检/上限）→ PRECONDITION_FAILED。
 */
const EXTRA_DIRECTORY_ERROR_CODES: Record<string, 'validation' | 'precondition'> = {
  invalid_directory: 'validation', // 路径形态不对（非目录等）
  choose_subfolder: 'validation', // 层级不对（应选照片子目录）
  thumbnail_only: 'validation', // 只包含缩略图目录
  choose_photo_folder: 'validation', // 应选择照片目录
  already_covered: 'validation', // 已被现有扫描根覆盖
  directory_unavailable: 'precondition', // 目录暂不可访问（盘未挂载等，可重试）
  too_many_directories: 'precondition', // 达到上限 16（上游承担判定）
  selection_expired: 'precondition', // 预检已过期（需重新 inspect）
  directory_not_found: 'precondition', // 目录 id 不存在/已被移除
  invalid_source: 'validation' // 1.0.27 setSource 的来源取值非法（本层 zod 已挡，兜底）
}

function extraDirectoryErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = message.trim().split(/[\s:]+/)[0]
  const mapped = code ? EXTRA_DIRECTORY_ERROR_CODES[code] : undefined
  if (mapped === 'validation') {
    return AppError.validation(`extra directory request rejected: ${code}`)
  }
  if (mapped === 'precondition') {
    return AppError.preconditionFailed(`extra directory state rejected: ${code}`)
  }
  return toAppError(error, 'extra-directories')
}

/** K6：剔除上游中文串字段（state().message——上游 UI 提示文案，§6「不透传渲染层」）。 */
function stripExtraDirectoriesState(state: unknown): unknown {
  if (typeof state !== 'object' || state === null) return state
  const rest = { ...(state as Record<string, unknown>) }
  delete rest.message
  return rest
}

/** K6：剔除提案的中文 hint（同上；id/roots/images/videos/limited 原样保留）。 */
function stripExtraDirectoryProposal(proposal: unknown): unknown {
  if (typeof proposal !== 'object' || proposal === null) return proposal
  const rest = { ...(proposal as Record<string, unknown>) }
  delete rest.hint
  return rest
}

/**
 * K9：上游 `invalid_accounts`（uid 键非法 / 超 200 / 非数组）→ VALIDATION_ERROR；
 * 其余沿用通用分类（未装配会话的 unavailable → PRECONDITION_FAILED）。
 */
function accountsErrorToAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const message = error instanceof Error ? error.message : String(error)
  const code = message.trim().split(/[\s:]+/)[0]
  if (code === 'invalid_accounts') {
    return AppError.validation(`sync account selection rejected: ${code}`)
  }
  return toAppError(error, 'sync-accounts')
}

/**
 * K9：剔除上游 `state().accounts[].label` 的中文文案（`UID x` / `未识别 UID 的照片` /
 * `旋转吧大喵`）；渲染层按 `uid` + i18n 出文案。`all` / `count` / `selected` / `samples` 原样。
 */
function stripAccountLabels(state: unknown): unknown {
  if (typeof state !== 'object' || state === null) return state
  const accounts = (state as { accounts?: unknown }).accounts
  if (!Array.isArray(accounts)) return state
  return {
    ...(state as Record<string, unknown>),
    accounts: accounts.map((item) => {
      if (typeof item !== 'object' || item === null) return item
      const row = { ...(item as Record<string, unknown>) }
      delete row.label
      return row
    })
  }
}

/**
 * K9：样例缩略图投影。上游 `preview()` 返回完整 DB 资源行，本仓只取 UI 需要的三键
 * （这是新增通道的显式投影，不是对既有资产 DTO 的裁剪）。
 */
function projectAccountPreview(row: unknown): NikkiSyncSyncAccountPreviewInfo {
  const record = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
  const resourceId = typeof record.resource_id === 'string' ? record.resource_id : ''
  const mimeType = typeof record.mime_type === 'string' ? record.mime_type : ''
  const sourcePath = typeof record.source_path === 'string' ? record.source_path : undefined
  return { resourceId, mimeType, ...(sourcePath === undefined ? {} : { sourcePath }) }
}

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

/**
 * 照片根目录设置键。读取端在 `app/nikkisync-runtime-setup.ts` 的 `buildSessionOptions`
 * （`SETTING_GAME_ROOT` 同名字符串）：空串 = 交给上游 game-directory-discovery（默认路径）。
 * 仿 organizerEnabled 的直读写先例——handler 层不 import app/ 常量，以注释交叉引用锁定同名。
 */
const SETTING_GAME_ROOT_KEY = 'nikkisync.gameRoot'

/**
 * 盘根/UNC 根形态判据（缺陷 D3）：`D:\`、`C:/`、`\`、`/`、`//`、`///`、`\\nas\share`。
 *
 * 为什么单独设一道：照片源目录的四关是「非敏感 → 存在 → 是目录 → 可读」，而
 * `isSensitivePath` 只按**首段**拦 windows/program files/programdata，盘根没有首段可拦，
 * 于是 `admit(D:\)` 四关全过并把整块盘登记成同步照片源、递给上游当扫描根。
 *
 * 判据刻意只看**串的形态**：不 import `node:path`、不触磁盘，故不引入 win32 钉也不引入
 * 方言引用（无需在 path-semantics-guard 登记），Windows 真宿主与 Linux 装置同判据。
 */
export function isBareDirectoryRoot(p: string): boolean {
  const s = p.trim()
  // 裸分隔符根：`/`、`\`，以及重复形态 `//`、`///`、`\\\\`——POSIX 上 `//` 语义等同 `/`
  // 且 stat 可过（实测 Windows 宿主同样能 stat 过并被登记），必须与单分隔符同判
  if (/^[\\/]+$/.test(s)) return true
  // 盘符根：`D:` / `D:\` / `D:/` / `D:\\`（分隔符多寡都算同一个根）
  if (/^[A-Za-z]:[\\/]*$/.test(s)) return true
  // UNC 根：恰好「服务器 + 共享」两段，其后不再有路径段（`\\nas\share\photos` 是子目录，放行）
  return /^\\\\[^\\/]+[\\/][^\\/]+[\\/]*$/.test(s)
}

/**
 * 照片目录自定义通道（set-game-root / admit-directory）共用的目录校验：
 * 绝对路径形态已由 zod schema 先行，这里做「敏感目录黑名单 → 存在 + 目录 → 可读（R_OK 必过）」，
 * 并 fail-open 探测可写（返回 writable 布尔，只提示不阻断——照片源目录扫描只读，
 * Program Files 等不可写位置本身合法，系统敏感目录则一律拒绝）。
 */
async function validatePhotoSourceDirectory(dir: string): Promise<{ writable: boolean }> {
  if (isSensitivePath(dir)) {
    throw AppError.forbidden(`refusing to use a system sensitive directory as photo source: ${dir}`)
  }
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(dir)
  } catch {
    throw AppError.validation(`photo source directory does not exist: ${dir}`)
  }
  if (!stat.isDirectory()) {
    throw AppError.validation(`photo source path is not a directory: ${dir}`)
  }
  try {
    await fs.promises.access(dir, fs.constants.R_OK)
  } catch {
    throw AppError.forbidden(`photo source directory is not readable: ${dir}`)
  }
  let writable = true
  try {
    await fs.promises.access(dir, fs.constants.W_OK)
  } catch {
    // 可写探测 fail-open：EACCES/EROFS/其他异常都只归为「不可写」，绝不阻断保存
    writable = false
  }
  return { writable }
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

/**
 * 照片目录落库之后的运行期生效（set / reset 共用）。
 *
 * 为什么需要这一环：`nikkisync.gameRoot` 的原生读者只有进程启动那一次的
 * `buildSessionOptions`（`app/nikkisync-runtime-setup.ts`），产物冻结进会话依赖的默认快照。
 * 只落库不生效，运行中的同步库就停在旧根，而图库工具栏的 `startScan()` 是无参的（同一份旧
 * 快照）——应用内不存在任何动作能把刚保存的目录推给当前会话，表现为「选了自定义路径但板块
 * 不显示该路径的照片」。生效本体（换根重建 + 全量扫描 + LAN 复原）在 `runtime-manager`。
 *
 * 三条不让步的口径：
 * 1. 先落库再生效：生效失败时值仍已持久化（下次进程按既有语义读到），不把已成功的保存改判失败；
 * 2. 只在生效成功后广播 `library-changed`（与 `start-scan`「只在扫描成功后发」同判据——
 *    库没变化就通知，只会让 UI 重取一次旧结果）；
 * 3. 只回分类码不回原文：`src/**` 禁硬编码中文，且上游错误原文（含路径线索）不该跨 IPC 泄漏，
 *    真实原因由 `runtime-manager` 的 `deps.log` 落日志。
 */
async function applyPersistedGameRoot(
  runtime: NikkiSyncRuntimeHandle | undefined,
  gameRoot: string,
  event: IpcMainInvokeEvent
): Promise<NikkiSyncGameRootApplyResult> {
  if (!runtime) {
    // 契约把 runtime-unavailable 定义为「Runtime 未装配 / 未建链」，未装配这一支也必须如实回
    // 分类码（渲染层仍按 needRestart 走重启兜底，补码只为诊断与契约成真）
    return { applied: false, needRestart: true, applyError: 'runtime-unavailable' }
  }
  try {
    await runtime.applyGameRoot(gameRoot)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 判据与 `runtime-manager` 同源：`installation-not-found` 的唯一特征就是那一条
    // installNotfoundMessage（该文件 :496/:540 也是拿它比的）。宽正则 `/not found/i`
    // 会把任何含 "not found" 的下游故障（缺表、缺资源行）误判成安装根问题，
    // 让渲染层给出「请改选游戏安装目录」这种无效指向。未建链/未就绪仍走下一支。
    if (message.includes(installNotfoundMessage)) {
      return { applied: false, needRestart: true, applyError: 'installation-not-found' }
    }
    if (/not ready|unavailable/i.test(message)) {
      return { applied: false, needRestart: true, applyError: 'runtime-unavailable' }
    }
    return { applied: false, needRestart: true, applyError: 'scan-failed' }
  }
  notifyLibraryChanged(event)
  return { applied: true, needRestart: false }
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

  // ---- K6：额外照片目录（仅作用于同步库扫描器，不影响本地图库 customScanPaths）----

  ipcMain.handle(
    'nikkisync:get-extra-directories',
    wrapHandlerNoArgs(ctx, () => {
      const runtime = requireRuntime(ctx)
      try {
        return stripExtraDirectoriesState(runtime.extraDirectoriesState())
      } catch (error) {
        throw extraDirectoryErrorToAppError(error)
      }
    })
  )

  ipcMain.handle(
    'nikkisync:inspect-extra-directory',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(
        inspectDirectorySchema,
        args[0] ?? {},
        'inspect-extra-directory',
        async (input) => {
          // 白名单守卫，放在 zod 之后：形态错误仍先由 inspectDirectorySchema 判 VALIDATION。
          // 两类合法来源：① 目录选择器（dialog:selectDirectory）返回的路径已由 dialog-handler
          // 登记进 userPickedDirs；② 渲染层手输、已过 admit-directory 校验+登记的同步域集合
          // （isSyncPhotoDir，只在本通道被消费，不影响 scanner/settings/media 的短路判据）。
          // 两者都不命中的伪造绝对路径交 assertFileReadPath ⇒ PermissionError →
          // IPC_PATH_FORBIDDEN，不会把一个渲染层字符串原样递给上游去枚举真实文件系统
          // （提案随后可被 add 提升为长期扫描根，内容再经 media:// 可读）。
          if (!pathGuard.isUserPickedDir(input.path) && !pathGuard.isSyncPhotoDir(input.path))
            assertFileReadPath(input.path)
          try {
            return stripExtraDirectoryProposal(
              await runtime.inspectExtraDirectory(input.path, input.source)
            )
          } catch (error) {
            throw extraDirectoryErrorToAppError(error)
          }
        }
      )
    })
  )

  ipcMain.handle(
    'nikkisync:add-extra-directory',
    wrapHandlerRaw(ctx, async (args, _ctx, event) => {
      const runtime = requireRuntime(ctx)
      const state = await parseAndRun(
        z.object({ id: directoryIdSchema }),
        args[0] ?? {},
        'add-extra-directory',
        async (input) => {
          try {
            return stripExtraDirectoriesState(await runtime.addExtraDirectory(input.id))
          } catch (error) {
            throw extraDirectoryErrorToAppError(error)
          }
        }
      )
      // review-fix：目录清单变化属作用域变更（来源分组随目录进出，上游同样
      // onSourcesChanged）⇒ 本地图库按 fullResyncRequired 重取
      notifyLibraryChanged(event)
      return state
    })
  )

  ipcMain.handle(
    'nikkisync:remove-extra-directory',
    wrapHandlerRaw(ctx, async (args, _ctx, event) => {
      const runtime = requireRuntime(ctx)
      const state = await parseAndRun(
        z.object({ id: directoryIdSchema }),
        args[0] ?? {},
        'remove-extra-directory',
        async (input) => {
          try {
            return stripExtraDirectoriesState(await runtime.removeExtraDirectory(input.id))
          } catch (error) {
            throw extraDirectoryErrorToAppError(error)
          }
        }
      )
      // review-fix：同 add——目录移出作用域亦须让本地图库重取
      notifyLibraryChanged(event)
      return state
    })
  )

  ipcMain.handle(
    'nikkisync:set-extra-directory-source',
    wrapHandlerRaw(ctx, async (args, _ctx, event) => {
      const runtime = requireRuntime(ctx)
      const state = await parseAndRun(
        directorySourceSchema,
        args[0] ?? {},
        'set-extra-directory-source',
        async (input) => {
          try {
            return stripExtraDirectoriesState(
              await runtime.setExtraDirectorySource(input.id, input.source)
            )
          } catch (error) {
            throw extraDirectoryErrorToAppError(error)
          }
        }
      )
      // 来源分组变化属作用域变更（有账号选择时资产进出作用域）⇒ 本地图库按 fullResyncRequired 重取
      notifyLibraryChanged(event)
      return state
    })
  )

  ipcMain.handle(
    'nikkisync:rescan-extra-directories',
    wrapHandlerNoArgs(ctx, async () => {
      const runtime = requireRuntime(ctx)
      try {
        return stripExtraDirectoriesState(await runtime.rescanExtraDirectories())
      } catch (error) {
        throw extraDirectoryErrorToAppError(error)
      }
    })
  )

  // ---- 照片目录自定义（game-root 三通道 + K6 手输预检）----
  // 与 K6 的分工：gameRoot 替代上游自动发现的游戏安装根（单值）；set/reset 落库后当场走
  // 运行期生效通道（`runtime.applyGameRoot` = 换根重建 + 全量扫描），生效成功即不再需要重启，
  // 生效不了才退回「重启后生效」并以 applied/applyError 如实告知（原因见 applyPersistedGameRoot）。
  // admit 不落库，只做校验 + 同步域登记，让手输路径能过既有 inspect 门禁。登记刻意不进
  // userPickedDirs：那条路是「对话框显式选中」专属，而本通道入参来自渲染层，写进全局集合
  // 就顺带给了 scanner:start / settings:set / media:// 免检（前缀命中 ⇒ 一次调用整盘放行）。
  // get/admit 不 requireRuntime；set/reset 在 Runtime 未装配时仍可落库（applied:false）。

  ipcMain.handle(
    'nikkisync:get-game-root',
    wrapHandlerNoArgs(ctx, () => {
      const value = ctx.dbManager.getSetting<string>(SETTING_GAME_ROOT_KEY, '')
      // 历史脏值（早期版本可能写入非字符串）按读取端口同口径回退空串
      return { gameRoot: typeof value === 'string' ? value : '' }
    })
  )

  ipcMain.handle(
    'nikkisync:set-game-root',
    wrapHandlerRaw(ctx, async (args, _ctx, event) =>
      parseAndRun(gameRootSetSchema, args[0] ?? {}, 'set-game-root', async (input) => {
        const { writable } = await validatePhotoSourceDirectory(input.path)
        ctx.dbManager.setSetting(SETTING_GAME_ROOT_KEY, input.path)
        const apply = await applyPersistedGameRoot(ctx.nikkisyncRuntime, input.path, event)
        return { gameRoot: input.path, writable, ...apply }
      })
    )
  )

  ipcMain.handle(
    'nikkisync:reset-game-root',
    wrapHandlerNoArgs(ctx, async (_ctx, event) => {
      ctx.dbManager.setSetting(SETTING_GAME_ROOT_KEY, '')
      // 空串 = 「不下发 selectedInstallRoot」，交给上游自动发现（生效通道内已归一）
      return applyPersistedGameRoot(ctx.nikkisyncRuntime, '', event)
    })
  )

  ipcMain.handle(
    'nikkisync:admit-directory',
    wrapHandlerRaw(ctx, async (args) =>
      parseAndRun(admitDirectorySchema, args[0] ?? {}, 'admit-directory', async (input) => {
        // 盘根先拒（D3）：它在「非敏感 + 存在 + 是目录 + 可读」四关上全过，但登记进去就是
        // 把整块盘递给上游当同步扫描根；这里不落库也不登记。
        if (isBareDirectoryRoot(input.path)) {
          throw AppError.validation('refusing a bare drive or UNC root as a photo source directory')
        }
        await validatePhotoSourceDirectory(input.path)
        // 校验全过才登记，且只进**同步域专用集合**（不是 userPickedDirs）：入参来自渲染层、
        // 无对话框手势，若写全局集合则 `matchesPicked` 的前缀语义会让一次 admit 变成
        // 整棵子树对 scanner:start / settings:set / media:// 免检。登记后渲染层走
        // inspect-extra-directory 时由 isSyncPhotoDir 短路放行，授权面止于同步库预检本身。
        pathGuard.registerSyncPhotoDir(input.path)
        return { path: input.path }
      })
    )
  )

  // ---- K9：账号同步作用域（上游 AccountSyncSettings —— 1.0.27 新增线上同步范围）----

  ipcMain.handle(
    'nikkisync:get-sync-accounts',
    wrapHandlerNoArgs(ctx, async () => {
      const runtime = requireRuntime(ctx)
      try {
        return stripAccountLabels(await runtime.listSyncAccounts())
      } catch (error) {
        throw accountsErrorToAppError(error)
      }
    })
  )

  ipcMain.handle(
    'nikkisync:preview-sync-account',
    wrapHandlerRaw(ctx, async (args) => {
      const runtime = requireRuntime(ctx)
      return parseAndRun(
        accountPreviewSchema,
        args[0] ?? {},
        'preview-sync-account',
        async (input) => {
          try {
            return projectAccountPreview(await runtime.previewSyncAccount(input.assetId))
          } catch (error) {
            throw accountsErrorToAppError(error)
          }
        }
      )
    })
  )

  ipcMain.handle(
    'nikkisync:set-sync-account-selection',
    wrapHandlerRaw(ctx, async (args, _ctx, event) => {
      const runtime = requireRuntime(ctx)
      const state = await parseAndRun(
        accountSelectionSchema,
        args[0] ?? {},
        'set-sync-account-selection',
        async (input) => {
          try {
            return await runtime.setSyncAccountSelection(input.uids)
          } catch (error) {
            throw accountsErrorToAppError(error)
          }
        }
      )
      // 作用域变更会 bump revision ⇒ 客户端 fullResyncRequired；此处同步通知本地图库重取
      notifyLibraryChanged(event)
      return stripAccountLabels(state)
    })
  )

  // ---- K8：整理队列（批量删除；确认链为上游协议内建双重确认，本仓只调既有方法）----

  ipcMain.handle(
    'nikkisync:get-organizer-queue',
    wrapHandlerNoArgs(ctx, () => {
      // 开关门先于句柄装配检查：开关关闭时不给「未装配」误导信号
      requireOrganizerEnabled(ctx)
      const runtime = requireRuntime(ctx)
      try {
        return runtime.organizerStatus()
      } catch (error) {
        throw organizerErrorToAppError(error)
      }
    })
  )

  ipcMain.handle(
    'nikkisync:decide-organizer-item',
    wrapHandlerRaw(ctx, async (args) => {
      requireOrganizerEnabled(ctx)
      const runtime = requireRuntime(ctx)
      return parseAndRun(
        z.object({ id: organizerIdSchema, approve: z.boolean() }),
        args[0] ?? {},
        'decide-organizer-item',
        async (input) => {
          try {
            // 上游 decide 自带状态校验（not_pending/phone_offline），本层不做二次判定
            return await runtime.organizerDecide(input.id, input.approve)
          } catch (error) {
            throw organizerErrorToAppError(error)
          }
        }
      )
    })
  )

  ipcMain.handle(
    'nikkisync:approve-organizer-items',
    wrapHandlerRaw(ctx, async (args) => {
      requireOrganizerEnabled(ctx)
      const runtime = requireRuntime(ctx)
      return parseAndRun(
        organizerApproveSchema,
        args[0] ?? {},
        'approve-organizer-items',
        async (input) => {
          try {
            return await runtime.organizerApproveMany(input.ids)
          } catch (error) {
            throw organizerErrorToAppError(error)
          }
        }
      )
    })
  )
}
