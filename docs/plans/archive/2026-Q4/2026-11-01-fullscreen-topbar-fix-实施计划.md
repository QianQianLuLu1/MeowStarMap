# 全屏预览顶部工具栏：布局对齐 + 点击无响应 修复计划

> 日期：2026-11-01 · 状态：已批准，执行中 · 结论回写见文末「实测记录」

## Context（背景与根因）

全屏预览（FullscreenViewer，`fixed inset-0 z-[80]`）顶部 7 个按钮「看得见、点不动、排列不齐」。经代码证据与 Electron 官方文档确认两个独立根因：

**点击无响应**：`src/renderer/components/layout/TitleBar.tsx:9` 标题栏带 `.app-drag`（窗口拖拽区，`fixed top-0 h-10`，常驻挂载）。Electron 的 `-webkit-app-region: drag` 拖拽区按矩形计算、**不感知遮挡**（官方文档证实，参考 [Custom Window Interactions](https://electronjs.org/es/docs/latest/tutorial/custom-window-interactions)）：全屏查看器虽视觉盖住它，窗口顶部 40px 条带仍是活动拖拽区 → 按钮主体（y≈10~46px，中心 y=28px）落在条带内，mousedown 被窗口拖动吞掉、click 永不触发。修复 = 给全屏根容器加 `.app-no-drag`（`globals.css:1597` 仓库预留的工具类，注释明说留给此用途）做几何减法；仅全屏时生效，非全屏 TitleBar 拖拽行为零影响。

**布局不对齐**（`FullscreenViewer.tsx:501-526`）：

1. 播放/间隔按钮包在裸 `div.relative`（块级、行内**基线对齐**）：播放按钮基线=图标底缘（y≈27px），间隔按钮基线=文本基线（y≈20px）→ 间隔按钮下沉 ~7px 与其余按钮不齐；
2. 间隔按钮 `ml-1` → 该处间距 12px、其余 8px；
3. 间隔按钮内联 `minWidth:'auto'` + `padding:'4px 8px'` → 尺寸口径不一致。

修复 = wrapper 改 `flex items-center gap-2`、去 `ml-1` 与内联覆盖，全部按钮统一 36×36 盒 + 8px 等距 + 垂直居中（工具栏 h-14 保持不变，已确认「仅组内对齐」）。

**同病同修（已确认）**：`SlideshowPlayer.tsx:245`（幻灯片模式，从全屏工具栏播放按钮进入）顶栏退出按钮同在 40px 拖拽条内 → 根容器加同一行 `app-no-drag`。

已排除项：Toast 在右下角（`Toast.tsx:33`）不遮挡；jsdom 中按钮接线全部正常（既有 7 个 FullscreenViewer 测试为证）；WCO env() 避让逻辑正常，不动。

## 依赖声明

无新增依赖。复用：仓库 `.app-no-drag`（globals.css:1597-1600）、@testing-library/react（^16.3.2）、vitest 双项目基建（根 `vitest.config.ts` + `tests/setup.ts`）。

## 修复方案（最小改动）

| 文件                                                   | 改动                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/components/gallery/FullscreenViewer.tsx` | ① 根容器（:387）className 追加 `app-no-drag`；② 播放/间隔 wrapper（:501）→ `relative flex items-center gap-2`；③ 间隔按钮（:519-523）删 `ml-1`、删内联 `minWidth/padding`（保留 `text-xs`） |
| `src/renderer/components/gallery/SlideshowPlayer.tsx`  | 根容器（:245）className 追加 `app-no-drag`                                                                                                                                                  |

不改 globals.css、不改 TitleBar、不改 WCO 避让 margin、不动自动隐藏逻辑（3s 为既有设计）。

## 启动说明

- 环境：Node ≥ 22（本机就绪）、依赖已装（禁 npm install；如需重建 `@nikkisync` 链接跑 `npm run link:nikkisync`）。
- 开发：`npm run dev`；单测：`npx vitest run <文件>`；全量：`npm test`；变更验证：`npm run verify`（只读）。

## 错误处理

- 无新增运行时分支/日志（纯 class 与 JSX 微调）。
- `app-no-drag` 在非 Electron 环境（浏览器预览版）为无效 CSS 属性、静默忽略 → 预览构建零影响；布局统一化在预览版同样生效且不回归。
- 若真机实测发现点击仍无响应（拖拽区假设被推翻），回退到 WCO 命中路径继续排查（env() 失效 → 关闭按钮压原生按钮），并在此记录转向；单元测试断言的类/结构契约不受影响。

## 参数校验

纯 UI 层修复，无新增 IPC、入参或存储键；不触及 `src/main/`、`src/shared/`。既有回调的入参兜底（`if (!fullscreenOpen || !currentFile) return null`、`window.electronAPI` 判空）不动。

## 子任务与验收标准（TDD：先红后绿）

### T0 落盘计划

本文件即产物。验收：文件存在且含依赖声明 / 启动说明 / 错误处理 / 参数校验 / 基础测试用例五节。

### T1 红灯——新建 2 个测试文件

- `src/renderer/components/gallery/FullscreenViewer.topbarFix.test.tsx`（沿用同目录既有测试模式）：
  - 红灯 A（点击）：全屏根容器（`getByRole('dialog')`）含 `app-no-drag` 类 → 修复前失败；
  - 红灯 B（对齐）：播放按钮 parentElement 含 `flex` 与 `items-center` → 修复前失败；
  - 红灯 C（等距/同尺寸）：间隔按钮 classList 不含 `ml-1`、`style.minWidth===''`、`style.padding===''` → 修复前失败；
  - 安全网（修复前后均绿，沿仓库「安全网：结构与交互不回归」惯例）：7 按钮点击接线——间隔→菜单 5 选项、信息→浮层出现、另存为→`dialog.selectDirectory` 被调、删除→确认框出现、收藏→`mediaAction.updateFavorite` 被调、关闭→`fullscreenOpen` 变 false、播放（2 张文件）→aria-label 变暂停。
  - 边界：视频文件（无信息按钮）按实际按钮集断言；单张文件仍可点关闭。
- `src/renderer/components/gallery/SlideshowPlayer.topbarNoDrag.test.tsx`：置 `slideshowOpen: true` 打开，断言根容器含 `app-no-drag` → 修复前失败。

验收：`npx vitest run` 两文件 → 红灯 4 项失败、安全网通过。

### T2 绿灯——改 FullscreenViewer.tsx（3 处）

验收：红灯 4 项全转绿；同目录既有 8 个 `FullscreenViewer.*.test.tsx` 全绿。

### T3 绿灯——改 SlideshowPlayer.tsx（1 处）

验收：幻灯片用例转绿。

### T4 全局回归

`npm test` 无新增失败；`npm run verify` 全绿（`[VERIFY] ✓`；format/lint 失败则 `prettier --write`/`lint:fix` 后重跑）。改动均在 renderer 组件，不在核心路径保护清单内，无需 `@core-change` 授权注释。

### T5 真机验证（亲自运行）

`npm run dev` 启动（若空库则扫描导入 ≥2 张样例图）；实测：全屏依次点 7 个顶栏按钮均触发对应行为（重点：右上「关闭」退出全屏、拖拽区不再吞点击）、幻灯片「退出」可点；非全屏标题栏仍可拖动窗口。实测读数回写本文末尾。

## 基础测试用例（正常/异常/边界）

- 正常：7 按钮接线安全网；幻灯片根容器 no-drag。
- 异常：electronAPI 缺失时点击另存为/删除不抛错（沿用既有 mock 策略）。
- 边界：视频文件顶栏无「信息」按钮；单张文件无左右导航仍可关闭；aria-label 全集（`播放幻灯片/播放间隔/收藏/查看图片信息/另存为/删除/关闭`）不回归——已有 `FullscreenViewer.toolbarContrast.test.tsx` 安全网双重锁定。

---

## 实测记录（执行后回写）

> 2026-11-01 执行完毕，全部验收通过。

### 测试结果（TDD 红绿闭环）

| 阶段        | 结果                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| T1 红灯     | 新建 2 个测试文件：**恰好 4 项失败**（两处 no-drag、wrapper flex 对齐、间隔按钮样式），10 项安全网/边界通过                      |
| T2/T3 绿灯  | 修复后 9 个测试文件 80 用例全绿（含既有 7 个 FullscreenViewer 测试）                                                             |
| T4 全局回归 | `npm test` 全量 461 文件 7261 用例通过（20 skipped，0 失败）；`npm run verify` 4/4 全绿（typecheck / lint / core-gate / format） |

### 真机实测（npm run dev + 屏幕控制，本机媒体库 29 个文件）

| 验证项               | 结果                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 布局对齐             | ✅ 全屏顶栏 7 按钮统一 36×36 盒、8px 等距、垂直居中，正确避让右上角原生窗口控制按钮                                             |
| 点击修复（核心）     | ✅ 按钮中心 y≈24~31px 全部落在原生 40px WCO 拖拽条内，坐标点击均正常触发——拖拽区不再吞点击（修复前 mousedown 会被窗口拖动吞掉） |
| 播放间隔             | ✅ 菜单弹出 5 选项；切换 3s→1s→3s 生效（实测后已恢复默认 3s，无数据残留）                                                       |
| 收藏                 | ✅ 图标实心/空心切换、aria 变「取消收藏」、库卡片同步（实测后已复原为未收藏）                                                   |
| 查看图片信息         | ✅ 信息浮层展开（镜头与构图/光学与光效/画面调节），再点收起                                                                     |
| 另存为               | ✅ 系统目录选择对话框弹出（实测后取消，未写盘）                                                                                 |
| 删除                 | ✅ 确认对话框「确定将 ”…“ 移至回收站吗？」弹出（实测后取消，未删除）                                                            |
| 播放幻灯片           | ✅ 按钮变「暂停幻灯片」、自动翻页启动；再点暂停生效                                                                             |
| 关闭                 | ✅ 退出全屏回图库，共享元素过渡回位、选中态保留                                                                                 |
| SlideshowPlayer 退出 | ✅ 顶栏退出按钮（同在 40px 拖拽条内）点击即退出放映回图库                                                                       |
| 非全屏回归           | ✅ TitleBar 未改动；图库单击/双击/工具栏行为正常                                                                                |

### 备注

- 实测中「间隔选项点击落空」复现为工具栏 3 秒自动隐藏（既有设计）：点击前先在画面中心唤起即可触发，与本次修复无关。
- 实测产生的用户数据副作用均已复原（收藏状态、播放间隔均为原值）。
