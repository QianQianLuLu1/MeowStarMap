# 修复日志

> 依据 `.review/issues.md`（2026-08-16）按严重度分批修复。本轮范围：全部 high（critical 为 0）。
> 测试命令：`npm test`（vitest run，全量 157 文件 / 3247 用例）。

## 批次 1

- 修复问题：组5-1（high，shell:openPath 可执行文件启动通道）
- 修改文件：
  - src/main/ipc/handlers/shell-handler.ts：新增 `EXECUTABLE_PATH_EXTENSIONS` 黑名单常量（.exe/.bat/.cmd/.scr/.com/.msi/.ps1/.vbs/.js/.hta/.lnk 等 24 种可执行/脚本扩展名）与 `assertNotExecutablePath` 校验函数；`shell:openPath` handler 在 `assertShellPathSafe` 之后追加调用，命中黑名单抛 `AppError.forbidden`（IPC_PATH_FORBIDDEN）。`showItemInFolder` 仅定位不执行，未改动。
  - src/main/ipc/handlers/shell-handler.test.ts：新增 4 个用例——openPath 拒绝 .exe、拒绝 .scr/.bat/.ps1/.lnk 且不触达 shell API、普通图片文件放行、showItemInFolder 对 .exe 仍放行（锁定拦截范围仅 openPath）。
- 测试运行：通过（shell-handler.test.ts 14/14；全量 3247/3247）
- 自验结论：PASS

## 批次 2

- 修复问题：组9-1（high，DB worker 致命错误 exit(0) 致自动重启/崩溃通知失效 + 启动期写请求永久挂起）
- 修改文件：
  - src/main/database/worker/database-worker.ts：拆分 `cleanupDb`（纯资源清理）与 `cleanupAndExit(exitCode=0)`；DB_OPEN 失败、uncaughtException、unhandledRejection 三个致命路径改为 `cleanupAndExit(1)`，使 bridge 的 `code !== 0` 崩溃判定生效（触发 fault 日志 + attemptAutoRestart）；DB_DISPOSE 保持 exit 0；`process.on('exit')` 兜底改为仅调用 `cleanupDb`（exit 事件期间不再调用 process.exit，退出码由原 fatal/normal 路径决定）。
  - src/main/database/worker/database-worker-bridge.ts：新增 `readyReject` 字段与 `failReadyHandshake(reason)` 统一失败入口（清空握手状态并 reject readyPromise）；三处接入——① `DB_WORKER_ERROR` 消息到达且握手未完成时（DB_OPEN 失败先于 exit 到达）；② `handleWorkerExit` 中握手未完成时（worker 在 DB_READY 前死亡）；③ `dispose()` 中握手中止兜底。`ensureWorker` 与 attemptAutoRestart 无 dbPath 分支的 Promise 构造同步保存 reject 句柄。
- 测试运行：通过（全量 3247/3247）；typecheck（tsc -b）在我改动的文件无错误——存在 4 个预先存在的错误位于 src/renderer/pages/settings/scan-sections.tsx（importRoot API，属工作区未提交的导入根功能），与本批无关
- 自验结论：PASS
- 说明：两文件无既有专用测试；修复参照了同仓 media-worker bridge 的 failReadyHandshake 模式。scanner/media worker 的同类 exit(0) 问题属组2-4/组11-2（medium），本轮不处理。

## 批次 3

- 修复问题：组3-1（high，saveBatchToDatabase 抛错被降级为"跳过目录"，整批最多 500 条文件静默丢弃且扫描仍报成功）
- 修改文件：
  - src/main/scanner/worker-entry.ts：
    - 新增 `ScanBatchWriteError` 标记错误类（"流式写入数据库"区块）；
    - `saveBatchToDatabase` 将 prepare 与 `insertMany(batch)` 事务执行包入 try/catch，抛错时统一包装为 ScanBatchWriteError 携带批次大小向上传播（SQL 文本与写入字段不变）；
    - `scan` 递归的 catch 识别 ScanBatchWriteError 后 workerLog('error') 并 rethrow（不再按"跳过目录"降级），错误经 scanDirectory → startScan 外层 catch（既有）转为 `SCAN_COMPLETE { success:false, message:'扫描失败: 数据库批量写入失败…' }` 上报渲染端。视频任务的 addFile 失败经 runWithConcurrency（Promise.all）同样传播。未扩 worker 协议（复用既有失败通道）。
  - src/main/scanner/**tests**/scan-batch-write-failure.test.ts（新增）：2 个用例——① media_files INSERT 抛 SQLITE_BUSY 时 SCAN_COMPLETE 为 success:false 且 message 含"扫描失败/数据库批量写入失败/SQLITE_BUSY"；② 对照组正常写库仍 success:true。驱动方式：parentPort 桩 + Module._load 挂钩替换 better-sqlite3（vite-node 注入的原生 require 不经 vi.mock 注册表，且本机 native 模块为 Electron ABI 在 Node 下无法加载，故挂钩 CJS 加载器入口定向替换，afterAll 还原）。
- 测试运行：通过（新文件 2/2；全量 158 文件 3249/3249）；typecheck 无新增错误
- 自验结论：PASS

## 批次 4

- 修复问题：组22-1 + 组22-2 + 组20-1（high，搜索体系三处联动失效，issues.md 建议一并修复）
- 修改文件：
  - src/renderer/search/search-service.ts（组22-1）：`init()` 导入成功后 `indexedDocCount` 不再取 `segments.length`（导出分片数，通常个位数），改为新增的 `countImportedDocs()` 解析 flexsearch reg 分片（键形如 "N.reg" 的文档 id 注册表，已核对 node_modules/flexsearch 0.8.212 serialize.js 的 save/reg_to_json 实现）统计实际文档数；无 reg 分片或解析失败回退 0，由既有 5% 偏差校验触发重建兜底。
  - src/renderer/search/use-search-index.ts（组22-2）：新增 `hasBaselineRef` 标志替代 `lastSeen.size === 0` 判定"首次 baseline"——空 baseline（DB 首启/取数未完成时首次 ready）之后 mediaFiles 变非空不再被吞，走正常 diff 将新增文件加入索引；effect 增加 searchState 订阅（useSyncExternalStore，与 useFilteredMediaFiles 同款用法），ready 瞬间即记录 baseline。
  - src/renderer/hooks/useFilteredMediaFiles.ts（组20-1）：新增 `isFilteringActive` 判定（搜索/类型/收藏视图/丢失/损坏/分组/场景/时段/套装/分类/日期/评分任一激活）+ 副作用 effect：筛选激活且 `hasMoreMedia=true` 时逐页调用 store 既有的 `loadNextMediaPage()`（自带 loadingMore 并发保护），每页追加使 mediaFiles.length 变化驱动 effect 再次触发直至加载完毕，使筛选/搜索覆盖全库而非仅首屏 500 条；回收站视图（独立 recycleBinFiles 数据源）不触发。
  - src/renderer/search/search-service.test.ts：新增组22-1 用例（reg 分片 5 id + 字段分片 → indexedDocCount=5 且与 total 一致不重建）；修正旧用例"无 schemaHash 不触发重建"的 fixture——原 fixture 无 reg 分片，修复后计数正确归 0 会触发偏差重建，补 reg 分片对齐真实导出格式（测试意图不变）。
  - src/renderer/search/use-search-index.test.tsx（新增，.tsx 以命中 jsdom 环境匹配）：3 个用例——空列表首次 ready 后新增文件被增量 add（修复前死锁）、非空首次 ready 仅记 baseline 不重复 add、后续内容变化走 updated 分支。
  - src/renderer/hooks/useFilteredMediaFiles.test.ts：vi.mock 桩掉 `loadNextMediaPage`（spread 其余实际导出，存量用例行为不变），新增 5 个组20-1 用例（无筛选不触发/搜索触发/评分触发/hasMoreMedia=false 不触发/回收站不触发）。
- 测试运行：通过（本批相关 52/52；全量 159 文件 3258/3258）；typecheck 仅剩 4 个预先存在的 scan-sections.tsx 错误（与本批无关）
- 自验结论：PASS
- 说明：修改了计划外文件 search-service.test.ts 的既有用例 fixture——组22-1 修复后按 reg 分片计数，旧 fixture（无 reg 分片）会正确地触发偏差重建，与该用例"验证 schemaHash 为空不重建"的意图冲突，补齐 reg 分片后意图保持不变。

## 批次 5

- 修复问题：组19-1（high，cleanupOrphanThumbnails 每次启动整体删除 _low/_high 变体与 cache-metadata.json，LRU 持久化失效、变体缓存跨重启不可用）
- 修改文件：
  - src/main/utils/constants.ts：`CACHE_METADATA_FILENAME` 从 thumbnail/generator.ts 迁出至此（叶子常量模块，两侧共享避免名称漂移）。
  - src/main/thumbnail/generator.ts：删除本地常量定义，改为从 utils/constants import（模块内 5 处使用点不变）。
  - src/main/app/startup-tasks.ts：`cleanupOrphanThumbnails` 清理循环新增豁免——① entry === CACHE_METADATA_FILENAME 直接保留；② 变体档（`_(low|high).jpg$` 后缀）剥离后缀还原标准档名（与 generator.enforceCacheLimit 行 796-799 相同的归并手法），标准档路径仍在引用集合中则保留；标准档也未被引用的变体才是真孤儿照删。
  - src/main/app/**tests**/startup-tasks.test.ts：测试 18 升级为覆盖新行为——keep.jpg 被引用时 keep_low/keep_high/cache-metadata.json 保留；orphan.jpg/orphan_low.jpg（标准档未被引用的变体）删除，恰好删 2 个。
- 测试运行：通过（本批相关 43/43；全量 3258/3258）；typecheck 仅剩 4 个预先存在的 scan-sections.tsx 错误（与本批无关）
- 自验结论：PASS
- 说明：常量迁至 utils/constants.ts 而非直接从 generator import——startup-tasks 的测试 mock 了 fs/electron，直接引入 generator 会连带加载 ffmpeg-paths（模块层 fs.existsSync）与 sharp 等重依赖导致测试崩溃（已实测），叶子常量模块无此问题。

## 批次 6（跳过项复核）

- 问题：组21-1（high，撤销栈加载未反转 DESC 结果致 Ctrl+Z 顺序颠倒）
- 结论：**跳过——现状代码已修复，问题清单基于旧版本**
- 复核证据（2026-08-16 通读两文件全文确认）：
  - src/main/ipc/handlers/operation-history-handler.ts:77-99：`operation-history:list` 查询 `ORDER BY created_at DESC LIMIT ?` 后，第 91 行已执行 `rows.reverse()`，注释明确"反转为正序（栈顶在末尾），与内存栈一致"，返回记录为旧→新。
  - src/renderer/stores/operationHistoryStore.ts：`loadFromDatabase`（217-243 行）直接 `set({ stack: records })`——因 handler 已反转为正序，栈顶=末尾=最新，与内存约定（47 行注释"最新操作在末尾"）一致；`undo`（144 行）取 `stack[stack.length - 1]` 即最新；`push`（105-112 行）末尾追加 + 超 50 条 `next.shift()` 淘汰的是栈首=最旧，FIFO 语义正确。
- 测试运行：不适用（无代码改动；既有 operationHistoryStore.test.ts 22 个用例在全量中通过）

## 批次 7

- 修复问题：组2-1 + 组2-2 + 组2-3（medium，扫描 worker 崩溃恢复链路三处联动失效）
- 修改文件：
  - src/main/scanner/scanner-worker-bridge.ts：
    - 组2-1：`handleWorkerMessage` 的 SCAN_COMPLETE 分支在收到真实完成事件（成功或失败）时清空 `lastScanOptions`——非扫描期 worker 崩溃不再按旧参数整体重跑用户未请求的扫描（崩溃合成的假 SCAN_COMPLETE 直接走 messageHandlers，不经过该分支，恢复参数保留）；
    - 组2-2：`startScan` 入口增加 `isScanning` 运行态守卫，扫描中重复启动直接抛错（不再覆盖 currentTaskId 造成 taskRegistry 泄漏与双 SCAN_START），调用方（Manager 的 catch / 恢复回调的 try/catch）已按失败处理；
    - 组2-3：新增 `restoreExecutor` 注入口（`setRestoreExecutor`），崩溃自动重启的恢复回调优先经注入的 Manager 层 startScan 恢复，无注入时回退原直连路径。
  - src/main/scanner/index.ts（ScannerManager）：构造时注入恢复执行器——恢复扫描走 `this.startScan(options)` 复用 running 去重（用户已在 2s 重启窗口内手动重扫时放弃恢复并记日志）与 pendingComplete 完成链；完成后 emit 新事件 `restoredComplete(result, options)`。新增 logger import 用于跳过日志。
  - src/main/ipc/handlers/scanner-handler.ts：成功路径链式动作（缩略图生成、导入根登记、scanner:complete 广播、notifyMediaUpdated）抽取为共享函数 `runPostScanActions`；新增 `restoredComplete` 事件监听——崩溃恢复的扫描完成时补齐广播与链式动作（原 IPC await 路径的 Promise 已在崩溃合成事件时以失败 resolve，不补齐则渲染端永久认为扫描失败）。IPC 路径与恢复路径共用同一函数，行为一致。
  - src/main/scanner/scanner-worker-bridge.test.ts：既有"复用 worker 不重复 fork"用例适配新守卫（先 COMPLETE 再二次 startScan）；新增 3 个用例——扫描中重复 startScan 抛错且只发一个 SCAN_START（组2-2）、正常完成后崩溃重启不重放旧参数（组2-1）、扫描中崩溃重启经 restoreExecutor 恢复（组2-3）。
  - src/main/ipc/handlers/scanner-handler.test.ts + src/main/ipc/handlers/_test-helpers.ts：计划外文件——scannerManager 的 mock/stub 补 `on: vi.fn()`（注册期新增的 restoredComplete 监听需要），默认 stub 与各内联 mock 均已补齐。
- 测试运行：通过（scanner 相关 11 文件 218/218；全量 159 文件 3261/3261，净增 3 用例）
- 自验结论：PASS

## 批次 8

- 修复问题：组3-2 + 组3-3 + 组3-4（medium，扫描 worker 核心逻辑）
- 修改文件：
  - src/main/scanner/worker-entry.ts：
    - 组3-2：`saveBatchToDatabase` 的 INSERT ON CONFLICT 更新列表新增 `missing_count = 0, is_missing = 0`——扫描刚物理确认文件存在，残留的旧缺失计数（记录删除重建/外部移动后扫回/DB 迁移残留）会让下次完整性校验首次失败即置 is_missing=1，跳过"连续两次缺失"防抖；
    - 组3-3：uncaughtException/unhandledRejection 处理器在 cleanupAndExit 之前，若扫描进行中（progress.status='running'）先补发 `SCAN_COMPLETE { success:false, message:'扫描进程异常退出: <真实错误>' }`，再发 WORKER_ERROR——原先直接退出使渲染端只能收到 exit 合成的通用失败（丢失具体错误信息且有时序竞争）；
    - 组3-4：四个修复步骤改为"前置失败即中止后续"链（repairOk 标志），V1 失败（事务已回滚、脏数据未清理）时不再继续 V2/V3/V4 二次修改；本地函数 repairLegacyDataV2 返回 boolean。
  - src/main/scanner/repair-legacy-data-v1.ts / v3.ts / v4.ts：函数返回值从 void 改为 boolean（成功/已应用=true，内部 catch 失败=false），签名注释标记 FIX(组3-4)。返回类型放宽对既有调用方（仅 worker-entry 与各自测试）向后兼容。
  - src/main/scanner/**tests**/scan-worker-recovery.test.ts（新增）：4 个用例——①组3-2 断言 INSERT 语句的 ON CONFLICT 列表含 missing_count/is_missing 归零；②组3-3 直接调用 worker 注册的 uncaughtException 监听器（绕过 process.emit 避免触发 vitest 自身处理，process.exit 桩掉），断言先收到携带真实错误的失败 SCAN_COMPLETE + WORKER_ERROR + exit(0)；③④组3-4 对照组——fake db 迁移标记全未应用时 V1-V4 标记全部写入；.all() 抛错（V1 清理查询失败）时 V2/V3/V4 标记不写入且扫描仍成功。
  - 说明：组3-4 测试走真实 repair 模块（实测 vi.mock 无法拦截 worker-entry 内部 import 的依赖——worker-entry 惰性 require better-sqlite3 走 Module._load，其静态 import 也不经 mock 注册表），通过 fake db 的可控行为驱动断言。
- 测试运行：通过（scanner 11 文件 207/207；全量 159 文件 3265/3265，净增 4 用例）
- 自验结论：PASS

## 批次 9

- 修复问题：组1-1（medium，scanner:start 先 registerRoots 后校验使白名单形同虚设）
- 修改文件：
  - src/main/ipc/handlers/scanner-handler.ts：调换顺序——`assertScanPathsAllowed(options)` 先执行（失败广播失败 complete 并原样上抛 forbidden），校验通过后再 `pathGuard.registerRoots(scanRoots)`（保留 Bug B 登记意图，仅限已通过校验的路径）。安全性论证：合法调用方的路径此刻已在白名单内（dialog:selectDirectory 选择时登记；customScanPaths 在 settings:set 逐条 assertFileReadPath + dialog 来源已登记 + 启动时 refreshPathGuardRoots 从 DB 注册），翻转不会误拦合法流程；渲染进程直接传入未授权路径则被拒且不再被登记。
  - src/main/ipc/handlers/scanner-handler.test.ts：新增用例——assertFileReadPath 抛 forbidden 时，registerRoots 未被调用、startScan 未被调用、广播失败 complete。
- 测试运行：通过（scanner-handler 16/16；全量 159 文件 3266/3266，净增 1 用例）
- 自验结论：PASS

## 批次 10

- 修复问题：组5-2 + 组6-2（medium，安全校验两处）
- 修改文件：
  - src/main/utils/ipc-validate.ts（组5-2）：新增导出 `isSensitivePath()`——纯字符串模式判定，覆盖①任意盘符的 Windows/Program Files/Program Files (x86)/ProgramData（正则含目录名边界，沿用 P1-A8 精确边界语义）；②UNC 管理共享 `\\server\c$\...`（管理共享即整盘访问，根与子路径一律敏感）；③用户主目录下第一段为 .ssh/.aws/.gnupg/.kube 的凭据目录。`validateNonSensitivePath` 改用该判定，并在模式匹配通过后用 `fs.realpathSync.native` 解析符号链接复检（路径不存在时跳过复检），阻断软链映射绕过。SYSTEM_SENSITIVE_DIRS 常量保留（既有测试与兼容引用）。
  - src/main/ipc/validator.ts（组5-2）：PathGuard.isAllowed 的敏感目录黑名单检查从遍历 5 条硬编码路径改为 isSensitivePath()（热路径保持纯字符串匹配，不引入 realpath IO）。
  - src/main/ipc/handlers/plugin.ts（组6-2）：plugin:db.query 表白名单校验从"SQL 包含至少一个白名单表名即通过"（子查询 `SELECT ... FROM media_files WHERE id IN (SELECT * FROM settings)` 可绕过）收紧为"出现的所有已知表名必须 ∈ 白名单"——新增 PROTECTED_TABLES 集合（app_settings/edit_history/filter_presets/import_roots/operation_history/pending_renames/schema_migrations/watermark_templates/sqlite_master/sqlite_sequence），扫描前先剥离单引号字符串字面量避免 `WHERE notes='operation_history'` 误伤；引用任一受保护表（含子查询/CTE）即拒绝且不触达 DB。
  - src/main/utils/ipc-validate.test.ts：新增组5-2 用例——任意盘符系统目录、UNC 管理共享（含非管理共享对照组）、用户凭据目录（含非主目录同名对照）、validateNonSensitivePath 扩展场景、junction 符号链接指向 System32 被拒（指向普通目录放行）。
  - src/main/ipc/handlers/**tests**/plugin-db-query.test.ts（新增，新目录 **tests**）：5 个用例——合法查询通过且参数绑定触达 DB、外层白名单表+子查询受保护表被拒（不触达 DB）、仅查 sqlite_master 被拒、字符串字面量含受保护表名不误伤、非 SELECT 拒绝。mock：electron/validator/plugins/i18n/logger。
- 测试运行：通过（本批相关 111/111；全量 160 文件 3276/3276，净增 10 用例）
- 自验结论：PASS

## 批次 11

- 修复问题：组6-1（medium，media:// 路径参数双重百分号解码）
- 修改文件：
  - src/main/app/media-protocol.ts：删除第二次 `decodeURIComponent(encodedPath)`——`url.searchParams.get('path')` 已按 URL 规范解码一次，渲染端（src/renderer/utils/file.ts:31）仅 `encodeURIComponent` 一次；二次解码使含 % 的文件名（100%20photos.jpg）指向错误路径（404/白图）或因 %ZZ 非法序列抛 URIError（500）。
  - src/main/app/**tests**/media-protocol.test.ts：新增 2 个用例——含 % 的已索引文件按原路径命中白名单返回 200（修复前被二次解码成 '100 photos.jpg' 导致 403 裂图）；含非法转义序列的文件名（50%off.png）不再抛 URIError 500。既有用例路径无 % 字符，双重解码下原本就不受影响，无需调整。
- 测试运行：通过（media-protocol 21/21；全量 161 文件 3278/3278，净增 2 用例）
- 自验结论：PASS

## 批次 12

- 修复问题：组7-1 + 组7-2（medium，数据库连接与恢复路径数据一致性）
- 修改文件：
  - src/main/database/connection.ts：
    - 组7-1：initialize 的打开失败分支区分错误类型——新增 `isSqliteLockError()`（识别 err.code/消息中的 SQLITE_BUSY/SQLITE_LOCKED）。锁类错误（外部 SQLite 工具/备份软件暂时占用）不删除 -wal/-shm（原实现无条件删除会丢弃 WAL 中未 checkpoint 的已提交事务，健康库也丢最近写入）、不进恢复流程，等待 500ms 重试一次；仍失败抛出明确的"被其他程序锁定"指引。仅疑似损坏类错误保留原"清理 WAL/SHM 重试 → 备份恢复"路径。
    - 组7-2：attemptRecovery 的恢复失败分支——backupCorruptedDb 已把原库改名挪走，原实现直接 `new Database(dbPath)` 会在原路径新建全新空库（用户图库被静默清空，原数据仅在 .corrupt-<ts> 副本）。改为优先把副本还原回原路径再打开（回到恢复前状态）；还原或打开失败则不新建空库，由 initialize 的 db 句柄校验抛错（启动失败可诊断优于静默清空），副本路径已随 failureInfo 通知监听器。
  - src/main/database/connection.test.ts：MockDatabase 新增 `failNextConstructionWithLock`（抛 code=SQLITE_BUSY 的锁错误，检查顺序在最前以支持组合场景）；新增 3 个用例——锁错误不删 WAL/SHM 且重试成功、锁持续未释放抛占用指引、恢复失败时两次 rename（挪走+还原）且打开原库而非空库。既有 WAL 清理用例走非锁错误路径，行为不变。
- 测试运行：通过（connection 111/111；全量 161 文件 3281/3281，净增 3 用例）
- 自验结论：PASS

## 批次 13

- 修复问题：组9-2（medium，database-worker-bridge 写请求无超时兜底）
- 修改文件：
  - src/main/database/worker/database-worker-bridge.ts：新增写请求超时巡检——`REQUEST_TIMEOUT_MS=60s` / `SWEEP_INTERVAL_MS=15s`；首个请求入队时惰性启动 setInterval 巡检（unref，不阻止进程退出），按已采集的 enqueuedAt 判定超时：reject 携带 SQL 的超时错误并记 fault（workerCrash + stage=request-timeout，含 requestId/入队时间/剩余 pending 数），队列清空后巡检自动停止；dispose 时清理定时器。超时后迟到的 DB_RESULT 由既有的"未知 requestId 忽略"逻辑兜底。超时仅 reject 调用方（不杀 worker/不重启——卡死恢复属更大改动，本轮以消除无限等待+诊断信号为目标）。
  - src/main/database/worker/database-worker-bridge.test.ts（新增，该模块首个测试文件）：3 个用例——worker 就绪但永不回复时 60s 后 reject 且 fault 记录诊断信息、迟到 DB_RESULT 被忽略、正常回复不受巡检影响。mock：electron.utilityProcess.fork → EventEmitter 模拟 worker + logger 桩。
- 测试运行：通过（bridge 3/3；全量 162 文件 3284/3284，净增 3 用例）
- 自验结论：PASS

## 批次 14

- 修复问题：组11-1 + 组11-2（medium，媒体批处理 worker 崩溃恢复与致命退出码）
- 修改文件：
  - src/main/media-worker/bridge.ts（组11-1）：新增 `setRestoreExecutor` 注入口；attemptAutoRestart 的恢复回调优先经注入的 Manager 层 executor 恢复任务（携带崩溃时各类型任务的参数快照），无注入时回退原直连路径——恢复不再绕过 Manager 的 isXxxRunning 互斥（避免与用户 2s 窗口内手动任务并发共享 shouldStop* 标志）与 registerTask 注册（恢复的任务可经 task:cancel 取消、有 task:progress 进度，对用户可见）。
  - src/main/media-worker/manager.ts（组11-1）：构造时注入恢复执行器——按 bridge 传来的任务快照调用本类 startThumbnailBatch/startPhashBatch/startDuplicateMark/startSimilarFind，互斥命中时自然被"已在进行中"拒绝。
  - src/main/media-worker/worker-entry.ts（组11-2）：拆分 `cleanupDb`（纯清理）与 `cleanupAndExit(exitCode=0)`；uncaughtException/unhandledRejection 以 `cleanupAndExit(1)` 退出（原固定 exit(0) 使 bridge 的 isCrash 判定恒 false，自动重启与 workerCrash fault 永不触发）；MEDIA_WORKER_DISPOSE 保持 exit 0；`process.on('exit')` 改为仅 cleanupDb（exit 期间不再调 process.exit）。与批次 2（组9-1）的 database-worker 修复同模式。
  - src/main/media-worker/bridge.test.ts：新增用例——缩略图任务运行中崩溃重启后经 restoreExecutor 恢复（携带 cacheDir/quality），且不再直连 bridge 层重复发 THUMBNAIL_BATCH_START。
  - src/main/media-worker/manager.test.ts：mock bridge 补 `setRestoreExecutor`；新增 2 个用例——构造时注入执行器、执行器经 Manager 层启动（dbPath 正确传递）且恢复期间用户手动启动被互斥拒绝。
  - src/main/media-worker/worker-entry.test.ts：新增用例——直接调用注册的 uncaughtException 监听器（process.exit 桩掉），断言先发 WORKER_ERROR 再 exit(1)。
- 测试运行：通过（media-worker 5 文件 141/141；全量 162 文件 3288/3288，净增 4 用例）
- 自验结论：PASS

## 批次 15

- 修复问题：组19-2（medium，启动清理对不可访问文件绕过"连续两次缺失"防抖）
- 修改文件：
  - src/main/app/startup-tasks.ts：cleanupAndRepairDatabase 第一阶段的缺失标记语句从 `SET is_missing = 1` 改为与 scanner checkMissingFiles 完全一致的 `missing_count = missing_count + 1, is_missing = CASE WHEN missing_count + 1 >= 2 THEN 1 ELSE 0 END`——首轮 + 1s 重试失败只累加计数，累计达 2 次才隐藏；外置盘/网络盘挂载慢于 1 秒不再整盘文件被标记 missing（与批次 8 组3-2 的 ON CONFLICT 归零语义闭环：文件重新出现并被扫描后计数归零）。
  - src/main/app/**tests**/startup-tasks.test.ts：既有用例 19 的 SQL 匹配串与断言更新为新语句（并断言 CASE WHEN 子句存在）；makeDb 默认 prepare 分支同步更新。
- 测试运行：通过（startup-tasks 36/36；全量 162 文件 3288/3288，用例数不变）
- 自验结论：PASS

## 批次 16

- 修复问题：组14-1（medium，moveFiles 批量中途失败丢弃已完成项映射致 DB 指向旧路径破图）
- 修改文件：
  - src/main/services/file-service.ts：moveFiles 循环改为逐项 try/catch——单项失败终止循环（保持原"遇错即停"语义），但失败结果携带已完成项的 `actualPaths` 与 `renamed` 映射（原先被外层 catch 丢弃）；预检失败（mkdir/磁盘空间）路径不变（无已移动项）。moveToRecycleBin 无 renamed/actualPaths 契约且 file:delete 本就无 DB 同步（由缺失检测兜底），无需同类修改。
  - src/main/ipc/handlers/file.ts：file:move 的 DB 同步条件从 `result.success && result.renamed` 放宽为 `result.renamed 非空`——部分失败时也同步已成功移动的项，避免 media_files.file_path 指向已不存在的旧路径（破图/missing，重试也因旧路径不存在而失败）。
  - src/main/services/file-service.test.ts：新增用例——3 项移动第 2 项 EBUSY 失败：success=false 且 message 含占用提示、renamed/actualPaths 仅含第 1 项、第 3 项未被尝试（moveFile 恰好调用 2 次）、源文件状态正确（真文件系统 fixtures）。
  - src/main/ipc/handlers/file.test.ts：新增用例——service 返回 success:false + renamed 时 DB 同步仍被执行。
- 测试运行：通过（file 相关 71/71；全量 162 文件 3290/3290，净增 2 用例）
- 自验结论：PASS

## 修复总结（high 轮，批次 1-6；medium 轮进行中，最终统计在 medium 轮收尾时更新）

- 已修复（high 轮）：7 个问题（组5-1、组9-1、组3-1、组22-1、组22-2、组20-1、组19-1，全部为 high）
- 跳过：1 个问题（组21-1，high——现状代码已修复，清单描述与当前代码不符，见批次 6）
- 测试与类型：全量 3258/3258 通过（157→159 个文件，净新增 2 个测试文件、12 个用例，并升级 2 个既有用例断言）；`tsc -b` 在我改动的文件无错误，仅剩 4 个预先存在的 src/renderer/pages/settings/scan-sections.tsx importRoot 错误（工作区未提交的导入根功能所致，与本轮无关）
- 残留风险：
  1. 组20-1 自动加载全库在超大库（10 万+条）时渲染端内存上升（MediaFile 对象较小，属让结果完整的直接代价；后续可考虑服务端筛选）
  2. 组22-2 修复后，"首次 ready 时 mediaFiles 为空但索引已由 init 重建"的场景会对已索引文档重复 add（flexsearch add 不去重），仅多占内存，搜索结果经 Set 去重不受影响，下次全量重建自愈
  3. 组9-1 仅修 database-worker；scanner/media worker 的同类 exit(0) 缺陷属组2-4/组11-2（medium），未在本轮范围
  4. 组22-1 的 reg 分片解析依赖 flexsearch 0.8.x 导出格式（已对照 node_modules 源码核实），升级 flexsearch 大版本时需回归该用例
