# 优化"检查更新"弹窗实施计划

> 目标：简化"设置 → 应用信息 → 检查更新"的弹窗反馈，仅改动更新弹窗相关逻辑，复用现有成熟库，不引入新依赖。

## 1. 需求概述

| 场景                                   | 弹窗标题 | 正文文案                         | 按钮            | 点击"确定"行为                                       |
| -------------------------------------- | -------- | -------------------------------- | --------------- | ---------------------------------------------------- |
| 网络繁忙 / 检测失败（`error` 阶段）    | `更新`   | `当前网络繁忙，点击确定跳转官网` | `关闭` + `确定` | 打开 `https://github.com/QianQianLuLu1/NikkiGallery` |
| 未检测到新版本（`not-available` 阶段） | `更新`   | `当前已是最新版本`               | `关闭` + `确定` | 打开同上官网                                         |

- 弹窗左上角标题统一为"更新"二字，替换原有"更新出错"。
- "确定"按钮替换原"重试"按钮（不再触发重试，改为跳转官网）。
- "关闭"按钮保持原有 dismiss 行为。

## 2. 依赖声明

本项目已集成以下成熟开源库，**无需新增任何依赖**：

- `electron-updater`：负责更新检测、下载、校验（主进程 `src/main/app/auto-update.ts`）。
- `electron` 的 `shell.openExternal`：负责打开官网（preload `src/main/preload.ts` 暴露为 `shell.openExternal`）。
- `i18next` + `react-i18next`：国际化文案。
- `vitest`：单元测试（结构性断言模式）。

> **不要**自研网络请求或下载逻辑；不要新增 npm 包。

## 3. 修改范围（最小侵入）

| 文件                                                   | 动作 | 说明                                                                                                                   |
| ------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/components/common/UpdateDialog.tsx`      | 修改 | error / not-available 改为带"关闭"+"确定"的模态；标题统一"更新"；not-available 纳入 `isModalStage` 并移除其 toast 分支 |
| `src/renderer/i18n/locales/zh-CN.json`                 | 修改 | `settings.about` 下新增 `updateTitle` / `updateNetworkBusy` / `updateNoNewVersion`                                     |
| `src/renderer/i18n/locales/en.json`                    | 修改 | 同步新增上述 key 英文文案                                                                                              |
| `src/renderer/components/common/UpdateDialog.test.tsx` | 新增 | 结构性断言测试                                                                                                         |

**明确不改动**：`src/main/app/auto-update.ts`、`src/main/ipc/handlers/app-handler.ts`、`src/main/preload.ts`、`src/renderer/pages/settings/about-sections.tsx`（检查按钮）、`src/renderer/pages/settings/plugin-sections.tsx`。

## 4. 启动 / 验证说明

```powershell
# 1. i18n 文案完整性检查（确认无新增缺失 key）
npm run i18n:check

# 2. 运行单元测试（结构性断言，全部须通过）
npx vitest run src/renderer/components/common/UpdateDialog.test.tsx

# 3. 构建验证（受限环境用 electron-vite 直接构建，勿用 npm run build 的 clean 步骤）
npx electron-vite build
```

> 已知 `npm run i18n:check` 存在与本改动无关的既有缺失项（`toast.backup` 等）。判断是否自己引入时，用
> `git stash push -u` 回到 HEAD 复现对比。

## 5. 参数校验与错误处理

- `UpdateDialog` 通过 `app.onUpdate((p: UpdateProgress) => ...)` 接收主进程推送的 `stage` 字段。
  - 仅当 `p.stage === 'error'` 或 `p.stage === 'not-available'` 时进入本次改造的模态分支。
  - `p.stage` 为 `undefined` / 未知值时，保持既有默认分支（轻量 toast 或忽略），不抛错。
- "确定"跳转使用 `window.electronAPI?.shell?.openExternal?.(GITHUB_URL)`，对 API 存在性做可选链保护，缺失时静默失败（不抛异常）。
- `GITHUB_URL` 定义为模块级常量，与主进程/about-sections 保持一致：
  `const GITHUB_URL = 'https://github.com/QianQianLuLu1/NikkiGallery'`。
- 模态 `dismissed` 状态在每次新事件到达时重置（沿用既有逻辑），避免上一次关闭状态污染下一次弹窗。
- toast 定时器在组件卸载时 `clearTimeout`（沿用既有模式）。

## 6. 基础测试用例（UpdateDialog.test.tsx，结构性断言）

> 渲染重页面沿用 `GalleryPage.test.tsx` 的源码结构性断言模式：通过源码字符串匹配断言"不得包含/必须包含"某写法，做否定断言前先剔除注释行。

1. **error 模态标题断言**：源码中 error 分支渲染的标题文案应取自 `updateTitle`（= "更新"），不再包含字面量 `"更新出错"`。
2. **error 文案断言**：error 分支正文应包含 `updateNetworkBusy`（"当前网络繁忙，点击确定跳转官网"）。
3. **error 按钮断言**：error 分支应渲染"关闭"（`common.close`）与"确定"（`common.ok`）两个按钮，且不再渲染字面量 `"重试"`。
4. **not-available 模态断言**：源码中 `'not-available'` 应出现在 `isModalStage` 判定中；`onUpdate` 回调不再存在 `else if (p.stage === 'not-available') showToast(...)` 分支（避免重复提示）。
5. **not-available 文案断言**：not-available 模态正文应包含 `updateNoNewVersion`（"当前已是最新版本"）。
6. **确定跳官网断言**：源码中"确定"按钮的 onClick 应调用 `openExternal(GITHUB_URL)`（或 `window.electronAPI.shell.openExternal(GITHUB_URL)`），不再调用 `checkUpdate()` / 重试逻辑。
7. **i18n key 存在性断言**：`zh-CN.json` 与 `en.json` 均包含 `settings.about.updateTitle` / `updateNetworkBusy` / `updateNoNewVersion` 三个 key。

**验收标准**：`npx vitest run` 上述用例全部通过；`npm run i18n:check` 无本改动引入的新缺失项（既有缺失项除外）。

## 7. 子任务清单与验收

### 子任务 1：编写本 MD 计划

- 输入：需求描述、现有代码结构。
- 输出：本文件 `docs/plan-check-update-dialog.md`。
- 验收：文件存在且包含依赖声明/启动说明/错误处理/参数校验/基础测试用例五节。

### 子任务 2：新增 i18n 文案 key

- 输入：`zh-CN.json` / `en.json` 的 `settings.about` 段。
- 输出：两个文件各新增 `updateTitle` / `updateNetworkBusy` / `updateNoNewVersion`。
- 验收：`npm run i18n:check` 无本改动引入的缺失；JSON 语法合法。

### 子任务 3：改造 UpdateDialog.tsx

- 输入：现有 `UpdateDialog.tsx`、`i18n` key。
- 输出：error / not-available 模态标题"更新"、双按钮"关闭"+"确定"、确定跳官网；not-available 移出 toast 分支并纳入 `isModalStage`；模块级 `GITHUB_URL` 常量。
- 验收：源码结构性断言满足第 6 节用例；组件可被正常编译（`npx electron-vite build` 通过）。

### 子任务 4：编写并运行 UpdateDialog.test.tsx

- 输入：改造后的 `UpdateDialog.tsx`。
- 输出：`UpdateDialog.test.tsx` 结构性断言。
- 验收：`npx vitest run` 全部通过。

### 子任务 5：构建验证与范围复盘

- 输入：全部改动。
- 输出：`npx electron-vite build` 成功；`git status` 确认仅改动上述 4 个文件（含新增测试）。
- 验收：构建无错；无关文件未被修改。

## 8. 执行纪律

每一步先验证通过（对应命令无错），再进入下一步；遇到报错当即定位修复，不把问题带入下一阶段。
