# AGENTS.md — `src/main/database`（数据库连接与仓储层）

本文件为 Agent 与新协作者提供 **数据库模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC handler 注册层约定见 [`../ipc/handlers/AGENTS.md`](../ipc/handlers/AGENTS.md)；AppError 错误分类等硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）。本文件只补 **本目录内** 的连接管理、读写分离、仓储模式与测试约定。

## 模块概述

`src/main/database/` 承载主进程侧的 **better-sqlite3 连接管理、schema 迁移、仓储（Repository）类与写 Worker 进程**。采用 **读写分离架构**：读操作在主进程同步执行，写操作经独立 `utilityProcess` worker 异步执行，避免 better-sqlite3 同步 I/O 阻塞主进程事件循环。

**核心约束**：数据库层只负责 SQL 访问与持久化，**不注册任何 `ipcMain.handle``**——IPC 注册职责完全在 [`../ipc/handlers/`](../ipc/handlers/) 层。仓储通过 `DatabaseManager` 向 handler 与 service 层提供数据访问能力。

## 目录结构

```
src/main/database/
├── connection.ts                          # DatabaseManager 类：连接管理、schema 迁移、PRAGMA、完整性校验、自恢复
├── media-repository.ts                    # MediaRepository：media_files / categories / character_profiles 等表的 SQL 访问层
├── import-root-repository.ts              # ImportRootRepository：import_roots 表的 SQL 访问层
├── resonance-repository.ts                # ResonanceRepository：resonance_* 系列表的 SQL 访问层
├── asset-edits-repository.ts              # AssetEditsRepository：asset_edits 表（同步面编辑覆盖层）
├── sync-pairing-repository.ts             # SyncPairingRepository：sync_pairing_sessions 一次性配对令牌
├── sync-metadata-repository.ts            # SyncMetadataRepository：sync_* 四表 + 只读 media_files
├── sync-read-repository.ts                # SyncReadRepository：media_files / sync_change_journal 的读取面
├── sync-row-mappers.ts                    # 同步面行 → DTO 零转换透传映射（与上游列名对齐）
├── sql-chunk.ts                           # SQLite IN (...) 参数分片工具（SQLITE_MAX_VARIABLE_NUMBER 安全分片）
├── worker/
│   ├── worker-protocol.ts                 # 主进程 ↔ database worker 消息协议（DbWorkerCommand / DbWorkerEvent）
│   ├── database-worker-bridge.ts          # DatabaseWorkerBridge：主进程侧 worker 生命周期管理与写请求队列
│   ├── database-worker.ts                 # worker 进程入口：独立 better-sqlite3 连接，仅响应写指令
│   └── *.test.ts                          # worker 层单元测试
└── *.test.ts                              # 仓储层与连接层单元测试（Vitest，npm run test:main）
```

## 1. 读写分离架构

### 1.1 核心原则

- **读操作（SELECT）**：在 Repository 方法中 **同步** 执行，直接走主进程 `db` 连接（`db.get()` / `db.all()`）。读多写少，且查询需要同步语义（handler 需立即返回结果给渲染层）。
- **写操作（INSERT / UPDATE / DELETE / 事务）**：**必须** 通过 `runWrite()` 方法 **异步** 执行，内部调用 `DatabaseWorkerBridge` 转发到独立 worker 进程，避免 better-sqlite3 同步 I/O 阻塞主进程事件循环。

```ts
// 读：同步，直接走主进程 db
listMedia(): MediaRow[] {
  return this.db.prepare('SELECT ... FROM media_files WHERE ...').all() as MediaRow[]
}

// 写：async，经 worker bridge
async softDeleteMedia(id: number): Promise<void> {
  await this.runWrite('UPDATE media_files SET is_deleted = 1 WHERE id = ?', [id])
}
```

### 1.2 `runWrite` 降级机制

每个 Repository 内部统一使用 `runWrite(sql, params)` 私有方法：

- **注入了 `workerBridge` 时**：调用 `workerBridge.execute(dbPath, sql, params)` 走 worker 进程。
- **未注入 `workerBridge` 时**（测试场景 / 未启用 worker）：**降级为同步直写** 主进程 `db.prepare(sql).run(params)`。

```ts
private async runWrite(sql: string, params: unknown[]): Promise<void> {
  if (!this.workerBridge) {
    this.db.prepare(sql).run(params)  // 降级：同步直写
    return
  }
  await this.workerBridge.execute(this.dbPath, sql, params)  // 正常：走 worker
}
```

`DatabaseManager` 同样提供 `executeAsync()` 公共方法供非仓储的直接写操作使用，语义一致。

### 1.3 Worker 进程架构

- **独立 `utilityProcess`**：`database-worker.ts` 在独立进程中持有 better-sqlite3 连接，与主进程共享同一 db 文件。
- **通信协议**（`worker/worker-protocol.ts`）：
  - 主进程 → worker：`DB_OPEN` / `DB_EXECUTE` / `DB_EXECUTE_BATCH` / `DB_TRANSACTION` / `DB_DISPOSE`
  - worker → 主进程：`DB_READY` / `DB_RESULT` / `DB_LOG` / `DB_WORKER_ERROR` / `DB_WORKER_DISPOSED`
- **写请求队列**（`DatabaseWorkerBridge`）：`requestId` 单调递增，`pendingRequests: Map<requestId, { resolve, reject }>` 维护 Promise 映射；worker 返回 `DB_RESULT` 时按 requestId 匹配 resolve/reject。
- **超时保护**：单请求 60s 超时上限 + 15s 巡检间隔，防止 worker 卡死导致调用方永久等待。
- **自动重启**：worker 异常退出时由 `WorkerRestartPolicy` 延迟重启，下次写请求自动 fork 新 worker。
- **PRAGMA 一致**：worker 的 `openDatabase()` 与主进程 `DatabaseManager.initialize()` 设置完全相同的 PRAGMA（WAL、foreign_keys、synchronous、cache_size 等），确保 WAL 多连接并发安全。
- **DDL 不经过 worker**：schema 迁移与索引创建仍由主进程 `DatabaseManager.initialize()` 同步完成，worker 仅执行 DML 写操作。

## 2. better-sqlite3 连接管理与 WAL 并发约束

### 2.1 惰性加载

`better-sqlite3` 原生模块采用 **惰性加载**（`import()` 而非顶层 `require()`），使 ABI 不匹配时崩溃能被 `bootstrapApplication` 的 `try/catch` 捕获，而非在模块加载期静默崩溃导致白屏。`DatabaseManager` 缓存 `databaseCtor` 避免重复 `await import()`。

### 2.2 数据库文件位置

数据库文件固定存放在 `{userData}/database/meow_star_map.db`，由 `DatabaseManager` 构造函数自动创建目录。

### 2.3 WAL 模式与 PRAGMA

`initialize()` 在打开数据库后依次设置：

| PRAGMA               | 值            | 作用                                            |
| -------------------- | ------------- | ----------------------------------------------- |
| `journal_mode`       | `WAL`         | 写前日志，允许读写并发                          |
| `foreign_keys`       | `ON`          | 启用外键约束                                    |
| `synchronous`        | `NORMAL`      | WAL 模式下安全且性能优于 `FULL`                 |
| `cache_size`         | `-20000`      | 20MB 内存缓存                                   |
| `temp_store`         | `MEMORY`      | 临时表与排序使用内存                            |
| `mmap_size`          | `268435456`   | 256MB 内存映射 I/O 加速读取                     |
| `wal_autocheckpoint` | `1000`        | 自动 checkpoint 阈值（≈4MB），防止 WAL 无限膨胀 |
| `busy_timeout`       | `5000`        | 锁等待超时 5 秒（WAL 多连接并发必需）           |
| `auto_vacuum`        | `INCREMENTAL` | 增量回收空闲页（仅首次设置生效）                |

退出时执行 `wal_checkpoint(PASSIVE)` 尽力合并 WAL，`PRAGMA optimize` 维护查询计划统计。

### 2.4 WAL 并发安全

- **主进程 + worker 两个连接** 共享同一 db 文件，依赖 WAL 模式的读写并发能力。
- 两端均设置 `busy_timeout = 5000`，写冲突时自动重试 5 秒。
- **自恢复并发边界**：`attemptRecovery()` 前必须停止所有持有 dbPath 连接的 worker（`scannerWorkerBridge` / `workerBridge` / `mediaWorkerBridge`），通过 `stopWorkerForRestore()` + `hasLiveWorker()` 确认句柄释放后才执行 rename 覆盖，避免 Windows EPERM 共享冲突。

### 2.5 完整性校验与自恢复

- **分级策略**：`quick_check`（毫秒级）永远同步执行作为兜底安全网；失败时升级为同步 `integrity_check` + `attemptRecovery`。
- **干净退出标志**：`{dbPath}.clean-exit` 侧车文件标记正常退出；缺失时下次启动触发后台全量复核。
- **故障分类**（`DbFailureKind`）：锁/权限/磁盘满/ABI 不匹配/未知 → **保留在线库**，绝不覆盖；仅 CORRUPT / WAL_CORRUPT 在数据保全失败后才用备份覆盖。
- **WAL 恢复优先**：WAL 损坏先走 `runWALRecovery`（checkpoint 合并），失败才回退备份覆盖。

## 3. 仓储模式（Repository Pattern）

### 3.1 设计原则

- Repository **仅负责 SQL 访问**（`prepare` / `run` / `all` / `get` / `transaction`），**不含 IPC、不含副作用**（`dialog` / `fs.unlink` / `notifyMediaUpdated` 均留在 handler 层）。
- Repository 是 **测试接缝（seam）**：可对内存数据库（`new Database(':memory:')`）实例化并验证 SQL 行为，无需 mock Electron API。
- **SQL 一律为调用点静态字面量**，全部参数绑定，无任何拼接/插值/展开。

### 3.2 现有仓储

| 仓储                              | 覆盖表                                                                                                                                                                  | 写路径                                                 | 说明                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MediaRepository`                 | `media_files` / `categories` / `character_profiles` / `favorites` / `filter_presets` / `watermark_templates` / `edit_history` / `operation_history` / `pending_renames` | 经 worker bridge（async）                              | 最大仓储，21+ 个 media handler 的 SQL                                                                                                                                                                                                                                                                                     |
| `ImportRootRepository`            | `import_roots`                                                                                                                                                          | 经 worker bridge（async）                              | 导入根登记与放行                                                                                                                                                                                                                                                                                                          |
| `ResonanceRepository`             | `resonance_pulls` / `resonance_edits` / `resonance_pearpal` / `resonance_evo` / `resonance_wardrobe_items` / `resonance_banner_wishlist`                                | 同步直写（安全扫描工具误报待修正，方法签名保持 async） | 共鸣录数据                                                                                                                                                                                                                                                                                                                |
| `AssetEditsRepository`            | `asset_edits`                                                                                                                                                           | 经 worker bridge（async）                              | 同步面资产的编辑覆盖层，阶段4 新增；与 `media_files` 表级隔离，绝不回写                                                                                                                                                                                                                                                   |
| `SyncPairingRepository`           | `sync_pairing_sessions`                                                                                                                                                 | 经 worker bridge（async）                              | 一次性配对令牌，只存 sha256，兑换后置 `used_at`                                                                                                                                                                                                                                                                           |
| `SyncMetadataRepository`          | `sync_service_state` / `sync_paired_devices` / `sync_change_journal` / `sync_motion_links`，另**只读** `media_files`                                                    | 经 worker bridge（async）                              | 同步面元数据与 revision 推进；对 media_files 只 SELECT 不写                                                                                                                                                                                                                                                               |
| `SyncReadRepository`              | `media_files` / `sync_change_journal`                                                                                                                                   | 读为同步 SELECT；**另有一处同步直写**（见下）          | 供 preload 只读查询面按 revision 增量拉取。例外（§1.1 读写分离的一处违例，同表 `ResonanceRepository` 亦为同步直写）：`resolveSourceSha256()` 在 sha256 缺失时算完直接 `UPDATE media_files SET sha256 = ? WHERE id = ?`（同步、不经 worker bridge），属缓存回填而非业务写；改动它须同时回归 `sync-read-repository.test.ts` |
| `sync-row-mappers.ts`（非仓储类） | —                                                                                                                                                                       | —                                                      | 同步面行 → DTO 零转换透传映射，列名与上游对齐                                                                                                                                                                                                                                                                             |

### 3.3 Row Types

- 每个仓储在文件顶部定义对应的 **Row Type**（如 `MediaRow`、`ImportRootRow`），与数据库表列一一对应。
- 数值型布尔字段（`is_favorite` / `is_deleted` / `is_missing` 等）保持 **raw DB 值（0/1)**，由 IPC handler 在响应塑形时转为 `boolean`。
- Row Types 定义在仓储文件中；跨进程共享的类型（如 `SearchableDocRow`、`ResonancePullRow`）放在 `src/shared/types/`。

### 3.4 Schema 迁移

- 迁移由 `DatabaseManager.applyMigrations()` 在 `initialize()` 内 **同步执行**，包裹在 `db.transaction()` 中保证原子性。
- **迁移前备份**：`VACUUM INTO` 生成带时间戳的独立 `.db` 文件，仅当"确有待执行迁移 + 库里已有用户表"时触发。
- **幂等设计**：所有 `CREATE TABLE` 使用 `IF NOT EXISTS`；新增列使用 `safeEnsureColumn()`（`ALTER TABLE ADD COLUMN` + 忽略"duplicate column name"错误）。
- **版本号迁移**：`schema_migrations` 表记录已应用的命名迁移与版本号，`KNOWN_MIGRATION_VERSIONS` 数组跟踪。
- **迁移失败处理**：事务自动回滚 → `quick_check` 探测库可用性 → 不可用时回滚到 `VACUUM` 备份。
- **新增迁移步骤**：在 `applyMigrations()` 末尾添加新的 `migrateXxx()` 方法调用，内部使用 `safeEnsureColumn()` 或幂等 DDL；若需版本标记则调用 `markMigrationVersionApplied(n)`。

### 3.5 `IN (...)` 参数分片

`sql-chunk.ts` 提供 `chunkArray()` 工具，将大数组按 500 片分片，避免超过 `SQLITE_MAX_VARIABLE_NUMBER`（999）限制。批量 `IN (...)` 查询 **必须** 使用此工具：

```ts
const chunks = chunkArray(ids)
for (const chunk of chunks) {
  const placeholders = chunk.map(() => '?').join(',')
  db.prepare(`... WHERE id IN (${placeholders})`).run(...chunk)
}
```

## 4. FakeDb 测试约定

### 4.1 两种测试策略

| 策略                              | 适用场景                                                                                         | 示例                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| **FakeDb（SQL 匹配桩）**          | 被测代码 SQL 模式有限且固定，通过正则匹配 SQL 字符串返回预设数据                                 | `import-root-repository.test.ts`、`database-worker.test.ts` |
| **MockDatabase（内存 SQL 引擎）** | 被测代码 SQL 模式丰富多样，需要真实 SQL 语义（CREATE TABLE / INSERT / SELECT / UPDATE / DELETE） | `media-repository.test.ts`                                  |

### 4.2 FakeDb 约定

- FakeDb 实现 `prepare()` / `exec()` / `pragma()` 等 `Database.Database` 接口子集，通过 `as unknown as Database.Database` 转型注入。
- 内部用正则匹配 SQL 字符串，按表结构返回内存数组数据。
- **只覆盖被测代码实际用到的 SQL**，未匹配的 SQL 抛 `FakeDb: 未覆盖的 SQL: ${sql}` 快速暴露遗漏。
- 测试 worker bridge 注入时：构造 mock `bridge = { execute: vi.fn() }` 验证写操作经 worker 而非直写。

### 4.3 MockDatabase 约定

- 实现简化内存 SQL 引擎（解析 CREATE TABLE / INSERT / UPDATE / DELETE / SELECT），支持 `:memory:` 路径。
- 通过 `vi.mock('better-sqlite3', ...)` 全局替换构造函数，使被测代码无感知。
- 测试内用 `db.exec(...)` 建表后实例化 Repository，验证完整 SQL 行为。

### 4.4 通用约定

- 单元测试与源码同目录，命名 `*.test.ts`（Vitest，`npm run test:main`）。
- 测试中 **不依赖真实 better-sqlite3 原生模块**（避免 Node ABI 兼容问题），一律使用 FakeDb 或 MockDatabase。
- 写操作测试须验证两条路径：①未注入 bridge 时降级同步直写；②注入 bridge 时写操作经 worker（`bridge.execute` 被调用）。

## 5. 与 IPC handler 的依赖关系

### 5.1 依赖方向

```
IPC handler 层  →  Repository 层  →  DatabaseManager
     ↓                   ↓                  ↓
  参数校验           SQL 访问          连接 & 迁移
  响应包装           (同步读/async写)    (WAL/PRAGMA)
  AppError
```

- **handler 层**（`src/main/ipc/handlers/`）通过 `HandlerContext.dbManager` 获取 `DatabaseManager`，再构造或获取 Repository 实例。
- **handler 内每次调用动态获取 Repository**（如 `const getRepo = () => {...}`），因 `db` 可能在初始化/重连时变化；db 缺失时抛 `AppError`。
- **Repository 不 import `ipcMain`**，不感知 IPC 通道——所有 IPC 相关逻辑（参数校验、响应塑形、错误捕获）留在 handler 层。

### 5.2 service 层的数据库访问

- `src/main/services/` 中的 service 同样通过注入的 `DatabaseManager` 或 Repository 访问数据库。
- service 不直接操作 `db` 连接——通过 Repository 或直接使用 `DatabaseManager.execute()` / `query()` / `getSetting()` / `setSetting()`。

### 5.3 注意事项

- **Repository 不注册 IPC handler**——IPC 注册职责在 handler 层。
- **Repository 不直接访问 `Application` 单例**——通过构造函数注入 `db` 与 `workerBridge`。
- 新增 Repository 时：若被多个 handler 共用则放入 `src/main/database/`；若仅被单个 handler 使用且逻辑简单，考虑内联到 handler 文件。
- 修改 Repository 公共签名时须同步检查对应 handler 与测试是否受影响。
- `DatabaseManager.getSetting()` / `setSetting()` 操作 `app_settings` 表（key-value 存储），`getSetting` 含运行时类型兼容检查（解析失败/类型不符时回退默认值）。
