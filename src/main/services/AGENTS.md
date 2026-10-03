# AGENTS.md — `src/main/services`（主进程业务服务层）

本文件为 Agent 与新协作者提供 **services 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC handler 注册层约定见 [`../ipc/handlers/AGENTS.md`](../ipc/handlers/AGENTS.md)；AppError 错误分类与 CSS 变量等硬性约定见 always-on 规则 `project-conventions.md`。本文件只补 **本目录内** 的服务设计与依赖约定。

## 模块概述

`src/main/services/` 承载主进程侧的 **业务服务类与函数模块**，每个 service 封装一个独立业务域（备份、崩溃、解密、编辑器、文件操作、Live Photo、日志、分享、缩略图/pHash、视频、水印、XMP 元数据等）。它们被 [`src/main/ipc/handlers/`](../ipc/handlers/) 中的 handler 通过 `HandlerContext` 或直接 import 调用，**自身不注册任何 `ipcMain.handle`**——IPC 注册职责完全在 handler 层。

**核心约束**：service 层可依赖 Node.js 内置模块（`fs`、`path`、`crypto`、`http` 等）、Electron API（`app`、`shell`、`dialog`）、`src/main/` 下的工具与仓储，以及 `src/shared/` 的类型与错误定义。**禁止** 依赖渲染进程模块（`src/renderer/`）。

## 目录结构

```
src/main/services/
├── backup-service.ts              # 数据库备份（自动/手动/启动延迟）、恢复、LRU 清理
├── crash-service.ts               # 崩溃 dump 管理（列举/清理/目录初始化）
├── decryption-service.ts          # 游戏图片解密（koffi FFI → nuan5_decryption.dll，EXPECTED_ABI_VERSION 内联 ABI 校验）
├── editor-service.ts              # 图片编辑保存（备份→写入→恢复三段式 + 编辑历史）
├── file-service.ts                # 文件导出/移动/删除/重命名 + 命名规则变量替换
├── livephoto-service.ts           # Apple Live Photo 导出（JPG + MOV 配对）
├── log-service.ts                 # 日志/故障记录管理（列举/清理/打包上传）
├── share-clipboard-service.ts     # Windows 剪贴板文件分享（CF_HDROP + PowerShell）
├── share-clipboard-service.*.ts   # 剪贴板渠道检测辅助（微信/QQ/vivo办公等）
├── share-wifi-service.ts          # WiFi 局域网分享（HTTP 文件下载 + PIN 鉴权）
├── thumbnail-phash-service.ts     # 缩略图生成 + pHash 计算（单条/批量/分级调度）
├── video-service.ts               # 视频处理（导出/裁剪/调速/帧截图/元数据）
├── watermark-service.ts           # 水印批量应用（文本/图片 + 平铺/定位）
├── xmp-metadata-service.ts        # XMP 元数据写入/读取（wxnn: 自定义命名空间）
└── *.test.ts                      # 单元测试（与源码同目录，Vitest）
```

## 1. 服务设计模式

### 1.1 类 vs 函数模块

- **有状态/有生命周期** 的服务使用 **class**（如 `VideoService`、`WatermarkService`、`FileService`、`LivePhotoService`），通过构造函数或 setter 注入依赖（`dbManager`、`markCorruptedFn` 等）。
- **无状态/工具性质** 的服务使用 **函数模块**（如 `backup-service.ts`、`crash-service.ts`、`log-service.ts`），通过模块级变量管理状态（如 `crashDir: string | null`）。
- 新增 service 时按是否有实例状态选择；**不要** 在同一文件内混用两种风格。

### 1.2 依赖注入

- service 依赖 `HandlerContext`（[`../ipc/handler-context.ts`](../ipc/handler-context.ts)）获取 `dbManager`、`taskScheduler`、`mediaWorkerManager` 等聚合上下文。
- 部分 service 直接接收 `DatabaseManager` 实例（如 `EditorService` 构造注入）。
- **service 不直接访问 `Application` 单例**——所有外部依赖通过注入获得，便于单元测试 mock。

### 1.3 与 handler 层的边界

- handler 层负责 IPC 参数校验（zod）+ 响应包装（`wrapHandler`）+ 异常捕获；service 层 **只负责业务逻辑**。
- service 抛出 `AppError` 家族错误，由 handler 层的 `wrapHandler` 自动捕获并转为 `IpcError`。**禁止** 在 service 内 `try/catch` 后返回 `{ success: false }` 模拟错误——直接 `throw`。
- service 不 import `ipcMain` / `ipcRenderer`，不感知 IPC 通道。

## 2. 关键服务说明

| 服务                      | 核心职责                            | 关键依赖                                                         | 注意事项                                                                                       |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `backup-service`          | 数据库自动/手动备份、恢复、LRU 清理 | `better-sqlite3`（惰性加载）、`DatabaseManager`、`TaskScheduler` | 惰性加载 better-sqlite3（`import()` 而非 `require()`），使 ABI 不匹配时崩溃可被 bootstrap 捕获 |
| `decryption-service`      | 游戏图片 FFI 解密                   | `koffi`、`nuan5_decryption.dll`                                  | async mutex 串行化避免并发操作 C 内存 use-after-free；10MB 文件读取上限                        |
| `editor-service`          | 图片编辑保存 + 原图备份 + 编辑历史  | `sharp`、`MediaRepository`、`xmp-metadata-service`               | 备份→写入→恢复三段式保障；快照 LRU 上限 50 个                                                  |
| `file-service`            | 文件导出/移动/删除/重命名           | `sharp`、`exifr`、`pathGuard`                                    | 命名规则支持 `{date}` `{album_type}` `{uid}` 等变量替换                                        |
| `video-service`           | 视频导出/裁剪/调速/帧截图           | `fluent-ffmpeg`（经 `ffmpeg-runner`）、`video-probe`             | 超时按操作类型区分（导出 5 分钟、元数据 30 秒）；损坏文件回调标记                              |
| `watermark-service`       | 批量水印应用                        | `sharp`                                                          | 平铺间距必须为正数（`tileSpacingX/Y ≤ 0` 会导致死循环）                                        |
| `share-wifi-service`      | WiFi 局域网文件分享                 | `http`（Node 内置）、`network-address`                           | PIN 码鉴权；默认 10 分钟超时；仅绑定局域网 IP                                                  |
| `share-clipboard-service` | Windows 剪贴板文件分享              | `child_process`（PowerShell）                                    | 通过 PowerShell 写标准 CF_HDROP（非 Electron clipboard）                                       |
| `thumbnail-phash-service` | 缩略图生成 + pHash 计算             | `sharp`、`mediaWorkerManager`                                    | 批量任务下发到 utilityProcess；分级调度（high/low 优先级）                                     |
| `livephoto-service`       | Apple Live Photo 导出               | `fluent-ffmpeg`                                                  | UUID v4 作为 ContentIdentifier；JPG + MOV 配对                                                 |
| `xmp-metadata-service`    | XMP 元数据读写                      | `sharp`、`exifr`                                                 | 自定义 `wxnn:` 命名空间；`schemaVersion` 字段向前兼容                                          |
| `crash-service`           | 崩溃 dump 管理                      | `fs`                                                             | dump 保留上限 10 份 + 30 天过期自动清理                                                        |
| `log-service`             | 日志/故障记录管理                   | `fs`、`zip-archive`                                              | 基于目录 mtime + 文件列表签名的缓存失效机制                                                    |

## 3. 错误处理约定

- 可预期业务错误 **必须** 使用 `AppError` 家族（`src/shared/errors/app-error.ts`）：`ValidationError` / `NotFoundError` / `FileSystemError` 等。
- `cause` 字段携带原始错误（`fs` 错误、`sharp` 错误、`koffi` 错误等），用于日志排查。
- `userMessage` 给用户看（不含路径/堆栈），`message` 给开发者。
- **禁止** `throw new Error('字符串')` 表达可预期业务错误。

## 4. 原生模块与惰性加载

- `better-sqlite3`：`backup-service` 使用 `import()` 惰性加载，使 ABI 不匹配时崩溃能被 `bootstrapApplication` 的 `try/catch` 捕获。测试中 `vi.mock` 可正确拦截 `import()`。
- `koffi` + `nuan5_decryption.dll`：`decryption-service` 在模块加载时绑定 FFI 函数并缓存；引入 `EXPECTED_ABI_VERSION` 启动时校验。
- `sharp`：多个 service 直接 import（非惰性），若需改为惰性加载须同步更新对应测试 mock。

## 5. 文件安全与磁盘空间

- 涉及文件写入的 service（`file-service`、`editor-service`、`watermark-service`、`video-service`）在写入前 **必须** 调用 `assertFileWritePath`（`../ipc/validator.ts`）校验路径白名单。
- 大文件操作前应调用 `assertDiskSpace`（`../utils/disk.ts`）检查目标磁盘剩余空间。
- 唯一路径生成统一使用 `getUniqueFilePath`（`../utils/file-utils.ts`），避免文件名冲突覆盖。

## 6. 注意事项

- **service 不注册 IPC handler**——IPC 注册职责在 `src/main/ipc/handlers/` 层。
- **service 不直接访问 `Application` 单例**——通过依赖注入获取所需上下文。
- 新增 service 时，若被多个 handler 共用则放入本目录；若仅被单个 handler 使用且逻辑简单，考虑内联到 handler 文件。
- 单元测试与源码同目录，命名 `*.test.ts`（Vitest，`npm run test:main`）。mock 策略：`vi.mock` 外部依赖（`fs`、`sharp`、`koffi` 等），注入 fake `HandlerContext`。
- 修改 service 公共签名时须同步检查对应 handler 与测试是否受影响。
