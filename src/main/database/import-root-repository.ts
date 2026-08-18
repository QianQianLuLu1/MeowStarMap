import type Database from 'better-sqlite3'
import type { DatabaseWorkerBridge } from './worker/database-worker-bridge'

/**
 * ImportRootRepository — import_roots 表的 SQL 访问层
 *
 * 导入根 = 用户手动导入的目标目录，被登记为"归本应用管理"的事实。
 * 与 app_settings.customScanPaths 的语义区别：
 *   - customScanPaths：用户配置"还要扫哪些目录"，可随时增删，不代表内容归属
 *   - import_roots：已导入内容的归属根，供图库放行与扫描索引共同引用
 * 两者互不覆盖，避免把导入行为写进扫描配置而污染其语义。
 *
 * 与 MediaRepository 一致的读写分工：
 *   - 写（INSERT/DELETE）async，经 database-worker；未注入 bridge 时降级同步直写（测试场景）
 *   - 读（SELECT）同步，直接走主进程 db 连接
 */

/**
 * 导入根路径归一化：去首尾空白 + 反斜杠转正斜杠 + 去尾部分隔符。
 *
 * 不做大小写折叠——存储保留原始大小写供界面展示，
 * 大小写不敏感的比较由 SQL 侧 LOWER() 负责（Windows 路径大小写不敏感）。
 * 'H:\Photos\' 与 'H:/Photos' 归一化后同为 'H:/Photos'，UNIQUE 约束才真正生效。
 */
export function normalizeRootPath(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

export class ImportRootRepository {
  /**
   * @param db 主进程数据库连接（查询用，同步）
   * @param workerBridge 写 worker 桥接（写用，async）。未注入时降级为同步直写 db
   * @param dbPath 数据库文件路径（workerBridge 需要）
   */
  constructor(
    private readonly db: Database.Database,
    private readonly workerBridge: DatabaseWorkerBridge | null = null,
    private readonly dbPath: string = ''
  ) {}

  /**
   * 登记一个导入根。已存在（归一化后相同）时静默跳过，可重复调用。
   * @throws rootPath 归一化后为空时抛错——空路径会让前缀匹配放行全库，必须显式拒绝
   */
  async addImportRoot(rootPath: string): Promise<void> {
    const normalized = this.requireRootPath(rootPath, 'addImportRoot')
    await this.runWrite(
      "INSERT OR IGNORE INTO import_roots (root_path, created_at) VALUES (?, datetime('now', 'localtime'))",
      [normalized]
    )
  }

  /** 按登记顺序返回全部导入根（归一化后的原始大小写路径） */
  listImportRoots(): string[] {
    const rows = this.db.prepare('SELECT root_path FROM import_roots ORDER BY id').all() as Array<{
      root_path: unknown
    }>
    const roots: string[] = []
    for (const row of rows) {
      // 防御脏数据：非字符串或空值直接跳过，不让单条坏记录影响整个放行条件
      if (typeof row.root_path === 'string' && row.root_path.length > 0) {
        roots.push(row.root_path)
      }
    }
    return roots
  }

  /**
   * 移除一个导入根。不存在时为无操作。
   * 用 LOWER() 比对，兼容 Windows 下大小写不同但指向同一目录的登记。
   */
  async removeImportRoot(rootPath: string): Promise<void> {
    const normalized = this.requireRootPath(rootPath, 'removeImportRoot')
    await this.runWrite('DELETE FROM import_roots WHERE LOWER(root_path) = LOWER(?)', [normalized])
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  /** 归一化并校验路径非空；空路径是调用方 bug，必须抛错而非静默 */
  private requireRootPath(rootPath: string, caller: string): string {
    const normalized = normalizeRootPath(rootPath)
    if (!normalized) {
      throw new Error(`${caller}: rootPath 不能为空`)
    }
    return normalized
  }

  /** 走 worker 执行写操作；未注入 bridge 时降级为同步直写 */
  private async runWrite(sql: string, params: unknown[]): Promise<void> {
    if (!this.workerBridge) {
      this.db.prepare(sql).run(params)
      return
    }
    await this.workerBridge.execute(this.dbPath, sql, params)
  }
}
