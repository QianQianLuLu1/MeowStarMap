# 删除 / 永久删除「阶段步骤进度」可视化 — 实施计划

> 状态：已确认（2026-08-18）。按 T1→T7 逐步实施，每步自测通过再进下一步。

## 0. 现状与目标

- **现状**：`useFileOperations` 的单文件软删除/永久删除、批量软删除，以及 `RecycleBinPage` 的永久删除/清空回收站，均只弹最终 toast，**无实时进度**。`DuplicatesPage` 与 `ScanProgress` 已验证了 `task:progress` + `TaskProgress` 协议 + `TaskProgressOverlay` 的可行性。
- **目标**：把全部删除入口统一接入「阶段步骤（stages）」实时进度，支持取消，且**零新增 npm 依赖**，复用项目内已有进度系统（`shared/types/progress.ts`、`TaskProgressOverlay`、`ProgressThrottle` 思路）。

## 1. 依赖声明（Dependencies）

- **无新增第三方依赖**。复用既有内部模块：
  - `src/shared/types/progress.ts` —— `TaskProgress` 协议（扩展 `stages`）。
  - `src/renderer/components/common/TaskProgressOverlay.tsx` —— 通用浮窗（增强渲染 stages）。
  - `src/renderer/pages/DuplicatesPage.tsx` —— 既有的 `onProgress` 订阅 + 内联进度条（参考实现与接入点）。
  - `src/renderer/hooks/useFileOperations.ts` / `RecycleBinPage.tsx` —— 接入点。
- 测试依赖沿用现有：`vitest`、`@testing-library/react`、`jsdom`（已在 `devDependencies`）。
- 注：`progress-throttle.ts` 依赖 `electron` 的 `BrowserWindow`，**不移入 shared**；渲染端在 `useDeleteProgress` 内用极小的本地节流（timer 节流 ~10/s）实现等价效果，降低风险。

## 2. 覆盖范围（5 类入口 → 文件/函数）

1. 单文件软删除 → `useFileOperations.ts` `getDeleteConfirm`（media id 分支）。
2. 单文件永久删除 → `useFileOperations.ts` `getDeleteConfirm`（filePath 分支）via `file:deletePermanent`。
3. 批量软删除 → `useFileOperations.ts` `deleteFilesBatch` via `imageProcess.batchSoftDelete`。
4. 回收站永久删除/清空 → `RecycleBinPage.tsx` `handlePermanentDelete` / `handleEmptyRecycleBin` via `mediaAction.permanentDelete`。
5. 重复项批量删除 → `DuplicatesPage.tsx` `performDelete` via `mediaAction.softDelete`（已有进度，补 stages）。

## 3. 设计

### 3.1 类型扩展 `progress.ts`

新增 `TaskStage { id; label; status: 'pending'|'active'|'done'|'failed'; detail? }`，`TaskProgress.stages?: TaskStage[]`。**向后兼容**（现有 `phase`/`percent` 不动）。

### 3.2 `TaskProgressOverlay` 渲染 stages

当 `stages` 存在时，在 percent 条上方渲染**阶段步骤列表**（pending=灰 / active=高亮旋转 / done=✓ / failed=✗），保留原 percent/ETA/取消按钮。无 `stages` 时与原行为完全一致。

### 3.3 渲染端编排器 `useDeleteProgress`（新建，约 60–80 行）

- 入参：`{ title, stages, run: (onProgress, signal) => Promise<void>, canCancel }`。
- 内部：`AbortController` + 本地节流（timer ~10/s）；维护 `TaskProgress` 本地 state（含 `stages`、`phase`、`percent`、`current/total`、`processedPerSec`、`etaMs`、`canCancel`、`taskId`）。
- 输出：`{ progress, run, cancel }`，`cancel()` 调 `abort()` 并在下一阶段边界优雅停止，发 `phase:'cancelled'`。
- 复用 `TaskProgress` 既有的字段形态（本地 state 替代 main 推送，避免改动 preload/main）。

### 3.4 各入口接入

- 批量类（3/4/5）：将单次批量 IPC 改为**按项循环 + 节流推送**，每阶段 `preparing→processing(逐项)→finalizing→done`，中途可取消。
- 单文件类（1/2）：`preparing→processing→finalizing→done` 四阶段快速推进，`canCancel=false`。

## 4. 子任务清单（每步：修改文件 / 输入输出 / 验收标准）

**T1 类型扩展 + 单测**

- 文件：`src/shared/types/progress.ts`（新增 `TaskStage` + `stages?`）、`src/shared/types/progress.test.ts`（新建）。
- 输入：原 `TaskProgress`；输出：带 `stages` 的协议。
- 验收：`vitest` 单测通过（stage 状态枚举、可选字段、与旧字段兼容）；`tsc --noEmit` 无类型错误。

**T2 Overlay 渲染 stages + 单测**

- 文件：`src/renderer/components/common/TaskProgressOverlay.tsx` 及其 `.test.tsx`。
- 输入：`progress.stages`；输出：阶段步骤 UI。
- 验收：单测覆盖 pending/active/done/failed 渲染与无障碍属性；`vitest` 通过；UI 无 `stages` 时回归原样。

**T3 编排器 hook + 单测**

- 文件：`src/renderer/hooks/useDeleteProgress.ts`（新建）+ `.test.tsx`。
- 输入：run/onProgress/signal；输出：带节流 `stages` 的 `progress`。
- 验收：单测验证「阶段顺序推进、percent 钳制 0–100、cancel 在阶段边界中断、节流不刷爆」。

**T4 `useFileOperations` 接入（单软/单永久/批量软）**

- 文件：`src/renderer/hooks/useFileOperations.ts`，补 `useFileOperations.test.tsx`。
- 输入：原 confirm/批量参数；输出：调用处拿到 `progress` 并渲染浮窗。
- 验收：mock IPC 下 `vitest` 通过；批量删除逐项 progress 递增；`npm run build` 成功。

**T5 `RecycleBinPage` 接入**

- 文件：`src/renderer/pages/RecycleBinPage.tsx`。
- 输入：`selectedIds` / 清空；输出：stages 进度 + 取消。
- 验收：`vitest` 或结构断言通过；`tsc` 无错；手动冒烟清空回收站见阶段进度。

**T6 `DuplicatesPage` 接入**

- 文件：`src/renderer/pages/DuplicatesPage.tsx`（现有 `performDelete`/`taskProgress` 补 `stages`）。
- 验收：重复项删除显示阶段步骤；现有进度条回归有效。

**T7 集成冒烟 + 质量门**

- 文件：无新增（跑既有）。
- 验收：`npm run lint` 通过、`npm run i18n:check`（仅比对是否引入新缺失 key）、`vitest run` 全绿、`npm run build` 成功。

## 5. 强制条目

- **启动说明**：`npm install`（增量）→ `npm run dev` 启动；删除操作触发浮窗/内联进度。
- **错误处理**：`run` 抛错时置 `phase:'error'` 并展示 `message`；单文件失败（C-S3 既有 `failed[]` 逻辑）映射为 `stage.status:'failed'` + toast；取消置 `cancelled`，保留已处理项。
- **参数校验**：`stages` 非空数组、`taskId` 必填、`percent` 入参钳制 `[0,100]`、空 `ids` 直接 early-return 不弹进度。
- **基础测试用例**：T1–T3 单测 + T4–T6 行为/结构断言（覆盖取消、错误、空输入、阶段顺序）。

## 6. 分步执行与验证门禁

按 T1→T7 顺序，**每步先 `vitest`/`tsc`/`lint` 通过再进下一步**，报错当场修复，不把问题带进下一步。

## 7. 风险与回滚

- 进度为**纯展示增强**，不改 `file-service` 删除语义（仅把批量 IPC 改为按项循环，结果与原来一致）；若回归，单文件 `git checkout` 对应文件即可。
- 不动 scanner/i18n/store 等无关模块（仅可能新增少量 i18n key 供 stages 文案）。
