# 修复「点击收藏后弹出红色错误 Toast」实施计划

- 状态：已完成（TDD 闭环 + 全量回归通过）
- 日期：2026-09-11
- 关联：根因位于渲染层误用 IPC 响应契约，主进程与 preload 无需改动

## 1. 现状调研与根因分析

### 1.1 UI 层追踪

点击「收藏」有两处入口：

- 图库/全屏：复用 `useFavoriteToggle`（`src/renderer/hooks/useFavoriteToggle.ts`），由 `useFileOperations.handleToggleFavorite`（`useFileOperations.ts:425`）与 `FullscreenViewer.tsx:50` 调用。
- 失败提示经 `onShowMessage(text,'error')` 委托 `useErrorToast.showMessage`（`useErrorToast.ts:183-188`），即右下角带叉图标的红色全局 Toast。

### 1.2 链路下钻

`useFavoriteToggle.ts:30-31`：

```ts
const result = await window.electronAPI.mediaAction.updateFavorite(Number(file.id), next)
if (!result.success) throw new Error(result.message)
```

- `mediaAction.updateFavorite` = `call<{ updated: boolean }>('media:updateFavorite', mediaId, isFavorite)`（`src/main/preload/api/media-action.ts:10-11`）。
- preload `call()`（`src/main/preload/ipc.ts:41-51`）把主进程 `IpcResponse<T>` 解包为 `res.data`，**失败抛 `IpcError`**。
- 主进程 handler `media:updateFavorite`（`src/main/ipc/handlers/media-handler.ts:39-46`）返回 `{ updated: true }`，经 `wrapHandler` 包装后 `call` 返回 `{ updated: true }`。

### 1.3 根因结论

`call()` 返回的是已解包的 data `{ updated: true }`，**不存在 `success` / `message` 字段**。因此 `result.success` 恒为 `undefined`，`if (!result.success)` 恒真 → **每次点击收藏都抛 `new Error(undefined)`** → `onShowMessage('undefined','error')` → 右下角红色 Toast 必现（收藏星标其实已正常切换）。

同一缺陷位于 `useFileOperations.ts:119` 的 `favorite_toggle` 撤销 handler：`if (!undoResult.success) return { success: false, message: undoResult.message }`，导致撤销恒报失败并跳过 store 回写。

现有测试（如 `useFavoriteToggle.test.ts:118` 的 `mockResolvedValue({ success: false })`、`useFileOperations.test.ts:787` 的 `{ success: true }`）均模拟了与真实契约不符的响应形态，掩盖了 Bug。

## 2. 依赖声明

无新增/变更依赖。纯渲染层逻辑修正，复用既有 stores、`useTranslation`、`IpcError` 契约与已有 i18n key `toast.favoriteFailed`（zh-CN.json:2269）。

## 3. 启动与验证说明

- 环境：`npm install`（增量；本机 Safe-Delete 网关拦截全量删除，勿用 `npm ci`）。
- 单元验证：
  - `npx vitest run src/renderer/hooks/useFavoriteToggle.test.ts`
  - `npx vitest run src/renderer/hooks/useFileOperations.test.ts`
- 全局校验：`npm test` / `npm run lint` / `npm run typecheck`（基线均 exit 0）。
- 手动验证（可选，需 electron 环境）：`npm run dev` 后点击任一张图片收藏，确认不再弹红色 Toast 且星标正常切换、撤销可正常恢复。

## 4. 错误处理策略

- 成功：`call()` 不抛错即视为成功，正常 `pushHistory`（接入撤销栈）。
- 失败：主进程 `wrapHandler` 抛 `AppError` → preload 还原 `IpcError` → 渲染层 `catch` 捕获 → 回滚乐观更新 + 弹 error Toast（文案取 `error.message`，非 `Error` 时兜底 `toast.favoriteFailed`）。
- 日志：`IpcError` 已由主进程 `wrapHandler` 记录，渲染层不再重复打日志（与 `useErrorToast` 约定一致）。

## 5. 参数校验

- `file`：`MediaFile`，`file.id`（string）→ `Number(file.id)` 作为 `mediaId`（number，handler 侧 zod `mediaId` 校验）。
- `isFavorite`：boolean，`next = !file.is_favorite`。
- 边界：无 `window.electronAPI`（预览环境）仅本地切换不调 IPC；未传 `onShowMessage` 仅回滚不弹窗；非法 `mediaId` 由 handler 侧 zod 拦截并抛 `IpcError`。

## 6. 测试用例矩阵

| 场景     | 用例                                      | 期望                                               |
| -------- | ----------------------------------------- | -------------------------------------------------- |
| 正常     | preload 真实响应 `{ updated: true }`      | 不弹 Toast + `pushHistory` 1 次                    |
| 正常     | 当前已收藏切换为 false                    | `updateFavorite(1, false)`                         |
| 异常     | `updateFavorite` reject(IpcError)         | 回滚 + `onShowMessage(err.message,'error')`        |
| 异常     | reject 非 Error                           | 兜底 `toast.favoriteFailed`                        |
| 边界     | 无 `electronAPI`                          | 仅本地切换                                         |
| 边界     | 未传 `onShowMessage`                      | 仅回滚不抛错                                       |
| 撤销正常 | undo handler 真实响应 `{ updated: true }` | `undoResult.success=true` + `updateMediaFile` 调用 |
| 撤销异常 | undo handler `updateFavorite` reject      | `undoResult.success=false` + `message=err.message` |

## 7. 子任务与验收

1. **编写红灯回归用例**（`useFavoriteToggle.test.ts` 新增 `{ updated: true }` 用例；改写 `success:false` 用例为 `reject(IpcError)`；`useFileOperations.test.ts` 新增 `favorite_toggle` 撤销正常/异常用例）。验收：`npx vitest run` 对应文件出现 2 个失败（红灯）。
2. **修复 `useFavoriteToggle.ts`**：删除 `if (!result.success) throw` 两行，成功分支直接 `pushHistory`。验收：上述用例转绿。
3. **修复 `useFileOperations.ts` 撤销 handler**：删除 `if (!undoResult.success)` 分支。验收：撤销用例转绿。
4. **全局校验**：`npm test` 279 文件 / 4725 用例全绿；`npm run lint`、`npm run typecheck` exit 0。

## 8. 结果

- 修复前：每次点击收藏必弹 `undefined` 红色 Toast。
- 修复后：成功不再弹错误 Toast；仅主进程真实抛错（`IpcError`）时才回滚并提示，且文案为真实错误信息。
- 全量测试：279 文件 / 4725 用例通过（基线 4722 + 新增 3 个回归用例）。
