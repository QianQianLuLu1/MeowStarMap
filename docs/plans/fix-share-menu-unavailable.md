# 修复"分享"子菜单三渠道不可用 实施计划

> 项目：NikkiGallery（无限暖暖相册管理工具）Windows 桌面相册
> 日期：2026-08-27
> 范围：右键菜单/分享按钮触发 → 渲染进程分享回调 → `window.electronAPI.share`（copyFiles/detectApp/launchApp）→ preload 桥接 → 主进程 `share:*` IPC → 剪贴板复制 / 目标应用检测与启动 → 错误提示与国际化文案

## 根因结论（已完成排查）

分享链路触发端（右键菜单子菜单 `ContextMenu`/`getContextMenuItems`、`ShareMenuButton`、`BatchActions`）、preload 装配（`src/main/preload.ts` 已暴露 `share: shareAPI`）、主进程 `share:*` handler（`src/main/ipc/handlers/share.test.ts` 8 用例覆盖）、`share-clipboard-service`、38 个链路 i18n key（已在 12 份语言包基准核对齐全）均核查无断点。

三个分享渠道（微信 / QQ / vivo办公套件）共用同一条「复制到剪贴板 → 检测目标应用 → 弹引导窗」管线，以下三个共用底层缺陷导致三渠道一齐失效（缺陷 C 在 T4 集成测试阶段被暴露并一并修复）：

- **缺陷 A（IPC 契约错位）**：`share:detectApp` 主进程实际返回 `{installed, running, installPath}`（无 `success` 字段，见 `src/main/ipc/handlers/share.ts` 与 `share.test.ts` L145-160），但渲染端 `src/renderer/vite-env.d.ts` 误声明了 `success: boolean` 字段，`GalleryPage.tsx` 的 `handleShareToClipboard` 用 `detect.success ? detect.installed : false` 取值 → 运行时 `detect.success` 恒为 `undefined` → `installed/running` 恒 `false` → 引导弹窗永远显示"未安装"兜底文案并 5 秒自动关闭，"打开 XX"启动按钮永不出现，`launchApp` 入口完全不可达。
- **缺陷 B（IPC 异常无兜底）**：`handleShareToClipboard` 对 `api.copyFiles`/`api.detectApp` 无 try/catch；preload `call()` 在主进程返回 `success:false`（路径白名单 FORBIDDEN / 参数校验失败 VALIDATION_ERROR / 响应畸形 IPC_MALFORMED_RESPONSE）时抛出 `IpcError` → unhandled promise rejection，UI 零反馈 → 点击分享毫无反应。
- **缺陷 C（running 未透传）**：`GalleryPage` 渲染 `ShareGuideDialog` 时未传 `running` 属性（状态里有但 JSX 遗漏）→ 弹窗内 `isRunning = installed && !!running` 恒为 `false` → 已安装且运行中的应用也会误显示"未运行"文案与"打开 XX"按钮，且"运行中 3 秒自动关闭"策略永不生效。

## 依赖声明

| 类型   | 项                                                                                      | 说明                                                                                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时 | Node 20.x（`.node-version`=20）                                                         | 本机当前为 Node 26.3.0，vitest 1.6.1 setup 阶段崩溃（已实测 `tests/setup.ts` 报 `Cannot read properties of undefined`）；需 nvm/portable Node 20，否则单测降级为 tsc+eslint+手测（与 `docs/plans/2026-08-27-path-permission-av-compat.md` 先例一致） |
| 运行时 | Windows 平台                                                                            | 剪贴板 `CF_HDROP` 写入与目标应用检测仅支持 win32，非 win32 由主进程返回"平台不支持"降级                                                                                                                                                              |
| 测试   | vitest 1.6.1 + jsdom（已在 devDependencies）                                            | 不新增任何依赖                                                                                                                                                                                                                                       |
| 手测   | 微信 / QQ 任一已安装                                                                    | 验证"已安装运行中/已装未运行"分支；均未安装时验证"未安装"兜底分支                                                                                                                                                                                    |
| 复用   | `ShareGuideDialog` 失败态 UI（`copyResult.success=false` 分支）、`IpcError.userMessage` | 错误提示复用既有 UI 与主进程已翻译消息，不新增 i18n key                                                                                                                                                                                              |

## 启动说明（复现与验证）

1. `npm run dev` 启动（或打包产物冒烟：`npm run build` 后 `npm run preview`）。
2. 首次使用先执行扫描（侧栏「扫描」），使图库有媒体且 `pathGuard` 白名单登记 `media_files.source_path`（`share:copyFiles` 的 `assertFileReadPath` 依赖该白名单）。
3. 复现路径：右键任一图片 → 「分享」→ 悬停展开子菜单 → 点击「分享到微信」。修复前表现为无反应（缺陷 B）或弹窗恒显示"未检测到安装"并 5 秒消失（缺陷 A）；修复后应弹出引导窗且按真实安装/运行状态展示文案。
4. 批量路径验证：勾选多张图片 → 批量操作栏「分享」菜单选择渠道，行为应与右键单文件一致。

## 错误处理（失败点与降级策略）

| 失败点                                                             | 现象              | 降级与提示策略                                                                                                                         |
| ------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `window.electronAPI.share` 缺失（preload 异常）                    | 无法调用          | `showMessage(galleryPage.shareUnavailable,'error')`（已有，保留）                                                                      |
| 未选择文件（空数组）                                               | 无目标            | `showMessage(galleryPage.selectShareFirst,'error')`（已有，保留）+ 工具函数防御性返回失败 `copyResult`                                 |
| `copyFiles` IPC 抛错（FORBIDDEN / VALIDATION / 畸形响应）          | 缺陷 B 静默       | 新增：捕获后复用 `ShareGuideDialog` 失败态，`copyResult={success:false, message:userMessage??message, count:0, skipped:0}`，不自动关闭 |
| `copyFiles` 业务失败（全部文件不可访问 / 平台不支持 / 剪贴板异常） | `{success:false}` | 已有：失败态弹窗展示主进程已翻译的 `message`（保留）                                                                                   |
| `detectApp` IPC 抛错                                               | 缺陷 B 静默       | 新增：捕获后降级 `installed/running=false`，与主进程 handler 的降级语义一致，不阻断复制结果展示                                        |
| 目标应用未安装 / 未运行                                            | 三态分支          | 修复 A 后按真实状态展示：运行中→粘贴引导（3 秒自动关）；已装未运行→"打开 XX"按钮（`launchApp`）；未安装→兜底文案（5 秒自动关）         |
| `launchApp` 失败                                                   | 启动异常          | `ShareGuideDialog` 已有处理（`{success:false,message}` 与抛错均显示失败消息），保留                                                    |

## 参数校验（契约规则）

- `filePaths`：主进程 `schemas.filePathArrayBulk`（数组非空，元素非空且 ≤1024 字符）+ 逐路径 `assertFileReadPath`（PathGuard 白名单：用户主目录 / userData / 已登记扫描根，系统敏感目录黑名单兜底）。
- `channelId`：主进程 `schemas.shortString(64)`（1-64 字符、无控制字符）；渲染端类型窄化为 `'wechat' | 'qq' | 'vivo'`。
- 返回契约（修复后渲染端声明与主进程实际返回一致）：
  - `copyFiles` → `{success: boolean, count: number, skipped: number, message: string}`
  - `detectApp` → `{installed: boolean, running: boolean, installPath: string | null}`（删除渲染端误声明的 `success`）
  - `launchApp` → `{success: boolean, message: string}`

## 基础测试用例（必须覆盖）

| #   | 场景                                                                          | 断言                                                                                                |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | 三渠道 wechat / qq / vivo 正常可分享                                          | `copyFiles` 收到选中文件路径数组；`detectApp` 收到对应渠道；弹窗状态收到 `channelId` 与真实检测结果 |
| 2   | 未选择文件（空数组）                                                          | 工具函数不调用 `copyFiles`，返回 `copyResult.success=false`；GalleryPage 空选提示走既有 toast 守卫  |
| 3   | 复制业务失败（`{success:false}`）                                             | 弹窗失败态收到原 `message`，不进入检测步骤                                                          |
| 4   | 复制 IPC 抛错（模拟 FORBIDDEN）                                               | 弹窗失败态收到错误消息（优先 `userMessage`），无 unhandled rejection                                |
| 5   | 检测 IPC 抛错                                                                 | 降级 `installed/running=false`，弹窗仍打开且携带成功复制结果                                        |
| 6   | 应用未安装（`installed:false`）/ 已装未运行（`installed:true,running:false`） | 弹窗状态透传真实值（修复 A 的核心断言：不再恒为 false）                                             |
| 7   | `share` 命名空间缺失                                                          | `showMessage` 收到 `galleryPage.shareUnavailable`                                                   |

回归基线：既有 `share.test.ts`、`share-clipboard-service.test.ts`、`ShareGuideDialog.test.tsx`、`ContextMenu.test.tsx`、`preload.test.ts` 全部通过；本次不改动主进程与组件代码，预期零回归。

## 子任务（按序执行，每步自验通过后再进入下一步）

### T0：落盘 MD 计划文档

- 新增：`docs/plans/fix-share-menu-unavailable.md`（即本文件）
- 输入：排查结论与五节强制内容
- 输出：仓库内计划文档
- 验收：文件存在且依赖声明/启动说明/错误处理/参数校验/测试用例五节齐全

### T1：对齐 detectApp 类型契约（缺陷 A 的类型侧）

- 修改：`src/renderer/vite-env.d.ts` —— `share.detectApp` 返回类型删除 `success: boolean` 行，与 `src/shared/types/electron-api.ts` 的 `ShareDetectAppResult` 一致
- 输入：主进程实际返回结构（`share.test.ts` L145-160 佐证）
- 输出：渲染端声明与运行时契约一致
- 验收：`tsc -b` 该文件无新增错误；全仓无其他 `detectApp` 消费点（已核查仅 `GalleryPage` 使用）

### T2：抽取剪贴板分享流程为纯函数（TDD）

- 新增：`src/renderer/utils/share.test.ts`（先写失败测试，按上表用例 2-6）
- 新增：`src/renderer/utils/share.ts`，导出：
  - `ClipboardShareCopyResult`（`{success, message, count, skipped}`）
  - `ClipboardShareOutcome`（`{copyResult, installed, running}`）
  - `runClipboardShare(api, filePaths, channelId): Promise<ClipboardShareOutcome>` —— `api` 参数为结构子集 `{copyFiles, detectApp}`（复用 `Window['electronAPI']` 声明推导）；内部流程：空数组防御 → `copyFiles`（捕获异常转失败 `copyResult`，消息取 `userMessage ?? message`）→ 业务失败提前返回 → `detectApp`（捕获异常降级 false）
- 输入：既有 `IpcError` 语义、`ShareChannelId` 类型（`import type`，无运行时依赖）
- 输出：可独立单测的分享流程函数
- 验收：`npx vitest run src/renderer/utils/share.test.ts` 全部通过（Node 20 环境）；Node 26 不可用时以 `tsc -b` + `eslint` 该文件 0 错误兜底并注明

### T3：GalleryPage 接入工具函数（缺陷 A + B 的行为修复）

- 修改：`src/renderer/pages/GalleryPage.tsx` 的 `handleShareToClipboard`：
  - 保留空选与 `share` 缺失两个既有守卫
  - 其余逻辑替换为 `const { copyResult, installed, running } = await runClipboardShare(api, filePaths, channelId)` 后 `setShareGuide({ open: true, channelId, installed, running, copyResult })`
  - 删除对 `detect.success` 的引用
- 输入：T2 工具函数
- 输出：三渠道点击后按真实检测结果弹窗，任何 IPC 失败都有可见反馈
- 验收：`tsc -b` 该文件 0 新增错误；`eslint` 0 错误；`GalleryPage.test.tsx` 不回归

### T4：GalleryPage 分享链路集成测试

- 新增：`src/renderer/pages/GalleryPage.share.test.tsx`（jsdom；独立 `vi.mock` 集：`BatchActions` 渲染可点击渠道按钮、`ShareGuideDialog` 捕获 props、store 注入选中文件；覆盖用例 1/4/7）
- 输入：T3 成果
- 输出：渲染层链路回归测试
- 验收：该文件全部用例通过

### T5：全链路回归与静态校验

- 运行：分享相关测试集（`share.test.ts`、`share-clipboard-service.test.ts`、`ShareGuideDialog.test.tsx`、`ContextMenu.test.tsx`、`ShareMenuButton.test.tsx`、`preload.test.ts`、T2/T4 新文件）+ 本次改动文件 `eslint` + `tsc -b` 比对无新增错误
- 验收：全绿（或 Node 26 环境下按依赖声明降级校验并注明）；确认未触碰扫描/解密/数据库/缩略图等无关文件

### T6：手工验证（启动应用）

- 按「启动说明」执行：右键单图三渠道 + 批量栏三渠道；分别验证已安装运行中（粘贴引导 + 3 秒自动关）、已装未运行（"打开 XX"可启动）、未安装（兜底文案）；验证复制失败可见错误弹窗
- 验收：每渠道行为符合「错误处理」表预期，无控制台 unhandled rejection

## 明确不改动（范围约束）

`src/main/ipc/handlers/share.ts`、`share-clipboard-service.ts`、`share-wifi-service.ts`、`src/main/preload/**`、`ContextMenu`、`ShareGuideDialog`、`ShareMenuButton`、`utils/gallery.tsx`、i18n 语言包（无需新增 key）、以及扫描/解密/数据库/缩略图等无关模块。除非三个分享渠道共同依赖的底层逻辑存在缺陷，不改动与分享功能无关的页面与其他功能。

## 执行验证记录（2026-08-27）

本机环境限制：Node 26.3.0 下 vitest 1.6.1 CLI fork 池不兼容（既有全部测试文件同样在 setup 阶段崩溃，非本次引入）；验证采用 vitest 编程式 API 进程内运行，用例与断言完全等价。

| 步骤 | 验证动作                                                                                                                                                                                                                                              | 结果        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| T0   | 计划文档五节齐全（依赖声明/启动说明/错误处理/参数校验/测试用例）                                                                                                                                                                                      | ✅          |
| T1   | `vite-env.d.ts` detectApp 删除 `success` 字段，与 `ShareDetectAppResult` 一致；全仓仅 GalleryPage 消费                                                                                                                                                | ✅          |
| T2   | `utils/share.test.ts` 8 用例（三渠道/空数组/复制业务失败/复制抛错含 userMessage 优先/无 userMessage 回退/检测抛错降级/未安装/已装未运行）全部通过；eslint 0 错                                                                                        | ✅          |
| T3   | `handleShareToClipboard` 接入 `runClipboardShare`，保留两个既有守卫；`GalleryPage.test.tsx` 15/15 不回归；eslint 0 错                                                                                                                                 | ✅          |
| T4   | `GalleryPage.share.test.tsx` 7 用例（三渠道端到端/已装未运行透传/复制业务失败/复制 IPC 抛错提示/命名空间缺失）全部通过；期间暴露并修复缺陷 C（running 未透传）                                                                                        | ✅          |
| T5   | 分享相关 11 个测试文件 144/144 通过（含既有 share handler/service/ShareGuideDialog/ContextMenu/ShareMenuButton/preload/GalleryPage）；改动文件 eslint+prettier 0 错；`tsc -b` 改动文件 0 新增错误（仓库存量 24 个错误均在无关模块，与基线一致）       | ✅          |
| T6   | `npm run dev` 启动：main（159 模块）/preload（32 模块）/renderer 构建成功，窗口正常加载；日志中 ENOENT 为游戏目录 Temp 文件缺失的既有 pHash 噪音，与分享无关。GUI 逐渠道点击验证依赖用户环境（微信/QQ 安装状态），按「启动说明」第 3/4 步手测清单执行 | ✅ 启动通过 |
