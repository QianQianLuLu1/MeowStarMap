/**
 * NikkiSync 资源路径授权表（阶段 4 · `media://` 第 4 条规则的事实来源）。
 *
 * 为什么需要它：`src/main/app/media-protocol.ts` 的 `isMediaPathAllowed()` 既有三条规则
 * （缩略图缓存目录 / `media_files` 精确匹配 / 已索引 `source_path` 目录）只认本 App 自己的
 * `media_files` 表。图库改从 NikkiSync Runtime 取数后，资产的
 * `resources.source_path` 不在那份表里，`media://` 会一律 403 —— 而把整条协议另起一套
 * （`nikkisync://`）要同时改 `navigation-guard` 与 `preload/origin-guard` 两层互相镜像的
 * 放行集合，并重复实现 Range/ETag，代价与风险都更大。因此这里只补一张**精确匹配**的表。
 *
 * 安全口径（比既有规则 3 更窄，不得放宽）：
 * - 只做**确切文件**的精确匹配，不给目录级授权；
 * - 表项只由查询面在把路径交给渲染层时登记，外部无法自行写入；
 * - `libraryRevision` 变化 ⇒ 整表替换（扫描删除的资产不残留授权）；
 * - `clear()` 后一律拒绝（Runtime 停止 / 未就绪态）；
 * - 条目数硬上限 + 插入序淘汰，避免长会话无界增长。
 *
 * 扩展名白名单**不在**本表判：那是展示层的策略，留在 `media-protocol` 那道闸里，
 * 本文件只回答「这个确切路径，我们是否给出去过」。
 *
 * 字符串字面量保持英文（`src/**` 中文硬编码护栏为 error）；中文只出现在注释。
 */

import nodePath from 'node:path'
// 固化 win32 语义：本表是**纯键表**（值从不交给 fs，调用方传进来的已是 realpath 解引用后的
// 路径），键的归一与前缀形态必须与宿主无关。产品只发布 Windows x64，库里的资源路径恒为
// Windows 形态；用宿主 path 时，CI 的 ubuntu runner 上 `resolve('D:\\…')` 会把整串当相对名
// 拼到 cwd 之后，登记侧与查询侧虽然仍自洽，但折叠大小写那一半随平台开关失效（见下），
// 于是 `D:\A\B.png` 与 `d:\a\b.png` 被判成两个身份。与同层黑名单
// （utils/ipc-validate.ts）、白名单（ipc/validator.ts）同一口径。
const path = nodePath.win32

/** 表项硬上限：一页上限 500，留出约 40 屏的浏览窗口后开始淘汰最旧条目。 */
const MAX_ENTRIES = 20000

/**
 * Windows/NTFS 不区分大小写：DB 存 `D:\Photos`、请求 `d:\photos` 必须同一身份，否则裂图。
 * 这里**不再按平台开关**：产品只在 Windows 上跑，折叠是产品事实；条件折叠正是本轮要消灭的
 * 反模式（同层黑名单早已修过一处，白名单与本表是它漏掉的两处）。
 * 安全性口径不变：折叠只把「同一文件的不同写法」并成一个键，绝不放宽到目录前缀，
 * 未登记的确切路径仍然拒绝。
 */

/** 当前表所属的 `libraryRevision`；`undefined` 表示表已被清空（未就绪）。 */
let currentRevision: number | undefined

/** key = 归一化后的绝对路径；Map 的插入序即淘汰序。 */
const allowedPaths: Map<string, true> = new Map()

/** 归一化：按 win32 解析为绝对路径（消解 `..`、多余分隔符），再折叠大小写。 */
function normalizeKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase()
}

/** 可信条目判定：必须是含非空白字符的字符串。非字符串/空白一律忽略，不进表。 */
function usablePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 登记一批资源绝对路径。
 *
 * `revision` 与当前表不同 ⇒ 先整表替换再登记：扫描后已删除的资产不应继续可示。
 * 同一 `revision` 多次调用是**追加**（分页逐页登记）。
 */
export function registerNikkiSyncResourcePaths(revision: number, paths: readonly unknown[]): void {
  if (currentRevision !== undefined && currentRevision !== revision) {
    allowedPaths.clear()
  }
  currentRevision = revision
  for (const candidate of paths) {
    const value = usablePath(candidate)
    if (!value) continue
    const key = normalizeKey(value)
    // 先删后插：重复登记不膨胀，且把该 key 挪到插入序末尾（最近使用）
    allowedPaths.delete(key)
    allowedPaths.set(key, true)
    if (allowedPaths.size > MAX_ENTRIES) {
      const oldest = allowedPaths.keys().next().value
      if (oldest !== undefined) allowedPaths.delete(oldest)
    }
  }
}

/** 该**确切**路径是否被登记过（调用方传入的必须是已 realpath 解引用的路径）。 */
export function isNikkiSyncResourcePath(filePath: unknown): boolean {
  const value = usablePath(filePath)
  if (!value) return false
  return allowedPaths.has(normalizeKey(value))
}

/** 清空授权表并回到「未就绪」态：任何路径一律拒绝，直到重新登记。 */
export function clearNikkiSyncResourcePaths(): void {
  allowedPaths.clear()
  currentRevision = undefined
}

/** 诊断用：当前表项数量（不暴露任何绝对路径）。 */
export function nikkiSyncResourcePathCount(): number {
  return allowedPaths.size
}

/** 诊断用：表所属的 `libraryRevision`；未就绪时为 `undefined`。 */
export function nikkiSyncResourceRevision(): number | undefined {
  return currentRevision
}
