# AGENTS.md — `src/shared`（主/渲染共享契约层）

本文件为 Agent 与新协作者提供 **shared 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像），通道契约细节见 [`docs/IPC_CONTRACT.md`](../../docs/IPC_CONTRACT.md)。本文件只补 **本目录内** 的类型、错误、工具约定。

## 模块概述

`src/shared/` 承载主进程与渲染进程（及 preload）**共同消费的类型定义、错误分类、常量与纯工具函数**。该模块是跨进程契约的单一权威来源（Single Source of Truth），主/渲染两侧均通过 `@shared/*` 或相对路径引用，**禁止** 在任一侧复制同名类型或重新定义错误码。

**核心约束**：本模块 **不得引入任何 Node.js 内置模块**（`fs`、`path`、`crypto` 等）与 **Electron 模块**（`electron`），确保渲染进程（浏览器环境）与主进程均可安全导入。唯一的"运行时依赖"是 `setAppErrorTranslator` 翻译注入函数——它由主/渲染各自的 i18n 初始化时注入，shared 自身不持有 i18next 实例。

## 目录结构

```
src/shared/
├── errors/
│   ├── app-error.ts        # AppError 基类 + 6 个子类 + 类型守卫 + extractUserMessage
│   └── error-codes.ts      # ERROR_CODES 常量 + ErrorCode 枚举类型
├── types/
│   ├── index.ts            # 统一导出入口（re-export 所有子模块）
│   ├── media.ts            # MediaFile / MediaRow / ScanOptions 等媒体核心类型
│   ├── ipc.ts              # IPC 请求/响应类型（IpcResponse、各通道参数与返回值）
│   ├── ipc-types.ts        # IPC_ERROR_CODES、IpcError 接口
│   ├── electron-api.ts     # window.electronAPI 完整类型声明（渲染进程全局桥）
│   ├── category.ts         # 分类域类型
│   ├── profile.ts          # 角色档案域类型
│   ├── editor.ts           # 编辑器、滤镜预设、编辑历史类型
│   ├── editor-metadata.ts  # XMP 元数据结构（EditorMetadata + schemaVersion）
│   ├── watermark.ts        # 水印配置类型
│   ├── settings.ts         # 应用设置、备份、缓存、日志、崩溃报告类型
│   ├── duplicate.ts        # 重复/相似检测域类型
│   ├── resonance.ts        # 共鸣记录域类型
│   ├── progress.ts         # 任务进度阶段类型（TaskStage / TaskStageStatus）
│   └── plugin.ts           # 插件系统类型
├── utils/
│   ├── concurrency.ts      # settleWithConcurrency 固定并发遍历工具
│   ├── extremum.ts         # maxOf / minOf 安全极值（避免 Math.max 栈溢出）
│   └── taskStages.ts       # createStages / setStageStatus 进度阶段工具
├── settings-keys.ts        # RENDERER_PREF_KEYS 白名单 + SECURITY_SENSITIVE_KEYS
├── scene-category.ts       # SceneCategory / SceneTime 枚举与配置常量
└── dimension.ts            # GroupDimension 智能分组维度配置
```

## 1. 类型定义约定

- **数据库行类型** 以 `XxxRow` 命名（如 `MediaRow`），与表字段一一对应（snake_case）。
- **渲染进程模型** 以 `Xxx` / `XxxRecord` 命名（如 `MediaFile`），采用驼峰命名。
- **杜绝 `any` / `unknown`**：所有 interface 字段必须有明确类型；IPC 通道参数与返回值全部在 `types/ipc.ts` 或对应域文件中声明。
- **统一导出入口**：`types/index.ts` re-export 所有子模块；外部优先 `import type { ... } from '@shared/types'`，避免直接引用子模块路径（除非只需单个类型且希望减小 import 体积）。
- 所有导出均带 JSDoc 注释，便于 IDE 悬浮提示。

## 2. AppError 错误体系

`errors/app-error.ts` 定义跨进程统一错误基类与 6 个分类子类：

| 子类              | 语义                    | 对应 ERROR_CODES    |
| ----------------- | ----------------------- | ------------------- |
| `ValidationError` | 参数校验/业务规则不匹配 | `VALIDATION_ERROR`  |
| `NotFoundError`   | 记录/文件/目录不存在    | `NOT_FOUND`         |
| `PermissionError` | 路径白/黑名单拦截       | `PATH_FORBIDDEN`    |
| `DatabaseError`   | SQL 错误、事务冲突      | `DATABASE_ERROR`    |
| `FileSystemError` | fs 读写错误             | `FILE_SYSTEM_ERROR` |
| `InternalError`   | 兜底未预期异常          | `INTERNAL_ERROR`    |

**使用约定**：

- `cause` 字段 **必须** 携带原始错误（`fs` / `better-sqlite3` 等），用于日志排查；`toJSON()` 序列化时 **不** 跨 IPC 传输 `cause`。
- `userMessage` 用于 UI 展示，写用户可读语言，不含技术细节/路径/堆栈；`message` 给开发者看。
- `details` 只放调试上下文，**禁止** 包含密码、token、完整文件路径等敏感数据。
- 渲染层 toast 文本 **必须** 经 `extractUserMessage(error)` 取得。
- 类型守卫：`isAppError` / `isValidationError` / `isNotFoundError` / `isPermissionError` / `isDatabaseError` / `isFileSystemError` / `isInternalError`，优先使用守卫而非比对字符串错误码。
- 翻译函数由主/渲染 i18n 初始化时通过 `setAppErrorTranslator` 注入；**禁止** 在 `src/shared/**` 引入 electron / react / i18next 运行时依赖。

## 3. 设置键白名单与安全约束

`settings-keys.ts` 定义渲染进程可自由写入的偏好 key 白名单（`RENDERER_PREF_KEYS`）与安全敏感 key 映射（`SECURITY_SENSITIVE_KEYS`）。

- 安全敏感 key（如 `backupDir`、`thumbnailCacheDir`）只能由各自专用通道写入（如 `backup:setDir`），`settings:set` 必须拒绝。
- 新增渲染进程可写设置时，**必须** 在 `RENDERER_PREF_KEYS` 数组中追加；涉及路径/安全的 key **不得** 加入此白名单。

## 4. 纯函数工具约定

`utils/` 内的工具函数 **必须** 是纯函数或仅依赖其他 shared 模块，不引入 Node/Electron API：

- `concurrency.ts`：固定并发遍历，支持 AbortSignal 取消与进度回调。
- `extremum.ts`：安全极值（`maxOf` / `minOf`），规避 `Math.max(...arr)` 栈溢出反模式。
- `taskStages.ts`：进度阶段构造与状态更新，配合 `types/progress.ts` 使用。

## 5. 场景分类与分组维度

- `scene-category.ts`：`SceneCategory`（thumbnail / screenshot / travel_journal 等）与 `SceneTime`（day / night / dawn / dusk）枚举及配置常量，按文件夹名称模式匹配场景类型。纯类型与常量模块。
- `dimension.ts`：`GroupDimension` 智能分组维度配置，供 Sidebar 与 SmartGroupPanel 共享。

## 6. 注意事项

- **禁止** 在 `src/shared/` 中新增任何对 `fs`、`path`、`crypto`、`electron`、`better-sqlite3`、`sharp` 等 Node/Electron/原生模块的 import——这会破坏渲染进程的浏览器环境导入。
- 新增跨进程共享类型时，优先放入 `types/` 下对应的域文件；若为全新领域则新建文件并在 `types/index.ts` 追加 re-export。
- 修改 `ERROR_CODES` 或 `IPC_ERROR_CODES` 时须同步检查 `docs/IPC_CONTRACT.md` 是否需更新。
- `settings-keys.ts` 的 `SECURITY_SENSITIVE_KEYS` 值（通道名）须与实际 handler 通道名保持一致。
- 单元测试与源码同目录，命名 `*.test.ts`（Vitest）。
