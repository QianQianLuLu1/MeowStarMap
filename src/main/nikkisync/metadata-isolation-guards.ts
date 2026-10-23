/**
 * 阶段 6：同步面与原有库的表级隔离护栏（零依赖纯函数）。
 *
 * 存在理由：整合阶段 6 的全部硬约束里，最难自动守住的一条是
 * 「同步侧绝不写原有库的表」（`media_files` 等）。既有测试只能证明
 * 「现在没写」，无法在将来有人往 `src/main/nikkisync/**` 里加一句针对该表的
 * 更新语句时先于人工评审失败。本模块把那条铁律折成一个可断言的谓词。
 *
 * 判据形态：只认 **SQL 语句上下文**里的表引用（`FROM` / `JOIN` / `UPDATE` /
 * `INSERT INTO` / `DELETE FROM` 之后紧跟的标识符），不做裸词匹配。
 * 这样中文说明里提到「`media_files` 表」不会被误判（那些散文本来就不是 SQL），
 * 而真会执行语句的写法必然落网。
 * 代价与约定：注释里**不要**逐字写出「UPDATE 某表 SET …」这类完整语句形态，
 * 改写散文即可（本模块自身就按该约定行文，并由结构档守护）。
 */

/**
 * 只存在于**原有库**（`meow_star_map.db`）的表名。
 *
 * 刻意**不含** `app_settings` 与 `schema_migrations`：这两个名字在 NikkiSync 自有库里
 * 同样存在（`migrations/0001_initial.sql` 里就有），列进来只会让同步面每次正常读写
 * 自己的同名表都误报，等于把护栏调成常真——那比没有护栏更糟。
 * 反之 `sync_*` 四组表与 `asset_edits` 虽然也是「同步能力」在用，但它们落在**原有库**里、
 * 归移植面仓储与叠加层仓储所有，内嵌装载缝同样不该写它们，故一并列入禁用集。
 */
export const ORIGINAL_ONLY_TABLES: readonly string[] = [
  'asset_edits',
  'categories',
  'character_profiles',
  'edit_history',
  'favorites',
  'filter_presets',
  'import_roots',
  'media_files',
  'media_fts',
  'operation_history',
  'pending_renames',
  'resonance_edits',
  'resonance_evo',
  'resonance_pearpal',
  'resonance_pulls',
  'resonance_wardrobe_items',
  'scan_history',
  'sync_change_journal',
  'sync_motion_links',
  'sync_paired_devices',
  'sync_pairing_sessions',
  'sync_service_state',
  'watermark_templates'
]

/** SQL 语句中「表引用」的位置：关键字之后紧跟的标识符。 */
const TABLE_REFERENCE_PATTERN =
  /\b(?:from|join|update|insert\s+into|delete\s+from)\s+([A-Za-z_][A-Za-z0-9_]*)/gi

/** 从一段 SQL 文本里取出所有被引用的表名（原样大小写，去重）。 */
export function sqlTableReferences(sql: string): string[] {
  const found = new Set<string>()
  // 复位 lastIndex：模式带 g 旗标，模块级常量在多次调用间共享游标
  TABLE_REFERENCE_PATTERN.lastIndex = 0
  for (const match of sql.matchAll(TABLE_REFERENCE_PATTERN)) {
    if (match[1]) found.add(match[1])
  }
  return [...found]
}

/**
 * 命中「只属于原有库」的表引用（大小写不敏感比较）。
 * 返回空数组即该段文本在表级上与原有库隔离。
 */
export function findOriginalTableRefs(sql: string): string[] {
  const forbidden = new Set(ORIGINAL_ONLY_TABLES.map((name) => name.toLowerCase()))
  return sqlTableReferences(sql).filter((name) => forbidden.has(name.toLowerCase()))
}

/** 断言形态的纯谓词：便于在测试与未来的提交闸门里共用一条判据。 */
export function isSyncLaneSqlAllowed(sql: string): boolean {
  return findOriginalTableRefs(sql).length === 0
}
