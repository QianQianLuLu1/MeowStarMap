/**
 * SQLite `IN (...)` 参数分片工具。
 *
 * 背景：单条 SQL 的绑定参数受 SQLITE_MAX_VARIABLE_NUMBER 限制。
 * better-sqlite3 内置的 SQLite 新版编译值为 32766，但旧版本编译默认值仅 999，
 * 超限会抛 "too many SQL variables"。批量选中几千张照片时很容易触发。
 *
 * 取 500 作为分片大小：远低于 999 下限（给非 id 参数留足余量），
 * 同时单条语句仍足够大，不至于把一次批量操作打散成上百条 SQL。
 */
export const SQL_IN_CHUNK_SIZE = 500

/**
 * 把数组按 size 切成若干块。空数组返回空数组（调用方无需额外判空）。
 *
 * @param items 待分片的数组
 * @param size 每片最大长度，默认 {@link SQL_IN_CHUNK_SIZE}
 * @throws size 非正整数时抛错（静默取整会掩盖调用方的计算错误）
 */
export function chunkArray<T>(items: readonly T[], size: number = SQL_IN_CHUNK_SIZE): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkArray: size 必须是正整数，收到 ${size}`)
  }
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
