# 替换分享图标为成熟开源字形（Lucide share-2）实施计划

- 状态：已批准（2026-09-30，经 ExitPlanMode 流程确认，图标造型经用户选定：三节点网络）
- 前序：`docs/plans/2026-09-30-fix-share-icon-clipping.md`（上一会话已完成的几何修补，本计划将其字形整体替换，`flex-shrink-0` 防挤压修复保留）
- 执行约束：最小改动、零新 npm 依赖、严格 TDD（红→绿）、全量回归通过后才算完成

## 0 现状与根因

- 工作树中已有上一会话按旧计划完成的修复（未提交）：IconShare 外弧终点收进安全区（`icons/index.tsx:475`）、ShareMenuButton 包装层加 `flex-shrink-0`、新建 `icons/index.test.tsx`（几何守卫）与 `icons/index.stories.tsx`、旧计划文档。
- 本次诉求升级：**当前「WiFi 弧线 + 圆点」字形设计本身被否决**——缩短后的外弧仍呈悬空截断观感，误导用户。必须整体更换为成熟开源字形。
- 用户已选定：**Lucide `share-2` 三节点网络字形**（3 个 circle + 2 条 line）。坐标已核实（lucide-static v1.49.0，ISC License，与仓库 MIT 兼容）：circle (18,5,3) / (6,12,3) / (18,19,3)；line (8.59,13.51)→(15.42,17.49)、(15.41,6.51)→(8.59,10.49)。全部笔画范围 [3,21]×[2,22]，描边极值 ≤23 < 24，零裁剪风险。
- 集成方式：沿用仓库既有模式（全部 60+ 图标均为内联 Feather/Lucide 字形 + `BaseIcon`），仅换字形不引库。**不引入 lucide-react**（单图标引库破坏一致性、违反最小改动）。

## 1 依赖声明

**零新增 / 变更 npm 依赖。** 字形设计复用 Lucide share-2（ISC License，源码注释保留出处署名），渲染复用既有 `BaseIcon`；测试复用既有 vitest + @testing-library/react + jsdom；视觉复用既有 Storybook 10。

## 2 启动与验证说明

```bash
npx vitest run src/renderer/icons/index.test.tsx    # TDD 红灯/绿灯（逐节点）
npx vitest run src/renderer/components/common/ShareMenuButton.test.tsx
npm run test:renderer                                # 局部回归
npm test && npm run typecheck && npm run lint && npm run audit   # 全局回归（audit=audit-ci 安全检查）
npm run storybook   # http://localhost:6006 → Icons/ShareIconFamily，64px 放大目检
npm run dev         # 降级手工路径：右键菜单分享项 / 批量栏分享、WiFi 分享按钮 / 顶部工具栏
```

## 3 TDD 子任务（红→绿闭环，文件 / 输入输出 / 验收标准）

### S1 红灯 — 改写 `src/renderer/icons/index.test.tsx`

- 输入：当前 IconShare（旧字形 3 path + 1 circle）。输出：新用例集。
- 动作：① 文件头注释更新为「字形设计缺陷 → 整体替换」根因；② **重写**编码旧字形的结构用例（"3 path + 1 circle"）为新字形指纹用例：断言 IconShare 恰好由 **3 个 circle + 2 个 line 组成（无 path）**，且坐标与 Lucide share-2 官方值逐一相等（含来源注释）；③ 保留既有几何安全区守卫（全家族 [0.5,23.5]）、方形比例/描边属性矩阵（14/16/28）、扫描器异常用例，均不动。
- 验收（可判定）：`npx vitest run src/renderer/icons/index.test.tsx` → 新指纹用例 **RED**（旧字形不匹配），几何守卫等既有用例保持 **GREEN**。满足「回归测试修复前必须红灯」——几何越界红灯已由上一会话消耗，本次替换的红灯即字形指纹用例。

### S2 绿灯 — 替换 `src/renderer/icons/index.tsx:470-480` IconShare 字形

- 动作：3 条弧线 path + 1 circle → Lucide share-2 的 3 circle + 2 line（坐标见上），注释改为字形出处（Lucide share-2，ISC）与选型原因。导出名 `IconShare` 不变，全部调用点零改动。
- 验收：同命令重跑 → **全绿**（新字形通过几何守卫：底缘 y=22 ≤ 23.5）。

### S3 更新视觉验收故事 — `src/renderer/icons/index.stories.tsx`

- 动作：仅更新文件头注释与 docs description（验收点改为三节点字形完整无裁剪、来源 Lucide share-2），标题 `Icons/ShareIconFamily` 与网格结构不变。
- 验收：`npm run storybook` 启动无编译错误，故事正常渲染。

### S4 局部回归

- `npx vitest run src/renderer/components/common/ShareMenuButton.test.tsx`（24 个用例，图标为 mock 不受影响）+ `npm run test:renderer`（此前 1697 全绿）。
- 验收：均无新增失败。

### S5 全局回归

- `npm test`（此前 4905 全绿）+ `npm run typecheck` + `npm run lint` + `npm run audit`。
- 验收：与改动前基线持平，无新增失败；audit 若因网络受限失败则如实报告，不伪造通过。

### S6 视觉验收

- 启动 Storybook 后浏览器截图目检 64px 档：三节点完整、连线清晰、无裁切；并核对 14px（批量栏）/16px（右键菜单）档可辨识。
- 验收：截图无截断/遮挡；不可用时降级 `npm run dev` 手工路径并在交付说明中列出。

### S0 计划落盘（执行首步）

- 将本计划写入 `docs/plans/2026-09-30-replace-share-icon.md`（含执行记录节，随执行更新），旧计划文档保留作历史。

## 4 错误处理

- 图标为纯展示组件，无异步/IO/IPC 分支。svg 渲染异常时按钮仍保留 `title`/`aria-label` 完整文案兜底。
- 防护策略：几何安全区守卫 + 新字形指纹用例双重拦截未来回归；扫描器遇未知路径命令显式抛错。
- Storybook 不可用时降级 `npm run dev` 手工目检。

## 5 参数校验

- `IconProps.size?: number` 为 TS strict 编译期约束，`BaseIcon` 默认 16；不新增运行时校验（与全库图标现状一致，纯展示无非法值风险面）。
- 尺寸测试矩阵：14（批量栏）/ 16（右键菜单、工具栏）/ 28（单测）+ 64（Storybook 放大目检）。

## 6 基础测试用例矩阵

| 类别             | 用例                                                            | 期望                      |
| ---------------- | --------------------------------------------------------------- | ------------------------- |
| 红灯（复现缺陷） | IconShare 字形指纹 = Lucide share-2（3 circle + 2 line + 坐标） | 替换前 RED → 替换后 GREEN |
| 正常渲染         | 几何安全区守卫（分享家族 4 图标）                               | 全程 GREEN，防截断回归    |
| 正常渲染         | size=14/16/28 方形 svg、viewBox/stroke-width/linecap 正确       | 不回归                    |
| 异常状态         | 扫描器未知命令/参数不足显式抛错                                 | 不回归                    |
| 行为回归         | ShareMenuButton 既有 24 用例（含 flex-shrink-0）                | 不回归                    |

## 7 改动边界（明确不动）

`ShareMenuButton.tsx`（保留上一会话 `flex-shrink-0` 修复）、`BatchActions.tsx`、`utils/gallery.tsx`、`ContextMenu.stories.tsx`、`ShareMenuButton.test.tsx`、i18n 文案、package.json。WiFi 分享按钮沿用同一 `IconShare`（按钮旁「WiFi 分享」文字标签承载语义，最小改动；专属 WiFi 图标属范围扩张，不做）。不顺手重构/格式化无关代码，不加 `@ts-ignore`。

## 8 改动文件清单

| 文件                                          | 变更                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| `src/renderer/icons/index.tsx`                | IconShare 字形整体替换为 Lucide share-2（约 6 行）+ 出处注释 |
| `src/renderer/icons/index.test.tsx`           | 头注释更新；结构用例重写为新字形指纹；守卫用例保留           |
| `src/renderer/icons/index.stories.tsx`        | 注释与 docs description 更新                                 |
| `docs/plans/2026-09-30-replace-share-icon.md` | 新建：本计划 + 执行记录                                      |

## 9 最终用户验收路径

1. `npm run storybook` → `Icons/ShareIconFamily` 64px 档：三节点字形完整清晰无裁切。
2. `npm run dev`：图库/截图/收藏/启动器缓存选中图片 → 右键「分享」项图标为三节点网络；多选 → 批量栏「分享」「WiFi 分享」按钮同步；重复文件页右键同理。

## 10 执行记录（2026-09-30 已完成）

- [x] S0 计划落盘：本文档创建。
- [x] S1 红灯确认：`npx vitest run src/renderer/icons/index.test.tsx` → **2 failed | 9 passed (11)**。失败的是两个新字形指纹用例（收到的正是旧字形唯一的 circle (12,18,1.5)、无 line），几何守卫 / 尺寸矩阵 / 扫描器异常等 9 个既有用例保持 GREEN，满足「回归测试修复前必须红灯」。
- [x] S2 绿灯确认：`icons/index.tsx` IconShare 字形替换为 Lucide share-2（3 circle + 2 line），重跑 → **11 passed (11)**。
- [x] S3 故事更新：`icons/index.stories.tsx` 头注释与 docs description 改为新字形验收点（三节点完整、来源 Lucide share-2）。
- [x] S4 局部回归：`ShareMenuButton.test.tsx` → **24 passed (24)**；`npm run test:renderer` → **127 文件 / 1698 测试全绿**（基线 1697 + 新增 1，零失败）。
- [x] S5 全局回归：`npm test` → **294 文件 / 4906 测试全绿**（基线 4905 + 新增 1）；`npm run typecheck`（tsc -b）→ **0 错误**；`npm run lint`（eslint .）→ **0 错误**；`npm run audit`（audit-ci）→ **失败，但为改动前基线问题**：electron 40.10.6 新披露 4 条 high 通告（GHSA-9qh4-3jw8-366w / GHSA-gr2m-v5gq-v685 / GHSA-hq2x-r82h-9wj4 / GHSA-j84w-jfhq-vhvj，均不在 `audit-ci.jsonc` 豁免清单）。本次任务零依赖变更（`package.json` / `package-lock.json` / `audit-ci.jsonc` 经 `git status` 核实未改动），audit 结果与本任务无关；修复需升级 electron 大版本，属独立专项，按约定如实上报、不在本次最小改动中处理、不通过改豁免清单弱化安全门禁。
- [x] S6 视觉验收：清理上个会话残留的 6006 端口旧 Storybook 实例（PID 5860，避免目检到旧代码）后，以 `--ci` 模式启动全新实例（v10.5.10），Playwright 截图 `Icons/ShareIconFamily` 故事 iframe：**16 个 svg（4 图标 × 4 尺寸）全部渲染、无控制台错误；64px 放大档下 IconShare 三节点网络字形三个圆点与两条连线完整清晰，无切边、无贴边裁切**；14/16/28 档可辨识。截图存档：`%TEMP%\share-icon-story.png`。

### 本次改动文件清单

| 文件                                          | 变更                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/icons/index.tsx`                | IconShare 字形整体替换为 Lucide share-2（3 circle + 2 line）+ 出处与选型注释（导出名不变，调用点零改动）                      |
| `src/renderer/icons/index.test.tsx`           | 头注释更新为「字形替换」根因；编码旧字形的结构用例重写为 Lucide share-2 字形指纹用例（结构 + 逐坐标）；几何守卫等既有用例保留 |
| `src/renderer/icons/index.stories.tsx`        | 头注释与 docs description 更新为新字形验收点                                                                                  |
| `docs/plans/2026-09-30-replace-share-icon.md` | 本计划与执行记录                                                                                                              |

### 遗留事项（非本任务范围）

- electron 40.10.6 的 4 条新披露 high 通告待专项升级治理（同 `audit-ci.jsonc` 中既有豁免项的跟踪模式），建议后续单独建任务。
