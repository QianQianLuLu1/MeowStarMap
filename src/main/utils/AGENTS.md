# AGENTS.md — `src/main/utils`（主进程核心工具层）

本文件为 Agent 与新协作者提供 **主进程工具层模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像）。本文件只补 **本目录内** 的工具分类、编码约定与注意事项。

## 模块概述

主进程核心工具层——为 Electron 桌面应用的主进程提供底层基础设施，涵盖文件系统操作、并发控制、日志/诊断、媒体处理（ffmpeg/图片/视频）、IPC 安全校验、任务管理和进程生命周期管理。所有模块面向主进程内其他 service/handler/worker 层复用，**不直接暴露给渲染进程**。

## 目录结构

约 31 个源文件 + 28 个测试文件（27 个源文件有同名配套测试，即覆盖率 ≈ 87%），按职责可分为以下子域：

### 叶子层（零项目依赖，可安全被任何模块导入）

| 文件                  | 职责                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| `constants.ts`        | 全局常量（扫描延迟、缩略图并发、驱动器字母范围、缓存 TTL、数组上限等） |
| `concurrency.ts`      | `runWithConcurrency<T>()` / `createConcurrencyLimiter()` 并发控制      |
| `atomic-file.ts`      | `writeFileAtomic()` 原子写入（temp sibling + rename）                  |
| `eta-calculator.ts`   | `EtaCalculator` 类，滑动窗口 ETA 估算                                  |
| `image-encode.ts`     | 图片编码格式归一化、无损压缩选项                                       |
| `process-registry.ts` | 子进程/ffmpeg 命令跟踪与统一 kill                                      |
| `task-registry.ts`    | `TaskRegistry` 类，通用任务注册/查询                                   |
| `user-diag-path.ts`   | 用户面诊断目录路径候选链（Documents → appData → temp）                 |

### 日志与诊断

| 文件                    | 职责                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `logger.ts`             | `logger` 单例 + `initLogger` + `logFault` 故障记录（基于 electron-log）                                       |
| `startup-diagnostic.ts` | 启动期错误文件持久化（`diagLog` / `readStartupErrors`）                                                       |
| `early-crash-guard.ts`  | 启动早期致命错误弹窗 + 非致命错误提示（i18n 未就绪时的兜底；含 spawn 错误与流状态竞态两类"已就绪后降级"分类） |
| `spawn-error-log.ts`    | 子进程 spawn 错误分类与诊断日志                                                                               |

### 安全与校验

| 文件              | 职责                                                                          |
| ----------------- | ----------------------------------------------------------------------------- |
| `ipc-validate.ts` | IPC 参数校验工具集（敏感路径检测、文件路径/数组/数值/字符串/标签名/URL 校验） |
| `path-safety.ts`  | 路径安全（非 ASCII 检测、可写目录确保、安全二进制路径解析、PE 结构校验）      |
| `disk.ts`         | 磁盘空间断言（`assertDiskSpace`）                                             |

### FFmpeg 工具链

| 文件                    | 职责                                              |
| ----------------------- | ------------------------------------------------- |
| `ffmpeg-paths.ts`       | ffmpeg/ffprobe 路径解析（asar unpacked 安全替换） |
| `ffmpeg-runner.ts`      | `runFfmpegCommand()` 统一 ffmpeg 执行入口         |
| `fluent-ffmpeg-shim.ts` | fluent-ffmpeg spawn 守卫安装（幂等）              |
| `video-probe.ts`        | `probeVideoMetadata()` 视频元数据探测             |

### 媒体分析

| 文件                   | 职责                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `phash.ts`             | `calculatePHash()` / `hammingDistance()` 感知哈希（sharp） |
| `scene-brightness.ts`  | 场景亮度分析（批量 + 并发控制）                            |
| `video-frame.ts`       | 空白帧检测（标准差阈值）                                   |
| `duplicate-scoring.ts` | 重复文件评分与最佳选择                                     |
| `media-constants.ts`   | 媒体扩展名/MIME 映射、相册类型解析                         |

### 进度与任务

| 文件                   | 职责                                         |
| ---------------------- | -------------------------------------------- |
| `progress-throttle.ts` | `ProgressThrottle` 类，进度广播节流（200ms） |
| `active-task-store.ts` | 活跃扫描/索引任务状态存储                    |

### 高层工具

| 文件                       | 职责                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir-manager.ts`           | 自定义目录解析/迁移/确保（backup/thumbnail/log/crash）                                                                                                                 |
| `file-utils.ts`            | 文件工具（存在性检查、唯一路径、DataUrl 转换、哈希计算、移动）                                                                                                         |
| `managed-read-stream.ts`   | 受管读取流（字节范围 + 生命周期跟踪）；media:// 响应体由调用方经 `Readable.toWeb` 转换后供给 `new Response`（绕开 undici 对 Node 流的无守卫包装，2026-10-15 闪退根因） |
| `worker-restart-policy.ts` | `WorkerRestartPolicy` 类，worker 崩溃重启策略                                                                                                                          |
| `zip-archive.ts`           | `createZipFromDirectory()` ZIP 打包（archiver）                                                                                                                        |

## 编码约定

### 命名与风格

- 文件名 kebab-case；导出函数 camelCase；类 PascalCase；常量 UPPER_SNAKE_CASE。
- 中文 JSDoc 注释，每个模块顶部说明设计背景/动机，引用修复单号（如 P1-A7, R19）。

### 错误处理策略

- 工具函数普遍采用 **fail-open / best-effort** 策略——诊断/日志类模块绝不向业务冒泡异常。
- 校验函数返回 `{ valid, message? }` 结构体（`ipc-validate.ts`），不抛异常。
- `try/catch` 内静默忽略仅用于非关键路径；关键路径必须记录到 `logger` 或 `diagLog`。

### 依赖分层

- **叶子模块**（`constants`、`concurrency`、`atomic-file`、`user-diag-path` 等）刻意零项目依赖，避免循环依赖。
- i18n 分层：主进程用 `../i18n`；worker 安全场景用 `../i18n/worker-safe`；logger/诊断模块不依赖 i18n（中文硬编码作为兜底，因 i18n 可能未初始化）。
- 依赖方向：叶子层 → 基础工具层 → 安全/校验层 → FFmpeg 工具链 → 媒体分析 → 高层工具。**禁止反向依赖**（如 `logger.ts` 不得导入 `ffmpeg-runner.ts`）。

### 可测试性

- 通过依赖注入接口（如 `EarlyCrashDeps`、`UserDiagDirDeps`）方便单测 mock。
- 测试文件与源码同目录，命名 `*.test.ts`（Vitest）。

### Windows 特化

- 路径操作统一 `path.win32`；PE 结构校验、asar unpacked 路径替换等均为 Windows 专属逻辑。产品仅发布 Windows x64。

## 注意事项

- **禁止** 在 utils 模块中直接调用 `ipcMain.handle` 或 `contextBridge.exposeInMainWorld`——这些属于 IPC 层职责。
- **禁止** 在 utils 模块中引入 `react` / `electron`（除 `logger.ts`、`progress-throttle.ts`、`early-crash-guard.ts` 等已标注的 Electron API 消费者）。
- 新增工具文件时，优先检查是否已有同功能模块，避免重复实现。
- `sharp` 和 `fluent-ffmpeg` 为重依赖，导入时注意惰性加载或确认调用方已有并发控制。
- 修改 `constants.ts` 中的常量值需评估对所有消费方的影响（全局搜索引用）。
- 4 个文件缺少测试（`active-task-store`、`image-encode`、`managed-read-stream`、`user-diag-path`），新增或修改时建议补充。
