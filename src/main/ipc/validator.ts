/**
 * IPC 参数校验 + 统一响应包装核心模块
 *
 * 提供三大能力：
 * 1. wrapHandler 高阶函数：自动 zod 校验参数 + 统一包装响应 + 统一异常捕获
 * 2. PathGuard 路径白名单：拦截系统目录，仅允许已注册根/用户主目录/应用数据目录
 * 3. schemas 通用 zod schema 集合：filePath/mediaId/rating 等可复用校验器
 *
 * 改造原则：
 * - handler 只关心业务逻辑，参数校验由 wrapHandler 统一处理
 * - handler 返回原始数据 T，wrapHandler 自动包装为 IpcResponse<T>
 * - handler 抛出 AppError 时自动转为 IpcError；抛出普通 Error 标记为 INTERNAL_ERROR
 * - 文件操作类 handler 调用 assertFileOpPath 完成路径白名单校验
 */
import { z } from 'zod'
import path from 'path'
import os from 'os'
import { app, type IpcMainInvokeEvent } from 'electron'
import type { HandlerContext } from './handler-context'
import { AppError, isAppError, toIpcError } from '../../shared/errors/app-error'
import { IPC_ERROR_CODES, type IpcResponse } from '../../shared/types/ipc-types'
import { isSensitivePath } from '../utils/ipc-validate'
import {
  MAX_FILE_PATH_LENGTH,
  MAX_PATH_ARRAY_SIZE,
  MAX_MEDIA_ID_ARRAY_SIZE,
  MAX_TAG_NAME_LENGTH
} from '../utils/constants'
import { logger } from '../utils/logger'
import { t } from '../i18n'

// ============ 通用 zod schema 集合 ============

/**
 * 通用 schema 集合
 *
 * 所有 handler 应优先复用这些 schema，避免散落的内联定义。
 * schema 命名规则：业务字段名 + Schema 后缀。
 */
export const schemas = {
  /** 单个绝对文件路径（1-1024 字符） */
  filePath: z
    .string()
    .min(1, t('main.validator.pathRequired'))
    .max(MAX_FILE_PATH_LENGTH, t('main.validator.pathMaxLength', { max: MAX_FILE_PATH_LENGTH })),

  /** 文件路径数组（1-1000 个元素，每个 1-1024 字符） */
  filePathArray: z
    .array(
      z
        .string()
        .min(1, t('main.validator.pathRequired'))
        .max(MAX_FILE_PATH_LENGTH, t('main.validator.pathMaxLength', { max: MAX_FILE_PATH_LENGTH }))
    )
    .min(1, t('main.validator.pathArrayRequired'))
    .max(MAX_PATH_ARRAY_SIZE, t('main.validator.pathArrayMaxLength', { max: MAX_PATH_ARRAY_SIZE })),

  /** mediaId（正整数） */
  mediaId: z.number().int().positive(t('main.validator.mediaIdPositive')),

  /** mediaId 数组（1-1000 个正整数） */
  mediaIdArray: z
    .array(z.number().int().positive(t('main.validator.mediaIdPositive')))
    .min(1, t('main.validator.mediaIdsRequired'))
    .max(
      MAX_MEDIA_ID_ARRAY_SIZE,
      t('main.validator.mediaIdsMaxLength', { max: MAX_MEDIA_ID_ARRAY_SIZE })
    ),

  /**
   * mediaId 批量数组（用于软删除/恢复/彻底删除）：保留元素级校验（正整数 + 非空），
   * 但**去掉 1000 人为上限**——下游 media-repository 经 sql-chunk 的 chunkArray 已按 500 分片，
   * 可承载任意长度数组。修复「参数校验失败：mediaId 数组长度上限 1000」批量删除报错。
   */
  mediaIdArrayBulk: z
    .array(z.number().int().positive(t('main.validator.mediaIdPositive')))
    .min(1, t('main.validator.mediaIdsRequired')),

  /** 评分（0-5 整数） */
  rating: z.number().int().min(0).max(5, t('main.validator.ratingRange')),

  /** 整数 ID（正整数，通用） */
  positiveIntId: z.number().int().positive(t('main.validator.idPositive')),

  /** 短字符串（1-64 字符，用于标签/分类名等） */
  shortString: (max = MAX_TAG_NAME_LENGTH) =>
    z
      .string()
      .min(1, t('main.validator.stringRequired'))
      .max(max, t('main.validator.stringMaxLength', { max }))
      .refine(
        // eslint-disable-next-line no-control-regex
        (s) => !/[\x00-\x1f\x7f]/.test(s),
        t('main.validator.stringControlChars')
      ),

  /** UID（1-32 字符，仅字母数字） */
  uid: z
    .string()
    .min(1, t('main.validator.uidRequired'))
    .max(32, t('main.validator.uidMaxLength'))
    .regex(/^[A-Za-z0-9]+$/, t('main.validator.uidAlphanumeric')),

  /** HTTP/HTTPS URL（1-2048 字符） */
  httpUrl: z
    .string()
    .min(1, t('main.validator.urlRequired'))
    .max(2048, t('main.validator.urlMaxLength'))
    .url(t('main.validator.urlInvalid'))
    .refine(
      (u) => u.startsWith('http://') || u.startsWith('https://'),
      t('main.validator.urlHttpOnly')
    ),

  /** 主题枚举 */
  uiTheme: z.enum(['default', 'soft-pink-luxury']),

  /** 缩略图质量枚举 */
  thumbnailQuality: z.enum(['low', 'standard', 'high']).optional(),

  /** 备份文件名（严格正则约束，防路径穿越） */
  backupFilename: z
    .string()
    .regex(
      /^wxnn_photo_manager_\d{8}_\d{6}(_[a-zA-Z0-9]+)?\.db$/,
      t('main.validator.backupFilenameInvalid')
    ),

  /** 短 ID（用于故障 ID 等，1-100 字符） */
  shortId: z.string().min(1).max(100),

  /** 缓存上限字节数（正有限数） */
  cacheLimitBytes: z.number().finite().positive(t('main.validator.limitBytesPositive'))
} as const

// ============ 路径白名单 ============

/**
 * 文件操作路径白名单
 *
 * 设计原则：
 * - 默认拒绝：未注册且不在安全根下的路径一律拒绝
 * - 安全根：用户主目录、应用 userData 目录（始终允许）
 * - 动态注册：扫描器发现的媒体目录、用户对话框选择的目录、自定义目录设置
 * - 系统敏感目录：始终拒绝（即使被注册也不允许，作为兜底防线）
 *
 * 使用方式：
 * - 文件操作 handler 中调用 assertFileOpPath(path) 校验
 * - 扫描完成后调用 pathGuard.registerRoots(mediaRoots)
 * - 对话框选择后调用 pathGuard.register(selectedPath)
 */
class PathGuard {
  private roots = new Set<string>()
  private userHome = ''
  private userDataDir = ''

  constructor() {
    try {
      this.userHome = path.resolve(os.homedir()).toLowerCase()
    } catch {
      // 测试环境下 os.homedir() 可能抛错，留空字符串使后续检查回退到仅黑名单模式
    }
  }

  /** 初始化 userData 目录（必须在 app.whenReady 后调用） */
  initUserDataDir(): void {
    try {
      this.userDataDir = path.resolve(app.getPath('userData')).toLowerCase()
    } catch {
      // app 未 ready 时 getPath 抛错，忽略
    }
  }

  /** 注册单个根路径（幂等） */
  register(p: string): void {
    if (typeof p !== 'string' || p.length === 0) return
    try {
      const resolved = path.resolve(p).toLowerCase()
      this.roots.add(resolved)
    } catch {
      // 无效路径忽略
    }
  }

  /** 批量注册根路径 */
  registerRoots(paths: string[]): void {
    for (const p of paths) this.register(p)
  }

  /** 检查路径是否在白名单内（不抛错，返回布尔） */
  isAllowed(p: string): boolean {
    if (typeof p !== 'string' || p.length === 0) return false
    if (!path.isAbsolute(p)) return false

    let resolved: string
    try {
      resolved = path.resolve(p).toLowerCase()
    } catch {
      return false
    }

    // 1. 始终拒绝系统敏感目录（黑名单兜底）
    // FIX(组5-2): 改用共享的 isSensitivePath 模式判定——覆盖任意盘符系统目录、
    // UNC 管理共享与用户主目录凭据目录（原先仅 5 条硬编码 C: 盘路径）。
    // 热路径保持纯字符串匹配，不引入 realpath IO
    if (isSensitivePath(p)) return false

    // 2. 用户主目录与 userData 目录始终允许
    if (
      this.userHome &&
      (resolved === this.userHome || resolved.startsWith(this.userHome + path.sep))
    ) {
      return true
    }
    if (
      this.userDataDir &&
      (resolved === this.userDataDir || resolved.startsWith(this.userDataDir + path.sep))
    ) {
      return true
    }

    // 3. 检查已注册的根路径
    for (const root of this.roots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) return true
    }

    // 4. 默认拒绝
    return false
  }

  /**
   * 断言路径安全（失败抛 AppError.forbidden）
   * 文件操作 handler 调用此方法完成白名单校验
   */
  assertAllowed(p: string, op: 'read' | 'write' = 'write'): void {
    if (!this.isAllowed(p)) {
      throw AppError.forbidden(
        t('main.validator.pathNotAllowed', {
          op: op === 'write' ? t('main.validator.opWrite') : t('main.validator.opRead')
        }),
        {
          path: maskPath(p)
        }
      )
    }
  }

  /** 调试用：返回当前已注册的根数量 */
  size(): number {
    return this.roots.size
  }
}

/**
 * 脱敏路径：仅保留末尾 2 段，前面替换为 <...>
 * 用于日志/错误详情，避免完整路径泄露用户目录结构
 */
function maskPath(p: string): string {
  try {
    const resolved = path.resolve(p)
    const segments = resolved.split(path.sep).filter(Boolean)
    if (segments.length <= 2) return `<...>${path.sep}${segments.join(path.sep)}`
    return `<...>${path.sep}${segments.slice(-2).join(path.sep)}`
  } catch {
    return '<invalid-path>'
  }
}

/** 路径白名单单例（应用全局共享） */
export const pathGuard = new PathGuard()

/**
 * 校验文件操作路径（读模式）
 * handler 中使用：assertFileReadPath(filePath)
 */
export function assertFileReadPath(p: string): void {
  pathGuard.assertAllowed(p, 'read')
}

/**
 * 校验文件操作路径（写模式）
 * handler 中使用：assertFileWritePath(targetDir)
 */
export function assertFileWritePath(p: string): void {
  pathGuard.assertAllowed(p, 'write')
}

// ============ wrapHandler 高阶函数 ============

/**
 * zod schema 元组类型约束
 * 接受 z.tuple([...]) 形式的 schema，对应 IPC handler 的位置参数
 */
type ZodTupleSchema = z.ZodTuple<[z.ZodTypeAny, ...z.ZodTypeAny[]]>

/**
 * 将 zod schema 元组类型推断为 TS 元组
 */
type InferArgs<S extends ZodTupleSchema> = z.infer<S>

/**
 * wrapHandler 返回的 ipcMain.handle 回调签名
 */
type WrappedHandler<R> = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResponse<R>>

/**
 * 业务 handler 签名：接收已校验的参数元组 + 上下文 + IPC event
 */
type HandlerFn<S extends ZodTupleSchema, R> = (
  args: InferArgs<S>,
  ctx: HandlerContext,
  event: IpcMainInvokeEvent
) => Promise<R> | R

/**
 * 包装带参数的 IPC handler
 *
 * @param ctx 依赖注入上下文
 * @param schema zod 元组 schema，对应 handler 的位置参数
 * @param handler 业务函数，接收 [args元组, ctx, event]，返回业务数据 T
 * @returns 可直接传给 ipcMain.handle 的回调
 *
 * @example
 * ipcMain.handle(
 *   'file:delete',
 *   wrapHandler(ctx, z.tuple([schemas.filePathArray]), async ([paths]) => {
 *     return ctx.fileService.moveToRecycleBin(paths)
 *   })
 * )
 */
export function wrapHandler<S extends ZodTupleSchema, R>(
  ctx: HandlerContext,
  schema: S,
  handler: HandlerFn<S, R>
): WrappedHandler<R> {
  return async (event, ...rawArgs) => {
    try {
      const parseResult = schema.safeParse(rawArgs)
      if (!parseResult.success) {
        const message = parseResult.error.issues
          .map((i) => {
            const pathStr = i.path.length > 0 ? i.path.join('.') : 'root'
            return `[${pathStr}] ${i.message}`
          })
          .join('; ')
        return {
          success: false,
          error: {
            code: IPC_ERROR_CODES.VALIDATION_ERROR,
            message: t('main.validator.paramValidationFailed', { message }),
            details: parseResult.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
              code: i.code
            }))
          }
        }
      }
      const data = await handler(parseResult.data, ctx, event)
      return { success: true, data }
    } catch (error) {
      return handleError(error)
    }
  }
}

/**
 * 包装无参数的 IPC handler
 *
 * @param ctx 依赖注入上下文
 * @param handler 业务函数，返回业务数据 T
 */
export function wrapHandlerNoArgs<R>(
  ctx: HandlerContext,
  handler: (ctx: HandlerContext, event: IpcMainInvokeEvent) => Promise<R> | R
): (event: IpcMainInvokeEvent) => Promise<IpcResponse<R>> {
  return async (event) => {
    try {
      const data = await handler(ctx, event)
      return { success: true, data }
    } catch (error) {
      return handleError(error)
    }
  }
}

/**
 * 包装需要原始事件访问的 handler（用于 scanner:complete 等需要 event.sender 的场景）
 *
 * 与 wrapHandler 的差异：handler 接收未校验的原始参数数组，自行处理
 * 仅在参数结构特殊（如嵌套对象需手工校验）或需要 event.sender.send 时使用
 */
export function wrapHandlerRaw<R>(
  ctx: HandlerContext,
  handler: (args: unknown[], ctx: HandlerContext, event: IpcMainInvokeEvent) => Promise<R> | R
): (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<IpcResponse<R>> {
  return async (event, ...rawArgs) => {
    try {
      const data = await handler(rawArgs, ctx, event)
      return { success: true, data }
    } catch (error) {
      return handleError(error)
    }
  }
}

/**
 * 统一错误处理：AppError 提取 code/details，其他错误标记 INTERNAL_ERROR
 */
function handleError(error: unknown): IpcResponse<never> {
  if (isAppError(error)) {
    return { success: false, error: error.toIpcError() }
  }
  logger.error(t('main.validator.log.handlerUncaught'), error)
  return { success: false, error: toIpcError(error) }
}

// ============ 辅助：构造成功/失败响应 ============

/** 手动构造成功响应（少数非 wrapHandler 场景使用） */
export function ok<T>(data: T): IpcResponse<T> {
  return { success: true, data }
}

/** 手动构造失败响应 */
export function fail(
  code: string = IPC_ERROR_CODES.INTERNAL_ERROR,
  message: string,
  details?: unknown
): IpcResponse<never> {
  return {
    success: false,
    error: { code, message, ...(details !== undefined ? { details } : {}) }
  }
}
