/**
 * 重扫复位软删除状态所用 SQL 谓词（worker 与单测共享的唯一真源）
 *
 * 背景：扫描 UPSERT 的 `ON CONFLICT(file_path) DO UPDATE` 会在重扫重新发现文件时
 * 复位 `is_deleted`。复位范围必须**排除用户主动软删除**的记录——软删除不再搬动文件
 * （文件保留在原路径），若无条件复位，用户删掉的每张照片都会在下轮扫描复活，
 * 表现为"删了又回来"。
 *
 * 判定口径（与 `media_files.delete_origin` 列配套）：
 * - `'user'`：`media:softDelete` 触发的用户主动删除 → **不复位**（保留在回收站）
 * - `'root'`：`softDeleteByRootPath`（移除扫描源且清空记录）触发的整批软删 → 复位回图库
 * - `NULL`：升级前的存量旧记录 → 复位（与修复前行为一致，不引入回归）
 *
 * 抽为独立模块的原因：`worker-entry.ts` 是 utilityProcess 入口，import 即注册
 * parentPort 监听并可能 `process.exit`，无法被单测直接引入；纯字符串常量模块可在
 * 测试中直接驱动真实 SQL 执行做语义断言。
 */

/** 游戏目录树路径口径（小写 + 正斜杠）：自动发现的游戏安装树，不含用户自定义导入根 */
export const RESCAN_RESTORE_GAME_TREE =
  "(LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/gameplayphotos/%' OR LOWER(REPLACE(file_path, '\\', '/')) LIKE '%/x6game/%')"

/**
 * 重扫复位谓词：命中游戏目录树 **且** 不是用户主动软删除。
 * `COALESCE(delete_origin, '') <> 'user'` 使 NULL 的存量记录仍按旧行为复位。
 */
export const RESCAN_RESTORE_PREDICATE = `${RESCAN_RESTORE_GAME_TREE} AND COALESCE(delete_origin, '') <> 'user'`
