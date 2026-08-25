/**
 * 文件完整性校验（checkMissingFiles）的根目录差量过滤。
 *
 * 背景：增量扫描只扫"变更目录"，但原 checkMissingFiles 仍对整个媒体库未删除记录
 * 逐页 fsp.access 校验（8 路并发），即使用户只增量扫了一个小目录，也会触发全库
 * 数万次磁盘访问，抵消增量"只扫变更目录"的核心收益。
 *
 * 做法：把本次增量扫描实际覆盖的根目录集合转换为 SQL LIKE 前缀过滤子句，
 * 仅校验这些根目录下的未删除记录。
 *
 * 转义约定与 worker-entry.ts 的 existingFiles 查询保持一致（FIX 组3-5）：
 * - ESCAPE 字符用反斜杠 '\'，路径中的 \ / % / _ 经 replace(/[\\%_]/g, '\\$&') 转义，
 *   防止被 LIKE 误当通配符（如 C:\foo 误匹配 C:\foobar）。
 * - 前缀锚定 path.sep：root + sep 作为前缀，确保只命中 root 自身目录树下的文件。
 * - 参数化绑定（? 占位），多根 OR 拼接，杜绝 SQL 注入并保留预编译语句复用。
 *
 * 大小写一致性（Windows 路径大小写不敏感）：
 * stock SQLite 默认 BINARY 排序下，`file_path LIKE prefix%` 仅对 ASCII 大小写不敏感，
 * CJK/Unicode 大小写差异会被漏匹配——若 root 与已存 file_path 大小写不一致，整棵子树
 * 会被跳过 is_missing 校验（误判为"文件未删除"）。故两侧（本过滤与 existingFiles）
 * 统一用 `LOWER(REPLACE(file_path, '\', '/'))` 归一化范式（与 media-repository 的
 * GALLERY_PATH_CONDITION / NORMALIZED_PATH_EXPR 同口径），覆盖全部字符大小写。
 * 代价：LIKE 作用在表达式上，file_path 唯一索引退化为全扫描；该查询仅校验增量根集合、
 * 行量小，可接受。param 须先 replace(/\\/g, '/').toLowerCase() 再 escapeLikePattern，
 * 否则 escapeLikePattern 产生的转义反斜杠 '\' 会被 REPLACE 误改成 '/' 破坏 ESCAPE 语义。
 */
import path from 'path'

const LIKE_SPECIAL = /[\\%_]/g

/** file_path 归一化表达式：反斜杠转正斜杠 + 小写，与 media-repository NORMALIZED_PATH_EXPR 同口径。 */
export const NORMALIZED_PATH_EXPR = "LOWER(REPLACE(file_path, '\\', '/'))"

/** 单根差量过滤子句模板（与 existingFiles 查询同口径的大小写不敏感范式）。 */
export const ROOT_LIKE_CLAUSE = `${NORMALIZED_PATH_EXPR} LIKE LOWER(?) ESCAPE '\\'`

/** 转义 LIKE 通配符（\ % _），与 existingFiles 查询同款转义。 */
export function escapeLikePattern(value: string): string {
  return value.replace(LIKE_SPECIAL, (ch) => `\\${ch}`)
}

/**
 * 把根目录规整为 LIKE 前缀参数：先反斜杠转正斜杠 + 小写，再转义通配符，最后追加尾缀 '%'。
 * 导出供 worker-entry.ts 的 existingFiles 增量查询复用，确保与 ROOT_LIKE_CLAUSE 完全对称。
 */
export function normalizeRootPrefixForLike(root: string, sep: string): string {
  const prefix = root.endsWith(sep) ? root : root + sep
  return escapeLikePattern(prefix.replace(/\\/g, '/').toLowerCase()) + '%'
}

export interface IntegrityRootFilter {
  /** 注入 WHERE 的 AND 子句，例如 "LOWER(REPLACE(file_path, '\', '/')) LIKE LOWER(?) ESCAPE '\' OR ..."（不含前导 AND） */
  clause: string
  /** 与 clause 占位符一一对应的参数：每个为 normalizeRootPrefixForLike(root, sep) */
  params: string[]
}

/**
 * 根据根目录集合构建差量过滤。
 *
 * - `undefined`：旧调用方/遗留路径 → 返回 null，调用方不加任何过滤（全库校验旧语义，向后兼容）。
 * - 空数组 `[]`：防御性 → 返回 `0=1`，总行数为 0、直接跳过校验（无根可校验）。
 * - 非空数组：多根 OR 拼接的 LIKE 前缀过滤（大小写不敏感，与 existingFiles 同口径）。
 */
export function buildIntegrityRootFilter(roots?: string[]): IntegrityRootFilter | null {
  if (roots === undefined) return null
  if (roots.length === 0) return { clause: '0=1', params: [] }

  const params = roots.map((root) => normalizeRootPrefixForLike(root, path.sep))
  const clause = params.map(() => ROOT_LIKE_CLAUSE).join(' OR ')
  return { clause, params }
}
