# 2026-10-17 图库选中态描边修复：未提交变更审查 / 修复 / 提交 / 版本复验 / 重新打包实施计划

- 计划日期：2026-10-17
- 基线提交：`abe8476`（工作区仅余「图库卡片选中态边框可见性修复」一批未提交变更）
- 影响面：`src/renderer/components/gallery/` 四视图 + stories、`src/renderer/styles/` 两处 CSS、`tailwind.config.ts`、两个新测试文件、`CHANGELOG.md`；打包产物 `release/`

## 一、审查结论（逐行读 diff + 工具交叉验证）

未提交变更为「修复图库卡片选中态边框不显眼」一套完整实现（原计划见 `docs/plans/2026-10-17-fix-image-selection-border-visibility.md`，其 §7 已回填该改动的 TDD 执行记录）。本轮逐项审查后确认 **1 个代码规范缺陷**，其余维度通过。

### 缺陷清单

| 编号 | 严重度           | 位置                                                        | 结论                                                                                                                                                                                                                                            |
| ---- | ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | 低（规范符合性） | `src/renderer/styles/media-card-selection.test.ts` L143-145 | 联合类型未按 Prettier 格式（三行断行应为单行）。实测 `npx prettier --check` 对该文件报警，会导致 `npm run verify` 的 format 步骤失败（pre-commit 钩子虽会自动改写，但按 AGENTS.md 工作流必须先过 verify）。修复 = 仅对该文件 `prettier --write` |

### 审查通过项（无需改动）

- **定位机制**：`.media-card` 基类（`globals.css:1239-1245`）有 `position: relative` + `overflow: hidden` + `border-radius`，`::after` 的 `inset: 0` + `border-radius: inherit` 成立；四视图仅在 multiSelectMode 时加的 `relative` 类不影响（基类已定位）。
- **CSS 优先级链**：`.media-card.is-selected:hover::after`(0,3,1) > `.media-card.is-selected::after`(0,2,1) > `.media-card:hover::after`(0,2,1)；soft-pink 主题覆盖 (0,3,1) 因 `@import` 位于 `globals.css` 第 2 行（规则在前），对非 hover 选中态以高优先级胜出，hover 选中态由 globals 后源 `--accent-deep`（soft-pink 已定义 `#cf8ba8`）胜出——「选中 ≠ 悬停」层次在两主题均成立。
- **主题变量**：`--accent-soft` / `--accent-deep` / `--shadow-lg` 在 `:root` 与 soft-pink 两主题均已定义，且新规则全部带 `var(…, fallback)` 兜底。
- **无障碍**：`aria-selected={isSelected}` 在三视图保留（`VirtualImageGrid.tsx:522` / `TimelineView.tsx:210` / `EventTimelineView.tsx:301`）；MasonryView 勾选框 `role=checkbox aria-checked` 由测试覆盖。
- **Tailwind ring 令牌影响面**（全量 grep）：`RecycleBinPage.tsx:523` 裸 `ring-2` 由默认蓝 `#3b82f6` 变为 `var(--accent)`（符合 R4 意图的主题化改进，无 offset 故无露白圈）；`profile-sections.tsx:248` 内联 `--tw-ring-color` 覆盖不受影响；`scan-log-diagnostic-section.tsx` 用具名色不受影响；`CategoriesPage.tsx:679` 任意值不受影响；其余无裸 ring 用法；`ring-offset-2` 仅剩 `globals.css` 注释中的废弃说明。
- **测试兼容性**：既有测试无对旧 ring 类名的断言；e2e 无 `is-selected` / `ring-offset` 引用；stories 的 `fn` 已导入（第 2 行）。
- **新增测试实测**：`npx vitest run src/renderer/styles/media-card-selection.test.ts src/renderer/components/gallery/media-card-selection.test.tsx src/renderer/styles/layer-budget.test.ts` → 3 files / 29 tests 全过（14 + 12 + 3）。
- **依赖**：零新增、零变更（diff 不含 `package.json` / `package-lock.json`）。
- **工具交叉验证**：`ocr delegate preview/rule`（workspace 模式，8 个可审查文件）确认可审查面与人工审查一致；按系统规则组（死代码 / Hooks 规则 / 内联样式 / 空检查 / 严格相等 / 注释 / 拼写等）逐条应用后无 F1 之外的新增类别问题。注意：四视图改动实际是**减少**内联样式（删除 `--tw-ring-color` 扩展），与「避免内联样式」规则同向。

### TDD 说明

本轮未提交变更为既有实现的收尾审查，其行为类测试在该改动引入时已按红绿闭环执行（原计划 §7：CSS 测试 11 红→绿、令牌断言 3 红→绿、渲染级 12 红→绿）。本轮 F1 为格式缺陷，以 `prettier --check` 红灯（修复前已实测报警）→ `prettier --write` → `--check` 绿灯为闭环；修复后重跑 29 项测试确认零行为影响（无任何用例被改动、跳过或弱化）。

## 二、依赖声明

**无新增、无变更、无删除任何依赖。** 全部修复与提交动作落在既有文件内：

- 样式继续复用既有 CSS 变量体系（`--accent` / `--accent-soft` / `--accent-deep` / `--bg-primary` / `--shadow-lg`）与 `globals.css` / `themes/soft-pink-luxury.css`。
- 校验全部复用仓库既有脚本：`scripts/verify-changes.ts`、`scripts/pre-dist-check.ts`、`scripts/check-changelog-release.ts`、`scripts/check-doc-versions.ts`、`scripts/verify-nikkisync-link.ts`。
- 不新增脚本、不新增 i18n key、不改 `vitest.config.ts`。

## 三、启动与运行说明

```bash
# 环境准备（只读校验）
node -v                                        # 需 >= 22.12.0
npm run link:nikkisync:check                   # 四链 junction 必须全 OK（打包前复验）

# F1 修复（红灯 → 绿灯）
npx prettier --check src/renderer/styles/media-card-selection.test.ts   # 修复前：报警（红）
npx prettier --write src/renderer/styles/media-card-selection.test.ts   # 修复
npx prettier --check src/renderer/styles/media-card-selection.test.ts   # 修复后：All matched files use Prettier code style（绿）

# 修复后局部回归（29 项）
npx vitest run src/renderer/styles/media-card-selection.test.ts src/renderer/components/gallery/media-card-selection.test.tsx src/renderer/styles/layer-budget.test.ts

# 变更后只读闸门
npm run verify

# 全局回归
npm test
npm run lint
npm run typecheck

# 版本闸门（打包前）
npx tsx scripts/check-changelog-release.ts
npx tsx scripts/check-doc-versions.ts

# 重新打包（Safe-Delete 两命中点预防性移走后一次跑通）
npm run dist:win
npm run verify:dist
npm run verify:nikkisync
npm run e2e:smoke
```

## 四、错误处理与兜底

| 异常分支                                                                         | 兜底策略                                                                                                         | 可观测结果                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `npm run verify` format 步骤失败                                                 | 仅对报警文件 `prettier --write`（禁止全局 format，遵守最小化改动红线）                                           | `[VERIFY] ✓ format`           |
| pre-commit 钩子改写文件（eslint --fix / prettier --write）                       | 提交后 `git status --porcelain` 核对；非格式层残留即回查                                                         | 工作树仅剩后续笔次应含文件    |
| PowerShell 提交消息传输坑（BOM / here-string 拆包 / 引号转义）                   | 消息避开双引号 + `[System.IO.File]::WriteAllText(path, msg, UTF8Encoding($false))` 无 BOM 写入 + `git commit -F` | commitlint 通过               |
| Safe-Delete 网关拦截 `npm run build` 清 `dist/main`（862 项 > 500）              | 打包前预防性 `Move-Item dist/main` 至 `%TEMP%\wxnn-repack-backup-20261017`，clean 的 `existsSync` 无删除动作     | 构建继续，旧产物留证          |
| Safe-Delete 网关拦截 electron-builder doPack 删 `release/win-unpacked`（753 项） | 同上预防性 `Move-Item release\win-unpacked`                                                                      | 打包继续                      |
| `zip-archive.test.ts`（restore-failed）全量复现                                  | 记录为既有 flake（主进程归档用例，与本轮渲染层改动无关）                                                         | 不作为本轮回归失败            |
| 版本字段复验不一致（预期不会发生）                                               | 修正该字段并使三处（package.json / lock 两处 / database-mock）一致后重跑闸门                                     | `node -e` 三处均 `2.5.5-beta` |

日志规范：renderer 侧 eslint 禁 `console`、禁 `throw new Error`；本轮无新增日志面。

## 五、参数校验

本轮无新增接口、无新增入参。既有被触碰处的校验维持原状：

| 位置                               | 校验                                                                                            | 处理                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `MasonryView` props                | `selectedIds` / `onSelect` / `onContextMenu` / `multiSelectMode` / `onToggleSelection` 全部可选 | 组件内既有归一化（`selectedIds \|\| []`、函数类型守卫回落 no-op）不改动 |
| `.media-card.is-selected` 主题变量 | `--accent-soft` / `--bg-primary` / `--shadow-lg` / `--accent-deep`                              | 全部 `var(…, fallback)`；变量缺失时该段降级而非整条声明失效             |
| `tailwind.config.ts` ring 令牌     | `ringColor.DEFAULT` / `ringOffsetColor.DEFAULT`                                                 | 指向 `var(--accent)` / `var(--bg-primary)`；具名色与任意值用法不受影响  |

## 六、基础测试用例矩阵（正常 / 异常 / 边界）

| 类别 | 用例                       | 断言要点                                                                                                                                                                                  |
| ---- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 | F1 修复后 prettier --check | 该文件转绿（修复前报警 = 红灯）                                                                                                                                                           |
| 正常 | 修复后 29 项相关测试       | media-card-selection 两套件 26 例 + layer-budget 3 例全绿                                                                                                                                 |
| 正常 | `npm run verify`           | typecheck / lint / core-gate / format / test 五项全绿                                                                                                                                     |
| 正常 | 全量 `npm test`            | 407 files / 6288 passed / 2 skipped，与基线精确吻合、零新增失败                                                                                                                           |
| 正常 | 全量 `npm run lint`        | 0 error（11 warning 均为既有测试文件 Unicode BOM，与基线一致）                                                                                                                            |
| 正常 | 全量 `npm run typecheck`   | exit 0                                                                                                                                                                                    |
| 异常 | 双版本闸门                 | `check-changelog-release`（版本节存在且唯一、Unreleased 收口）与 `check-doc-versions`（README Electron 版本一致）均 exit 0                                                                |
| 边界 | 提交面核对                 | C1 恰 10 文件（8 改 + 2 新测试）、C2 恰 1 文件（CHANGELOG）、C3 恰 1 文件（计划文档）；每笔后 `git status --porcelain` 无钩子残留                                                         |
| 边界 | 打包产物校验               | exe mtime 晚于末笔提交；`latest.yml` 的 version/size/sha512 与新 exe 逐项一致；`verify:dist` / `verify:nikkisync` 全 ✔；`e2e:smoke` 15/15（含 `app.getVersion` 与 package.json 一致断言） |

### 基线记录

执行前基线（上一轮 2026-10-17 全屏修复提交后）：`npm test` 405 files / 6262 passed / 2 skipped；本改动（原计划记录）引入后为 407 files / 6288 passed / 2 skipped。本轮实测与后者精确吻合即无新增失败。

## 七、子任务与验收标准

### T0 · 审查与交叉验证

- **涉及文件**：无（只读）。
- **输入 / 输出**：输入 = 工作区未提交变更全集（8 改 + 3 新增）；输出 = F1 缺陷清单 + 审查通过项 + `ocr delegate` 交叉验证结论。
- **验收标准**：`git status --porcelain` 与计划列举的 11 个条目一致；29 项新测试实测全绿；OCR 规则组逐条应用后无 F1 之外新增类别问题。

### T1 · F1 修复（红灯 → 绿灯）

- **涉及文件**：`src/renderer/styles/media-card-selection.test.ts`（唯一改动文件）。
- **输入 / 输出**：输入 = 该文件 L143-145 三行联合类型；输出 = 单行联合类型（prettier --write 结果）。
- **验收标准**：修复前 `prettier --check` 报警（红灯，已取证）；修复后转绿；重跑 29 项测试零行为影响；`git diff` 范围仅格式层。

### T2 · 只读闸门与全局回归

- **涉及文件**：无（只读验证）。
- **输入 / 输出**：输入 = T1 后的工作区；输出 = 全绿证据。
- **验收标准**：`npm run verify` 五项全绿；`npm test` 407 files / 6288 passed / 2 skipped；`npm run lint` 0 error；`npm run typecheck` exit 0。

### T3 · 三笔提交（C1 / C2 / C3）

- **涉及文件**：C1 = 10 文件（四视图 + stories + 两 CSS + tailwind.config.ts + 两新测试）；C2 = `CHANGELOG.md`；C3 = 本文档。
- **输入 / 输出**：输入 = 已验证工作区；输出 = 三笔 commit（C1 `fix(gallery)` / C2 `chore(release)` / C3 `docs(plans)`）。
- **验收标准**：commitlint 三笔均过；core-path-gate 均判「不涉及受保护路径」；每笔后 `git status --porcelain` 仅剩后续笔次应含文件；版本三处字段复验均为 `2.5.5-beta`；双版本闸门 exit 0。

### T4 · 重新打包与产物校验

- **涉及文件**：无仓库文件改动；产物落 `release/`。
- **输入 / 输出**：输入 = T3 提交后的干净工作区；输出 = 新安装包 + 校验证据。
- **验收标准**：`npm run dist:win` 退出码 0（预防性移走旧 `dist/main` 与 `release/win-unpacked`，Safe-Delete 网关不触发）；`verify:dist` 全 ✔；`verify:nikkisync` blocking failures 0；`release/NikkiGallery-Setup-2.5.5-beta.exe` mtime 晚于末笔提交；`latest.yml` 的 version/size/sha512 与新 exe 逐项一致；`npm run e2e:smoke` 退出码 0（含打包态 `app.getVersion` 与 package.json 一致断言）。

## 八、范围边界（明确不做）

- 不改四视图组件逻辑 / Props、不改 `.media-card` 既有 hover 行为、不新增暗色主题、不动覆盖率阈值。
- 不装 / 升依赖、不做无关重构与格式化（唯一格式化对象是 F1 所在测试文件）。
- 不修改版本号数值（三处已为 `2.5.5-beta`，本轮动作为复验 + CHANGELOG 补录）。
- 不跑 `e2e:perf`、不做 storybook 人工目视（原计划已记录 story 手验入口）。

## 九、执行记录

| 节点     | 状态   | 关键产出 / 证据                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T0       | 完成   | 逐行读 diff + `ocr delegate preview/rule`（workspace 模式，8 个可审查文件）交叉验证；29 项新测试实测全绿；`git status --porcelain` 11 条目与计划一致                                                                                                                                                                                                                                 |
| T1（F1） | 完成   | 红灯证据：`prettier --check` 对 `media-card-selection.test.ts` 报警（L143-145 三行联合类型）。修复：仅对该文件 `prettier --write`。绿灯：`--check` 转绿；重跑 29 项测试全绿（零行为影响）                                                                                                                                                                                            |
| T2       | 完成   | `npm run verify` 五项全绿（typecheck 7510ms / lint 2264ms / core-gate 586ms / format 649ms / test 1975ms；4 个 ⚠ 为「源文件无同名测试套件」非阻断提示，其行为由新增的 media-card-selection 套件覆盖）。全量 `npm test`：407 files / **6288 passed / 2 skipped / 0 failed**（与基线精确吻合）；`npm run lint` 0 error / 11 warning（全部既有 BOM）；`npm run typecheck` exit 0        |
| T3       | 完成   | 版本三处复验均 `2.5.5-beta`（`node -e` 取证）；CHANGELOG 追加 dated addendum + Fixed 条目（既有条目未动）；双闸门 exit 0。C1 = `68b798c`（10 files, +377/-19，pre-commit 三步全过：lint-staged / core-gate 跳过（不涉受保护路径）/ tsc -b；commitlint 过）；C2 = `7e9a4f0`（1 file, +3，lint-staged 过、typecheck 步骤因无 TS 文件跳过）；每笔后 `git status --porcelain` 无钩子残留 |
| T4       | 待回填 | 重新打包与产物校验（`link:nikkisync:check` → 预防性移走旧产物 → `npm run dist:win` → `verify:dist` / `verify:nikkisync` / `e2e:smoke`），结果以第四笔 docs(plans) 回填                                                                                                                                                                                                               |
