# 喵星图 架构文档

> **项目代号**：`meow-star-map`
> **应用名称**：喵星图（Meow Star Map）
> **当前版本**：2.5.5-beta
> **平台**：Windows x64
> **文档版本**：1.5
> **最后更新**：2026-10-06

---

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 技术选型说明](#2-技术选型说明)
- [3. 进程模型](#3-进程模型)
- [4. 目录结构](#4-目录结构)
- [5. 主进程模块职责（src/main）](#5-主进程模块职责srcmain)
- [6. 渲染进程模块职责（src/renderer）](#6-渲染进程模块职责srcrenderer)
- [7. 共享模块（src/shared）](#7-共享模块srcshared)
- [8. 数据流](#8-数据流)
- [9. 数据库架构](#9-数据库架构)
- [10. 安全与可观测性](#10-安全与可观测性)
- [11. 构建与发布](#11-构建与发布)
- [12. 关键设计约束](#12-关键设计约束)

---

## 1. 项目概览

### 1.1 项目定位

喵星图是一款基于 Electron + React 的桌面应用，专为《无限暖暖》游戏玩家提供本地相册的扫描、浏览、编辑、整理、分享与备份能力。所有用户数据均存储在本地，不上传任何云端。

### 1.2 核心能力

| 能力域              | 说明                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **媒体扫描**        | 自动定位游戏目录，全盘/增量扫描 NikkiPhotos、MagazinePhotos、ScreenShot 等 16 类签名文件夹                                                                                                                                      |
| **图库浏览**        | 网格/列表/时间线/瀑布流/活动时间轴 5 种视图，虚拟滚动，多档缩略图                                                                                                                                                               |
| **详情查看**        | EXIF 拍摄参数、游戏相机参数（姿势/光圈/灯光/滤镜）、套装/染色/交互对象信息、坐标定位                                                                                                                                            |
| **图片编辑**        | 22 项调整（曝光/对比/HSL/曲线/色调分离/LUT/水印）+ 编辑历史栈 + 批量应用                                                                                                                                                        |
| **视频处理**        | 缩略图提取、元数据读取、裁剪、调速（0.25x-4.0x）、格式转换、Apple Live Photo 导出                                                                                                                                               |
| **重复检测**        | 精确 SHA256 + 感知哈希（pHash）双重检测，4 维智能评分推荐保留项                                                                                                                                                                 |
| **智能分组**        | 按相册类型/场景分类/场景时段/套装/文件类型 6 维度聚合                                                                                                                                                                           |
| **角色档案**        | 多账号管理、按 UID 隔离、跨档案转移、统计图鉴                                                                                                                                                                                   |
| **分类管理**        | 系统分类 + 用户自定义分类树，拖拽排序，颜色与图标配置                                                                                                                                                                           |
| **回收站**          | 软删除/恢复/彻底删除/清空，二次确认与三阶段事务保证一致性                                                                                                                                                                       |
| **分享**            | 微信/QQ/vivo 剪贴板分享 + WiFi 局域网分享（PIN 鉴权 + Range 支持）                                                                                                                                                              |
| **备份恢复**        | 自动定时备份 + 手动备份，按档案 UID 后缀识别，5 份 LRU 保留                                                                                                                                                                     |
| **设置中心**        | 启动行为/外观/扫描/档案/数据/诊断/关于/工具 8 大分组配置                                                                                                                                                                        |
| **国际化**          | 12 种语言（zh-CN/zh-TW/en/ja/ko/fr/de/es/pt/ru/th/vi），含"跟随系统"选项                                                                                                                                                        |
| **主题**            | 默认主题 + 柔粉轻奢主题，CSS 变量驱动，零 JS 重渲染切换                                                                                                                                                                         |
| **诊断**            | 故障日志（10 类 FaultType）+ 崩溃 dump + 启动诊断 + 进程退出诊断                                                                                                                                                                |
| **游戏参数解密**    | 通过 koffi 调用 nuan5_decryption.dll 解密游戏内照片相机参数                                                                                                                                                                     |
| **共鸣录**（2.5.0） | 抽卡记录浏览与手动补录、我的衣橱（部件/妆容/Momo/道具/共鸣色）拥有状态与套装收集进度、本地 JSON 导入导出（解析预览 → 分批事务 → 可取消、断点幂等）、个人统计（欧非百分位与出货分布）；6 张共鸣表 + 10 个 IPC 通道，纯离线零外链 |

### 1.3 应用形态

项目同时提供两种应用形态，**共享同一套界面布局、配色、菜单层级、交互逻辑与视觉风格**：

- **exe 桌面程序**：通过 electron-builder 打包的 NSIS 安装包，承载完整功能
- **HTML 预览版**：作为快速预览调试载体，无需运行 installer 即可查看设计效果

> **同步迭代原则**：HTML 预览版与 exe 程序必须同步迭代，确保版本一致性。HTML 预览版不是独立产品，而是开发期的设计预览载体。

---

## 2. 技术选型说明

### 2.1 核心技术栈

| 层            | 技术                          | 版本        | 选型理由                                           |
| ------------- | ----------------------------- | ----------- | -------------------------------------------------- |
| **运行时**    | Electron                      | 41.10       | 跨平台桌面应用框架，复用 Web 技术栈，支持原生 API  |
| **前端框架**  | React                         | 19.2        | 生态成熟，团队熟悉度高，支持并发特性               |
| **状态管理**  | Zustand                       | 5.0         | 轻量、TypeScript 友好，避免 Redux 模板代码         |
| **构建工具**  | Vite                          | 6.4         | 渲染进程快速 HMR，Rollup 打包                      |
| **类型系统**  | TypeScript                    | 5.9         | strict 模式，跨进程类型共享                        |
| **样式方案**  | Tailwind CSS                  | 3.4         | 原子化 CSS，CSS 变量驱动主题                       |
| **动画库**    | Motion                        | 12.42       | React 声明式动画，性能优于 CSS keyframes           |
| **数据库**    | better-sqlite3                | 12.11       | 同步 SQLite，WAL 模式，性能优秀                    |
| **图片处理**  | sharp                         | 0.35        | C++ 绑定 libvips，缩略图/编辑器 pipeline           |
| **视频处理**  | ffmpeg-static + fluent-ffmpeg | 5.3 / 2.1   | 静态 ffmpeg 二进制，无需系统安装                   |
| **EXIF 解析** | exifr                         | 7.1         | 现代化 EXIF 解析库，支持多种格式                   |
| **FFI 调用**  | koffi                         | 3.1         | 调用 nuan5_decryption.dll，比 node-ffi-napi 更现代 |
| **参数校验**  | zod                           | 4.4         | TypeScript 优先的 schema 校验，IPC 边界必备        |
| **国际化**    | i18next + react-i18next       | 26.3 / 17.0 | 标准 i18n 方案，支持命名空间                       |
| **测试框架**  | Vitest                        | 5.0         | Vite 原生测试，零配置                              |

### 2.2 关键依赖选型理由

#### 为什么不用 p-limit？

项目使用自研 `concurrency.ts`（`runWithConcurrency`）。原因：p-limit v7 起改为纯 ESM，主进程编译为 CommonJS 后 `require()` 会失败。自研实现仅 30 行，避免 ESM/CJS 兼容问题。

#### 为什么用 utilityProcess 而不是 worker_threads？

Electron 41 提供 `utilityProcess` API，独立进程级隔离、独立事件循环、独立 V8 上下文，比 worker_threads 更适合 CPU 密集型任务（如 sharp 缩略图、pHash 计算）。六个 worker（scanner / media / thumbnail / video / database / decryption）各自独立，单个崩溃不影响主进程。

#### 为什么用 better-sqlite3 而不是 sqlite3？

better-sqlite3 是同步 API，性能比 sqlite3（异步回调）高 5-10 倍。通过 utilityProcess 拆分写操作到独立进程，避免同步 I/O 阻塞主进程事件循环。

#### 为什么用 koffi 而不是 node-ffi-napi？

node-ffi-napi 已停止维护，koffi 是现代替代方案，性能更好，TypeScript 类型支持完善。

---

## 3. 进程模型

### 3.1 进程拓扑

```
┌──────────────────────────────────────────────────────────────────┐
│                        主进程（Main Process）                     │
│                      src/main/index.ts                            │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ BrowserWindow │  │  IPC Handlers│  │  media:// Protocol    │  │
│  │  (Renderer)   │  │(43 handlers)│  │  (Path Whitelist)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ DatabaseMgr   │  │ ScannerMgr   │  │ MediaWorkerMgr       │  │
│  │ (read sync)   │  │ (shell)      │  │ (shell)              │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                  │                     │              │
│         │   TaskScheduler  │                     │              │
│         │   (priority Q)   │                     │              │
│         │                  │                     │              │
└─────────┼──────────────────┼─────────────────────┼──────────────┘
          │                  │                     │
          ▼                  ▼                     ▼
   ┌──────────────┐   ┌──────────────┐    ┌──────────────────┐
   │  Database    │   │  Scanner     │    │  Media Worker    │
   │  Worker      │   │  Worker      │    │  (utilityProc)   │
   │  (utilityProc│   │  (utilityProc│    │                  │
   │              │   │              │    │  - Thumbnail     │
   │  - All DB    │   │  - Full scan │    │    batch         │
   │    writes    │   │  - Increment │    │  - pHash batch   │
   │  - Txn       │   │  - Signature │    │  - Duplicate     │
   │  - Batch     │   │  - Path      │    │    mark          │
   │              │   │    classify  │    │                  │
   └──────┬───────┘   └──────┬───────┘    └─────────┬────────┘
          │                  │                      │
          │                  │                      │
          └──────────────────┴──────────────────────┘
                             │
                             ▼
                   ┌─────────────────────┐
                   │  meow_star_map       │
                   │  .db (SQLite WAL)    │
                   │  userData/database/  │
                   └─────────────────────┘

   （另有三个 utilityProcess：thumbnail-worker —— sharp 缩放；
     video-worker —— 视频编辑 FFmpeg 执行，见 §5.6 / §5.12；
     decryption-worker —— 网络解码 FFI 隔离，见 §3.2）
```

### 3.2 进程职责矩阵

| 进程                  | 入口                                          | 职责                                                                                                                                                                                                                                                       | 通信方式                                   |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **主进程**            | `src/main/index.ts`                           | BrowserWindow 管理、IPC handler 注册、media:// 协议、nativeTheme 同步、单实例锁、启动编排、退出清理                                                                                                                                                        | ipcMain.handle / webContents.send          |
| **Renderer**          | `src/renderer/main.tsx`                       | UI 渲染、用户交互、状态管理                                                                                                                                                                                                                                | window.electronAPI (preload contextBridge) |
| **scanner-worker**    | `src/main/scanner/worker-entry.ts`            | 全盘/增量/签名扫描、文件元数据提取、缺失检测、旧数据修复                                                                                                                                                                                                   | utilityProcess.parentPort                  |
| **database-worker**   | `src/main/database/worker/database-worker.ts` | 承接所有 `media_files` / `categories` / `character_profiles` 写操作（INSERT/UPDATE/DELETE/事务）                                                                                                                                                           | utilityProcess.parentPort                  |
| **media-worker**      | `src/main/media-worker/worker-entry.ts`       | 缩略图批量生成（sharp）、pHash 批量补算（DCT-II）、重复标记（Union-Find）                                                                                                                                                                                  | utilityProcess.parentPort                  |
| **thumbnail-worker**  | `src/main/thumbnail/worker-entry.ts`          | sharp 缩放实现（迁移自 ThumbnailGenerator 的 CPU 密集部分）                                                                                                                                                                                                | utilityProcess.parentPort                  |
| **video-worker**      | `src/main/video-editor/worker-entry.ts`       | 视频编辑的 FFmpeg 命令构建与执行、进度上报                                                                                                                                                                                                                 | utilityProcess.parentPort                  |
| **decryption-worker** | `src/main/decryption-worker/worker-entry.ts`  | 网络解码隔离（`cloth_diy_decode_network` / `home_build_decode_network` 是同步无超时且做真实网络 I/O 的 FFI，留在主进程会冻结事件循环）；koffi 结构定义与主进程刻意重复（两进程各持独立 koffi 注册表）；`WORKER_READY` 推迟到 DLL 加载 + ABI 校验完成后才发 | utilityProcess.parentPort                  |

### 3.3 通信协议

六个 utilityProcess 采用模式一致但协议独立的消息格式，所有消息均为可序列化 JSON。以下列出 scanner / database / media 三者的协议；thumbnail-worker（`THUMBNAIL_PROCESS_START` / `THUMBNAIL_WORKER_DISPOSE` → `WORKER_READY` / `THUMBNAIL_PROCESS_COMPLETE`）、video-worker（`EDIT_START` / `EDIT_STOP` / `EDITOR_DISPOSE` → `WORKER_READY` / `EDIT_PROGRESS` / `EDIT_COMPLETE`）与 decryption-worker（`DECRYPT_WORKER_INIT` → `WORKER_READY`，主进程侧 8s `Promise.race` 硬超时后 kill）的协议定义见 `src/main/thumbnail/worker-protocol.ts`、`src/main/video-editor/worker-protocol.ts` 与 `src/main/decryption-worker/worker-protocol.ts`。

#### scanner-worker 协议

| 方向      | 消息类型        | 字段                                                                       |
| --------- | --------------- | -------------------------------------------------------------------------- |
| 主→worker | `SCAN_START`    | `dbPath`, `options: { path?, incremental?, customKnownPaths?, fullScan? }` |
| 主→worker | `SCAN_STOP`     | —                                                                          |
| 主→worker | `SCAN_DISPOSE`  | —                                                                          |
| worker→主 | `WORKER_READY`  | —                                                                          |
| worker→主 | `SCAN_PROGRESS` | `scanned`, `found`, `currentPath`, `status`                                |
| worker→主 | `SCAN_COMPLETE` | `success`, `message`, `filesFound?`                                        |
| worker→主 | `SCAN_LOG`      | `level`, `message`, `args?`                                                |
| worker→主 | `WORKER_ERROR`  | `message`, `stack?`                                                        |

#### database-worker 协议

| 方向      | 消息类型           | 字段                                          |
| --------- | ------------------ | --------------------------------------------- |
| 主→worker | `DB_OPEN`          | `dbPath`                                      |
| 主→worker | `DB_EXECUTE`       | `requestId`, `statement: { sql, params? }`    |
| 主→worker | `DB_EXECUTE_BATCH` | `requestId`, `statements: DbStatement[]`      |
| 主→worker | `DB_TRANSACTION`   | `requestId`, `statements: DbStatement[]`      |
| 主→worker | `DB_DISPOSE`       | —                                             |
| worker→主 | `DB_READY`         | —                                             |
| worker→主 | `DB_RESULT`        | `requestId`, `success`, `result?`, `message?` |
| worker→主 | `DB_LOG`           | `level`, `message`, `args?`                   |
| worker→主 | `DB_WORKER_ERROR`  | `message`, `stack?`                           |

**写请求队列**：`DatabaseWorkerBridge` 维护 `Map<requestId, {resolve, reject, sql, enqueuedAt}>`，worker 返回 `DB_RESULT` 时按 `requestId` 匹配并 resolve/reject。worker 异常退出时遍历全部 reject。`lastInsertRowid` 已从 bigint 转 number，避免 IPC 精度丢失。

#### media-worker 协议

| 方向      | 消息类型                                           | 字段                                                        |
| --------- | -------------------------------------------------- | ----------------------------------------------------------- |
| 主→worker | `THUMBNAIL_BATCH_START`                            | `dbPath`, `cacheDir`, `thumbnailQuality`                    |
| 主→worker | `PHASH_BATCH_START`                                | `dbPath`（完成后自动链式触发 `markDuplicates`）             |
| 主→worker | `DUPLICATE_MARK_START`                             | `dbPath`                                                    |
| 主→worker | `THUMBNAIL_STOP` / `PHASH_STOP` / `DUPLICATE_STOP` | 各自独立取消                                                |
| 主→worker | `MEDIA_WORKER_DISPOSE`                             | —                                                           |
| worker→主 | `WORKER_READY`                                     | —                                                           |
| worker→主 | `THUMBNAIL_PROGRESS` / `THUMBNAIL_COMPLETE`        | `processed`, `total`, `currentFile?`                        |
| worker→主 | `PHASH_PROGRESS` / `PHASH_COMPLETE`                | `processed`, `total`, `duplicatesResult?`                   |
| worker→主 | `DUPLICATE_PROGRESS` / `DUPLICATE_COMPLETE`        | `compared`, `totalPairs`, `markedDuplicates`, `totalGroups` |
| worker→主 | `MEDIA_WORKER_LOG` / `WORKER_ERROR`                | —                                                           |

### 3.4 启动与关闭顺序

#### 启动流程（`Application.initialize()`）

```
1. app.requestSingleInstanceLock()
   ├─ 失败：3 次重试（每次间隔 1s）
   ├─ 仍失败：弹窗"清理并重启 / 手动处理 / 退出"
   └─ 用户选"清理并重启"：taskkill /F /T /PID → app.relaunch + app.exit(0)

2. app.whenReady()

3. 注册全局异常捕获（uncaughtException / unhandledRejection）
   ├─ logStartupError → startup-errors.log
   ├─ 首次弹窗 showErrorBox
   └─ app.releaseSingleInstanceLock + app.exit(1)

4. dbManager.initialize()
   ├─ 打开 meow_star_map.db
   ├─ PRAGMA 优化（WAL/synchronous=NORMAL/cache_size=20MB/mmap_size=256MB）
   ├─ runMigrations()（schema_migrations 表跟踪）
   └─ setWorkerBridge(databaseWorkerBridge)

5. applyCustomDirectories()（4 个目录：backup/thumbnail/log/crash）
   ├─ resolveCustomDir → ensureDir → migrateDirFiles（async）
   └─ 任一失败不阻塞其他

6. initLogger()（失败不阻塞）

7. crashReporter.start() + initCrashDir()

8. backupService.init() + scheduleStartupBackup()
   editorService.init() + setScheduler()

9. registerMediaProtocol()（media:// 协议）

10. scannerManager.setDbPath() + mediaWorkerManager.setDbPath()

11. setupIPC()（注册 ~15 个域的 IPC handler + pathGuard 初始化）

12. createMainWindow()
    ├─ loadFile('dist/renderer/index.html')
    └─ ready-to-show → taskScheduler.resume()

13. applyUITheme() + cleanupAndRepairDatabase() + setupThemeListener()

14. ensureDesktopShortcut()（仅 packaged 环境，fire-and-forget）

15. 启动后延迟任务（taskScheduler.enqueueLow）：
    ├─ STARTUP_SCAN_DELAY_MS (5000ms) → performStartupScan()
    ├─ +5s → thumbnailGen.enforceLimitNow()
    └─ +6s → enforceCrashLimit()
    同时：thumbnailGen.startLruBackgroundTask()（每 5 分钟）

16. before-quit 处理器：
    ├─ event.preventDefault() + isCleaningUp=true
    ├─ 根据 WAL 大小动态计算超时（2s / 5s）
    ├─ forceExitTimer（超时强制退出）
    └─ performCleanup().finally() → app.exit(0)
```

#### 关闭流程（`performCleanup()`）

```
1. 收集 before-cleanup 诊断（活跃句柄/请求/子进程数）

2. 清理 startupTimers + mediaUpdateTimer

3. killAllProcesses('SIGKILL')  // ffmpeg/ffprobe/PowerShell

4. taskScheduler.pause() + cancelAllLow()

5. scannerManager.stopScan()

6. scannerWorkerBridge.dispose()（1s 超时）

7. mediaWorkerBridge.dispose()（1s 超时）

8. databaseWorkerBridge.dispose()（1s 超时，含 WAL checkpoint）

9. wifiShareService.stop()

10. backupService.dispose()

11. thumbnailGen.stopLruBackgroundTask() + flushAccessTimes()

12. dbManager.close()
    ├─ PRAGMA optimize
    ├─ PRAGMA wal_checkpoint(PASSIVE)
    └─ db.close()

13. app.releaseSingleInstanceLock()

14. disposeDecryptionService()（koffi DLL 卸载）

15. 同步写入退出诊断到 faults-*.jsonl（fs.appendFileSync）
```

---

## 4. 目录结构

```
MeowStarMap/
├── docs/                              # 项目文档
│   ├── archive/                       # 历史归档文档（计划、报告、规范、旧架构文档）
│   ├── i18n/                          # i18n 改造 SOP（终态快照已归档）
│   ├── plans/                         # 近期实施计划与报告
│   ├── storybook/                     # Storybook MDX 指南
│   ├── tutorial/                      # 用户使用教程（MD 版）
│   └── IPC_CONTRACT.md / PLUGIN_API.md 等
├── resources/                         # 应用资源
│   ├── icons/                         # 应用图标（ico/svg）
│   └── nuan5_decryption.dll           # 游戏图片参数解密 DLL
├── scripts/                           # 构建辅助脚本
│   ├── after-pack-vc-runtime.cjs      # afterPack 复制 VC++ 运行库
│   ├── pre-dist-check.ts              # 打包预检查（产物时间戳/修复点/Git 干净）
│   ├── check-doc-versions.ts          # README Electron 版本一致性校验
│   ├── check-i18n-keys.ts             # i18n 键完整性检查
│   ├── check-preview-drift.ts         # HTML 预览版漂移检查
│   ├── generate-icon.js               # 图标生成
│   ├── copy-resonance-thumbnails.ts / generate-resonance-*.ts / sync-i18n-keys.ts
│   ├── electron-browser-stub.js       # 预览版 / Storybook 的 electron 桩
│   ├── i18n/                          # i18n 提取/守护脚本
│   └── perf-test/                     # 性能基线脚本
├── src/
│   ├── main/                          # 主进程
│   │   ├── app/                       # 应用生命周期管理（23 个源文件）
│   │   │   ├── application.ts         # 应用主类（阶段化编排）
│   │   │   ├── lifecycle.ts           # 生命周期管理（单实例锁等）
│   │   │   ├── cleanup.ts             # 退出清理
│   │   │   ├── startup-tasks.ts       # 启动任务
│   │   │   ├── startup-environment.ts # 启动环境检测
│   │   │   ├── window-manager.ts      # 窗口管理
│   │   │   ├── navigation-guard.ts    # 导航授信判定（will-navigate 拦截）
│   │   │   ├── desktop-shortcut.ts    # 桌面快捷方式
│   │   │   ├── error-handlers.ts      # 错误处理
│   │   │   ├── ipc-setup.ts           # IPC 注册编排
│   │   │   ├── media-protocol.ts      # media:// 协议
│   │   │   ├── renderer-protocol.ts   # app:// 渲染文档协议
│   │   │   ├── renderer-bridge.ts     # 渲染层事件桥
│   │   │   ├── media-update.ts        # 媒体更新通知
│   │   │   ├── recovery.ts            # 恢复逻辑
│   │   │   ├── theme.ts               # 主题同步
│   │   │   ├── custom-dirs.ts         # 自定义目录
│   │   │   ├── auto-update.ts         # 自动更新
│   │   │   ├── exit-forensics.ts      # 退出取证
│   │   │   ├── gpu-fallback.ts        # GPU 回退决策
│   │   │   ├── native-load-guard.ts   # 原生模块加载预检
│   │   │   ├── permission.ts          # 权限管理
│   │   │   └── app-context.ts         # 应用上下文
│   │   ├── database/                  # 数据库层
│   │   │   ├── connection.ts          # DatabaseManager
│   │   │   ├── media-repository.ts    # MediaRepository（SQL 访问层）
│   │   │   ├── resonance-repository.ts # 共鸣录 Repository
│   │   │   ├── import-root-repository.ts # 导入根目录 Repository
│   │   │   ├── sql-chunk.ts           # SQL 分块工具
│   │   │   └── worker/                # database-worker（utilityProcess）
│   │   ├── scanner/                   # 扫描器
│   │   │   ├── index.ts               # ScannerManager（薄壳）
│   │   │   ├── scanner-worker-bridge.ts
│   │   │   ├── path-classifier.ts     # 路径分类纯函数
│   │   │   ├── scan-channels.ts       # 扫描通道编排
│   │   │   ├── game-directory-discovery.ts # 游戏目录三渠道发现
│   │   │   ├── repair-legacy-data-v1..v6.ts # 旧数据修复系列
│   │   │   ├── worker-entry.ts        # scanner-worker 入口
│   │   │   └── worker-protocol.ts
│   │   ├── media-worker/              # media-worker（缩略图/pHash/重复检测）
│   │   │   ├── manager.ts             # MediaWorkerManager（薄壳）
│   │   │   ├── bridge.ts
│   │   │   ├── bktree-index.ts / bktree-js.ts # pHash BK-树索引
│   │   │   ├── worker-entry.ts
│   │   │   └── worker-protocol.ts
│   │   ├── scheduler/
│   │   │   └── task-scheduler.ts      # 分级任务调度队列
│   │   ├── thumbnail/
│   │   │   ├── generator.ts           # ThumbnailGenerator（单条生成 + LRU）
│   │   │   └── worker-*.ts            # thumbnail-worker（utilityProcess：sharp 缩放）
│   │   ├── services/                  # 业务服务层（13 个 service）
│   │   │   ├── file-service.ts
│   │   │   ├── video-service.ts
│   │   │   ├── watermark-service.ts
│   │   │   ├── backup-service.ts
│   │   │   ├── crash-service.ts
│   │   │   ├── livephoto-service.ts
│   │   │   ├── editor-service.ts
│   │   │   ├── share-clipboard-service.ts
│   │   │   ├── share-wifi-service.ts
│   │   │   ├── thumbnail-phash-service.ts
│   │   │   ├── decryption-service.ts
│   │   │   ├── xmp-metadata-service.ts
│   │   │   └── log-service.ts
│   │   ├── ipc/                       # IPC 层
│   │   │   ├── handler-context.ts     # 依赖注入上下文
│   │   │   ├── validator.ts           # wrapHandler + PathGuard + schemas
│   │   │   ├── media-read-guard.ts    # assertMediaReadPath（含 realpath 复检）
│   │   │   └── handlers/              # 47 个域文件（4 个 _ 前缀辅助与 set-dir-handler 工厂，43 个 registerXxxHandlers）
│   │   │       ├── media-handler.ts / media-lifecycle-handler.ts / media-cleanup-handler.ts
│   │   │       ├── file.ts / file-export-handler.ts / file-rename-handler.ts
│   │   │       ├── video.ts / watermark.ts / editor.ts
│   │   │       ├── editor-metadata-handler.ts / editor-preset-handler.ts / export-pref-handler.ts
│   │   │       ├── backup.ts / cache.ts / log.ts / crash.ts
│   │   │       ├── share.ts / scanner-handler.ts / scan-log-handler.ts / shell-handler.ts
│   │   │       ├── app-handler.ts / settings-handler.ts / theme-handler.ts
│   │   │       ├── dialog-handler.ts / import-handler.ts / import-root-handler.ts / data-handler.ts
│   │   │       ├── decrypt-handler.ts / duplicate-handler.ts / similar-handler.ts
│   │   │       ├── operation-history-handler.ts / task-handler.ts
│   │   │       ├── profile-handler.ts / search-index-handler.ts
│   │   │       ├── thumbnail-handler.ts / category-handler.ts / plugin.ts / plugin-bridge-handler.ts
│   │   │       ├── resonance-handler.ts
│   │   │       └── set-dir-handler.ts
│   │   ├── plugins/                   # 插件宿主
│   │   │   ├── plugin-host.ts         # 插件加载与生命周期
│   │   │   └── permission-guard.ts    # 权限校验
│   │   ├── video-editor/              # 视频编辑器子进程
│   │   │   ├── bridge.ts              # 主进程侧桥接层
│   │   │   ├── filter-builder.ts      # FFmpeg 滤镜构建
│   │   │   ├── watermark-builder.ts   # 水印叠加
│   │   │   ├── types.ts               # 视频编辑类型定义
│   │   │   ├── worker-entry.ts        # worker 进程入口
│   │   │   └── worker-protocol.ts     # 消息协议
│   │   ├── decryption-worker/         # 网络解码 FFI 隔离子进程（DLL 加载 + ABI 校验后才发 WORKER_READY）
│   │   ├── sync/                      # NikkiSync 移植面服务层（自有实现，纯 Node 可测）
│   │   │   ├── auth-service.ts        # Ed25519 签名验证、±5min 时间窗、nonce 内存防重放
│   │   │   ├── pairing-service.ts     # 一次性配对令牌（只存 sha256）与 NS1 二维码内容
│   │   │   ├── identity-service.ts    # TLS 自签证书 + 服务器身份文件持久化
│   │   │   ├── cert-der.ts            # X.509 v3 DER 纯函数构造（零依赖手写）
│   │   │   └── server/                # 移植面 HTTPS/WS 服务（sync-server / api-router / ws-hub / range / jpeg-export）
│   │   │                              #   阶段 3 起不再自启，设置页「同步服务」节由 NikkiSync LocalSyncServer 接管
│   │   ├── nikkisync/                 # NikkiSync 外部包（@nikkisync/*）装载缝，全仓唯一入口
│   │   │   ├── runtime-loader.ts      # 变量式 await import + 必需导出表（静态值导入会触发 ERR_REQUIRE_ASYNC_MODULE）
│   │   │   ├── runtime-facade.ts      # 装载 + 组装 + 只读查询面
│   │   │   ├── runtime-manager.ts     # 生命周期状态机（唯一依赖注入面；start() 永不外抛）
│   │   │   ├── probe.ts / probe-cli.ts # 链接探针：绝不启动任何服务，数据库只允许 :memory:
│   │   │   ├── sync-server-view.ts    # 上游 LocalSyncServer 配置的纯函数折算层
│   │   │   └── metadata-resolver-driver.ts / metadata-isolation-guards.ts  # 阶段 6 有界驱动与表级隔离护栏
│   │   ├── i18n/                      # 主进程国际化
│   │   │   ├── index.ts
│   │   │   └── worker-safe.ts         # worker 内纯查表翻译
│   │   ├── utils/                     # 主进程工具（31 个模块）
│   │   │   ├── active-task-store.ts / concurrency.ts / constants.ts / dir-manager.ts
│   │   │   ├── disk.ts / duplicate-scoring.ts / early-crash-guard.ts / eta-calculator.ts
│   │   │   ├── ffmpeg-paths.ts / ffmpeg-runner.ts / file-utils.ts / ipc-validate.ts
│   │   │   ├── logger.ts / managed-read-stream.ts / media-constants.ts / path-safety.ts
│   │   │   ├── phash.ts / process-registry.ts / progress-throttle.ts
│   │   │   ├── scene-brightness.ts / startup-diagnostic.ts
│   │   │   ├── task-registry.ts / user-diag-path.ts / video-frame.ts / video-probe.ts
│   │   │   └── worker-restart-policy.ts
│   │   ├── types/                     # 主进程类型声明
│   │   │   ├── decryption.ts / file.ts / ipc.ts
│   │   │   ├── ffprobe-static.d.ts / koffi.d.ts
│   │   ├── index.ts                   # 主进程入口（早期防护 + 协议注册 + 启动 Application）
│   │   ├── preload.ts                 # preload 入口（装配 + contextBridge 暴露）
│   │   ├── preload-logger.ts          # 渲染层日志转发 preload
│   │   ├── preload/                   # preload 拆分模块（ipc 基础层 / plugin-bridge / api/ 33 个命名空间）
│   │   └── tsconfig.json
│   ├── renderer/                      # 渲染进程
│   │   ├── assets/                    # 静态资源
│   │   │   ├── cloth-names.json       # 7369 条服装名
│   │   │   └── outfit-names.json      # 657 条套装名
│   │   ├── components/
│   │   │   ├── common/                # 通用组件（30+ 个）
│   │   │   ├── editor/                # 编辑器组件（12 个）
│   │   │   ├── gallery/               # 画廊组件（16 个）
│   │   │   ├── layout/                # 布局组件（AppShell/Sidebar/TitleBar）
│   │   │   ├── resonance/             # 共鸣录视图组件
│   │   │   ├── scanner/               # 扫描组件（ScanButton/ScanProgress）
│   │   │   └── video/                 # VideoPlayer
│   │   ├── data/resonance/            # 共鸣录静态数据（图鉴/卡池/百分位/12 语言名/缩略图）
│   │   ├── hooks/                     # 23 个自定义 hooks
│   │   ├── i18n/                      # 国际化
│   │   │   ├── index.ts
│   │   │   └── locales/               # 12 种语言 JSON
│   │   ├── icons/                     # 74 个 SVG 图标集中管理（单文件）
│   │   │   └── index.tsx
│   │   ├── pages/                     # 11 个页面
│   │   │   ├── settings/              # 设置页 sections（按分组拆分文件）
│   │   │   ├── GalleryPage.tsx
│   │   │   ├── CategoriesPage.tsx
│   │   │   ├── DetailPage.tsx
│   │   │   ├── DuplicatesPage.tsx
│   │   │   ├── EditorPage.tsx
│   │   │   ├── OutfitGalleryPage.tsx
│   │   │   ├── RecycleBinPage.tsx
│   │   │   ├── ResonanceRecordsPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── plugins/                  # 插件运行时（plugin-runtime.ts）
│   │   ├── preview/                   # 预览版 mock 数据与安装脚本
│   │   │   ├── index.html             # 预览版入口 HTML
│   │   │   ├── mock/                  # mock 数据（media/categories/resonance...）
│   │   │   └── install.ts             # 预览环境安装
│   │   ├── search/                    # 全文搜索索引
│   │   │   ├── search-index.ts        # FlexSearch 索引管理
│   │   │   ├── search-service.ts      # 搜索服务
│   │   │   ├── doc-builder.ts         # 文档构建器
│   │   │   └── use-search-index.ts    # 搜索 hook
│   │   ├── stores/                    # 7 个 Zustand store
│   │   │   ├── mediaStore.ts
│   │   │   ├── uiStore.ts
│   │   │   ├── themeStore.ts
│   │   │   ├── operationHistoryStore.ts
│   │   │   ├── resonanceStore.ts
│   │   │   └── pluginStore.ts
│   │   ├── styles/
│   │   │   ├── globals.css            # 全局样式 + CSS 变量
│   │   │   └── themes/
│   │   │       ├── index.ts
│   │   │       └── soft-pink-luxury.css
│   │   ├── types/
│   │   │   └── decryption.ts
│   │   ├── utils/                     # 23 个工具函数文件（含 resonance/ 共鸣录纯函数子目录）
│   │   ├── App.tsx                    # 应用根组件
│   │   ├── main.tsx                   # 渲染进程入口
│   │   ├── preview-entry.tsx          # 预览版入口
│   │   ├── index.html
│   │   └── vite-env.d.ts
│   └── shared/                        # 跨进程共享层
│       ├── errors/
│       │   ├── app-error.ts           # AppError 类与 6 个子类
│       │   └── error-codes.ts         # 错误码与类别映射
│       ├── types/                     # 共享类型定义（14 个域模块 + index）
│       │   ├── media.ts / category.ts / profile.ts / editor.ts
│       │   ├── watermark.ts / settings.ts / ipc.ts / ipc-types.ts
│       │   ├── progress.ts / plugin.ts / editor-metadata.ts / duplicate.ts
│       │   ├── resonance.ts / electron-api.ts
│       │   └── index.ts
│       ├── sync/                      # 同步协议契约（protocol.ts / domain-types.ts；协议唯一真相源，禁改）
│       ├── utils/                     # concurrency.ts / taskStages.ts
│       ├── settings-keys.ts           # 渲染层可写偏好 key 白名单
│       ├── dimension.ts               # 智能分组维度
│       └── scene-category.ts          # 游戏场景分类
├── tests/
│   ├── setup.ts
│   └── mocks/                         # electron / sqlite / parent-port 等测试桩
├── tools/                             # 辅助工具
│   ├── image-decode-analysis/
│   └── scripts/
├── .gitignore / .npmrc / .prettierrc / .prettierignore
├── .husky/ / commitlint.config.cjs    # Git 钩子与提交校验
├── electron.vite.config.ts            # 主/preload/renderer 三段式构建配置
├── vite.preview.config.ts             # 单文件预览版构建配置
├── eslint.config.js
├── package.json
├── postcss.config.cjs
├── tailwind.config.ts
├── tsconfig.json / tsconfig.scripts.json
├── vitest.config.ts
└── README.md
```

---

## 5. 主进程模块职责（src/main）

### 5.1 入口与生命周期

#### `index.ts` — 启动引导

主进程最早期入口，承担：

- **最早期异常捕获**：uncaughtException / unhandledRejection 经 startup-diagnostic 落盘 startup-errors.log
- **crashDumps 重定向**：崩溃 dump 输出到 用户文档/MeowStarMap/Diagnostics（`user-diag-path.ts`），Chromium 原生日志落盘与轮转
- **GPU 回退决策**：`recordBootDecision()` → 必要时 `disableHardwareAcceleration()`
- **协议特权声明**：`registerSchemesAsPrivileged` 注册 media:// 与 app://
- **启动 Application**：`app.whenReady()` 后动态 import `app/application.ts` 的 Application 并 `initialize()`

#### `app/application.ts` — Application 类（阶段化编排）

`Application.initialize()` 编排以下职责（各模块实现见 §5.10）：

- **单实例锁管理**：`requestSingleInstanceLock` + 3 次重试 + 三选项对话框（清理并重启 / 手动处理 / 退出）
- **阶段化初始化**：DB → 自定义目录 → logger → crash → backup → IPC → 窗口 → 主题 → 启动后任务
- **media:// 协议注册与白名单**：5 层 LRU 缓存路径校验
- **主题同步**：`applyUITheme` 同步 nativeTheme + TitleBarOverlay + setBackgroundColor
- **启动扫描**：首次启动强制全盘扫描，后续按用户设置
- **场景时段自动分析**：基于图像亮度直方图推断 day/night/dawn/dusk
- **数据库清理修复**：失效记录删除 + 缺失缩略图修复 + 孤儿缩略图清理
- **before-quit 异步清理**：含 WAL checkpoint + 子进程 kill + worker dispose + 强制超时兜底

#### `preload.ts` + `preload/` — contextBridge 桥接层

2026-08 命名空间化拆分重构：原 1176 行单体文件拆为入口装配 + 按功能域的模块树，
对外契约（全局名 / 方法签名 / 通道字符串）不变，并有单元测试守护（`preload/__tests__/`）。

- `preload.ts` 入口：装配 `electronAPI`（reportReady + 33 个命名空间，共 34 个键）并执行 5 个 `exposeInMainWorld`
  ——全部经 `exposeIfTrusted()` 门禁：非授信文档（origin 非 app:// / media:// / dev 5173）零暴露
- `preload/ipc.ts`：`IpcError` 类 + 统一调用入口 `call<T>(channel, ...args)`（解包 `IpcResponse<T>`，失败抛 `IpcError`）+ `subscribe` 事件订阅助手
- `preload/api/*.ts`：每文件一个命名空间对象（`scannerAPI`、`fileAPI`…），方法与通道字符串与拆分前逐字一致
- `preload/plugin-bridge.ts`：插件能力桥（`window.pluginAPI`）与 `__setPluginI18nT` 注入点
- `preload/origin-guard.ts`：文档源自检（第二层防线），放行集合与 `app/navigation-guard.ts` 镜像
- 业务 DTO 类型快照位于 `src/shared/types/electron-api.ts`（preload 层不再内联类型定义）
- 零依赖约束由测试机械化守护：运行时仅允许 `electron`，shared 引入必须 type-only

### 5.2 数据库层（database/）

#### `connection.ts` — DatabaseManager

- 打开 better-sqlite3 连接，运行 schema 迁移与 PRAGMA 优化
- **不执行业务写操作**——写操作通过 `executeAsync` 转发到 worker 进程
- 命名迁移跟踪（`schema_migrations` 表）：`safeAddColumn` / `isMigrationApplied` / `markMigrationApplied`
- 设置项读写：`getSetting<T>` / `setSetting<T>`（含运行时类型校验）
- 关闭前 `PRAGMA optimize` + `wal_checkpoint(PASSIVE)`

#### `media-repository.ts` — MediaRepository

- 从原 `media.ts` 34 个 IPC handler 内联 SQL 抽离的纯 SQL 访问层（seam）
- **写操作 async 走 worker**，**查询同步直读主进程 db**
- 可对内存数据库实例化，是测试接缝

#### `worker/` — database-worker 进程

- `database-worker-bridge.ts`：主进程侧桥接层，惰性 fork worker，维护 `requestId → Promise` 写请求队列
- `database-worker.ts`：worker 进程入口，独立持有 better-sqlite3 连接（WAL 多连接并发安全），仅响应 4 类写指令
- `worker-protocol.ts`：消息协议类型定义

### 5.3 扫描器（scanner/）

#### `index.ts` — ScannerManager（薄壳）

拆分后仅保留接口外壳。通过 `ScannerWorkerBridge` 转发 start/stop，订阅 worker 事件并通过 EventEmitter 转发 `progress` / `complete`。

#### `scanner-worker-bridge.ts` — ScannerWorkerBridge

惰性 fork worker、转发 `SCAN_START/STOP/DISPOSE`、接收 worker 事件。worker 异常退出时若 `isScanning=true` 合成失败的 `SCAN_COMPLETE` 事件，避免卡在 running 状态。

#### `path-classifier.ts` — 路径分类纯函数

三个函数共同决定每张照片入库时的 `media_source`/`album_type`/`account_uid`：

- `extractUidFromPath` — UID 正则 `[\\/](\d{6,12})[\\/]`；GamePlayPhotos 子树内优先用锚点正则（`GPP_ANCHOR_UID`），未匹配返回 `'default'`
- `extractAlbumTypeFromPath` — 父目录名匹配 `ALBUM_TYPE_MAP`（22 个游戏相册文件夹）
- `extractMediaSourceFromPath` — 顺序敏感规则：`launcher\cache` / `\MallPic\` / `\X6Game\Saved\ScreenShot\` / `\CloudPhotos\Temp\` → launcher；`\CloudPhotos\` → cloud；其余 → game

#### `worker-entry.ts` — Scanner Worker 进程入口

承载全部扫描核心逻辑：

- `findMediaDirectories` — 游戏目录查找优先级：用户自定义 → 硬编码默认 → Steam 注册表 + libraryfolders.vdf → Epic 注册表 → 全盘签名搜索（深度 15，先浅深度 4 快速定位）
- `scanDirectory` — 递归扫描媒体文件，跳过系统目录（Windows/ProgramData/$recycle.bin/onedrive/iclouddrive 等）
- `saveBatchToDatabase` — 批量入库（事务批写，走 worker）
- `checkMissingFiles` — 检测缺失文件，标记 `is_missing`
- `repairLegacyData` — 修复旧数据（`media_source='unknown'` 重新计算）

### 5.4 媒体 Worker（media-worker/）

#### `manager.ts` — MediaWorkerManager（薄壳）

通过 `MediaWorkerBridge` 转发三类任务（缩略图批量 / pHash 批量 / 重复标记），维护三类任务的 pendingPromise 与互斥运行标志。

#### `bridge.ts` — MediaWorkerBridge

惰性 fork worker、转发 7 类命令、接收 9 类事件并分发。worker 异常退出时合成失败的 `*_COMPLETE` 事件。

#### `worker-entry.ts` — Media Worker 进程入口

- **缩略图批量生成**：基于 sharp，支持 low(64px)/standard(320px)/high(512px) 三档
- **pHash 批量补算**：DCT-II 8x8 感知哈希，64 字符 0/1 串
- **重复标记**：Union-Find 聚类，汉明距离 ≤ 阈值的图片归组，4 维智能评分推荐保留项

### 5.5 任务调度器（scheduler/）

#### `task-scheduler.ts` — TaskScheduler

主进程侧分级任务调度队列，在各 utilityProcess worker 之上提供优先级管控：

- **高优先级**（`runHighPriority<T>`）：用户主动触发，立即执行，可抢占正在运行的低优先级任务（通过 `cancel` 回调，最多等待 2000ms）
- **低优先级**（`enqueueLow`）：后台自动触发，FIFO 入队，串行执行（`maxLowConcurrency = 1`），等高优先级空闲时 pump
- 启动期 `pause()`，主窗口 `ready-to-show` 后 `resume()`
- 事件：`low-task-start` / `low-task-complete` / `high-task-start` / `high-task-complete` / `preempt`

### 5.6 缩略图生成器（thumbnail/）

#### `generator.ts` — ThumbnailGenerator

- 基于 sharp 生成多档位缩略图，基于 ffmpeg 提取视频首帧
- **LRU 淘汰**（默认 2GB 上限，可配置），内容 hash 命名（前 1MB）
- 并发生成互斥锁（`generatingLocks`）
- 后台定时 LRU 校准任务（每 5 分钟，超阈值 10% 才触发清理）
- 支持自定义缓存目录

### 5.7 业务服务层（services/）

| 服务                         | 职责                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **FileService**              | 文件操作（回收站删除/复制/移动/重命名/导出/导入），EXIF 透传，命名规则变量 `{date}/{album_type}/{uid}/{original_name}/{sequence}` |
| **VideoService**             | 视频处理（元数据/导出/帧截图/裁剪/调速），超时清理部分输出避免残留                                                                |
| **WatermarkService**         | 水印批量添加（文字+图片，16 种 blend 模式，SVG overlay 合成）                                                                     |
| **BackupService**（单例）    | 数据库备份管理（启动后 5s 自动备份，7 天最小间隔，5 份 LRU 保留）                                                                 |
| **CrashService**             | 崩溃 dump 文件管理（保留 10 份 + 30 天过期）                                                                                      |
| **LivePhotoService**（单例） | Apple Live Photo 导出（JPG + MOV 配对，UUID v4 作为 ContentIdentifier）                                                           |
| **EditorService**（单例）    | 图片编辑保存（sharp pipeline，原图备份到 `editor-snapshots`，LRU 保留 50 个）                                                     |
| **ShareClipboardService**    | 剪贴板分享（CF_HDROP 格式），4 层渠道检测（注册表/卸载项/常见目录/进程路径反查）                                                  |
| **WifiShareService**（单例） | WiFi 局域网分享（本机 IP 绑定，PIN 鉴权，Range 请求支持）                                                                         |
| **ThumbnailPhashService**    | 4 组共享函数（启动路径与 IPC 路径共用），转发到 media-worker                                                                      |
| **DecryptionService**        | 游戏图片参数解密（koffi 调用 nuan5_decryption.dll，ABI 校验 + async mutex 串行化）                                                |
| **LogService**               | 故障记录管理（faults-*.jsonl 读取，缓存失效机制，ZIP 导出）                                                                       |
| **XmpMetadataService**       | XMP 元数据写入/读取（EditorMetadata 序列化为自定义命名空间 `wxnn:` 的 XMP packet，支持单图与批量写入）                            |

### 5.8 IPC 层（ipc/）

#### `handler-context.ts` — 依赖注入上下文

`Application.setupIPC()` 构造 `HandlerContext` 对象传入各域 register 函数，避免 handler 直接访问 Application 实例。字段包含：

```
dbManager / scannerManager / mediaWorkerManager / taskScheduler /
thumbnailGen / fileService / videoService / watermarkService /
getMainWindow() / notifyMediaUpdated() / invalidateMediaPathCache() /
applyUITheme(theme) / isThumbnailsGenerating() / setThumbnailsGenerating(v)
```

#### `validator.ts` — IPC 校验核心

三大能力：

1. **`wrapHandler` / `wrapHandlerNoArgs` / `wrapHandlerRaw`** 高阶函数：
   - zod 校验参数 → 失败返回 `IPC_VALIDATION_ERROR`
   - 调用 handler
   - 成功 → `{success:true, data: T}`
   - 抛 AppError → `{success:false, error: AppError.toIpcError()}`
   - 抛普通 Error → 标记 `INTERNAL_ERROR` + logger.error

2. **`PathGuard` 路径白名单**：
   - 默认拒绝
   - 安全根（用户主目录、userData 目录）始终允许
   - 动态注册（扫描发现的媒体目录、对话框选择目录）
   - 系统敏感目录黑名单始终拒绝（`SYSTEM_SENSITIVE_DIRS`：Windows/ProgramData/$recycle.bin/System32 等）

3. **`schemas`** 通用 zod schema 集合：`filePath` / `filePathArray` / `mediaId` / `mediaIdArray` / `rating` / `positiveIntId` / `shortString` / `uid` / `httpUrl` / `uiTheme` / `thumbnailQuality` / `backupFilename` / `shortId` / `cacheLimitBytes`

#### `handlers/` — 47 个域文件（4 个 `_` 前缀辅助与 `set-dir-handler` 工厂，43 个由 `setupIPC()` 注册的 `registerXxxHandlers`）

| 模块                           | 职责                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `media-handler.ts`             | 媒体域（list/findDuplicates/findSimilar/getGroupCounts/评分/收藏/标签/笔记/分类/套装/软删除/恢复/彻底删除/清空/丢失清理/套装图鉴等） |
| `media-lifecycle-handler.ts`   | 媒体生命周期管理（缺失检测/修复/清理）                                                                                               |
| `media-cleanup-handler.ts`     | 丢失与损坏记录清理（cleanupMissing/removeMissing/cleanupCorrupted/removeCorrupted）                                                  |
| `file.ts`                      | 文件操作（delete/copy/getExif），路径白名单校验                                                                                      |
| `file-export-handler.ts`       | 文件导出 / 另存为（file:export 支持默认目录与命名规则 / file:saveAs）                                                                |
| `file-rename-handler.ts`       | 文件重命名 / 移动（file:move / file:rename / file:batchRename）                                                                      |
| `video.ts`                     | 视频（thumbnail/metadata/export/captureFrame/trim/changeSpeed/exportLivePhoto）                                                      |
| `watermark.ts`                 | 水印（apply/saveTemplate/loadTemplates/deleteTemplate + progress 推送）                                                              |
| `editor.ts`                    | 编辑器（save/saveAs/preset CRUD/importPresetFromFile/exportPresetToFile）                                                            |
| `editor-metadata-handler.ts`   | 编辑器 XMP 元数据（导出含参数副本 + 一键恢复编辑参数）                                                                               |
| `editor-preset-handler.ts`     | 滤镜预设（入库 / JSON 文件导出导入 / 列表 / 删除）                                                                                   |
| `export-pref-handler.ts`       | 导出偏好读写                                                                                                                         |
| `backup.ts`                    | 备份（create/list/restore/delete + setDir/resetDir/getDir）                                                                          |
| `cache.ts`                     | 缓存（getStats/clean/setLimit/enforceLimit + setDir/resetDir/getDir）                                                                |
| `log.ts`                       | 日志（listFaults/getDetail/openDir/exportZip/clear/getStats + setDir/resetDir/getDir + reportRendererError）                         |
| `crash.ts`                     | 崩溃（list/stats/openDir/clear + setDir/resetDir/getDir）                                                                            |
| `share.ts`                     | 分享（startWifi/stop/getStatus + copyFiles/detectApp/launchApp）                                                                     |
| `scanner-handler.ts`           | 扫描器（start/stop/status）                                                                                                          |
| `scan-log-handler.ts`          | 扫描诊断日志（只读查询与导出，供诊断工具页回放/导出全链路扫描日志）                                                                  |
| `shell-handler.ts`             | 系统操作（openPath/showItemInFolder/openExternal）                                                                                   |
| `app-handler.ts`               | 应用信息（getStatus/getVersions）                                                                                                    |
| `settings-handler.ts`          | 应用设置读写（get/set）                                                                                                              |
| `theme-handler.ts`             | 主题切换（set）                                                                                                                      |
| `dialog-handler.ts`            | 文件/目录选择对话框（openFile/openDirectory）                                                                                        |
| `import-handler.ts`            | 文件导入（importFiles）                                                                                                              |
| `import-root-handler.ts`       | 导入根目录管理                                                                                                                       |
| `data-handler.ts`              | 数据管理（清除/重置）                                                                                                                |
| `decrypt-handler.ts`           | 游戏参数解密                                                                                                                         |
| `duplicate-handler.ts`         | 重复检测                                                                                                                             |
| `similar-handler.ts`           | 相似图片查找                                                                                                                         |
| `operation-history-handler.ts` | 操作历史（撤销/重做）                                                                                                                |
| `task-handler.ts`              | 后台任务管理（onStandby 等）                                                                                                         |
| `profile-handler.ts`           | 角色档案管理                                                                                                                         |
| `search-index-handler.ts`      | 搜索索引                                                                                                                             |
| `thumbnail-handler.ts`         | 缩略图生成                                                                                                                           |
| `category-handler.ts`          | 分类管理                                                                                                                             |
| `plugin.ts`                    | 插件管理                                                                                                                             |
| `plugin-bridge-handler.ts`     | 插件能力桥（media/db/fs/watermark/task/i18n 受控调用，配合 `permission-guard` 校验）                                                 |
| `resonance-handler.ts`         | 共鸣录（10 个通道：getData/手动记录 CRUD/readImportFile/commitImport/export/updateWardrobe/setWishlist/clearAll）                    |
| `set-dir-handler.ts`           | 工厂：`registerSetDirHandler` / `registerResetDirHandler`，消除 4 个文件同构模板                                                     |

### 5.9 工具层（utils/）

| 文件                       | 职责                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `active-task-store.ts`     | 活跃任务状态存储（供任务进度查询与取消）                                                                        |
| `concurrency.ts`           | 自研并发控制（`runWithConcurrency`），替代 p-limit 避免 ESM/CJS 兼容问题                                        |
| `constants.ts`             | 主进程全局命名常量（STARTUP_SCAN_DELAY_MS=5000、THUMBNAIL_CONCURRENCY=4、MEDIA_CACHE_TTL_MS=5min 等）           |
| `dir-manager.ts`           | 自定义目录管理（4 个功能可配置路径），`resolveCustomDir` / `ensureDir` / `migrateDirFiles`                      |
| `disk.ts`                  | 磁盘空间检查 `assertDiskSpace`（基于 `fsp.statfs`）                                                             |
| `duplicate-scoring.ts`     | 智能去重评分（4 维：分辨率 40 + 文件大小 30 + 拍摄时间 20 + 收藏加权 10）                                       |
| `early-crash-guard.ts`     | 早期致命错误上报（`reportEarlyFatal`：落盘 diagLog + showErrorBox + 释放单实例锁 + exit）                       |
| `ffmpeg-paths.ts`          | 统一 ffmpeg/ffprobe 二进制路径解析，`resolveAsarUnpackedPath` 替换 `app.asar` → `app.asar.unpacked`             |
| `ffmpeg-runner.ts`         | ffmpeg 命令执行工具，统一 trackFfmpegCommand 注册/反注册 + 超时 + 事件处理                                      |
| `file-utils.ts`            | 文件系统工具（pathExists/getUniqueFilePath/parseDataUrlToBuffer/bufferToDataUrl/moveFile/calculateFileHash）    |
| `ipc-validate.ts`          | IPC 参数校验工具（SYSTEM_SENSITIVE_DIRS 黑名单 + validateFilePath/validateMediaId 等）                          |
| `logger.ts`                | 日志管理（10 类 FaultType、FaultRecord 含完整环境信息、2GB 上限按 mtime 删除最旧）                              |
| `managed-read-stream.ts`   | 文件读流生命周期工具（`createManagedReadStream`：error 监听 + AbortSignal 取消 + fd 归还）                      |
| `media-constants.ts`       | 媒体扩展名与 MIME 类型统一常量（IMAGE/VIDEO/MEDIA_EXTENSIONS、ALBUM_TYPE_MAP 22 项）                            |
| `path-safety.ts`           | 路径安全工具（敏感目录判定 / 只读目录检测等）                                                                   |
| `phash.ts`                 | 感知哈希计算（8x8 DCT-II 64 位 hash，预计算余弦矩阵）                                                           |
| `process-registry.ts`      | 全局活跃子进程注册表（trackProcess/trackFfmpegCommand/killAllProcesses，60s 兜底清理）                          |
| `progress-throttle.ts`     | 任务进度推送节流                                                                                                |
| `scene-brightness.ts`      | 基于图像亮度直方图的场景时段分析（sharp.stats() + BT.601 加权）                                                 |
| `startup-diagnostic.ts`    | 启动诊断（logger 就绪前的独立错误记录，写入 `用户文档/MeowStarMap/Diagnostics/startup-errors.log`，100KB 滚动） |
| `task-registry.ts`         | 任务注册表（后台任务登记与查询）                                                                                |
| `user-diag-path.ts`        | 用户友好诊断目录定位（`文档/MeowStarMap/Diagnostics`）                                                          |
| `video-frame.ts`           | 视频帧提取工具                                                                                                  |
| `video-probe.ts`           | 共享 ffprobe 实现（probeVideoMetadata，安全解析 "30000/1001" 帧率格式）                                         |
| `worker-restart-policy.ts` | worker 重启策略（崩溃后重启次数/退避判定）                                                                      |

**读流约束**：任何把本地文件流写出去的场景（`media://` 协议、WiFi 分享下载/缩略图）都必须走
`createManagedReadStream`，禁止裸写 `fs.createReadStream(path).pipe(dest)`——`pipe()` 一返回外层
`try/catch` 就失效，异步阶段的错误既不进 catch 也不留日志，且未 `destroy()` 的流会残留 fd
（Windows 上表现为文件被锁、删不掉）。把流写进 HTTP 响应时，调用方还需在响应对象上挂
`error`/`close` 监听（参见 `share-wifi-service.ts` 的 `serveFile`）。

### 5.10 应用生命周期管理（app/）

从 `index.ts` 引导启动的 Application 编排层，23 个源文件各司其职：

| 文件                     | 职责                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| `application.ts`         | 应用主类，编排初始化与退出流程                                                   |
| `lifecycle.ts`           | 生命周期管理（单实例锁、ready/before-quit/will-quit 事件编排）                   |
| `cleanup.ts`             | 退出清理（WAL checkpoint + 子进程 kill + worker dispose + 强制超时兜底）         |
| `startup-tasks.ts`       | 启动后任务（自动扫描、数据库修复、缩略图补全）                                   |
| `startup-environment.ts` | 启动环境检测（原生依赖/路径可用性校验）                                          |
| `window-manager.ts`      | 窗口管理（创建、ready-to-show、最小化/恢复/关闭处理）                            |
| `navigation-guard.ts`    | 主窗口导航授信判定（app:// / media:// + dev 5173；拦截写 navigation-blocked）    |
| `desktop-shortcut.ts`    | 桌面快捷方式自动补建（检测缺失并重建）                                           |
| `error-handlers.ts`      | 全局错误处理（uncaughtException、unhandledRejection、render-process-gone）       |
| `ipc-setup.ts`           | IPC 注册编排（构造 HandlerContext 并按域调用 register 函数）                     |
| `media-protocol.ts`      | media:// 协议注册与白名单（5 层 LRU 缓存路径校验）                               |
| `renderer-protocol.ts`   | app:// 渲染文档协议注册                                                          |
| `renderer-bridge.ts`     | 渲染层事件桥（主进程 → 渲染层事件推送）                                          |
| `media-update.ts`        | 媒体更新通知（节流 100ms 后通过 webContents.send 通知渲染层刷新）                |
| `recovery.ts`            | 恢复逻辑（异常退出后的数据库修复与状态恢复）                                     |
| `theme.ts`               | 主题同步（applyUITheme 同步 nativeTheme + TitleBarOverlay + setBackgroundColor） |
| `custom-dirs.ts`         | 自定义目录管理（4 个功能可配置路径的 resolve/ensure/migrate）                    |
| `auto-update.ts`         | 自动更新（electron-updater）                                                     |
| `exit-forensics.ts`      | 退出取证（异常退出现场记录）                                                     |
| `gpu-fallback.ts`        | GPU 回退决策（GPU 异常时禁用硬件加速）                                           |
| `native-load-guard.ts`   | 原生模块加载预检（VC++ 运行库等，失败 showErrorBox）                             |
| `permission.ts`          | 系统权限管理                                                                     |
| `app-context.ts`         | 应用上下文（全局共享的应用状态与依赖容器）                                       |

### 5.11 插件宿主（plugins/）

| 文件                  | 职责                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `plugin-host.ts`      | 插件加载、激活点管理、生命周期钩子（install/activate/uninstall） |
| `permission-guard.ts` | 插件权限校验（文件系统/网络/系统资源等权限拦截）                 |

### 5.12 视频编辑器子进程（video-editor/）

独立的 utilityProcess，承担视频编辑的 FFmpeg 命令构建与执行：

| 文件                   | 职责                                        |
| ---------------------- | ------------------------------------------- |
| `bridge.ts`            | 主进程侧桥接层，转发编辑命令到 worker       |
| `filter-builder.ts`    | FFmpeg 滤镜链构建（调色/速度/裁剪组合）     |
| `watermark-builder.ts` | 水印叠加（overlay 滤镜参数构建）            |
| `worker-entry.ts`      | worker 进程入口，执行 FFmpeg 命令并上报进度 |
| `worker-protocol.ts`   | 消息协议类型定义                            |
| `types.ts`             | 视频编辑相关类型定义                        |

### 5.13 主进程国际化（i18n/）

| 文件             | 职责                                                  |
| ---------------- | ----------------------------------------------------- |
| `index.ts`       | 主进程国际化入口，为主进程日志/错误消息提供多语言支持 |
| `worker-safe.ts` | worker 进程内可用的纯查表翻译（不依赖 i18next 实例）  |

---

## 6. 渲染进程模块职责（src/renderer）

### 6.1 应用入口与路由

#### `main.tsx`

- `import './i18n'`（i18next 初始化）
- `installGlobalErrorHandler()`（注册 `window.onerror` + `unhandledrejection`，IPC 上报到主进程 faults）
- `ReactDOM.createRoot` 渲染 `<React.StrictMode>` → `<ErrorBoundary>` → `<App />`

#### `App.tsx`

- **自定义视图路由**（非 React Router），通过 `useUIStore.currentView` 切换 11 个视图：`gallery / detail / editor / categories / settings / recycle-bin / favorites / duplicates / launcher-cache / resonance-records / screenshots`
- **keep-alive 模式**：`ALL_VIEWS` 数组 + `visitedViews` Set，已访问页面保持挂载、用 `display:none` 隐藏，避免视图切换丢失滚动/重复触发 `fetchMediaFromDatabase`
- **视图层级映射**：`VIEW_LEVEL_MAP` 将视图分为 3 级（一级视图 / detail / editor），用于毛玻璃分层
- **页面切换动画**：`page-enter` CSS 类（8px 右移 + 淡入，220ms），`onAnimationEnd` 移除 `will-change`
- **顶层副作用**：useRefreshMedia / useFilteredMediaFiles / useGlobalUndo / applyThemeClass / display 偏好应用 / 操作历史加载
- **桥接组件**：`OperationHistoryErrorBridge` 在 `GlobalToastProvider` 内部渲染

### 6.2 页面层（pages/）

| 页面                              | 职责                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GalleryPage**                   | 图库主页（同时承担 favorites / launcher-cache 视图）。整合工具栏 + 5 种视图 + 批量操作 + 右键菜单 + 导入向导 + 幻灯片 + 智能分组 + 分享 + 重命名/水印对话框                                                                                                                                                                   |
| **CategoriesPage**                | 自定义分类管理。树形结构（parent_id）、增删改、拖拽排序、图标/颜色配置                                                                                                                                                                                                                                                        |
| **DetailPage**                    | 单文件详情。左右切换、EXIF 与游戏参数五面板展示、套装标注、视频元数据、ZoomableContainer 缩放                                                                                                                                                                                                                                 |
| **DuplicatesPage**                | 重复文件检测。精确/相似两种扫描模式、5 种清理策略、相似阈值档位、推荐保留项标记                                                                                                                                                                                                                                               |
| **EditorPage**                    | 图片/视频编辑器。useImageProcessor 处理管线、useEditHistory 历史栈、useEditorShortcuts 快捷键、批量应用、保存失败恢复                                                                                                                                                                                                         |
| **OutfitGalleryPage**             | 套装画廊。按套装聚合统计、StatCard + OutfitCard 卡片网格、点击跳转图库筛选                                                                                                                                                                                                                                                    |
| **RecycleBinPage**                | 回收站。软删除文件列表、全选/反选、恢复/彻底删除/清空、失败操作重试                                                                                                                                                                                                                                                           |
| **SettingsPage**                  | 设置中心。左侧分组导航 + 右侧 section 内容，`activeSection` 持久化到 localStorage                                                                                                                                                                                                                                             |
| **ResonanceRecordsPage**（2.5.0） | 共鸣录。四个视图切换——共鸣记录（73 卡池浏览、手动补录 / 改时间 / 删除、虚拟滚动）、我的衣橱（五分类拥有状态、套装聚合进度、名称搜索与筛选、批量勾选、「从共鸣记录推断」）、导入导出（解析预览 → 新增/重复/无效计数与逐条定位 → 分批事务提交、进度可视可取消）、个人统计（总览卡、欧非百分位、SVG 直方图、按卡池曲线与明细表） |

#### `pages/settings/` — Section 文件（按设置分组拆分）

| 文件                              | Section                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `shared.tsx`                      | GlobalToastProvider / useGlobalToast / SectionShell / 通用类型                                      |
| `sections.tsx`                    | 统一导出入口（re-export 各分组 Section，保持对外导入路径不变）                                      |
| `general-sections.tsx`            | GeneralStartupSection / GeneralFileOpsSection / GeneralExportSection                                |
| `appearance-sections.tsx`         | AppearanceThemeSection / AppearanceDisplaySection                                                   |
| `scan-sections.tsx`               | ScanPathsSection / GameRootsSection / ScanFallbackSection / ScanOptionsSection / ImportRootsSection |
| `scan-log-diagnostic-section.tsx` | 扫描日志诊断 Section                                                                                |
| `profile-sections.tsx`            | ProfileManageSection                                                                                |
| `plugin-sections.tsx`             | PluginManageSection                                                                                 |
| `data-sections.tsx`               | DataBackupSection / DataCacheSection / DataClearSection                                             |
| `diagnostics-sections.tsx`        | DiagnosticsLogsSection / DiagnosticsCrashSection                                                    |
| `about-sections.tsx`              | AboutInfoSection / AboutContactSection / AboutLicenseSection                                        |
| `language-sections.tsx`           | LanguageSection                                                                                     |
| `tools-sections.tsx`              | ToolsShareCodeSection                                                                               |

### 6.3 布局组件（components/layout/）

| 组件         | 职责                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **AppShell** | 整体布局骨架。TitleBar（顶）+ Sidebar（左）+ main（内容区）+ 底部状态栏                                                                      |
| **Sidebar**  | 侧边栏。可折叠（motion.aside 宽度动画 64↔220）。含返回栈顶按钮、角色档案切换器、9 个主导航项、智能分组快捷面板（gallery 视图专属）、底部统计 |
| **TitleBar** | 顶部标题栏。固定高度 40px、`app-drag` 类（Electron 拖拽区域）、显示应用图标 + i18n 标题                                                      |

### 6.4 通用组件（components/common/）

#### 对话框类（8 个）

- **BaseDialog**：模态对话框基类。封装 motion 进出场动画、useFocusTrap 焦点陷阱、4 档尺寸、遮罩点击关闭、Esc 关闭
- **ConfirmDialog**：确认对话框（primary/danger 两种确认按钮变体）
- **PropertiesDialog**：文件属性对话框（聚合 5 个 InfoPanel + 基础信息）
- **ShareGuideDialog**：分享引导（微信/QQ/Vivo 三渠道状态展示）
- **WifiShareDialog**：WiFi 分享对话框（大字号地址 + 复制按钮）
- **ShareCodeDecoderDialog**：分享码解码（3 Tab：服装 DIY / 家园建造 / 媒体加密）
- **FeedbackDialog**：错误反馈对话框（描述 + 附件 + 诊断包导出）
- **TagManager**：标签管理对话框

#### 信息展示面板类（6 个）

- **InfoRowPanel**：5 个 InfoPanel 的公共渲染载体。统一 loading/error/empty/data 四态、light/dark 双主题、扁平 rows 与分组 groups 两种形态
- **ExifPanel**：EXIF 拍摄参数（相机/镜头/光圈/快门/ISO/焦距/GPS/拍摄时间）
- **CameraInfoPanel**：游戏内相机参数（姿势/光圈/灯光/滤镜）
- **PhotographyPanel**：摄影信息（天气/拼图/交互/地点）
- **NikkiInfoPanel**：Nikki 参数面板
- **OutfitPanel**：套装信息（服装部位/状态/灵感点/颜色）
- **InteractionPanel**：交互对象面板

#### 基础 UI 类（7 个）

- **IconButton**：图标按钮（强制 aria-label）
- **SliderControl**：滑块（支持 label/单位/双击复位/onCommit 释放时回调）
- **Spinner**：加载旋转器（4 档尺寸）
- **Toast**：Toast 通知（success/error/info 三类、堆叠显示、入场+退场动画）
- **EmptyState**：空态组件（empty/loading/error 三态、CTA 按钮）
- **MissingBadge**：丢失文件角标
- **MediaThumbnail**：媒体缩略图（整合 MissingBadge + MediaThumbPlaceholder）

#### 反馈与错误类（3 个）

- **ErrorBoundary**：React ErrorBoundary 类组件
- **ErrorFallback**：错误兜底页（重试/打开日志目录/复制错误信息）
- **ContextMenu**：右键上下文菜单（Portal 渲染、二级子菜单、自动边界修正）

#### 分享辅助类（1 个）

- **ShareMenuButton**：分享菜单按钮（下拉选择渠道）

### 6.5 画廊组件（components/gallery/）

#### 视图渲染类（5 个）

- **VirtualImageGrid**：网格视图（useVirtualGrid 虚拟滚动、高分屏检测 DPR≥2 启用 512px 档）
- **ListView**：列表视图（useVirtualScroll 虚拟滚动、固定行高 72px）
- **TimelineView**：时间线视图（按日期分组、响应式列数）
- **MasonryView**：瀑布流视图（自定义列布局算法，MIN_COL_WIDTH=220，overscan 400px）
- **EventTimelineView**：活动时间轴视图（基于游戏版本节点）

#### 工具栏与操作类（4 个）

- **GalleryToolbar**：图库顶部工具栏（视图切换/筛选/排序/评分/搜索/扫描/分享/幻灯片/导入）
- **BatchActions**：批量操作栏（导出/移动/水印/删除/分类/分享/重命名/全选/反选）
- **SlideshowPlayer**：幻灯片播放器（Fisher-Yates 洗牌、4 档间隔、淡入淡出/滑动/无过渡）
- **FullscreenViewer**：全屏浏览器（View Transitions API 共享元素过渡、鼠标自动隐藏控件、视频播放）

#### 对话框类（4 个）

- **ImportWizard**：导入向导（3 步：文件预览 → 命名规则+分类+冲突策略 → 执行）
- **BatchRenameDialog**：批量重命名（模板变量 {date}/{time}/{scene}/{outfit}/{seq}/{original}）
- **RenameDialog**：单文件重命名
- **WatermarkDialog**：水印对话框

#### 辅助类（3 个）

- **SmartGroupPanel**：智能分组面板（6 维度动态分组）
- **TagManager**：标签管理对话框
- **MediaThumbPlaceholder**：缩略图占位/失败图标

### 6.6 编辑器组件（components/editor/）

| 组件                 | 职责                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| **EditorToolbar**    | 编辑器顶部工具栏（撤销/重做/重置/对比/快捷键/全屏/退出/另存为/保存/复制参数/粘贴参数/应用到选中） |
| **EditorTabs**       | 编辑器右侧 Tab 容器（7 个 Tab：basic/hsl/curves/split/filters/lut/watermark）                     |
| **FilterPanel**      | 滤镜面板（getFilterCategories + getPresetsByCategory，并发 4 路生成缩略图）                       |
| **LutPanel**         | LUT 面板（内置 LUT + 自定义 .cube 文件导入，localStorage 持久化）                                 |
| **ToneCurve**        | 曲线调整（RGB/R/G/B 四通道、Canvas 绘制、拖拽控制点）                                             |
| **Histogram**        | 直方图（Canvas 绘制 RGB 通道分布，80ms 防抖）                                                     |
| **ColorWheel**       | 色轮（Canvas 绘制、拖拽选 hue）                                                                   |
| **CompareView**      | 对比视图（拖拽分割线对比原图/编辑后）                                                             |
| **WatermarkPanel**   | 水印配置面板（文字/图片水印、模板、onCommit 入历史栈）                                            |
| **BatchApplyDialog** | 批量应用进度对话框                                                                                |
| **ShortcutsModal**   | 快捷键说明模态框                                                                                  |
| **VideoEditor**      | 视频编辑器（速度调整/格式转换/帧捕获/元数据展示）                                                 |

### 6.7 扫描与视频组件

- **scanner/ScanButton**：扫描按钮（三档模式：incremental/full/custom）
- **scanner/ScanProgress**：扫描进度条（scanned/found/currentPath + 停止按钮）
- **video/VideoPlayer**：视频播放器（播放进度按 src 哈希持久化到 localStorage）

### 6.8 自定义 Hooks（23 个）

#### 媒体操作类（7 个）

- **useFileOperations**：文件操作核心 hook（删除/移动/重命名/复制/收藏切换/属性更新），注册 4 个 undoHandler
- **useBatchOperations**：批量操作 hook（水印/批量重命名状态管理）
- **useVideoThumbGenerate**：视频缩略图生成 hook（模块级单次守卫防请求风暴，跨组件实例共享）
- **useFavoriteToggle**：收藏切换 hook（乐观更新 + 失败回滚 + pushHistory）
- **useFilteredMediaFiles**：筛选+排序+分组 hook（module-level 缓存避免多组件重复计算）
- **useGallerySearch**：搜索输入 hook（250ms 防抖）
- **useRefreshMedia**：刷新媒体 hook（封装 fetchMediaFromDatabase）

#### UI 交互类（7 个）

- **useToast**：Toast 管理 hook（最多 3 条 FIFO 淘汰、crypto.randomUUID 生成 id）
- **useZoomable**：缩放/平移交互 hook（滚轮缩放、拖拽平移、双击复位）
- **useSlideshow**：幻灯片播放 hook（isPlaying 状态、interval 计时器生命周期）
- **useFocusTrap**：模态框焦点陷阱 hook（Tab/Shift+Tab 循环、Esc 关闭）
- **useContainerSize**：容器尺寸监听 hook（ResizeObserver + window resize 双保险，含虚拟滚动变体 useVirtualGrid）
- **useFailedImages**：缩略图加载失败管理 hook
- **useErrorToast**：错误 Toast hook（按类别决定 toast 类型、自动上报非用户面错误）

#### 编辑器类（4 个）

- **useEditHistory**：编辑历史栈 hook（50 上限、historyIndex 同步更新 ref 避免同周期多次 push 错误截断）
- **useEditorShortcuts**：编辑器快捷键 hook（Ctrl+Z/Y/S/Shift+S/Shift+C/Shift/V/F11/?）
- **useImageProcessor**：图片处理 hook（防抖 80ms 预览、最大预览 1400px、最大导出 4096px、JPEG 质量 0.92/0.95）
- **useWatermark**：水印配置状态 hook（文字/图片配置更新与平铺切换）

#### IPC 调用与全局类（5 个）

- **useIpcCall**：IPC 调用包装 hook（自动管理 loading/错误捕获/toast 显示/泛型保留/幂等安全）
- **useExif**：EXIF 加载 hook
- **useGameParams**：游戏参数加载 hook（LRU + TTL 缓存，200 条/5 分钟）
- **useGlobalUndo**：全局撤销 hook（App 顶层注册 Ctrl+Z、非编辑器视图生效、输入框聚焦时跳过）
- **useStagedTask**：阶段化任务进度 hook（驱动 TaskProgress 阶段状态与条目进度、节流推送、携带取消信号）

### 6.9 状态管理（stores/）

| Store                     | 持久化                                         | 职责                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **uiStore**               | `wxnn-ui-store`                                | UI 全局状态：currentView + viewStack、selectedMediaId(s)、sidebarCollapsed、searchQuery/sortBy/sortOrder/viewMode/filterType/filterDateRange/filterRating、selectedSceneCategories/selectedSceneTimes/filterOutfit、showMissingOnly/showDuplicates、groupDimension/selectedGroupKey、fullscreen 状态（含 fullscreenTargetImg 用于 View Transitions 共享元素过渡）、slideshow 状态与配置 |
| **mediaStore**            | 否（内存）                                     | 媒体数据：mediaFiles/categories/loading/scanProgress/editingMedia/recycleBinFiles、currentProfileUid/profiles。纯 reducer actions + 异步 action `updateMediaFileAndPersist`（先 IPC 持久化再更新本地）                                                                                                                                                                                  |
| **themeStore**            | `wxnn-ui-theme`                                | 主题管理（setTheme + applyThemeClass，从 themes 配置自动派生所有非空 className）                                                                                                                                                                                                                                                                                                        |
| **operationHistoryStore** | 否（内存 + IPC 持久化到 operation_history 表） | 全局操作历史。50 上限、9 种 OperationType、按 type 分发的 UndoHandler 注册表（模块级 Map）、数据库写入失败回调 Set 订阅、loadFromDatabase 启动加载                                                                                                                                                                                                                                      |
| **resonanceStore**        | 否（内存）                                     | 共鸣录数据（记录/衣橱/统计与导入导出状态），2.5.0 新增                                                                                                                                                                                                                                                                                                                                  |
| **pluginStore**           | 否（内存）                                     | 插件运行时状态（已安装/启用插件列表、安装卸载等操作进行中标志与错误信息）                                                                                                                                                                                                                                                                                                               |

### 6.10 工具函数（utils/）

| 类别       | 文件                                                                                                                       | 用途                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 格式化     | `format.ts` / `date.ts`                                                                                                    | 字节格式化、日期格式化                                                           |
| 文件路径   | `file.ts`                                                                                                                  | toFileUrl / getDirName / joinPath                                                |
| 图像处理   | `imageProcessor.ts`                                                                                                        | 核心处理管线（HSL/Curves/SplitTone/Watermark 算法 + processImageData）           |
| 滤镜       | `filter.ts` / `filterPresets.ts` / `lut.ts` / `editor-colors.ts`                                                           | mergeFilterParams、6 分类预设、3D LUT 解析与应用、CHANNEL_COLORS                 |
| 游戏数据   | `enum-mappings.ts` / `cloth-name-lookup.ts` / `location-data.ts` / `location-map.ts`                                       | 游戏枚举→中文映射、服装/套装名查找、地点层级、坐标→地点映射                      |
| 业务辅助   | `group-field.ts` / `gallery.tsx` / `responsive.ts` / `category-name.ts` / `duplicateContextMenu.ts` / `scan-exclusions.ts` | 分组字段提取、右键菜单构建、响应式列数、分类名解析、重复文件右键菜单、扫描排除项 |
| 分享与事件 | `share.ts` / `game-events.ts`                                                                                              | 分享辅助、游戏事件映射                                                           |
| 动画与错误 | `motionPresets.ts` / `global-error-handler.ts` / `fault-colors.ts`                                                         | Motion 动画预设、全局错误兜底、故障类型元数据                                    |

### 6.11 国际化（i18n/）

- 基于 `i18next` + `react-i18next`
- **支持 13 种语言选项**（含"跟随系统"）：`auto / zh-CN / zh-TW / en / ja / ko / fr / de / es / pt / ru / th / vi`
- 中文（zh-CN）为基准语言，翻译最完整；其他 11 种为机翻初版，缺失 key 自动回退到 zh-CN（`fallbackLng: 'zh-CN'`）
- `SUPPORTED_LANGUAGES` 数组定义顺序（影响设置页下拉展示顺序）
- `detectSystemLanguage()`：基于 `navigator.language` 推断（zh-TW/HK/Mo 视为繁体）
- 命名约定：`nav.*` / `common.*` / `settings.groups.*` / `settings.sections.*` / `editor.tabs.*` / `duplicates.strategy.*` / `toast.*` 等

### 6.12 样式与主题（styles/）

#### `globals.css`

- 主题样式入口，按 CSS @import 规则主题文件置于最前
- 引入 Tailwind base/components/utilities
- 定义默认主题 CSS 变量体系（`:root`）：色彩/遮罩/阴影/毛玻璃变量
- 全局类：`.glass-panel` / `.glass-card` / `.app-drag` / `.title-bar` / `.status-bar` / `.page-enter` / `.font-size-*` / `.compact-mode` / `.reduce-motion` / `.nav-item` / `.icon-btn` / `.btn-primary`

#### `themes/index.ts`

- 主题配置中心。`UITheme = 'default' | 'soft-pink-luxury'`
- `themes` 数组：`{ id, name, className }`（default 不附加类名，soft-pink-luxury 附加 `.soft-pink-luxury` 类）
- 新增主题流程：1) 在此注册；2) 添加同名 CSS 文件并在 globals.css 引入

#### `themes/soft-pink-luxury.css`

- 「柔粉轻奢」主题样式
- `.soft-pink-luxury` 类作用域下覆盖全部 CSS 变量
- 色彩：奶白基底（`#fdf9fb`）+ 低饱和柔粉点缀（`#e2a4bc`）+ 柔焦玻璃材质 + 柔光分层光影

### 6.13 图标管理（icons/）

- **单一文件集中管理所有图标**，导出 74 个图标组件
- 基于 `BaseIcon` 统一封装：`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">`，符合 Feather/Lucide 风格
- `IconProps` 接口继承 `React.SVGProps<SVGSVGElement>` + `size?: number`（默认 16）
- 按用途分类：操作类（17）/ 视图类（5）/ 导航类（7）/ 编辑类（10）/ 媒体类（5）/ 状态类（4）/ 文件操作类（5）/ 分类与标签类（3）/ 分享渠道类（4）/ 导入导出类（2）/ 播放控制类（2）/ 社交平台类（3）/ 其他（7）

### 6.14 插件运行时（plugins/）

#### `plugin-runtime.ts`

- 渲染层插件运行时，负责扩展点注册与插件 UI 渲染
- 提供插件上下文（plugin context），让插件访问受控的渲染层 API
- 与主进程 `plugin-host.ts` 配合，实现插件生命周期管理
- 扩展点机制：插件可注册自定义面板、工具栏按钮、详情页信息块等

### 6.15 全文搜索索引（search/）

| 文件                  | 职责                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `search-index.ts`     | FlexSearch 索引管理（创建/更新/销毁），索引字段含文件名/标签/笔记/分类名 |
| `search-service.ts`   | 搜索服务（查询、结果排序、高亮匹配）                                     |
| `doc-builder.ts`      | 文档构建器（将 MediaFile 转为 FlexSearch 文档格式）                      |
| `use-search-index.ts` | 搜索 hook（索引构建/查询/防抖，供组件使用）                              |

### 6.16 预览版 mock（preview/）

HTML 预览版（`preview.html`）的数据支撑层，让预览版无需 Electron 主进程即可展示完整 UI：

| 文件/目录                 | 职责                                                   |
| ------------------------- | ------------------------------------------------------ |
| `mock/install.ts`         | 预览环境安装脚本（注入 mock 数据到 window 全局）       |
| `mock/`                   | mock 数据目录                                          |
| `mock/data/`              | 静态 JSON 数据（media-samples/categories/profiles 等） |
| `mock/database-mock.ts`   | 数据库 mock（模拟 mediaStore 的 IPC 响应）             |
| `mock/event-mock.ts`      | 事件 mock（模拟 scanner:progress 等事件推送）          |
| `mock/filesystem-mock.ts` | 文件系统 mock（模拟文件路径/缩略图 URL）               |
| `mock/ipc-error.ts`       | IPC 错误 mock（模拟 IPC 调用失败的响应格式）           |
| `mock/resonance-mock.ts`  | 共鸣录 mock（示例数据读取，写入提示不支持）            |

---

## 7. 共享模块（src/shared）

### 7.1 共享类型（shared/types/）

`src/shared/types/index.ts` 作为统一导出入口，汇总 14 个域类型模块，全部采用"数据库行（XxxRow，蛇形）↔ 渲染模型（Xxx，驼峰）"双轨制。

| 文件                   | 核心类型                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **media.ts**           | `MediaType` / `MediaSource` / `SceneTime` / `MediaRow` / `MediaFile`（27 字段）/ `MediaListOptions` / `ScanOptions` / `VideoExportFormat` / `DuplicateGroup` / `OutfitStat`                                                                                    |
| **category.ts**        | `CategoryRow` / `Category` / `CategoryCreateInput` / `CategoryTreeNode` / `SystemCategoryIcon`（7 个枚举）                                                                                                                                                     |
| **profile.ts**         | `ProfileRow` / `CharacterProfile` / `ProfileBaseStats` / `ProfileTopStatRow` / `GroupCountRow` / `ProfileStats`                                                                                                                                                |
| **editor.ts**          | `HSLColorKey`（12 通道）/ `FilterParams`（22 调整项 + HSL + 曲线 + 色调分离 + LUT）/ `FilterPresetRow` / `EditHistoryRow` / `OperationType`（13 种操作）/ `OperationHistoryRow`                                                                                |
| **watermark.ts**       | `WatermarkPosition`（9 + custom）/ `WatermarkStyle`（5 种）/ `BlendMode`（16 种）/ `WatermarkConfig` / `WatermarkTemplateRow`                                                                                                                                  |
| **settings.ts**        | `AppSettingRow` / `SettingKey`（29 个键枚举）/ `AppTheme` / `AppLanguage` / `UIScale` / `GridSize` / `SettingKeyMap`（key → TS 类型映射）/ `BackupRecord` / `CacheStats` / `LogStats` / `CrashStats` / `FaultType` / `FaultRecord`                             |
| **ipc.ts**             | 重导出 `IpcError` / `IpcResponse` / `IpcProgress` / `IPC_ERROR_CODES`、`ShareChannel` / `WifiShareSession`、`MediaParamType` / `CameraParams` / `RichCameraParams`、`ImportOptions` / `ExportOptions`、**`IPC_CHANNELS`**（24 个域前缀 / 91 个唯一通道名常量） |
| **ipc-types.ts**       | `IpcError`（code/message/userMessage/details）、`IpcResponse<T>` = `{success:true,data}` ∪ `{success:false,error}`、`IpcProgress`、`IPC_ERROR_CODES`（9 个 IPC_* 错误码）                                                                                      |
| **progress.ts**        | `TaskType`（7 类任务：scan/duplicate/batch/watermark/import/video-edit/indexing）、`TaskPhase`（6 阶段）、统一任务进度状态（主进程 `task:progress` 通道推送）                                                                                                  |
| **plugin.ts**          | `NikkiGalleryManifest` / `PluginPermission` 能力权限清单 / 业务扩展点常量与扩展响应类型                                                                                                                                                                        |
| **editor-metadata.ts** | `EDITOR_METADATA_SCHEMA_VERSION` / 调色、滤镜、LUT、水印参数的 XMP 自描述序列化结构                                                                                                                                                                            |
| **duplicate.ts**       | `DuplicateItem` / 重复相似检测域类型（主进程 handler 返回值契约，渲染层 DuplicatesPage 消费）                                                                                                                                                                  |
| **resonance.ts**       | 共鸣录域类型 + zod schema + 导入上限常量（2.5.0 新增）                                                                                                                                                                                                         |
| **electron-api.ts**    | preload `electronAPI` 各命名空间方法签名与 DTO 类型快照（preload 层不内联类型定义）                                                                                                                                                                            |

另注：`src/shared/settings-keys.ts` 定义渲染层可经 `settings:set` 自由写入的偏好 key 白名单（`RENDERER_PREF_KEYS`）与安全敏感 key 拒绝清单（`SECURITY_SENSITIVE_KEYS`）。

### 7.2 错误架构（shared/errors/）

#### `error-codes.ts`

- **`ERROR_CODES`**：在 `IPC_ERROR_CODES` 9 个码基础上扩展 2 个（`APP_DATABASE_ERROR` / `APP_FILE_SYSTEM_ERROR`），共 11 个错误码
- **`ErrorCategory`** 枚举：6 大类 —— `Validation` / `NotFound` / `Permission` / `Database` / `FileSystem` / `Internal`
- **`CODE_TO_CATEGORY`**：错误码 → 类别的静态映射表
- 工具函数：`categoryOfCode(code)` / `isUserFacing(category)`

#### `app-error.ts`

- **`AppError`** 继承 `Error`，携带 `code` / `details` / `userMessage` / `cause` 四个只读字段
- **静态工厂方法**（8 个）：`validation` / `forbidden` / `notFound` / `unauthorized` / `conflict` / `canceled` / `preconditionFailed` / `internal`
- **6 个分类子类**：`ValidationError` / `NotFoundError` / `PermissionError` / `DatabaseError` / `FileSystemError` / `InternalError`
- **序列化**：`toIpcError()` / `toJSON()` 输出 `{code, message, userMessage?, details?}`，**`cause` 不跨 IPC 传输**
- **类型守卫**：`isAppError` / `isValidationError` / `isNotFoundError` / `isPermissionError` / `isDatabaseError` / `isFileSystemError` / `isInternalError`
- **辅助函数**：`toIpcError(unknown)` / `extractUserMessage(error, fallback)`

**调用链**：handler 抛 `AppError` → `wrapHandler` 的 `handleError` 调 `toIpcError()` → 包成 `{success:false, error: IpcError}` → preload `call<T>` 解包时 `throw new IpcError(code, message, details, userMessage)` → 渲染层 `try/catch` 接收。

### 7.3 业务维度

#### `shared/dimension.ts`

- **`GroupDimension`**：`'none' | 'album_type' | 'scene_category' | 'scene_time' | 'outfit' | 'file_type'`
- **`GROUP_DIMENSION_OPTIONS`**：6 个 `{value, labelKey, label}` 三元组

#### `shared/scene-category.ts`

- **`SceneCategory`**：6 种 —— `thumbnail` / `screenshot` / `travel_journal` / `world_tour` / `collage` / `other`
- **`SceneTime`**：5 种 —— `day` / `night` / `dawn` / `dusk` / `unknown`
- **`SCENE_CATEGORIES`** 配置表（按优先级排序）：通过 `folderPattern`（如 `NikkiPhotos_LowQuality` / `ScreenShot` / `MagazinePhotos` / `ClockInPhoto` / `Collage_CollagePhoto`）匹配路径
- **`OUTFIT_PRESETS`**：34 个无限暖暖预设套装名
- 核心函数：`detectSceneCategory(filePath)` / `getSceneCategoryLabel` / `getSceneTimeLabel`

### 7.4 通用工具（renderer/utils/）

`src/common/utils/` 原为跨进程共享的纯工具模块，因无任何生产引用（死代码）已于轻量化优化时整体移除。
格式化 / 日期 / ETA 等工具统一收敛于 `src/renderer/utils/`（`format.ts` / `date.ts` 等），主进程侧工具各自内聚于 `src/main/utils/`。

---

## 8. 数据流

### 8.1 IPC 完整链路

```
渲染进程 (React Hook/Store)
   │  window.electronAPI.<domain>.<method>(...args)
   ▼
preload.ts (contextBridge.exposeInMainWorld)
   │  call<T>(channel, ...args) → ipcRenderer.invoke
   │  统一解包 IpcResponse<T>，失败抛 IpcError
   ▼
ipcMain.handle (src/main/ipc/handlers/*.ts)
   │  wrapHandler(ctx, zodSchema, handler) 包装：
   │    1. zod 校验参数 → 失败返回 IPC_VALIDATION_ERROR
   │    2. assertFileReadPath/assertFileWritePath（文件操作类）
   │    3. 调用 handler(args, ctx, event)
   │    4. 成功 → {success:true, data: T}
   │    5. 抛 AppError → {success:false, error: AppError.toIpcError()}
   │    6. 抛普通 Error → 标记 INTERNAL_ERROR + logger.error
   ▼
Service / Repository
   │  业务编排 + SQL 访问
   ▼
DatabaseManager
   │  读：同步 db.prepare().all()/get()
   │  写：async dbManager.executeAsync() → DatabaseWorkerBridge → utilityProcess
   ▼
better-sqlite3 (WAL 模式，meow_star_map.db)
```

### 8.2 实例一：media:list（读操作）

1. **渲染层** `mediaStore.ts` 调用 `window.electronAPI.media.list({ page, pageSize, accountUid, albumType, hideDuplicates, ... })`
2. **preload.ts** `media.list = (options) => call<MediaListResult>('media:list', options)`
3. **`call<T>`** 内部：`ipcRenderer.invoke('media:list', options)` → 收到 `IpcResponse<MediaListResult>` → 成功返回 `data`，失败 `throw new IpcError(...)`
4. **主进程** `ipc/handlers/media-handler.ts`：
   ```ts
   ipcMain.handle('media:list',
     wrapHandler(ctx, z.tuple([z.object({...}).optional()]),
       async ([options]) => {
         const result = getRepo().listMedia(options ?? {})
         return { files: result.rows.map(...), total, page, pageSize, hasMore }
       }))
   ```
5. **`MediaRepository.listMedia`**（同步路径，不走 worker）：
   - `buildListWhereClause(options)` 构建 WHERE（`is_deleted=0` / `account_uid=?` / `album_type=?` / `is_duplicate=0` / `media_source=?`）
   - 排序白名单防 SQL 注入（`created_at` / `modified_at` / `file_name` / `file_size` / `rating`，回收站默认按 `deleted_at`）
   - 分页：`SELECT ... LIMIT ? OFFSET ?`
   - `parseTagsField` 安全解析 `tags` JSON
   - **缓存优化**：默认视图（仅 `is_deleted=0`）命中 `app_settings.media_count` 缓存跳过 COUNT；非默认视图实时 COUNT
6. **返回**：`{success:true, data:{files, total, page, pageSize, hasMore}}`
7. **副作用**：list 不触发 `notifyMediaUpdated`；写操作（如 `media:updateRating`）会调用 `ctx.notifyMediaUpdated()` —— 节流 100ms 后通过 `mainWindow.webContents.send('media:updated')` 通知渲染层刷新

### 8.3 实例二：file:delete（文件操作）

1. **渲染层** `useFileOperations.ts` 调用 `window.electronAPI.file.delete(paths)`
2. **preload.ts** `file.delete = (filePaths) => call<FileOpResult>('file:delete', filePaths)`
3. **主进程** `ipc/handlers/file.ts`：
   ```ts
   ipcMain.handle(
     'file:delete',
     wrapHandler(ctx, z.tuple([schemas.filePathArray]), async ([filePaths]) => {
       for (const p of filePaths) assertFileReadPath(p) // 路径白名单校验
       return ctx.fileService.moveToRecycleBin(filePaths)
     })
   )
   ```
4. **PathGuard 白名单**：
   - **黑名单兜底**：`SYSTEM_SENSITIVE_DIRS` 始终拒绝（即使已注册）
   - **安全根**：用户主目录 `os.homedir()` + `app.getPath('userData')` 始终允许
   - **动态注册**：扫描器发现的媒体目录、对话框选择的目录通过 `pathGuard.register()` 注册
   - 失败抛 `AppError.forbidden`，details 中 `maskPath(p)` 仅保留末尾 2 段
5. **FileService.moveToRecycleBin**：循环 `shell.trashItem(filePath)`（系统回收站）
6. **返回**：`{success:true, data:{success:true, message:'已将 N 个文件移至回收站'}}`

### 8.4 实例三：media:permanentDelete（三阶段事务）

更复杂的链路展示主进程的副作用编排能力：

1. **二次确认**：`dialog.showMessageBox` 弹出警告，用户取消则 `throw AppError.canceled()`
2. **阶段 1**：`repo.softDeleteForPermanentDelete(ids)` —— 事务标记 `is_deleted=1`（幂等，可重试）
3. **阶段 2**：逐个 `shell.trashItem(file_path)`，区分"成功 / 文件不存在 / 失败"
4. **阶段 3**：`repo.hardDeleteBatch(idsToDelete)` —— 事务物理删除 DB 记录
5. **一致性保证**：中断后 DB 仍有 `is_deleted=1` 记录，用户可重试

### 8.5 media:// 协议数据流

```
渲染进程 <img src="media://host/?path=<URL-encoded-absolute-path>">
   │
   ▼
protocol.handle('media', async (request) => {...})
   │
   ├─ 1. 解析 url.searchParams.get('path')
   ├─ 2. decodeURIComponent + path.resolve 规范化
   ├─ 3. isMediaPathAllowed(normalizedPath) 白名单校验
   │      ├─ 路径级 LRU 缓存（TTL 5min，上限 1000）
   │      ├─ 缩略图缓存目录前缀匹配
   │      ├─ 数据库 file_path 精确匹配（UNIQUE 索引）
   │      ├─ 数据库 thumbnail 精确匹配
   │      └─ source_path 前缀匹配 + 扩展名白名单
   ├─ 4. fs.promises.access 校验可读
   ├─ 5. 根据扩展名获取 mimeType + isVideo
   ├─ 6. Range 请求支持：返回 206 Partial Content + Content-Range + Accept-Ranges
   └─ 7. 完整响应：返回 200 OK + Content-Type + Content-Length + Cache-Control: max-age=31536000
```

**关键安全修复**：

- 已修复 A-S2/C-F5：原实现 source_path 前缀匹配无扩展名限制，扫描 D:\ 后可读取整盘任意文件
- 已修复 A-S1/C-S2：原实现每次请求都执行数据库查询，现使用内存缓存（TTL 5 分钟）

### 8.6 状态流向

```
Electron主进程IPC
    ↕  (preload contextBridge)
stores (Zustand)
    ↕
hooks (副作用封装)
    ↕
components / pages (展示)
```

---

## 9. 数据库架构

### 9.1 数据库文件

- **路径**：`userData/database/meow_star_map.db`
- **模式**：WAL（Write-Ahead Logging）
- **PRAGMA 优化**：
  - `synchronous=NORMAL`（WAL 模式下安全且更快）
  - `cache_size=-20000`（20MB 缓存）
  - `temp_store=MEMORY`
  - `mmap_size=268435456`（256MB 内存映射）
  - `wal_autocheckpoint=1000`
  - `auto_vacuum=INCREMENTAL`
  - `busy_timeout=5000`

### 9.2 表结构

| 表                          | 字段（核心）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 用途                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **`media_files`**           | `id` (PK AUTOINCREMENT)、`file_path` (UNIQUE)、`file_name`、`file_type` ('image'/'video')、`file_ext`、`file_size`、`width`、`height`、`duration`、`created_at`、`modified_at`、`source_path`、`thumbnail`、`tags` (JSON 默认 '[]')、`category_id`、`rating`、`is_favorite`、`notes`、`indexed_at`、`scene_category`、`scene_time`、`outfit`、`is_deleted`、`deleted_at`、`is_missing`、`missing_count`、`phash` (64 字符 0/1 串)、`account_uid`、`album_type`、`is_duplicate`、`original_id`、`media_source` | 主表，27+ 字段                                                                                                         |
| **`categories`**            | `id`、`name` (UNIQUE)、`icon`、`color`、`sort_order`、`parent_id`、`is_system`、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                  | 分类树，含 7 个系统分类                                                                                                |
| **`scan_history`**          | `id`、`scan_type` ('full'/'incremental'/'signature')、`start_time`、`end_time`、`files_found`、`files_new`、`status`                                                                                                                                                                                                                                                                                                                                                                                          | 扫描历史                                                                                                               |
| **`app_settings`**          | `key` (PK)、`value` (JSON 字符串)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | KV 设置存储，含 `media_count` 缓存                                                                                     |
| **`filter_presets`**        | `id`、`name`、`category`、`params` (JSON)、`is_builtin`、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                         | 滤镜预设                                                                                                               |
| **`watermark_templates`**   | `id`、`name`、`config` (JSON)、`is_builtin`、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 水印模板                                                                                                               |
| **`edit_history`**          | `id`、`media_id` (FK CASCADE)、`params` (JSON)、`thumbnail`、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                     | 单媒体编辑历史                                                                                                         |
| **`operation_history`**     | `id`、`operation_type` (13 种)、`media_id`、`payload` (JSON)、`description`、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                     | 全局操作历史（跨重启撤销），启动时自动清理 30 天前记录                                                                 |
| **`character_profiles`**    | `uid` (PK)、`nickname`、`avatar`、`created_at`、`last_active_at`                                                                                                                                                                                                                                                                                                                                                                                                                                              | 角色档案，默认 'default'                                                                                               |
| **`favorites`**             | `id` (PK AUTOINCREMENT)、`media_id` (NOT NULL UNIQUE)、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                           | 收藏关系表（与 `media_files.is_favorite` 并存）                                                                        |
| **`import_roots`**          | `id` (PK AUTOINCREMENT)、`root_path` (NOT NULL UNIQUE)、`created_at`、`disabled` (默认 0)                                                                                                                                                                                                                                                                                                                                                                                                                     | 导入根登记，供导入向导与路径授权判定                                                                                   |
| **`pending_renames`**       | `id` (PK AUTOINCREMENT)、`old_path`、`new_path`、`new_file_name`、`created_at`、`retry_count` (默认 0)、`last_retry_at`                                                                                                                                                                                                                                                                                                                                                                                       | 重命名失败补偿队列，启动时重试                                                                                         |
| **`asset_edits`**           | `asset_id` (TEXT PK)、`is_favorite`、`rating`、`tags` (JSON)、`notes`、`category_id`、`outfit`、`scene_category`、`scene_time`、`is_hidden`、`deleted_at`、`updated_at`                                                                                                                                                                                                                                                                                                                                       | 同步面（NikkiSync 资产）编辑覆盖层，2026-10-14（2.5.5 期间）由 0790252 新增；与 `media_files` 表级隔离，绝不回写原有表 |
| **`sync_service_state`**    | `id` (PK CHECK id=1)、`library_revision`、`server_id`、`server_name`、`created_at`、`updated_at`                                                                                                                                                                                                                                                                                                                                                                                                              | 同步服务单行状态与库版本号                                                                                             |
| **`sync_paired_devices`**   | `device_id` (PK)、`device_name`、`platform` (ios/android)、`public_key`、`credential_hash`、`app_version`、`paired_at`、`last_seen_at`、`last_ack_revision`                                                                                                                                                                                                                                                                                                                                                   | 已配对设备与 Ed25519 公钥                                                                                              |
| **`sync_pairing_sessions`** | `pairing_token_hash` (PK)、`server_id`、`expires_at`、`used_at`、`created_at`                                                                                                                                                                                                                                                                                                                                                                                                                                 | 一次性配对令牌（只存 sha256，兑换后置 used_at）                                                                        |
| **`sync_change_journal`**   | `revision` (PK CHECK >0)、`event_type` (asset.created/updated/deleted)、`asset_id`、`occurred_at`、`payload_json`                                                                                                                                                                                                                                                                                                                                                                                             | 变更日志，客户端按 revision 增量拉取                                                                                   |
| **`sync_motion_links`**     | `still_media_id` (PK)、`motion_media_id` (NOT NULL UNIQUE)、`method` (embedded_id/filename/timestamp/heuristic/manual)、`confidence` (0–1)                                                                                                                                                                                                                                                                                                                                                                    | 静帧与动图（Live Photo）配对关系                                                                                       |
| **`schema_migrations`**     | `name` (PK)、`applied_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 命名迁移跟踪                                                                                                           |

**共鸣录表（2.5.0 新增 5 张；`resonance_banner_wishlist` 由 2545252「移植上游卡池心愿单」于 2026-10-10（2.5.3 期间）追加，共 6 张）**：DDL 常量 `RESONANCE_DDL_STATEMENTS`（`src/main/database/resonance-repository.ts`）由 `connection.ts` 的共鸣录迁移以 `db.exec` 逐条执行，全部为 `CREATE TABLE IF NOT EXISTS`，幂等可重复执行；6 张表均纳入既有整库备份 / 恢复。

| 表                              | 字段（核心）                                                                                                                                | 用途                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **`resonance_pulls`**           | `id` (PK)、`banner_id`、`item_id`、`obtained_at`、`source` ('json'/'manual-import')、`created_at`；UNIQUE (banner_id, obtained_at, item_id) | 抽卡记录主表                                                       |
| **`resonance_edits`**           | `id` (PK)、`banner_id`、`item_id`、`obtained_at`、`created_at`；UNIQUE (banner_id, item_id)                                                 | 手动补录记录                                                       |
| **`resonance_pearpal`**         | `banner_id`、`item_id`、`pool_cnt`、`obtained_at`、`raw_json`；UNIQUE (banner_id, item_id, pool_cnt)                                        | 美鸭梨（Pear-Pal）抓取记录，保留原始 JSON                          |
| **`resonance_evo`**             | `banner_id`、`outfit_id`、`level` (0–4)、`updated_at`；UNIQUE (banner_id, outfit_id)                                                        | 套装进化等级                                                       |
| **`resonance_wardrobe_items`**  | `category` ('item'/'makeup'/'momo'/'prop'/'eureka_color')、`item_id`、`updated_at`；PRIMARY KEY (category, item_id)                         | 我的衣橱拥有状态                                                   |
| **`resonance_banner_wishlist`** | `banner_id` (NOT NULL, UNIQUE)；写入为整表覆盖式（卡池心愿单是「当前集合」而非历史）                                                        | 卡池心愿单标记（2.5.5-beta 新增，经 `resonance:setWishlist` 写入） |

### 9.3 关键索引

**`media_files` 单列索引（15 个）**：`file_type` / `category_id` / `is_favorite` / `modified_at` / `thumbnail` / `source_path` / `scene_category` / `scene_time` / `outfit` / `is_deleted` / `is_missing` / `phash` / `account_uid` / `album_type` / `is_duplicate` / `original_id` / `media_source`

**联合索引（5 个）**：

- `idx_media_files_default_view` (is_deleted, account_uid, album_type) —— 图库默认列表
- `idx_media_files_profile_stats` (account_uid, is_deleted, file_type) —— 角色档案统计
- `idx_media_files_duplicate_group` (is_duplicate, is_deleted, original_id) —— 重复分组
- `idx_media_files_outfit_agg` (is_deleted, outfit) —— 套装聚合
- `idx_media_files_scene_analysis` (scene_time, file_type, is_deleted) —— 场景时段分析

**其他索引**：`idx_categories_parent_id` / `idx_edit_history_media_id` / `idx_operation_history_created_at` / `_media_id` / `_type` / `idx_character_profiles_nickname`

### 9.4 读写分离架构

- **读操作**：主进程 `DatabaseManager` 同步执行（读多写少，需同步语义）
- **写操作**：`DatabaseManager.executeAsync()` → `DatabaseWorkerBridge.execute()` → utilityProcess
- **降级路径**：未注入 `workerBridge` 时（如测试场景），写操作降级为同步直写主进程 db
- **事务**：worker 进程使用 better-sqlite3 原生 `db.transaction`，任一 statement 失败回滚

---

## 10. 安全与可观测性

### 10.1 安全基线

#### 10.1.1 Electron 安全配置

- `contextIsolation: true` —— 上下文隔离
- `nodeIntegration: false` —— 禁用 Node 集成
- `sandbox: true` —— 沙箱模式
- `protocol.registerSchemesAsPrivileged` —— media:// 与 app:// 协议特权声明

#### 10.1.2 导航防护与 preload 授信源

`preload` 是 webContents 级 `webPreferences`，对窗口加载的**任何**文档都会执行，与页面来源无关；
且 preload 不受页面 CSP 约束。因此「导航到非应用文档」等于把完整 IPC 桥交给那个文档。
两层防线独立生效（`will-navigate` 拦截为第一层，preload 自检为第二层）：

- **主进程侧** `src/main/app/navigation-guard.ts`：`isAppDocumentUrl(url, isDev)`
  - 放行：`app://` / `media://`；仅 dev 放行 `http://localhost:5173`、`http://127.0.0.1:5173`
  - 拒绝：`file://`（全环境）、非 5173 端口的 localhost、一切外站
  - 拦截时 `event.preventDefault()` + `logFault('navigation-blocked', …, { source, url })`
  - `window-manager.ts` 同时注册 `will-navigate`（主帧）与 `will-frame-navigate`（子帧；
    主帧事件短路，避免重复记故障）
- **preload 侧** `src/main/preload/origin-guard.ts`：`isTrustedDocumentOrigin(origin, isDev)`
  - 非授信文档不执行任何 `exposeInMainWorld`（`electronAPI` / `IpcError` / `pluggableElectronIpc` /
    `__setPluginI18nT` / `pluginAPI`）
  - 空 / `'null'` / `about:` 一律拒绝（opaque origin 会被 evil 父页 `document.write` 后访问其 `contentWindow`）
  - dev 开关来自编译期常量 `__NIKKI_PRELOAD_DEV__`（`electron.vite.config.ts` 的 preload `define`），
    未注入时安全缺省 `false`——运行时 `process.env` 在 sandbox preload 内不可靠

两处放行集合必须逐字镜像，改一处要同步改另一处（preload 不得引入主进程模块，故无法共用同一模块）。

#### 10.1.3 IPC 路径白名单（PathGuard）

- **默认拒绝**策略
- **黑名单兜底**：`SYSTEM_SENSITIVE_DIRS`（Windows/ProgramData/$recycle.bin/System32 等）始终拒绝
- **安全根**：用户主目录 + userData 目录始终允许
- **动态注册**：扫描器发现的媒体目录、对话框选择的目录
- **文件操作类 handler** 必须调用 `assertFileReadPath` / `assertFileWritePath`

#### 10.1.4 media:// 协议白名单

5 层校验：

1. 路径级 LRU 缓存（TTL 5 分钟，上限 1000）
2. 缩略图缓存目录前缀匹配
3. 数据库 `file_path` 精确匹配（UNIQUE 索引）
4. 数据库 `thumbnail` 精确匹配
5. 已索引 `source_path` 前缀匹配 + 扩展名白名单

#### 10.1.5 参数校验

- 所有 IPC handler 通过 `wrapHandler` 包装
- zod schema 校验参数类型与范围
- 通用 schema 集合：filePath / filePathArray / mediaId / rating / uid / httpUrl / uiTheme 等

### 10.2 可观测性

#### 10.2.1 故障日志（logger.ts）

- **10 类 FaultType**：uncaughtException / unhandledRejection / rendererCrash / ipcError / databaseError / fileSystemError / startupError / exitDiagnosis / decryptionError / custom
- **FaultRecord** 含完整环境信息：appVersion / electronVersion / nodeVersion / platform / osVersion / pid / uptime
- 日志总上限 2GB，超限按 mtime 升序删除最旧
- 文件命名：`faults-YYYY-MM-DD.jsonl`

#### 10.2.2 启动诊断（startup-diagnostic.ts）

- 在 logger 系统就绪前提供独立错误记录能力
- 直接写文件到 `userData/startup-errors.log`
- 100KB 上限滚动

#### 10.2.3 崩溃报告（crash-service.ts）

- `crashReporter.start({ uploadToServer: false, compress: true })`
- dump 文件保留 10 份 + 30 天过期
- 列表/统计/清理/打开目录

#### 10.2.4 进程退出诊断

- `collectExitDiagnosis(stage)` 收集活跃句柄/请求/子进程数/定时器数
- before-cleanup 与 after-cleanup 双阶段对比
- 同步写入 faults-*.jsonl（fs.appendFileSync，避免异步 I/O 延迟退出）

#### 10.2.5 渲染层错误上报

- `installGlobalErrorHandler` 注册 `window.onerror` + `unhandledrejection`
- IPC 上报到主进程 faults 日志（`log:reportRendererError`）
- ErrorBoundary 捕获子组件渲染同步异常
- `console-message` 事件捕获渲染层 error 级别日志

### 10.3 资源生命周期管理

#### 10.3.1 子进程注册表（process-registry.ts）

- `trackProcess` / `trackFfmpegCommand` / `untrackFfmpegCommand`
- `killAllProcesses(signal)` —— 退出时 kill 所有活跃 ffmpeg/ffprobe/PowerShell 子进程
- 60 秒兜底清理定时器

#### 10.3.2 单实例锁

- `app.requestSingleInstanceLock()` + 3 次重试（每次间隔 1s）
- 三选项对话框：清理并重启 / 手动处理 / 退出
- `before-quit` 中显式 `app.releaseSingleInstanceLock()`
- `uncaughtException` / `unhandledRejection` 处理器中显式释放锁 + `app.exit(1)`

#### 10.3.3 强制超时退出兜底

- `before-quit` 中根据 WAL 文件大小动态计算超时（2s / 5s）
- `forceExitTimer` 超时则 `app.exit(1)`
- 所有 `app.exit()` 调用直接执行，不使用 setTimeout 延迟

---

## 11. 构建与发布

### 11.1 构建脚本

```json
"dev": "electron-vite dev",
"clean": "node -e \"...删除 dist/renderer/assets 与 dist/main...\"",
"build": "npm run clean && electron-vite build && node -e \"...写 dist/main/package.json {\"type\":\"commonjs\"}...\"",
"build:preview": "vite build --config vite.preview.config.ts",
"preview": "electron-vite preview",
"dist": "npm run build && electron-builder --publish never",
"dist:win": "npm run build && npm run pre-dist-check && electron-builder --win --publish never && npm run verify:dist",
"pre-dist-check": "tsx scripts/pre-dist-check.ts && tsx scripts/check-doc-versions.ts",
"verify:dist": "tsx scripts/pre-dist-check.ts --verify-asar",
"typecheck": "tsc -b",
"typecheck:e2e": "tsc --noEmit -p e2e",
"lint / lint:fix": "eslint .（--fix 自动修复）",
"format / format:check": "prettier（覆盖 src / scripts / .storybook / 根目录）",
"test / test:watch / test:coverage / test:main / test:renderer / test:db": "vitest（按目录变体）",
"i18n:check / i18n:extract / i18n:extract:gallery / i18n:status / i18n:extract-legacy / i18n:prune-whitelist / i18n:codemod / i18n:guard / sync-i18n-keys": "i18n 脚本族（scripts/i18n/）",
"preview:check": "tsx scripts/check-preview-drift.ts",
"e2e:smoke": "playwright test --config e2e/playwright.config.ts --grep-invert @perf",
"e2e:perf": "playwright test --config e2e/playwright.config.ts --grep @perf",
"dist:win:smoke / dist:win:perf": "打包 + 冒烟 / 性能用例一键执行",
"perf:save-baseline": "tsx scripts/perf-test/save-perf-baseline.ts",
"storybook": "storybook dev -p 6006",
"build-storybook": "storybook build -o storybook-static",
"commit": "cz（commitizen 交互式提交）",
"commitlint / commitlint:check": "commitlint 提交信息校验"
```

> 已移除的历史脚本：`build:main` / `build:renderer`（现由 `electron-vite` 统一编译与打包）、`rebuild:native`
> （原生模块重建改用手执行 `npx @electron/rebuild`，打包期由 `package.json` 的 `build.npmRebuild: true` 自动完成）。

### 11.2 构建配置

#### `electron.vite.config.ts`（主/preload/renderer 三段式）

- **main**：lib 多入口 6 个（`index` / `scanner-worker` / `media-worker` / `thumbnail-worker` / `video-worker` / `database-worker`，各自 worker-entry.ts），outDir `dist/main/main/app`，CJS 输出；`writeCommonjsShim()` 写入 `dist/main/package.json {"type":"commonjs"}`
- **preload**：entry `src/main/preload.ts`，outDir `dist/main/main`，define 注入 `__NIKKI_PRELOAD_DEV__`
- **renderer**：`root: './src/renderer'`、dev 端口 5173（strictPort）、outDir `dist/renderer`；`resolve.alias`：`@` → renderer、`@main` → main、`@common` → common（`src/common` 已移除，别名仅为历史遗留），`electron` → `scripts/electron-browser-stub.js`；define 注入 `__PREVIEW__: false`

#### `vite.preview.config.ts`（单文件预览版）

- `vite-plugin-singlefile` 全内联打包，产出根目录 `preview.html`；define 注入 `__PREVIEW__: true`

#### `tsconfig.json`（根，渲染进程）

- `target: ES2020`、`module: ESNext`、`jsx: react-jsx`、`strict: true`
- `noUnusedLocals` / `noUnusedParameters` / `noFallthroughCasesInSwitch` 启用
- `paths`：`@/*` / `@main/*` / `@common/*`
- `references: [{path: "./src/main/tsconfig.json"}]` —— 项目引用（composite）

#### `src/main/tsconfig.json`（主进程）

- `target: ES2020`、`module: commonjs`（Electron 主进程需 CJS）
- `outDir: '../../dist/main'`、`rootDir: '../'`
- `declaration: true`、`sourceMap: true`、`composite: true`
- `include: ["**/*", "../shared/**/*"]`

#### `tailwind.config.ts`

- `content: ['./src/renderer/**/*.{js,jsx,ts,tsx}', './src/renderer/index.html']`
- `theme.extend.colors`：12 个 CSS 变量映射（`accent` / `bg-primary` / `text-primary` 等），全部用 `var(--xxx)` 引用，便于主题切换
- `transitionTimingFunction`：`win11` / `win11-decelerate` 两个 cubic-bezier

#### `electron-builder` 配置（嵌入 package.json）

- `appId: com.qianlu.meow-star-map`
- `productName: 喵星图`
- `directories.output: release`
- `files: [dist/**/*, resources/**/*]`
- **`asarUnpack`**：10 项 native 依赖解包到磁盘 —— `ffmpeg-static` / `ffprobe-static` / `better-sqlite3` / `bindings` / `file-uri-to-path` / `sharp` / `@img` / `koffi` / `@koromix` / `nuan5_decryption.dll`
- **Windows NSIS**：x64、非 one-click、允许自定义安装目录、强制创建桌面快捷方式 + 开始菜单快捷方式
- `signAndEditExecutable: false` / `verifyUpdateCodeSignature: false` —— 未启用代码签名

### 11.3 构建流程

1. `clean` —— 删除 `dist/renderer/assets` 与 `dist/main`
2. `electron-vite build` —— 编译主进程（`src/main` + `shared/`，CJS）→ `dist/main/`，同时用 Vite 打包 React 应用 → `dist/renderer/`；随后写入 `dist/main/package.json`（`{"type":"commonjs"}`）
3. `pre-dist-check` —— 校验 main / renderer 产物时间戳差 ≤5 分钟、关键修复点已编入产物、Git 工作区干净；并校验 `README.md` 中的 Electron 版本与 `package.json` 一致（不一致即阻断打包）
4. `electron-builder --win --publish never` —— 按 `package.json#build` 配置打包 NSIS 安装包到 `release/`，产物名 `MeowStarMap-Setup-<version>.exe`；afterPack 阶段由 `scripts/after-pack-vc-runtime.cjs` 将 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` / `concrt140.dll` 复制到 `electron.exe` 同级
5. `verify:dist` —— `pre-dist-check --verify-asar`，断言 VC++ 运行库等原生依赖已随包
6. 原生模块重建 —— 本地执行 `npx @electron/rebuild`；打包期由 `build.npmRebuild: true` 自动完成（better-sqlite3 / sharp / koffi）

### 11.4 关键依赖

- **Electron 41.10** + **React 19.2** + **Zustand 5** + **Vite 6** + **TypeScript 5.9**
- **better-sqlite3 12** —— 同步 SQLite，主进程读 + worker 写
- **sharp 0.35** —— 图片处理（缩略图、编辑器 pipeline）
- **zod 4** —— IPC 参数校验
- **exifr 7** —— EXIF 解析
- **fluent-ffmpeg 2** + **ffmpeg-static** + **ffprobe-static** —— 视频处理
- **koffi 3** —— FFI 调用 `nuan5_decryption.dll`
- **i18next 26** + **react-i18next 17** —— 12 种语言国际化
- **motion 12** —— 动画

### 11.5 桌面快捷方式

NSIS 安装器在覆盖安装等场景下可能未创建桌面快捷方式，应用启动时主动检查并补创建：

- 仅 `app.isPackaged` 环境执行
- 优先级：注册表自定义桌面路径 → `app.getPath('desktop')` → 用户主目录 fallback
- 快捷方式已存在时校验 target 有效性，失效则重建
- 使用 Electron 原生 `shell.writeShortcutLink`
- fire-and-forget 异步调用，避免阻塞启动流程

---

## 12. 关键设计约束

### 12.1 同步迭代原则

- HTML 预览版与 exe 程序必须同步迭代
- 两者界面布局、配色、菜单层级、交互逻辑、视觉风格完全统一
- HTML 预览版仅作为开发期设计预览载体，不是独立产品
- 后续迭代更新必须同时修改 HTML 预览版和 exe 程序，确保版本同步

### 12.2 版本号约束

- **版本号必须保持不变，除非用户明确要求**
- 当前版本：2.5.5-beta（2026-10-11 由用户要求从 2.5.3 升至 2.5.5，2026-10-16 定版为 2.5.5-beta）
- 改版本号需同步：`package.json` 的 `version`、`README.md` 版本徽章、`ARCHITECTURE.md` / `ARCHITECTURE.en.md` 头部与 §12.2、`DEVELOPMENT.md` / `DEVELOPMENT.en.md` 头部与 §7.8；安装程序文件名由 `artifactName` 模板自动跟随（`MeowStarMap-Setup-${version}.exe`）

### 12.3 性能红线

- 页面切换 FPS ≥ 55
- 包体积增量 ≤ 20KB gzip
- 不在 VirtualImageGrid 虚拟列表中使用 motion（性能风险）
- 保留 keep-alive 机制（不破坏滚动位置与组件状态）
- 页面切换使用轻量淡入动画（8px 右移 + 淡入，220ms）
- 毛玻璃效果需搭配实质性彩色背景内容，避免在纯色背景上使用
- 毛玻璃组件使用 `backdrop-filter: blur(12px)` + `rgba(255, 255, 255, 0.7)` 基础样式
- 毛玻璃组件不使用 inset 高光和 saturate filter，保持简洁样式
- 毛玻璃背景使用 `var(--bg-primary)` 而非径向渐变

### 12.4 进程退出可靠性

- 所有 `app.exit()` 调用必须直接执行，不使用 setTimeout 延迟
- `uncaughtException` / `unhandledRejection` 处理器必须添加 `app.releaseSingleInstanceLock?.()` + `app.exit(1)`，消除僵尸进程持锁
- `before-quit` 处理器必须 `event.preventDefault()` 防止默认退出流程
- `dbManager.close()` 必须在单独的微任务中执行，避免阻塞事件循环
- `performCleanup` 中的异步操作必须添加 `Promise.race()` 超时保护
- 诊断日志写入必须使用同步 API（`fs.appendFileSync`），避免异步 I/O 延迟退出
- 单实例锁释放必须在所有关键清理步骤完成后立即执行

### 12.5 原生二进制依赖

- `ffmpeg-static` / `ffprobe-static` / `better-sqlite3` / `bindings` / `file-uri-to-path` / `sharp` / `@img` / `koffi` / `@koromix` / `nuan5_decryption.dll` 必须通过 `asarUnpack` 解包
- ffmpeg/ffprobe 路径必须通过 `native-path.ts` 工具替换 `app.asar` → `app.asar.unpacked`

### 12.6 扫描器约束

- 游戏目录查找优先级：用户自定义 → 硬编码默认 → Steam 注册表 + libraryfolders.vdf → Epic 注册表 → 全盘签名搜索（深度 15）
- 全盘签名搜索必须先浅深度 4 快速定位，再深扫描
- 必须跳过系统目录（Windows/ProgramData/$recycle.bin/onedrive/iclouddrive/dropbox/google drive 等）
- 首次启动必须全盘扫描（incremental:false, fullScan:true）
- 扫描完成后必须发送 `scanner:complete` 事件
- 视频元数据提取必须包含 15 秒超时保护
- ScreenShot 检测必须包含路径上下文校验（必须含 'infinitynikki' 或 'x6game'）

### 12.7 分享功能约束

- 必须检测目标应用的安装与运行两种状态（微信、QQ、vivo 办公套件）
- 4 层 fallback 链：注册表候选 → 卸载项枚举 → 常见目录扫描 → 进程路径反查
- 微信优先 'Weixin' 注册表键和 'Weixin.exe' 进程，'WeChat' 作为 fallback
- QQ 使用 'QQNT'（无下划线）注册表键，查询 Uninstall 项的 DisplayIcon
- UI 必须显示三种状态：运行中、已安装未运行、未安装
- 自动关闭策略：运行中 3s，未安装 5s

### 12.8 数据库约束

- 所有 SQL INSERT 语句必须确保 VALUES 占位符数量与 `insertStmt.run()` 参数数量一致
- `operation_history` 表启动时清理 30 天前记录
- `character_profiles` 表 `nickname` 列必须有索引
- SQL insert 语句必须缓存 prepared statements 作为类成员，数据库连接变化时重置
- 旧数据修复必须在 startScan 时执行一次，修复 `media_source='unknown'` 记录并移除非游戏路径记录

### 12.9 日志约束

- 日志文件不得包含用户隐私数据
- 日志存储不得超过 2GB，超限按 mtime 升序删除最旧（见 §10.2.1）
- 日志文件按日期命名，自动滚动存储
- 崩溃 dump 文件限制 10 份最新，旧的自动清理（见 §10.2.3）

### 12.10 应用初始化约束

- `new Application()` 必须包裹在 `app.whenReady().then()` 中，避免 `app.getPath('userData')` 在 app ready 前调用
- `requestSingleInstanceLock()` 返回 false 时，必须显示对话框提示用户结束旧进程，禁止静默退出
- 主进程 `uncaughtException` 处理器必须使用 `hasShownRuntimeErrorDialog` 标志避免高频错误弹窗，仅显示首次错误
- `render-process-gone` 事件处理器必须 async，使用 `dialog.showMessageBox` 询问"重新加载/关闭应用"，三重 fallback（窗口销毁检查 → reload → createMainWindow）
- 应用启动失败错误对话框必须使用 `dialog.showMessageBox`（async）含"打开日志目录/退出"按钮
- `before-quit` 处理器必须包含 2 秒超时定时器，超时记录诊断并 `app.exit(1)`；清理完成时清除超时并 `app.exit(0)`

### 12.11 诊断包导出约束

- 必须使用 Windows 10 1803+ 内置 `tar.exe`（bsdtar）而非 PowerShell `Compress-Archive`，避免系统策略阻止
- 命令必须使用 `tar.exe -c --format=zip -f "目标路径.zip" -C "源目录" .`
- 创建后必须验证目标文件存在且非空，失败返回明确错误信息
- 不得依赖 PowerShell 执行策略

### 12.12 视频响应约束

- 必须支持 Range 请求（206 Partial Content + Content-Range）以支持 seek
- media 协议特权必须包含 `stream: true`
- 视频缩略图使用 `<img>` 元素，不受 `file_type === 'image'` 限制

### 12.13 自定义并发控制约束

- 必须使用自研 `concurrency.ts`（`runWithConcurrency`），避免 p-limit ESM `require()` 问题

### 12.14 共鸣录（Resonance）模块约束

- **离线优先**：共鸣录不得发起任何网络请求。静态数据全部随包——图鉴 11 片 + `banners.json` / `outfits.json` / `percentile.json` / `snapshot-meta.json` + 12 语言实体名包 + 73 张卡池缩略图（约 7.1MB）；卡池缩略图经 `src/renderer/data/resonance/thumbnails/index.ts` 静态 import 取得打包内相对 URL（`base: './'`），零外链
- **主进程职责边界**：主进程只做 zod 参数校验、PathGuard 白名单（`assertFileReadPath` / `assertFileWritePath`）、文件读写与 SQLite 存取；导入解析、合并去重、差异计数、导出载荷组装均为渲染层纯函数（`src/renderer/utils/resonance/`）
- **导入上限**（常量定义在 `src/shared/types/resonance.ts`）：单文件 `MAX_IMPORT_FILE_BYTES` = 64MB、总记录 `MAX_TOTAL_IMPORT_RECORDS` = 200000、单卡池 `MAX_PULLS_PER_BANNER` = 50000、单批提交 `MAX_COMMIT_BATCH_ROWS` = 2000、衣橱单批 `MAX_WARDROBE_BATCH` = 5000
- **导入提交**：渲染层按 `MAX_COMMIT_BATCH_ROWS` 分批调用 `resonance:commitImport`，每批一个事务、`INSERT OR IGNORE` 幂等，可中断后续传；`wardrobe` 仅最后一个批次携带（全量覆盖）
- **10 个 IPC 通道**全部经 `wrapHandler` + zod schema 校验：`resonance:getData`、`addManualRecord`、`updateManualRecord`、`deleteRecord`、`readImportFile`、`commitImport`、`export`、`updateWardrobe`、`setWishlist`、`clearAll`；`clearAll` 为危险操作，二次确认由渲染层负责
- **离线守护**：`src/renderer/utils/resonance/offline-guard.test.ts` 断言核心流程零网络调用并静态扫描新增源码，且含反向用例防假绿

### 12.15 工程不变量（2026-08 起收口）

**扫描通道编排**（`src/main/scanner/scan-channels.ts`）

- `resolveScanChannels` 只服务于「官方相册通道 + ScreenShot/Video 次级通道」编排；**带 `options.path` 的扫描走单目录分支（`scanDirectory`），不经过通道编排、无 UID 闸门**
- 只有 `fullScan: true 且无 path`、或 `!targetPath` 时才走 `findMediaDirectories → resolveScanChannels`
- 手动兜底 / 自定义目录扫描必须用 `fullScan: true + customKnownPaths`，**不要传 `path`**，否则拿不到官方相册通道的隐藏豁免与原生 LQ 复用

**游标分页 keyset**（`listMedia` 的 `useCursor`）

- 可空列在 DESC 排序时排尾；`sortValue === null` 的锚点用 `AND (col IS NULL AND id < ?)`，非 null 锚点分支必须 `OR col IS NULL`
- `orderBy` 必须含 `${col} IS NULL ${nullOrder}`（DESC → ASC）

**文件读流生命周期**

- 统一使用 `src/main/utils/managed-read-stream.ts` 的 `createManagedReadStream(filePath, { signal?, range?, onError? })`，**禁止裸写 `fs.createReadStream().pipe(dest)`**（`pipe` 只把源错误转发给 dest，外层 `try/catch` 覆盖不到异步阶段）
- 调用方：`src/main/app/media-protocol.ts`、`src/main/services/share-wifi-service.ts`
- 写入 HTTP 响应时仍须在 `res` 上挂 `error` / `close` 并用 `settled` 去重；Windows 上未关闭的 fd 会锁住文件

**IPC 读路径守卫**（`src/main/ipc/media-read-guard.ts`）

- `assertMediaReadPath` 快路径命中（`!isSensitivePath(p) && isMediaPathAllowed(ctx, p)`）后**必须**再以 `fs.realpathSync.native` 做敏感目录复检（纯字符串匹配识别不了 junction / 软链）；命中敏感则 `assertFileReadPath(real)`（传 real，不传入参）
- 刻意取舍：不重跑 `isMediaPathAllowed(real)`、不缓存 realpath（防 TOCTOU）；未命中分支原样传 `filePath`

**Worker 自恢复与 DB 句柄释放**

- 三处 bridge（`src/main/scanner/scanner-worker-bridge.ts`、`src/main/database/worker/database-worker-bridge.ts`、`src/main/media-worker/bridge.ts`）在 restore 前 `await` worker 回发 `*_DISPOSED`（`WORKER_DISPOSED` / `DB_WORKER_DISPOSED` / `MEDIA_WORKER_DISPOSED`），`DISPOSE_CONFIRM_TIMEOUT_MS = 2000` 超时兜底后再 kill

**相册类型解析**（`src/main/scanner/path-classifier.ts`、`src/main/utils/media-constants.ts`）

- `isGamePlayPhotosTree`（含无 `Saved` 变体，面向分类）与 `isGamePlayPhotosPath`（仅标准布局，面向缩略图复用）**不可混用**
- 目录名查表必须用 `Object.prototype.hasOwnProperty.call(ALBUM_TYPE_MAP, key)`（目录名可能是 `constructor` / `toString`，裸下标会命中 `Object.prototype`）

**图库栈溢出防护**

- 视图区包区域级 `ErrorBoundary`（`resetKeys = [viewMode, filterSignature]`、`maxRetries = 3`）；网格视图 `overscan = 150`、`increaseViewportBy` 100/100
- **不升级 react-virtuoso**（4.x 递归问题未根治，issue #946）

**导航 / preload 授权边界（双层防线）**

- 主进程侧 `src/main/app/navigation-guard.ts` 的 `isAppDocumentUrl(url, isDev)`，经 `window-manager.ts` 的 `will-navigate` + `will-frame-navigate` 拦截
- preload 侧 `src/main/preload/origin-guard.ts` 的 `isTrustedDocumentOrigin`，5 个 `exposeInMainWorld` 全部走 `exposeIfTrusted()`
- 两处放行集合**镜像但不共用模块**（preload 禁引主进程模块），改一处须同步另一处；`will-frame-navigate` 回调**只有一个参数**（`url` / `isMainFrame` 挂在 Event 上）
- preload 内不可用运行时 `process.env`（lib 模式不替换），dev 标志用 `electron.vite.config.ts` 的 `define: { __NIKKI_PRELOAD_DEV__ }`

**原生依赖与启动早期可观测性**

- `scripts/after-pack-vc-runtime.cjs` 在 afterPack 阶段复制 `vcruntime140.dll` / `vcruntime140_1.dll` / `msvcp140.dll` / `concrt140.dll` 到 `electron.exe` 同级；`npm run verify:dist`（`pre-dist-check --verify-asar`）断言其存在
- `src/main/app/native-load-guard.ts` 在 `app.whenReady` 内预检，失败用不依赖 i18n 的 `dialog.showErrorBox`
- `src/main/utils/early-crash-guard.ts` 的 `reportEarlyFatal`：落盘 diagLog + `showErrorBox` + 释放单实例锁 + `app.exit(1)`，带去重守卫；诊断目录由 `src/main/utils/user-diag-path.ts` 指向 `文档/MeowStarMap/Diagnostics`
- 验证开关 `NIKKI_EARLY_CRASH_SIM=1` / `NIKKI_SKIP_NATIVE_GUARD=1`；单向依赖：不得反向 import `native-load-guard`

---

## 附录 A：核心设计模式

### A.1 多进程隔离

DB 写 / 扫描 / 缩略图+pHash+重复检测 / sharp 缩放 / 视频编辑 各自独立 utilityProcess，避免阻塞主进程事件循环。

### A.2 分级调度

用户主动触发（high）可抢占后台任务（low），低优先级 FIFO 串行（并发 1）。

### A.3 WAL 多连接并发

主进程读 + worker 写共享同一 db 文件，`busy_timeout=5000`。

### A.4 测试接缝

`MediaRepository` 可对内存数据库实例化，`path-classifier` 为纯函数。

### A.5 统一安全基线

`PathGuard` 白名单 + 系统敏感目录黑名单 + zod 校验 + `wrapHandler` 统一响应包装。

### A.6 资源生命周期管理

`process-registry` 跟踪所有子进程，`before-quit` 时 `killAllProcesses` + dispose 三个 worker bridge + WAL checkpoint + 强制超时兜底。

### A.7 keep-alive 路由

避免视图切换重挂载，保留滚动与组件状态。

### A.8 module-level 缓存

`useFilteredMediaFiles` 跨组件共享过滤结果。

### A.9 乐观更新 + 失败回滚

`useFavoriteToggle` 模式。

### A.10 按 type 分发的撤销处理器

`operationHistoryStore` 避免 undoFn 闭包捕获。

### A.11 Set 订阅模式

`addOperationHistoryErrorHandler` 支持多订阅者。

### A.12 统一动画预设

`motionPresets` 单一来源。

### A.13 BaseDialog 基类

所有对话框统一焦点陷阱/动画/遮罩行为。

### A.14 InfoRowPanel 公共载体

5 个 InfoPanel 共享四态渲染。

### A.15 CSS 变量主题体系

主题切换零 JS 重渲染。

### A.16 shared/ 跨进程共享

`scene-category` / `dimension` 消除渲染层反向导入主进程模块的循环依赖。

---

## 附录 B：关键文件路径索引

### B.1 入口与配置

| 文件                      | 用途                                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `src/main/index.ts`       | 主进程入口（Application 类）                                            |
| `src/main/preload.ts`     | preload 入口（装配 + contextBridge 暴露；模块树见 `src/main/preload/`） |
| `src/renderer/main.tsx`   | 渲染进程入口                                                            |
| `src/renderer/App.tsx`    | 应用根组件                                                              |
| `package.json`            | 依赖与构建配置                                                          |
| `electron.vite.config.ts` | 主/preload/renderer 三段式构建配置                                      |
| `vite.preview.config.ts`  | 单文件预览版构建配置                                                    |
| `tsconfig.json`           | TypeScript 配置（根，渲染进程）                                         |
| `src/main/tsconfig.json`  | TypeScript 配置（主进程）                                               |
| `tailwind.config.ts`      | Tailwind 配置                                                           |
| `eslint.config.js`        | ESLint 配置                                                             |

### B.2 类型与错误

| 文件                                  | 用途                                      |
| ------------------------------------- | ----------------------------------------- |
| `src/shared/types/index.ts`           | 共享类型统一导出                          |
| `src/shared/types/media.ts`           | 媒体域类型                                |
| `src/shared/types/ipc.ts`             | IPC 域类型 + IPC_CHANNELS 注册表          |
| `src/shared/types/ipc-types.ts`       | IpcResponse / IpcError 契约层             |
| `src/shared/types/progress.ts`        | 任务进度状态协议                          |
| `src/shared/types/plugin.ts`          | 插件系统共享类型                          |
| `src/shared/types/editor-metadata.ts` | 编辑器参数 XMP 序列化类型                 |
| `src/shared/types/duplicate.ts`       | 重复/相似检测域类型                       |
| `src/shared/settings-keys.ts`         | 渲染层可写 key 白名单 + 安全敏感 key 清单 |
| `src/shared/errors/app-error.ts`      | AppError 类与 6 个子类                    |
| `src/shared/errors/error-codes.ts`    | 错误码与类别映射                          |
| `src/shared/dimension.ts`             | 智能分组维度                              |
| `src/shared/scene-category.ts`        | 游戏场景分类                              |
| `src/shared/types/resonance.ts`       | 共鸣录域类型 + zod schema + 导入上限常量  |

### B.3 主进程核心

| 文件                                                 | 用途                                           |
| ---------------------------------------------------- | ---------------------------------------------- |
| `src/main/database/connection.ts`                    | DatabaseManager                                |
| `src/main/database/media-repository.ts`              | MediaRepository（SQL 访问层）                  |
| `src/main/database/worker/database-worker-bridge.ts` | Database Worker 桥接                           |
| `src/main/database/worker/database-worker.ts`        | Database Worker 入口                           |
| `src/main/database/worker/worker-protocol.ts`        | Database Worker 协议                           |
| `src/main/scanner/index.ts`                          | ScannerManager（薄壳）                         |
| `src/main/scanner/scanner-worker-bridge.ts`          | Scanner Worker 桥接                            |
| `src/main/scanner/path-classifier.ts`                | 路径分类纯函数                                 |
| `src/main/scanner/worker-entry.ts`                   | Scanner Worker 入口                            |
| `src/main/scanner/worker-protocol.ts`                | Scanner Worker 协议                            |
| `src/main/media-worker/manager.ts`                   | MediaWorkerManager（薄壳）                     |
| `src/main/media-worker/bridge.ts`                    | Media Worker 桥接                              |
| `src/main/media-worker/worker-entry.ts`              | Media Worker 入口                              |
| `src/main/media-worker/worker-protocol.ts`           | Media Worker 协议                              |
| `src/main/scheduler/task-scheduler.ts`               | 分级任务调度器                                 |
| `src/main/thumbnail/generator.ts`                    | ThumbnailGenerator                             |
| `src/main/ipc/handler-context.ts`                    | 依赖注入上下文                                 |
| `src/main/ipc/validator.ts`                          | wrapHandler + PathGuard + schemas              |
| `src/main/ipc/media-read-guard.ts`                   | `assertMediaReadPath`（含 realpath 复检）      |
| `src/main/ipc/handlers/resonance-handler.ts`         | 共鸣录 10 个 IPC 通道                          |
| `src/main/preload/api/resonance.ts`                  | `electronAPI.resonance` 命名空间               |
| `src/main/preload/origin-guard.ts`                   | `isTrustedDocumentOrigin` + `exposeIfTrusted`  |
| `src/main/app/navigation-guard.ts`                   | `isAppDocumentUrl`（导航防护第一层）           |
| `src/main/app/native-load-guard.ts`                  | 原生模块加载预检（VC++ 运行库）                |
| `src/main/database/resonance-repository.ts`          | 共鸣录 Repository + `RESONANCE_DDL_STATEMENTS` |
| `src/main/scanner/scan-channels.ts`                  | `resolveScanChannels` 扫描通道编排             |
| `src/main/utils/media-constants.ts`                  | 相册类型映射 `ALBUM_TYPE_MAP`                  |
| `src/main/utils/managed-read-stream.ts`              | `createManagedReadStream`（读流生命周期）      |
| `src/main/utils/early-crash-guard.ts`                | `reportEarlyFatal` 早期崩溃上报                |
| `src/main/utils/user-diag-path.ts`                   | 诊断目录定位                                   |

### B.4 渲染进程核心

| 文件                                                   | 用途                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `src/renderer/stores/mediaStore.ts`                    | 媒体数据 store                                                                   |
| `src/renderer/stores/uiStore.ts`                       | UI 全局状态 store                                                                |
| `src/renderer/stores/themeStore.ts`                    | 主题 store                                                                       |
| `src/renderer/stores/operationHistoryStore.ts`         | 操作历史 store                                                                   |
| `src/renderer/hooks/useFileOperations.ts`              | 文件操作核心 hook                                                                |
| `src/renderer/hooks/useFilteredMediaFiles.ts`          | 筛选+排序+分组 hook                                                              |
| `src/renderer/hooks/useIpcCall.ts`                     | IPC 调用包装 hook                                                                |
| `src/renderer/components/layout/AppShell.tsx`          | 整体布局骨架                                                                     |
| `src/renderer/components/layout/Sidebar.tsx`           | 侧边栏                                                                           |
| `src/renderer/components/common/BaseDialog.tsx`        | 模态对话框基类                                                                   |
| `src/renderer/components/common/InfoRowPanel.tsx`      | InfoPanel 公共载体                                                               |
| `src/renderer/components/gallery/VirtualImageGrid.tsx` | 网格视图（虚拟滚动）                                                             |
| `src/renderer/components/gallery/FullscreenViewer.tsx` | 全屏浏览器                                                                       |
| `src/renderer/utils/imageProcessor.ts`                 | 图片处理管线                                                                     |
| `src/renderer/i18n/index.ts`                           | i18n 入口                                                                        |
| `src/renderer/styles/globals.css`                      | 全局样式 + CSS 变量                                                              |
| `src/renderer/styles/themes/index.ts`                  | 主题配置中心                                                                     |
| `src/renderer/icons/index.tsx`                         | 74 个 SVG 图标集中管理                                                           |
| `src/renderer/pages/ResonanceRecordsPage.tsx`          | 共鸣录页面（记录 / 衣橱 / 导入导出 / 统计）                                      |
| `src/renderer/stores/resonanceStore.ts`                | 共鸣录 store                                                                     |
| `src/renderer/components/resonance/`                   | 共鸣录视图组件（Records / Wardrobe / ImportExport / Stats / AddRecordDialog）    |
| `src/renderer/utils/resonance/`                        | 共鸣录纯函数（导入解析 / 合并 / 导出 / 统计 / 百分位 / 静态数据 / 离线守护测试） |
| `src/renderer/data/resonance/`                         | 共鸣录静态数据（图鉴 / 卡池 / 套装 / 百分位 / 12 语言名称 / 卡池缩略图）         |

### B.5 资源

| 文件                                    | 用途                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `resources/icons/icon.ico`              | 应用图标                                                                                                          |
| `resources/nuan5_decryption.dll`        | 游戏图片参数解密 DLL                                                                                              |
| `src/renderer/assets/cloth-names.json`  | 7369 条服装名                                                                                                     |
| `src/renderer/assets/outfit-names.json` | 657 条套装名                                                                                                      |
| `src/renderer/data/resonance/`          | 共鸣录静态数据（图鉴 11 片 + 卡池 / 套装 / 百分位快照 + 12 语言名称 + 73 张卡池缩略图，约 7.1MB，全部随包零外链） |

---

## 附录 C：项目概览补充要点

> 本节由 `docs/PROJECT-OVERVIEW.md` 合并精简而来（原文件已删除），仅保留与本文档不重复的要点。

### C.1 双形态交付

- **exe 安装包**（electron-builder）：完整桌面应用。
- **单文件 HTML 预览版**（vite-plugin-singlefile + mock IPC）：共享同一套 UI 与交互，供免安装预览；exe 版与预览版须同步迭代、版本一致。

### C.2 质量门禁脚本

- `typecheck`（tsc -b）、`lint`（eslint）、`test`（vitest run）、`format`（prettier）、`i18n:check`、`preview:check`、`pre-dist-check`。

### C.3 测试规模

- Vitest 5.0，408 个测试文件 / 6312 个通过 + 2 个 skip（2026-10-17 本轮全量实跑；历史读数 337 / 5331 为 2026-10-10 快照，见 `docs/plans/2026-10-10-markdown-inventory-and-corrections.md` §8.10）。
- 历史基线中的两个环境性失败（`path-safety.test.ts` 只读目录用例、`GalleryStackOverflow.test.tsx`）已在 2.5.0 修复，当前无既有失败。

---

**文档结束**

## 开发者信息 / 作者与社交平台

- **抖音**：纤璐不会玩摄影 ([主页链接](https://v.douyin.com/Dx67wYkw48A/))
- **小红书**：纤璐不会玩摄影 ([主页链接](https://www.xiaohongshu.com/user/profile/69270bb200000000370092db))
- **哔哩哔哩**：纤璐不会玩摄影 ([主页链接](https://b23.tv/zCR5oGE))
- **GitHub**：[QianQianLuLu1](https://github.com/QianQianLuLu1)
- **CSDN博客**：[QianQian-LuLu](https://blog.csdn.net/2604_96788940)
- **作者官网**：https://ppebv9al.qwenwork.host/
