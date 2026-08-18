# 检查计划

> 生成日期：2026-08-16。本计划覆盖核心业务代码，按模块/业务域分组；每组（子组）≤500 行，超过 500 行的大文件按功能区块拆为子组。
> 优先级标记：**P0** = 近期修改链路（git 未提交的 5 个文件所在组，最先检查）；**P1** = 安全面；**P2** = 数据与扫描核心；**P3** = 其余核心 services 与渲染端。
> 检查顺序建议：组 1 → 2 → 3 → 13 → 20 → 22（P0），随后 5 → 6（P1），再按 P2、P3 顺序推进。

## 项目概况

- 技术栈：Electron 40 + React 19 + TypeScript 5.9（strict）+ Zustand 5 + react-i18next + Tailwind；主进程侧 better-sqlite3、sharp、koffi（FFI）、flexsearch、fluent-ffmpeg；构建 electron-vite，测试 Vitest + Playwright
- 核心模块：
  - 主进程：`app/`（启动编排与生命周期）、`ipc/`（校验基础设施 + 39 个 handlers）、`scanner/`（utilityProcess 扫描 worker）、`database/`（连接/仓储 + DB 写 worker）、`thumbnail/` 与 `media-worker/`（缩略图、pHash、重复标记）、`video-editor/`、`services/`（13 个领域服务）、`preload.ts`（contextBridge 桥）
  - 渲染进程：`stores/`（5 个 Zustand store）、`hooks/`（25 个）、`search/`（flexsearch 全文检索）、`pages/` + `components/`（视图层）、`utils/`（imageProcessor 等纯函数）
- 检查范围：23 组 / 62 子组 / 约 76 个文件 / 约 26,000 行
- 排除项：测试文件（126 个 `*.test.ts`，仅作检查时的佐证参考，不作为检查对象）、`preview/mock/`、`icons/`、i18n locale 资源、纯 UI 展示组件、scripts/ 构建脚本

## 检查分组

### 组 1：扫描—IPC 入口与导入根管理【P0】

- 文件列表：`src/main/ipc/handlers/scanner-handler.ts`（133），`src/main/ipc/handlers/import-handler.ts`（101），`src/main/ipc/handlers/import-root-handler.ts`（82），`src/main/database/import-root-repository.ts`（98）
- 调用关系：import-handler → scannerManager.scanRoot + ImportRootRepository；scanner-handler → ScannerWorkerBridge → 扫描链式触发 generateThumbnailsForUnprocessed
- 预估行数：414 行
- 重点检查维度：
  - [ ] 异常捕获（扫描启动失败、导入根登记失败的错误传播）
  - [ ] 逻辑正确性（导入根登记 await 时序须先于媒体刷新广播；pathGuard.registerRoots 登记时机）
  - [ ] 空值处理（ctx 依赖、路径参数、DB 返回）
  - [ ] IPC 契约（zod 校验、IpcResponse 包装）
  - [ ] 并发与竞态（扫描重复触发、并发扫描去重）

### 组 2：扫描—进程桥与管理器【P0】（拆 2 子组）

- 子组 2a：`src/main/scanner/scanner-worker-bridge.ts` 前半·进程创建/WORKER_READY 握手/重启策略（≈270 行）
- 子组 2b：`src/main/scanner/scanner-worker-bridge.ts` 后半·事件接线/崩溃时合成 SCAN_COMPLETE（≈264）+ `src/main/scanner/index.ts`（130，ScannerManager 薄壳）+ `src/main/scanner/worker-protocol.ts`（82）
- 调用关系：ScannerManager（index.ts）转发至 bridge；bridge 管理 utilityProcess 生命周期并向 ipc-setup 广播进度
- 预估行数：746 行
- 重点检查维度：
  - [ ] 资源释放（进程退出/kill 路径、定时器清理）
  - [ ] 异常捕获（worker 崩溃恢复、握手超时 15s 兜底）
  - [ ] 并发与竞态（重启期间重复 startScan、事件乱序）
  - [ ] 逻辑正确性（ProgressThrottle/EtaCalculator 接线）

### 组 3：扫描—Worker 核心逻辑【P0】（拆 3 子组，worker-entry.ts 共 1207 行）

- 子组 3a：`src/main/scanner/worker-entry.ts`·目录发现与遍历（findMediaDirectories/scanDirectory，≈400）+ `src/main/scanner/path-classifier.ts`（80）
- 子组 3b：`src/main/scanner/worker-entry.ts`·批量入库（saveBatchToDatabase，≈400）
- 子组 3c：`src/main/scanner/worker-entry.ts`·缺失检查（checkMissingFiles）及其余（≈407）
- 调用关系：worker 进程内独立 better-sqlite3 连接直接写库；scanDirectory 输出喂给 saveBatchToDatabase
- 预估行数：1287 行
- 重点检查维度：
  - [ ] 逻辑正确性（空目录/权限拒绝/分页边界/路径分类纯函数）
  - [ ] 异常捕获（目录枚举 ENOENT/EPERM、DB 写失败中断处理）
  - [ ] 资源释放（独立 sqlite 连接与 prepared statement 复用/释放）
  - [ ] 安全漏洞（SQL 参数化、路径拼接）
  - [ ] 性能（批量插入大小、目录遍历去重）

### 组 4：扫描—游戏目录发现与数据修复【P2】（拆 2 子组）

- 子组 4a：`src/main/scanner/game-directory-discovery.ts`（385）+ `src/main/scanner/uid-discovery.ts`（87）
- 子组 4b：`src/main/scanner/repair-legacy-data-v1.ts`（195）+ `repair-legacy-data-v3.ts`（62）+ `repair-legacy-data-v4.ts`（77）
- 调用关系：game-directory-discovery 供启动扫描/设置页发现游戏安装目录；repair-legacy-* 由 worker-entry 在扫描后链式调用
- 预估行数：806 行
- 重点检查维度：
  - [ ] 逻辑正确性（Steam/Epic 注册表与全盘签名搜索解析、不可逆数据迁移的幂等性）
  - [ ] 异常捕获（全盘 IO 错误、注册表读取失败）
  - [ ] 安全漏洞（外部路径拼接进 DB/文件系统）
  - [ ] 空值处理（发现结果为空时的下游）

### 组 5：安全—shell 与路径校验【P1】（拆 2 子组）

- 子组 5a：`src/main/ipc/handlers/shell-handler.ts`（81）+ `src/main/utils/ipc-validate.ts`（256）——重点：近期从 pathGuard 白名单放宽为"绝对路径 + 敏感目录黑名单"的改动
- 子组 5b：`src/main/ipc/validator.ts`（426，wrapHandler/zod/pathGuard）+ `src/main/ipc/handler-context.ts`（40）
- 调用关系：全部 handlers 经 validator 包装；shell-handler 调 validateNonSensitivePath 后透传 electron shell
- 预估行数：803 行
- 重点检查维度：
  - [ ] 安全漏洞（路径穿越 `../`、符号链接、URI 编码/百分号绕过、大小写差异绕过黑名单、UNC 路径、敏感目录清单完备性）
  - [ ] 逻辑正确性（黑名单校验函数对相对路径/盘符根路径的行为）
  - [ ] 空值处理（空字符串、undefined 路径）
  - [ ] IPC 契约（shell:openExternal 的 URL 校验）

### 组 6：安全—协议与 preload 桥【P1】（拆 4 子组，preload.ts 共 1170 行）

- 子组 6a：`src/main/app/media-protocol.ts`（354，media:// 协议 + 白名单缓存）+ `src/main/app/renderer-protocol.ts`（80）
- 子组 6b：`src/main/preload.ts`·call() 解包与 IpcError 类型（≈390）
- 子组 6c：`src/main/preload.ts`·electronAPI 各命名空间通道（≈390）
- 子组 6d：`src/main/preload.ts`·插件桥（pluggableElectronIpc/pluginAPI）与全局类型声明（≈390）
- 调用关系：preload 是渲染进程访问主进程的唯一入口（contextBridge 4 次暴露）；media-protocol 决定 media:// 能读到哪些文件
- 预估行数：1604 行
- 重点检查维度：
  - [ ] 安全漏洞（协议白名单失效、CSP、渲染进程不可信参数直传 shell/fs、插件 API 权限边界）
  - [ ] IPC 契约（IpcResponse 双层解包与通道签名和 handler 一致）
  - [ ] 异常捕获（invoke 超时/失败时 IpcError 构造）
  - [ ] 类型安全（桥两端类型声明漂移）

### 组 7：数据库—连接与 schema【P2】（拆 3 子组，connection.ts 共 1590 行）

- 子组 7a：`src/main/database/connection.ts`·初始化/惰性加载 better-sqlite3/DDL（≈530）
- 子组 7b：`src/main/database/connection.ts`·schema 迁移与索引（≈530）
- 子组 7c：`src/main/database/connection.ts`·恢复/备份/WAL 配置（≈530）
- 调用关系：全部仓储与 worker 共享 dbPath；DDL 留在主进程，写操作经 DB worker
- 预估行数：1590 行
- 重点检查维度：
  - [ ] 安全漏洞（SQL 拼接、迁移脚本注入）
  - [ ] 逻辑正确性（迁移幂等、版本跳跃、失败回滚/半迁移状态）
  - [ ] 并发与竞态（WAL 多进程读写、busy_timeout）
  - [ ] 异常捕获（打开损坏 DB 的恢复路径）
  - [ ] 资源释放（连接关闭、pragma 预编译）

### 组 8：数据库—媒体仓储【P2】（拆 3 子组，media-repository.ts 共 1487 行）

- 子组 8a：`src/main/database/media-repository.ts`·查询/getSearchDocs/分页（≈500）
- 子组 8b：`src/main/database/media-repository.ts`·写入 CRUD（经 DatabaseWorkerBridge 下发，≈500）
- 子组 8c：`src/main/database/media-repository.ts`·markCorrupted/统计/其余（≈487）
- 调用关系：搜索索引（search:buildDocs）、media.list 分页、图库放行过滤均依赖本仓储
- 预估行数：1487 行
- 重点检查维度：
  - [ ] 安全漏洞（SQL 参数化、动态 ORDER BY/过滤字段白名单）
  - [ ] 空值处理（查询结果 row 映射、可选列缺省）
  - [ ] 逻辑正确性（分页游标边界、is_missing/is_corrupted/is_duplicate 过滤组合）
  - [ ] 性能（IN 分块 sql-chunk、索引命中、N+1 查询）

### 组 9：数据库—DB Worker【P2】（拆 2 子组）

- 子组 9a：`src/main/database/worker/database-worker.ts`（270）+ `src/main/database/worker/worker-protocol.ts`（88）
- 子组 9b：`src/main/database/worker/database-worker-bridge.ts`（399）
- 调用关系：media-repository 写操作 → bridge → DB worker utilityProcess（WAL 共享 db 文件）
- 预估行数：757 行
- 重点检查维度：
  - [ ] 资源释放（worker 进程退出、未决请求的 resolve/reject 收尾）
  - [ ] 异常捕获（worker 崩溃时挂起 Promise、SQL 执行错误回传）
  - [ ] 并发与竞态（BATCH/TRANSACTION 命令交错、主进程 DDL 与 worker DML 并发）
  - [ ] 逻辑正确性（协议请求-响应配对、超时处理）

### 组 10：缩略图【P2】（拆 4 子组）

- 子组 10a：`src/main/thumbnail/generator.ts` 前半·LRU 缓存（2GB 上限）与生成主流程（≈430）
- 子组 10b：`src/main/thumbnail/generator.ts` 后半·损坏标记回调与磁盘清理（≈423）
- 子组 10c：`src/main/thumbnail/worker-bridge.ts`（307）+ `src/main/thumbnail/worker-protocol.ts`（61）
- 子组 10d：`src/main/thumbnail/worker-entry.ts`（262，sharp 进程内处理）+ `src/main/utils/phash.ts`（136）
- 调用关系：thumbnail-handler → thumbnailGen.generate → bridge → worker（sharp）；损坏结果回流 markCorrupted
- 预估行数：1619 行
- 重点检查维度：
  - [ ] 资源释放（LRU 上界驱逐、磁盘缓存清理、worker 重启）
  - [ ] 异常捕获（sharp 解码失败→损坏标记链路、worker 超时）
  - [ ] 并发与竞态（并发上限控制、同图重复生成）
  - [ ] 逻辑正确性（缓存键、损坏判定条件）

### 组 11：媒体批处理 Worker【P2】（拆 6 子组）

- 子组 11a：`src/main/media-worker/manager.ts` 前半·TaskRuntime 节流/ETA/取消（≈320）
- 子组 11b：`src/main/media-worker/manager.ts` 后半·批量任务管理与优先级（≈319）
- 子组 11c：`src/main/media-worker/bridge.ts` 前半·进程与握手（≈270）
- 子组 11d：`src/main/media-worker/bridge.ts` 后半·事件接线（≈264）
- 子组 11e：`src/main/media-worker/worker-entry.ts` 前半·批量缩略图+pHash（≈490）
- 子组 11f：`src/main/media-worker/worker-entry.ts` 后半·O(n²) Union-Find 重复标记（≈487）
- 调用关系：scanner-handler/startup-tasks → taskScheduler → manager → bridge → worker 进程；结果写回 MediaRepository
- 预估行数：2150 行
- 重点检查维度：
  - [ ] 并发与竞态（取消传播、进度乱序、任务抢占、worker 崩溃恢复）
  - [ ] 性能（O(n²) 相似度比较的规模上限、pHash 批处理内存）
  - [ ] 异常捕获（单行失败不中断批量、错误聚合上报）
  - [ ] 资源释放（进程退出、任务表清理）

### 组 12：相似检索与任务调度【P2】（拆 2 子组）

- 子组 12a：`src/main/media-worker/bktree-index.ts`（125）+ `src/main/media-worker/bktree-js.ts`（127）+ `src/main/utils/duplicate-scoring.ts`（123）
- 子组 12b：`src/main/scheduler/task-scheduler.ts`（288，高/低优先级队列）+ `src/main/services/thumbnail-phash-service.ts`（200，批处理单一数据源）
- 调用关系：similar-handler → mediaWorkerManager（BK-tree）；scanner/duplicate/startup-tasks 共用 thumbnail-phash-service
- 预估行数：863 行
- 重点检查维度：
  - [ ] 逻辑正确性（海明距离阈值、BK-tree 插入/查询、重复评分权重）
  - [ ] 逻辑正确性（优先级抢占：用户 high 抢占后台 low、串行约束）
  - [ ] 性能（BK-tree 查询剪枝、任务队列饥饿）
  - [ ] 空值处理（缺 pHash 的行跳过策略）

### 组 13：搜索索引—主进程持久化【P0】

- 文件列表：`src/main/ipc/handlers/search-index-handler.ts`（154）——重点：tmp→rename 原子写修复（tmp 改为兄弟目录 search-index.tmp）；`src/renderer/search/search-index.ts`（95，索引导出/导入格式）
- 调用关系：search:exportIndex → 主进程 fs 原子写 userData/search-index；search:importIndex 回读（失败返回空触发前端重建）
- 预估行数：249 行
- 重点检查维度：
  - [ ] 异常捕获（rename ENOENT/EPERM 失败时清理残留并抛 AppError）
  - [ ] 逻辑正确性（rm(indexDir) 不再连带删除 tmp 的修复是否完备；导入格式版本兼容）
  - [ ] 资源释放（导入/导出中断时 tmp 残留清理）
  - [ ] 空值处理（空索引、损坏索引文件）

### 组 14：文件服务【P3】（拆 2 子组）

- 子组 14a/14b：`src/main/services/file-service.ts`（708）按功能二分（文件操作/辅助工具）
- 调用关系：file.ts、editor.ts、video.ts、import-handler 等多个 handler 依赖
- 预估行数：708 行
- 重点检查维度：
  - [ ] 安全漏洞（删除/移动/重命名的路径校验、回收站目录逃逸）
  - [ ] 异常捕获（IO 错误分类与用户可读信息）
  - [ ] 逻辑正确性（同名冲突、跨盘移动）
  - [ ] 资源释放（文件句柄、流）

### 组 15：编辑器服务【P3】（拆 2 子组）

- 子组 15a：`src/main/services/editor-service.ts`（384，元数据读写）
- 子组 15b：`src/main/services/xmp-metadata-service.ts`（339，XMP 解析/写回）
- 调用关系：editor.ts handler → editorService → xmp-metadata-service；渲染端编辑器透传游戏参数
- 预估行数：723 行
- 重点检查维度：
  - [ ] 逻辑正确性（XMP 命名空间解析、写回不破坏原有字段）
  - [ ] 异常捕获（非法 XMP/损坏文件）
  - [ ] 空值处理（可选元数据字段缺省）

### 组 16：视频域【P3】（拆 5 子组）

- 子组 16a：`src/main/services/video-service.ts`（407）
- 子组 16b：`src/main/services/livephoto-service.ts`（166）+ `src/main/services/watermark-service.ts`（253）
- 子组 16c：`src/main/video-editor/bridge.ts`（478）
- 子组 16d：`src/main/video-editor/worker-entry.ts`（436，ffmpeg 进程）
- 子组 16e：`src/main/video-editor/watermark-builder.ts`（311）+ `src/main/video-editor/filter-builder.ts`（60）
- 调用关系：video.ts handler → videoService/videoEditorBridge → ffmpeg worker（调色/水印滤镜链）
- 预估行数：2111 行
- 重点检查维度：
  - [ ] 资源释放（ffmpeg/ffprobe 子进程 kill、临时输出文件清理）
  - [ ] 异常捕获（ffmpeg 非零退出、时长探测失败）
  - [ ] 逻辑正确性（滤镜参数到 ffmpeg filter 表达式映射、水印定位计算）
  - [ ] 安全漏洞（临时文件路径、输出覆盖）

### 组 17：解密服务【P3】（拆 3 子组，decryption-service.ts 共 1294 行）

- 子组 17a/17b/17c：`src/main/services/decryption-service.ts` 按功能三分（FFI 初始化与 DLL 加载 / 解密调用与参数 marshalling / 结果解析），各 ≈430
- 调用关系：decrypt-handler 动态 import 本服务；koffi 调 resources/nuan5_decryption.dll 解密游戏照片参数
- 预估行数：1294 行
- 重点检查维度：
  - [ ] 资源释放（FFI 指针/缓冲区释放、DLL 卸载）
  - [ ] 异常捕获（DLL 缺失/架构不符/调用返回错误码）
  - [ ] 空值处理（解密失败/部分字段缺失）
  - [ ] 类型安全（koffi marshalling 与 TS 类型对齐、缓冲区长度）

### 组 18：备份服务【P3】（拆 2 子组）

- 子组 18a/18b：`src/main/services/backup-service.ts`（523）按功能二分（备份创建/恢复）
- 调用关系：backup handler + 渲染端 BackupRestoredBridge（backup:onRestored 事件）
- 预估行数：523 行
- 重点检查维度：
  - [ ] 逻辑正确性（恢复后 DB/索引/缩略图缓存一致性）
  - [ ] 异常捕获（备份中断、恢复中途失败）
  - [ ] 资源释放（临时目录、zip 句柄）

### 组 19：启动与生命周期【P2】（拆 6 子组）

- 子组 19a：`src/main/app/application.ts`（159）+ `src/main/app/app-context.ts`（40）+ `src/main/app/ipc-setup.ts`（176，31 个 handler 注册中枢）
- 子组 19b/19c：`src/main/app/lifecycle.ts`（594）二分（初始化顺序编排前/后半）
- 子组 19d/19e：`src/main/app/startup-tasks.ts`（797）二分（首启全盘扫描 / 链式缩略图·pHash·重复标记）
- 子组 19f：`src/main/app/cleanup.ts`（238，退出清理）+ `src/main/app/media-update.ts`（117，节流广播 + pathGuard 根刷新）
- 调用关系：index.ts → lifecycle.bootstrapApplication → Application 构造全部服务；ipc-setup 注册 handlers 并绑定扫描进度
- 预估行数：2121 行
- 重点检查维度：
  - [ ] 异常捕获（任一初始化步骤失败的降级与兜底，避免白屏/崩溃退出）
  - [ ] 逻辑正确性（初始化顺序依赖：协议→窗口→IPC→扫描；before-quit 清理顺序）
  - [ ] 资源释放（退出时 worker 进程/监听器/定时器全量回收）
  - [ ] 并发与竞态（启动扫描与用户立即操作、更新检查与退出竞态）

### 组 20：渲染端—过滤与取数【P0】（拆 3 子组）

- 子组 20a：`src/renderer/hooks/useFilteredMediaFiles.ts`（298，近期修改：全应用唯一过滤+排序计算点）+ `src/renderer/utils/group-field.ts`（23）+ `src/renderer/hooks/useRefreshMedia.ts`（48）
- 子组 20b：`src/renderer/stores/mediaStore.ts` 前半·状态定义/reducer/选择器（≈260）
- 子组 20c：`src/renderer/stores/mediaStore.ts` 后半·fetchMediaFromDatabase/loadNextMediaPage/updateMediaFileAndPersist（≈262）
- 调用关系：useRefreshMedia → mediaStore.fetch → electronAPI.media.list（服务端过滤）→ useFilteredMediaFiles 前端二次过滤（双层过滤架构）；module-level FilterCache 被 App/GalleryPage/DetailPage/Sidebar/FullscreenViewer 共享
- 预估行数：891 行
- 重点检查维度：
  - [ ] 逻辑正确性（16 个筛选条件组合、showMissingOnly↔showCorruptedOnly 互斥、is_missing 默认隐藏、endDate 取当天 23:59:59、5 维排序稳定性）
  - [ ] 状态一致性（module-level FilterCache 的失效条件、与 store 不同步窗口）
  - [ ] 空值处理（mediaFiles 未加载、字段缺失）
  - [ ] 性能（useMemo 依赖引用稳定性、大列表重算）

### 组 21：渲染端—UI 状态与撤销【P3】（拆 4 子组）

- 子组 21a：`src/renderer/stores/uiStore.ts`（410，persist：导航栈/选择集/筛选器/视图模式）
- 子组 21b：`src/renderer/stores/operationHistoryStore.ts`（244）+ `src/renderer/hooks/useGlobalUndo.ts`（82）+ `src/renderer/hooks/useFavoriteToggle.ts`（48）
- 子组 21c：`src/renderer/hooks/useFileOperations.ts`（421，删除并发上限/重命名/移动/软删恢复）
- 子组 21d：`src/renderer/hooks/useBatchOperations.ts`（369，批量收藏/评分/分类/标签）
- 调用关系：uiStore 被 21 处消费；operationHistoryStore 持久化到 DB operation_history 表支持跨重启撤销；useFileOperations 注册撤销 handler
- 预估行数：1574 行
- 重点检查维度：
  - [ ] 状态一致性（乐观锁冲突检测、撤销栈与 DB 持久化漂移、persist 恢复后导航栈合法性）
  - [ ] 逻辑正确性（撤销 handler 按 type 分发齐全、视图切换时选择集清理）
  - [ ] 并发与竞态（批量操作部分失败的回滚与提示）
  - [ ] 空值处理（选中项已被删除后的操作）

### 组 22：渲染端—搜索索引【P0】

- 文件列表：`src/renderer/search/search-service.ts`（336，索引生命周期/状态机）+ `src/renderer/search/use-search-index.ts`（81）+ `src/renderer/search/doc-builder.ts`（35，MediaFile→文档转换）
- 调用关系：App 根订阅 mediaStore 增量更新索引；useSyncExternalStore 订阅 flexsearch 就绪态供 useFilteredMediaFiles 三路径搜索
- 预估行数：452 行
- 重点检查维度：
  - [ ] 逻辑正确性（flexsearch 命中过滤/未就绪降级客户端过滤/极端时序兜底三路径的等价性）
  - [ ] 性能（增量更新 vs 全量重建阈值、索引内存）
  - [ ] 异常捕获（索引导入损坏、懒加载 locale 失败）
  - [ ] 状态一致性（索引 ready 状态与 mediaStore 版本同步）

### 组 23：渲染端—图片编辑核心【P3】（拆 3 子组）

- 子组 23a/23b：`src/renderer/utils/imageProcessor.ts`（955）二分（Canvas 滤镜/曲线/LUT 管线 / 水印与导出）
- 子组 23c：`src/renderer/hooks/useImageProcessor.ts`（274）+ `src/renderer/hooks/useEditHistory.ts`（89）+ `src/renderer/hooks/useEditorShortcuts.ts`（97）
- 调用关系：EditorPage → useImageProcessor → imageProcessor（Canvas 管线）；与主进程 editor-service 的 XMP 写回衔接
- 预估行数：1415 行
- 重点检查维度：
  - [ ] 资源释放（Canvas/ImageBitmap/OffscreenCanvas 释放、大图内存峰值）
  - [ ] 逻辑正确性（滤镜应用顺序与预览一致性、色彩空间）
  - [ ] 空值处理（未加载完成的图、缺参数的预设）
  - [ ] 性能（大分辨率处理的分块与降采样）

## 检查维度说明

| 维度       | 检查标准（什么算有问题）                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 空值处理   | 可选字段、DB 查询结果、IPC 返回值未判空即访问属性或方法；数组越界；用 `!` 或 `as` 掩盖可空类型；默认值缺失导致 NaN/undefined 传播                                                                            |
| 异常捕获   | Promise 链无 catch 且错误会逃逸到 unhandledrejection；try/catch 捕获后吞错不上报、不记日志；worker/子进程崩溃无恢复或兜底路径；异步回调（定时器/事件监听）内抛错无人处理                                     |
| 逻辑正确性 | 边界条件错误（空集合、分页末页、日期端点、0/负数）；条件组合矛盾或遗漏（互斥开关、默认隐藏）；状态机存在不可达或漏态；await 时序依赖错位（应先登记后广播等）；排序/比较函数不稳定                            |
| 资源释放   | utilityProcess/子进程未在退出路径 kill；prepared statement/数据库连接未复用或释放；定时器、事件监听器（ipcRenderer.on 返回的取消函数）未清理；临时文件/目录在失败路径残留；缓存无上界                        |
| 安全漏洞   | 路径穿越（`../`、符号链接、URI 百分号编码、大小写差异）绕过白名单/黑名单；敏感系统目录可被访问；SQL 字符串拼接而非参数化；渲染进程不可信输入未校验直传 shell/fs/exec；协议处理器白名单失效；CSP 缺失或被剥离 |
| 并发与竞态 | 多 worker 同时写同一 DB 无序；事件乱序导致状态错乱；同一操作可重复触发无去重；取消操作不彻底（进度仍上报/写库仍进行）；缓存与 store 更新不同步窗口；启动后台任务与用户操作冲突                               |
| IPC 契约   | handler 参数缺 zod 校验；IpcResponse 双层结构（success/data/error）解包错误；preload 暴露的通道签名与主进程注册不一致；事件订阅未提供取消函数；错误码/userMessage 缺失导致渲染端无法友好提示                 |
| 性能       | 热路径 O(n²) 无规模上限防护；memo/缓存依赖数组引用不稳定导致每次重算；批量 DB 操作大小不当（过大锁表/过小碎片）；主进程/主线程被 CPU 密集操作阻塞                                                            |
| 类型安全   | `any` 掩盖真实类型；类型断言 `as` 强转不兼容结构；跨进程类型声明（vite-env.d.ts 与 preload）漂移；可空标注与实际运行时不符                                                                                   |
| 状态一致性 | module 级缓存的失效条件不覆盖所有数据变更来源；乐观更新失败后未回滚；持久化（persist/DB）与内存态漂移；多组件共享状态的非受控修改                                                                            |

## 执行说明

- 本计划只定义分组与检查标准，检查时按组逐文件通读，对照维度勾选并记录问题（建议输出到 `.review/findings.md`，按组编号引用）
- 行数为 wc -l 实测或按功能区块估算；大文件子组的具体切分行号在进入该组检查时按函数边界微调，原则是每子组 ≤500 行且功能内聚
- 测试文件不列入检查对象，但当某文件存在配套测试时，应对照测试断言理解预期行为，必要时运行 `npm run test:main` / `test:renderer` 的对应子集验证
- 检查过程中发现的跨组问题（如 handler 与 preload 契约不匹配）需在两组中交叉确认后再定性
