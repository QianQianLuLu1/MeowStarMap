# AGENTS.md — `src/main/ipc/handlers`（IPC handler 注册层）

本文件为 Agent 与新协作者提供 **IPC handler 模块级** 速览与约定。顶层项目速览见根目录 [`AGENTS.md`](../../../../AGENTS.md)；IPC 白名单与 AppError 两条硬性约定见 [`docs/CODING_CONVENTIONS.md`](../../../../docs/CODING_CONVENTIONS.md)（唯一真相源；IDE 的 always-on 规则文件仅为它的本地镜像），通道契约细节见 [`docs/IPC_CONTRACT.md`](../../../../docs/IPC_CONTRACT.md)。本文件只补 **本目录内** 的注册与校验落地方式。

## 模块概述

主进程按 **领域一文件** 注册 `ipcMain.handle`，每个文件导出一个 `registerXxxHandlers(ctx: HandlerContext): void`，由 [`src/main/app/ipc-setup.ts`](../../app/ipc-setup.ts) 的 `setupIPC()` 统一调用。参数校验、响应包装、异常捕获全部委托给同目录上层的 [`../validator.ts`](../validator.ts)；文件路径安全由 `validator.ts` 的 `pathGuard` 与 [`../media-read-guard.ts`](../media-read-guard.ts) 承担。**禁止裸调 `ipcMain.handle`（不经 `wrap*` 包装）**。

依赖注入上下文 `HandlerContext`（[`../handler-context.ts`](../handler-context.ts)）由 `Application.setupIPC()` 构造并传入，聚合 `dbManager`、`scannerManager`、`fileService`、`videoService`、`watermarkService`、`mediaWorkerManager`、`taskScheduler`、`thumbnailGen`、`videoEditorBridge`、`getMainWindow`、`notifyMediaUpdated`、`invalidateMediaPathCache`、`applyUITheme` 等。**handler 内不直接访问 `Application` 实例**，只用 `ctx`。

## 目录结构

- 约 40 个按域拆分的 handler 文件（`app-handler.ts`、`category-handler.ts`、`scanner-handler.ts`、`settings-handler.ts`、`media-handler.ts`、`file.ts`、`video.ts`、`watermark.ts`、`plugin-bridge-handler.ts` 等），一个文件对应一个 `registerXxxHandlers`。
- 内部工具：`_shared.ts`、`_test-helpers.ts`、`_trash-utils.ts`（下划线前缀表示非独立注册文件）。
- `__tests__/`：跨文件/集成测试；单文件测试与源码同目录命名 `xxx.test.ts`（Vitest，`npm run test:main`）。
- 新增一个域：新建 `xxx-handler.ts` 导出 `registerXxxHandlers`，并在 `setupIPC()` 追加调用；同步更新 `docs/IPC_CONTRACT.md`。

## 1. 注册模式

```ts
export function registerCategoryHandlers(ctx: HandlerContext): void {
  ipcMain.handle('category:list', wrapHandlerNoArgs(ctx, async () => ({ categories: [...] })))
  ipcMain.handle(
    'category:delete',
    wrapHandler(ctx, z.tuple([schemas.positiveIntId]), async ([id]) => { ... return { deleted: true } })
  )
}
```

- 通道命名 `<domain>:<action>`（如 `app:relaunch`、`media:findDuplicates`、`settings:set`）。
- **每次调用动态获取 Repository**（如 `const getRepo = () => {...}`），因 `db` 可能在初始化/重连时变化；db 缺失时抛 `AppError.preconditionFailed(...)`。
- 未用的形参以 `_ctx` / `_e` 前缀命名（ts strict）。

## 2. `wrapHandler` 家族（`../validator.ts`）

| 包装器                              | 用途                                                                  | handler 签名                         |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------ |
| `wrapHandler(ctx, schema, handler)` | **带参数**：zod 校验位置参数后调用                                    | `(args, ctx, event) => R`            |
| `wrapHandlerNoArgs(ctx, handler)`   | **无参数**通道                                                        | `(ctx, event) => R`                  |
| `wrapHandlerRaw(ctx, handler)`      | 需原始参数/`event.sender`（如 `scanner:complete` 广播），**自行**校验 | `(args: unknown[], ctx, event) => R` |

- 三者都自动：① 成功时把返回值包为 `{ success: true, data }`；② 捕获 `AppError` 转 `IpcError`（`{ success: false, error }`）；③ 捕获普通 `Error` 记日志并标 `INTERNAL_ERROR`。
- **双层 `success` 结构**：外层 `IpcResponse.success` 由 `wrapHandler` 生成，preload 的 `call<T>()` 只透出 `res.data`。若前端会检查 `res.success`（如 `media:findDuplicates`），本 handler **必须真的返回含 `success: true` 的对象**（见 `docs/IPC_CONTRACT.md` §2），否则前端恒得 `undefined`。
- handler 内 **不要** 手写 `try/catch + return { success:false }` 去模拟错误——直接 `throw` `AppError`，由包装器统一转译。

## 3. 参数校验（zod `schemas`）

- 优先复用 `validator.ts` 的 `schemas`：`filePath`、`filePathArray`、`filePathArrayBulk`、`mediaId`、`mediaIdArray`、`mediaIdArrayBulk`、`rating`、`positiveIntId`、`shortString(max)`、`uid`、`httpUrl`、`uiTheme`、`thumbnailQuality`、`backupFilename`、`shortId`、`cacheLimitBytes`。批量导入/删除用 `*Bulk`（去掉人为上限，下游已分片/逐条处理）。
- 参数用 `z.tuple([...])` 表达 **位置参数**，顺序须与 preload 侧调用一致；元素级校验尽量在 schema 内完成（长度、正则、控制字符、`isSensitivePath` 语义等），不散落到 handler body。
- 校验失败时 `wrapHandler` 生成 `VALIDATION_ERROR`，`message` 汇总各 issue 的 `[path] message`。校验文案走 `t('main.validator.*')`（主进程 i18n，`import { t } from '../../i18n'`）。
- 涉及动态字段名拼接（如 `category:update`）必须用 `allowedFields` 白名单过滤后再拼 SQL，防注入。

## 4. 路径安全约束

文件读写 **必须** 按语义校验，未授权路径抛 `AppError.forbidden`（`IPC_PATH_FORBIDDEN`），错误详情经 `maskPath` 脱敏仅留末 2 段：

- `assertFileReadPath(p)` / `assertFileWritePath(p)`（`validator.ts`）：PathGuard 白名单 + 敏感目录黑名单校验。
- `assertMediaReadPath(ctx, p)`（`media-read-guard.ts`）：读取已入库媒体时用——媒体白名单优先，命中后对 `realpath` 复检敏感目录，未命中回落 `assertFileReadPath`。与 `media://` 展示授权同口径。
- `assertMediaDeletePath(ctx, p)`（`media-read-guard.ts`）：删除通道三级校验（`userPicked` → 媒体白名单 → PathGuard 兜底），不做敏感目录前置闸门（兼容游戏装在 Program Files 等系统目录形态下的已入库媒体）。
- **PathGuard 授权来源**：扫描发现的媒体根 `pathGuard.registerRoots(paths)`；用户在系统对话框显式选择的目录经 `dialog-handler.ts` 调 `pathGuard.registerUserPicked(p)` 登记为已授权，后续用 `pathGuard.isUserPicked(p)` 短路放行；**伪造路径**（未命中标记）仍走完整白名单 + 黑名单。用户主目录与 `userData` 目录始终允许，系统敏感目录（`isSensitivePath`）作黑名单兜底，即使命中注册也拒绝。

## 5. 错误处理

- 可预期业务错误 **必须** 用 `AppError` 家族（`shared/errors/app-error.ts`）：`ValidationError` / `NotFoundError` / `PermissionError` / `DatabaseError` / `FileSystemError` / `InternalError`；或用其工厂方法（`AppError.validation` / `AppError.forbidden` / `AppError.preconditionFailed` 等）。**禁止 `throw new Error('字符串')` 表达业务错误。**
- `userMessage` 给用户看（不含路径/堆栈），`message` 给开发者；`cause` 携带原始错误；`details` 仅放调试上下文，**禁止** 含密码/token/完整路径。

## 6. 契约稳定性与插件面

- 修改 **任何** 通道名、方法签名、`IpcResponse`/`IpcError` 结构时，**必须** 同步更新 `docs/IPC_CONTRACT.md` 并保持向后兼容（新增字段可选、旧字段语义不变；破坏性变更另起通道 + 迁移期双写）。
- 对插件暴露的 facade **必须只读**（如 `pluggable-electron` 仅暴露 `getActive`/`updatesAvailable`）；变更类管理操作统一经 `electronAPI.plugin.*` 通道，主进程侧做可信调用方校验。
