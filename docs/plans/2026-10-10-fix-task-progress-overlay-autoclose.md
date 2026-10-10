# 计划：删除后右下角「已完成」进度浮窗延时 3 秒自动平滑关闭

- 日期：2026-10-10
- 状态：已批准（用户确认：全部终态统一自动关闭；修复位于 `useStagedTask` 状态机层）
- 类型：Bug 修复（TDD：红灯 → 绿灯 → 回归 → 视觉验收）

## 1. 问题与根因

删除功能触发后，右下角进度型浮窗 `TaskProgressOverlay` 在任务结束时显示「已完成」（`taskProgress.phase.done`），但**永不自动关闭**。

根因（实码确认）：

- 浮窗显示与否完全由 `useStagedTask` 的 `progress` 状态驱动：`progress === null` 才不渲染（`TaskProgressOverlay.tsx:117`）。
- 任务结束 `run()` 将 `phase` 置为终态（`done`/`cancelled`/`error`）后，`progress` **永远不会被复位为 `null`**。
- `useFileOperations.ts:461` 虽暴露 `resetDelete`（即 `staged.reset`），但全仓无任何调用方；浮窗组件自身也没有任何自动关闭逻辑。
- 右下角另一套 Toast（`useToast`，默认 3 秒自动消失）不是本问题主体。

已确认的决策：

1. **全部终态**（done / cancelled / error）均延时 3 秒自动关闭（错误摘要仍由结果 Toast 承载）。
2. 修复位于 `useStagedTask` 状态机层——相册删除（单删/批删）、回收站彻底删除/清空、重复照片批量清理等同一状态机流程统一生效，调用侧零接线。

## 2. 方案（复用既有设施，两处小改动）

### 2.1 `src/renderer/hooks/useStagedTask.ts`（状态机，核心修复，约 +15 行）

- 新增模块常量 `AUTO_RESET_DELAY_MS = 3000`（对齐 `useToast` 默认 3 秒）与 `autoResetRef` 定时器引用。
- 提取 `clearAutoReset()`：清除待触发的自动复位定时器（`run()` 开始、`reset()`、hook 卸载三处调用）。
- `reset()` 先 `clearAutoReset()` 再复位（复用既有实现，定时器回调直接调用 `reset()`）。
- 新增 `scheduleAutoReset()`：`autoResetRef.current = setTimeout(reset, AUTO_RESET_DELAY_MS)`。
- `run()` 的 try / catch 两条路径在 `commit(final)` 后调用 `scheduleAutoReset()`——终态统一 3 秒后自动复位。
- 新增 `useEffect(() => clearAutoReset, [])` 卸载清理，避免卸载后 setState。
- 对外 API 签名不变（不新增入参）。

### 2.2 `src/renderer/components/common/TaskProgressOverlay.tsx`（平滑关闭，约 ±10 行）

- 根节点包 `<AnimatePresence>`，根 `<div>` 改 `<motion.div>`，加 `exit={{ opacity: 0, y: 16 }}` + `transition={{ duration: 0.25, ease: 'easeOut' }}`——复用仓库既有 `motion` 依赖与 Toast 同款成熟退场方案。
- 入场动画保持既有 `slideInBottom` CSS 不变；组件正文通过局部 `renderCard(progress)` 闭包承载，正文不动。
- 调用侧（GalleryPage / RecycleBinPage / DuplicatesPage）**零改动**：hook 复位 `progress` 后，退场动画自动播放。

### 2.3 影响面

- `useStagedTask` 消费者：GalleryPage（经 `useFileOperations`）、RecycleBinPage、DuplicatesPage——全部为删除/批量清理任务，统一获得自动关闭。
- `TaskProgressOverlay` 其他使用者（ScanProgress / VideoEditor / UpdateDialog）：仅在各自清空 `progress` 时获得退场动画，进度逻辑与清除时机不变。

## 3. 计划要素（按交付约束）

1. **依赖声明**：无新增依赖。`motion/react` 已在 dependencies；测试设施（vitest、@testing-library/react、fake timers 先例 `useToast.test.ts`）均已有。
2. **启动说明**：
   - 开发启动：`npm run dev`
   - 渲染层测试：`npm run test:renderer`；单文件：`npx vitest run <路径>`
   - 视觉验收：`npm run build:preview` 产物在浏览器打开（preview mock 环境），走删除流程观察浮窗终态 3 秒后平滑滑出；兜底路径为 Storybook（`npm run storybook`，`TaskProgressOverlay.stories.tsx` 已有 done/error 故事）。
3. **错误处理**：
   - 定时器三处清除（新 `run()` 开始 / 手动 `reset()` / hook 卸载），防止旧定时器误清新任务、卸载后 setState、定时器泄漏。
   - `stageLabels` 为空的既有参数校验路径在 `commit` 之前抛错，不会调度自动复位定时器。
   - error / cancelled 卡片同样 3 秒关闭（用户已确认）；错误详情通过既有结果 Toast 与阶段 `failed.detail` 已先行呈现。
   - 不新增日志（本次无新增异常分支）。
4. **参数校验**：`AUTO_RESET_DELAY_MS` 为模块常量 3000（毫秒）；`useStagedTask` 对外签名不变；自动复位仅对已进入终态的 progress 生效，进行中任务不受任何定时器影响。
5. **基础测试用例**（正常 / 异常 / 边界）：
   - 正常：done 终态 → 推进 3s → `progress === null`。
   - 异常：error、cancelled 终态 → 推进 3s → `progress === null`。
   - 边界：自动复位窗口内启动新任务（旧定时器不得清掉新进度，新任务自身窗口重新计满后关闭）；任务进行中推进 3s 不被误关；窗口内手动 `reset()`；卸载后推进定时器无异常；`deleteFilesBatch([])` 空输入早退不受影响（既有用例保持绿）。

## 4. 子任务与验收标准

| #   | 子任务                      | 文件                                                                                     | 输入 → 输出                                                              | 验收标准（客观可判定）                                                                                                       |
| --- | --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 0   | 计划落盘                    | `docs/plans/2026-10-10-fix-task-progress-overlay-autoclose.md`                           | 本文档                                                                   | 文件存在且入仓                                                                                                               |
| 1   | 红灯：hook 终态自动关闭测试 | `src/renderer/hooks/useStagedTask.test.tsx`                                              | 新增 3 个红灯用例（done/error/cancelled → 3s → null）+ 3 个守卫用例      | 修复前运行：3 个红灯用例 **FAIL**（progress 未复位）；守卫用例 PASS                                                          |
| 2   | 红灯：删除链路集成测试      | `src/renderer/hooks/useFileOperations.deleteProgress.test.tsx`                           | 新增用例：`deleteFilesBatch` 成功终态 → 3s → `deleteProgress === null`   | 修复前运行：该用例 **FAIL**                                                                                                  |
| 3   | 绿灯：状态机修复            | `src/renderer/hooks/useStagedTask.ts`                                                    | 终态后 3 秒自动复位（§2.1）                                              | `npx vitest run src/renderer/hooks/useStagedTask.test.tsx src/renderer/hooks/useFileOperations.deleteProgress.test.tsx` 全绿 |
| 4   | 平滑关闭：组件退场动画      | `src/renderer/components/common/TaskProgressOverlay.tsx`、`TaskProgressOverlay.test.tsx` | AnimatePresence + motion.div 退场；补 1 条「progress→null 卸载」守卫用例 | 既有组件测试全绿 + 新守卫用例绿                                                                                              |
| 5   | 全局回归与校验              | —（只读验证）                                                                            | `npm run verify` → 全量 `npm test` → `npm run lint`                      | 三者均无失败项、无新增告警                                                                                                   |
| 6   | 视觉验收                    | —（build:preview 产物）                                                                  | 浏览器走删除流程：卡片出现 → 终态「已完成」→ 3 秒后平滑滑出              | 截图/录屏留证；视觉验收代理判定通过                                                                                          |
| 7   | 提交                        | git                                                                                      | `fix(renderer): 任务终态进度浮窗延时 3 秒自动平滑关闭`                   | Conventional Commits 过钩子；`git status --porcelain` 干净                                                                   |

## 5. TDD 红绿验证记录

- 红灯（修复前）：`useStagedTask.test.tsx` 3 个终态自动关闭用例 + `useFileOperations.deleteProgress.test.tsx` 集成用例全部失败（progress 驻留为终态、未复位）。
- 绿灯（修复后）：上述用例与守卫用例全部通过；全量回归无新增失败。

## 6. 风险与兜底

- `deleteFilesBatch` 内部若依赖真实 `setTimeout`（如并发工具），fake timers 下挂起 → 改用 `vi.advanceTimersByTimeAsync` 或对该用例仅伪造 `setTimeout/clearTimeout`（执行时逐步验证）。
- 组件测试环境 `motion/react` 已被 mock（AnimatePresence 透传 children、motion.div 代理为原生 div 并剥离 exit/transition），组件改造不影响既有断言。
- 改动均不在核心保护路径（`preload/api`、`ipc/handlers`、`services`、`shared/errors`），无需 `@core-change` 授权注释。
