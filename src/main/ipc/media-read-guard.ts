/**
 * 读路径双层校验共享辅助函数
 *
 * 语义：媒体白名单优先、审批白名单（PathGuard）兜底：
 *   if (!isMediaPathAllowed(ctx, filePath)) assertFileReadPath(filePath)
 *
 * 设计动机：
 * - media://（图库显示）使用 isMediaPathAllowed 授权已索引媒体；
 *   IPC 文件读取类操作使用 PathGuard/assertFileReadPath 授权。两套白名单
 *   注册来源不同，对“已入库但不在 pathGuard.roots 内”的媒体会误拦截
 *   （如“图库右键属性 → 信息解析失败: 路径不在白名单内”）。
 * - 本函数将该放行模式统一抽取，供需要读取已入库媒体的 handler 复用，
 *   与 media:// 图库显示授权标准保持一致。
 *
 * 安全边界说明：
 * - 命中媒体白名单（缩略图缓存目录 / 已索引媒体精确匹配 / 已索引
 *   source_path 下的媒体扩展名文件）时直接放行；
 * - 快路径放行前追加敏感目录黑名单复检（isSensitivePath，纯字符串匹配零 IO）：
 *   敏感目录即使被媒体白名单命中也不走快路径，一律回落 assertFileReadPath
 *   由其拒绝（纵深防御，不依赖媒体白名单自身的黑名单完备性）；
 * - 快路径命中后再对 realpath 结果做一次敏感目录复检（见下）：纯字符串匹配
 *   无法识别符号链接 / junction，真实路径落敏感目录时回落 assertFileReadPath(real)
 *   由 PathGuard 拒绝；
 * - 未命中时仍走原 assertFileReadPath 兜底，保留既有安全边界，
 *   不会放宽任何现有约束；
 * - isMediaPathAllowed 内部异常时保守返回 false（见 media-protocol.ts），
 *   因此异常路径一律回落到 PathGuard 校验，不会产生放行漏洞。
 *
 * realpath 复检（快路径命中时的纵深防御，2026-08-29 收敛）：
 * - 背景：isSensitivePath 与 isMediaPathAllowed 均为纯字符串匹配。在已索引媒体
 *   目录下放置“媒体扩展名的符号链接 / junction”（如 ScreenShot\evil.jpg →
 *   %USERPROFILE%\.aws\credentials）时，两者都不命中黑名单、快路径直接 return，
 *   PathGuard 根本不执行——原注释所称“由 PathGuard 兜底路径覆盖”在命中分支不成立。
 * - 现行口径：快路径命中后调用 fs.realpathSync.native 解引用一次，
 *   isSensitivePath(real) 命中即回落 assertFileReadPath(real)，由 PathGuard 统一
 *   抛 AppError.forbidden（IPC_PATH_FORBIDDEN），复用既有错误与脱敏语义。
 * - IO 约定：同步 IO 只发生在快路径命中分支（前提是路径已在已索引媒体目录内）；
 *   未命中分支保持零 IO，“热路径无 IO”的整体约定不变。
 * - 不缓存 realpath 结果：缓存有效期内把普通文件替换为符号链接即可绕过（TOCTOU），
 *   故每次命中都真实 syscall（与 media-protocol.ts 的 realpathCache 取舍不同，
 *   后者是显示链路的性能优先选择）。
 * - 已知残留面（有意取舍）：复检只比对敏感目录黑名单，不重跑
 *   isMediaPathAllowed(ctx, real)，因此软链指向“非敏感的普通文件”
 *   （如 D:\Work\合同.pdf）仍可被读取，与 media:// 的 resolveRealPath +
 *   白名单复检口径仍有差异；收紧需同时评估媒体目录本身位于 junction 上的兼容性。
 */
import fs from 'fs'
import type { HandlerContext } from './handler-context'
import { assertFileReadPath, pathGuard } from './validator'
import { isMediaPathAllowed } from '../app/media-protocol'
import { isSensitivePath } from '../utils/ipc-validate'
import { logger } from '../utils/logger'
import { t } from '../i18n'

/**
 * 断言文件读取路径安全（双层白名单 + 敏感目录黑名单复检 + realpath 复检）。
 *
 * 命中媒体白名单且非敏感目录时，先对 realpath 结果复检敏感目录黑名单：
 * 真实路径落敏感目录则回落 assertFileReadPath(real) 由 PathGuard 拒绝；
 * realpath 失败（不存在 / 无权限）维持放行，交由下游读取报错。
 * 复检通过后放行并记录 debug 日志（复用 decrypt 域既有 i18n key，不新增 key）；
 * 快路径未命中时回退 assertFileReadPath(filePath)，由其抛出
 * AppError.forbidden（IPC_PATH_FORBIDDEN）拦截。
 */
export function assertMediaReadPath(ctx: HandlerContext, filePath: string): void {
  if (!isSensitivePath(filePath) && isMediaPathAllowed(ctx, filePath)) {
    // 纵深防御：快路径的纯字符串匹配无法识别符号链接 / junction，
    // 命中后再对真实路径复检一次敏感目录黑名单（仅命中时付出一次同步 IO）
    let real: string | null = null
    try {
      real = fs.realpathSync.native(filePath)
    } catch {
      // realpath 失败（文件不存在 / 无权限）：维持模式匹配结果放行，
      // 交由下游实际读取自行报错（与写通道 validateNonSensitivePath 一致）
      real = null
    }
    if (real !== null && isSensitivePath(real)) {
      assertFileReadPath(real)
      return
    }
    logger.debug(t('main.decrypt.log.mediaWhitelistHit'), filePath)
    return
  }
  assertFileReadPath(filePath)
}

/**
 * 断言删除路径安全（删除通道三级校验：userPicked → 媒体白名单 → PathGuard 兜底）。
 *
 * 供 file:delete / file:deletePermanent 等删除类通道使用，与
 * `assertMediaReadPath` 的差异：删除的是「DB 中已展示的媒体」这一窄集合，
 * 因此快路径不做 isSensitivePath 前置闸门——否则游戏装在
 * Program Files / ProgramData 等系统目录形态下时，已入库媒体
 * （media:// 可正常展示、media:permanentDelete 可直接彻底删除）
 * 却无法经 file:delete 移入回收站（删除白名单口径不一致）。
 *
 * 1. pathGuard.isUserPicked 命中 → 放行：用户在系统对话框中显式选中目录属
 *    真实授权行为，与 scanner:start / settings:set 对 userPicked 的短路同语义；
 * 2. isMediaPathAllowed 命中 → 放行：已入库 file_path 精确匹配 / 原生缩略图 /
 *    已索引 source_path 下媒体扩展名文件，与 media:// 展示授权同口径；
 * 3. 否则 assertFileReadPath 兜底：任意未入库路径（含敏感目录下未入库文件）
 *    仍被 PathGuard + 黑名单拒绝，不放宽既有安全边界。
 *
 * 安全边界说明：
 * - 零 IO：isUserPicked 纯字符串匹配；isMediaPathAllowed 自带 5 分钟 TTL 缓存，
 *   不使用 fs/realpath（与读通道的 realpath 复检取舍不同——删除目标来自渲染层
 *   已展示的 DB 路径，不存在「读侧已暴露、删侧新增」的暴露面）；
 * - 已知残留面（有意取舍，与本文件头注释 §已知残留面一致）：已索引 source_path
 *   下、媒体扩展名的符号链接/junction 指向敏感文件时与 media:// 读取同口径放行；
 * - isMediaPathAllowed 内部异常时保守返回 false，异常路径一律回落 PathGuard。
 */
export function assertMediaDeletePath(ctx: HandlerContext, filePath: string): void {
  if (pathGuard.isUserPicked(filePath)) return
  if (isMediaPathAllowed(ctx, filePath)) return
  assertFileReadPath(filePath)
}
