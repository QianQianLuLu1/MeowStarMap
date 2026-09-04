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
 * SQLite 单条 SQL 的绑定变量默认上限（SQLITE_MAX_VARIABLE_NUMBER）。
 * 旧版本 SQLite 编译默认值仅 999，超限会抛 "too many SQL variables"。
 * 任何动态 `IN (...)` 单条语句的占位符数都必须严格低于此值。
 */
export const SQLITE_MAX_VARIABLE_NUMBER = 999

/**
 * 单条动态 `IN (...)` 的安全上限余量。
 * 部分语句在 `IN (...)` 之外还带额外绑定参数（如
 * `UPDATE ... SET account_uid = ? WHERE id IN (...)` 多 1 个），
 * 故分片大小须为 keep below {@link SQLITE_MAX_VARIABLE_NUMBER} 并预留余量。
 */
export const SQL_IN_HEADROOM = 99

/** 分片大小的安全天花板：须 < {@link SQLITE_MAX_VARIABLE_NUMBER}，并为额外绑定参数留余量。 */
export const SQL_IN_SAFE_CEILING = SQLITE_MAX_VARIABLE_NUMBER - SQL_IN_HEADROOM // 900

/**
 * 校验分片大小：必须为正整数且不超过 {@link SQL_IN_SAFE_CEILING}，
 * 否则立即抛错（fail-fast），阻止把单条 `IN (...)` 推过 SQLite 变量上限。
 *
 * @throws size 非正整数或超出安全天花板时抛错
 */
export function assertChunkSize(size: number): void {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`assertChunkSize: size 必须是正整数，收到 ${size}`)
  }
  if (size > SQL_IN_SAFE_CEILING) {
    throw new Error(
      `assertChunkSize: size ${size} 超过单条 SQL 变量安全上限 ${SQL_IN_SAFE_CEILING}（SQLITE_MAX_VARIABLE_NUMBER=${SQLITE_MAX_VARIABLE_NUMBER}），会触发 "too many SQL variables"`
    )
  }
}

/**
 * 把数组按 size 切成若干块。空数组返回空数组（调用方无需额外判空）。
 *
 * @param items 待分片的数组
 * @param size 每片最大长度，默认 {@link SQL_IN_CHUNK_SIZE}
 * @throws size 非正整数时抛错（静默取整会掩盖调用方的计算错误）
 */
export function chunkArray<T>(items: readonly T[], size: number = SQL_IN_CHUNK_SIZE): T[][] {
  assertChunkSize(size)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
