/**
 * CI 装置的 `node:sqlite` 轴：只把**数据库文件路径**翻译成沙箱里的真路径，其余一律透传。
 *
 * 为什么需要它：`@nikkisync/database` 的 `DatabaseManager` 用原生 `node:sqlite` 打开库文件
 * （`packages/database/src/database-manager.ts:14-17`：`await import('node:sqlite')` →
 * `new SqliteDatabase(filename)`），而第 4 轴只接管 `fs` API。装置形态的
 * `/tmp/nikkisync-sync-…/x/nikkisync.db` 交给原生句柄后按 OS 语义解析，在 Windows 上变成
 * 盘相对路径 `D:\tmp\…`，目录不存在 ⇒ `unable to open database file`（第 4 轮 RC-6，25 盏）。
 * 真 CI（ubuntu）上 `/tmp` 就是 `/tmp`，所以这一轴是把装置补成 CI 的形状。
 *
 * Gate A 实测（本轴的成立前提）：`vi.mock('node:sqlite')` **确实**接管了链在仓库外的
 * `@nikkisync/*` 包里那条变量式 `await import(specifier)`——哨兵 mock 的报错能从上游一路打到
 * `runtime-facade.ts`，说明这些包在 vitest 的模块图里、没有被外部化。
 *
 * 一个必须显式交代的坑：上游取构造器的方式是 `sqliteModule.Database ?? sqliteModule.DatabaseSync`，
 * 而 vitest 的 mock 代理对**未定义的导出**直接抛「No "Database" export is defined on the mock」
 * （Node 26 的 `node:sqlite` 根本没有 `Database` 导出）。所以工厂返回值必须把 `Database` 显式
 * 置为 `undefined`，让上游顺利落到 `?? DatabaseSync` 这一支。
 */
import { toReal } from './ci-linux-fs'

/** `vi.mock('node:sqlite')` 工厂（上游唯一可达的 specifier 就是 `node:sqlite`，不含 `bun:sqlite`） */
export async function ciLinuxSqliteHost(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    DatabaseSync?: new (location: string, options?: unknown) => unknown
  }
  const RealDatabaseSync = actual.DatabaseSync
  // 宿主没有这个导出（Node 版本差异）⇒ 不接管，交回原形，比打死整个 profile 更好判
  if (typeof RealDatabaseSync !== 'function') return actual
  // 用 extends 而不是「构造函数返回外来对象」：保住 instanceof 与原型链
  class CiLinuxDatabaseSync extends RealDatabaseSync {
    constructor(location: string, options?: unknown) {
      const realLocation = toReal(location) as string
      // options 缺席时**不能**把它显式传给 super：原生构造函数对第二参做
      // `The "options" argument must be an object` 类型检查（实测
      // `new DatabaseSync(':memory:', undefined)` 抛 ERR_INVALID_ARG_TYPE），
      // 而上游 `new SqliteDatabase(filename)` 正是单参形态。
      if (options === undefined) super(realLocation)
      else super(realLocation, options)
    }
  }
  const wrapped: Record<string, unknown> = { ...actual, DatabaseSync: CiLinuxDatabaseSync }
  return { ...wrapped, Database: undefined, default: wrapped }
}
