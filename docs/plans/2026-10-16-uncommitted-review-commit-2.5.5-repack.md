# 未提交变更审查 → 提交 → 版本 2.5.5 核验 → 重新打包

> 生成日期 2026-10-16 · 基线 HEAD `6a6e531`（branch `feat/gallery-runtime-embed`，工作树 32 项未提交变更）· 版本 2.5.5
> 任务委托方规范：最小化改动 · 先计划后动手 · 分步原子化验证 · TDD 红-绿闭环 · 全局回归一票否决 · 禁止幻觉与测试作弊

## 0. 前提取证（审查结论，执行前已完成）

工作区 32 项未提交变更 = 「同步服务从设置页剥离、迁入同步图库板块二级子页 `sync-service`」的完整重构（26 修改 + 2 个 rename + 4 新增）。逐项只读取证，**未发现需要修复的缺陷**：

| 审查项                   | 取证方式                                                                                       | 结论                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 组件逻辑漂移             | `git diff HEAD -M` 对比原 `settings/sync-sections.tsx` 与新 `sync-gallery/SyncServicePage.tsx` | 6 个处理器与 refresh 逐字一致；仅 i18n 键名、import 路径、外层结构（PageHeader + 三段 SectionShell）、mount effect 增加 `currentView !== 'sync-service'` 轮询门控（计划内必要行为差异）                                                                                        |
| i18n 键迁移 ×12 包       | node 脚本机械比对 HEAD vs 工作树                                                               | 37 键值逐字平移 0 drift；`settings.sync`/`settings.groups.sync`/`settings.sections.syncService` 全清零；`syncService` 子树恰 38 叶子；`page.title == appShell.viewStatus.syncService == syncGallery.toolbar.service == service.title` 四值一致；死键 `status.connections` 已删 |
| `runtimeOff` 改写 ×12 包 | 脚本逐包断言                                                                                   | 均已改写且包含本包 `syncGallery.toolbar.service` 值（含 th 泰文）                                                                                                                                                                                                              |
| JSON 卫生                | 脚本逐包断言                                                                                   | `JSON.stringify(_, null, 2) + '\n'` 格式、UTF-8 BOM 保留、LF、增删行数对称（58/56）                                                                                                                                                                                            |
| 路由接线                 | 读 `uiStore.ts` / `App.tsx` / `AppShell.tsx`                                                   | ViewLevel +`'sync-service'`；ALL_VIEWS、VIEW_LEVEL_MAP 值 2、renderPage case、getViewStatusLabel case 全部在位；三处静默位点由 `App.view-registry.test.ts` 结构断言焊住                                                                                                        |
| 工具栏入口               | 读 `SyncGalleryToolbar.tsx` + 测试 diff                                                        | `onOpenService?` 可选（未传不渲染）、运行时 null 也绝不 disabled；既有 3 条用例未被弱化                                                                                                                                                                                        |
| e2e 改道                 | 读 `e2e/nikkisync-runtime.e2e.ts` diff                                                         | N3c 由「设置页直达」改为「同步图库 → 工具栏同步服务」，Sidebar nav-item 有 title 属性，`getByTitle` 可行；其余断言逐字未动                                                                                                                                                     |
| 测试有效性               | 读全部新增/改写测试                                                                            | 等集断言、反向锁、假时钟门控、残留 localStorage 回退等断言均为实质断言；`PairingQrDialog.test.tsx` 一行未改（值未漂移的硬证据）                                                                                                                                                |
| 版本文件                 | 读 `package.json` / `package-lock.json`                                                        | 均已是 2.5.5（任务第 4 步实为核验，不符才改）                                                                                                                                                                                                                                  |

## 1. 依赖声明

**无。** 不新增、不变更、不删除任何 npm 依赖，不引入第三方库，不新增脚本。全部复用 `package.json` scripts 中既有命令。

**禁止项（环境约束，违反即制造假绿）**：

- 禁止 `npm install` / `npm ci` —— 会剪掉 `node_modules/@nikkisync/*` junction，链接态用例降级为 skip；
- 禁止 `npm run sync-i18n-keys` —— 会以 zh-CN 为基线删掉其他 11 包 extra 键；
- 禁止改动 `vitest.config.ts` 覆盖率阈值与 exclude、禁止改动 `CHANGELOG.md` 既有条目。

环境要求：Node ≥ 22.12.0（`package.json engines`，本机 Node v26.3.0 满足）；无需联网装包。

## 2. 启动与运行说明

本任务无服务启动动作；全部验证通过命令行完成。执行目录固定为仓库根 `d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe`。

```bash
# 局部回归（本次变更直接相关，先跑，快）
npx vitest run src/renderer/pages/sync-gallery src/renderer/pages/SettingsPage.test.tsx \
               src/renderer/App.view-registry.test.ts src/renderer/stores/uiStore.test.ts \
               src/renderer/i18n/locales/sync-service-keys.test.ts \
               src/renderer/i18n/locales/sync-gallery-keys.test.ts \
               src/renderer/components/sync/PairingQrDialog.test.tsx \
               src/renderer/components/layout/Sidebar.test.tsx

# 静态检查链
npm run typecheck          # tsc -b && tsc -p tsconfig.scripts.json
npm run typecheck:e2e      # tsc --noEmit -p e2e（e2e 不在 npm test 内，唯一静态守卫）
npm run lint               # eslint .
npm run i18n:guard         # CI 守卫（单向 missing）
npm run i18n:check         # 12 包双向对齐（CI 不跑，必须手工）

# 全局回归
npm test                   # vitest 全量（397 files 基线）
npm run test:coverage      # 覆盖率阈值闸门 66/58/59/68
npm run verify             # verify-changes.ts（typecheck/lint/core-gate/format/test 五项）

# 标准打包（第 5 步）
npm run dist:win           # build + pre-dist-check + electron-builder --win --publish never + verify:dist
npm run verify:nikkisync   # 内嵌运行时链接态诊断（10 项断言）
```

**Safe-Delete 网关兜底（本机实测约束，阈值 500 项）**：`npm run build` 的 clean 步与 electron-builder doPack 解包会被拦截。打包前先 `Move-Item dist/main <临时目录>`、`Move-Item release/win-unpacked <临时目录>`，再跑 `npm run dist:win`；成功后删临进目录收尾。

## 3. 错误处理

| 失败点                  | 现象                                                 | 处置（兜底）                                                                                                 |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 局部/全量测试红         | 退出码非 0                                           | 停步进 TDD：先确认失败用例能复现问题（红），再最小修复转绿，复跑相关子集 + 全量；禁止 skip / 注释 / 弱化断言 |
| typecheck 红            | tsc 非 0                                             | 同 TDD 流程；`VIEW_LEVEL_MAP` 缺键等编译错误直接修接线                                                       |
| lint 红                 | eslint 非 0                                          | 修真实问题；既有 11 条 DEBT-030 警告（BOM）属基线，不新增即可                                                |
| i18n:check 红           | 键集不对齐                                           | 回查是哪一包漏改/多键，按 `sync-service-keys.test.ts` 反向锁定位                                             |
| pre-commit 钩子改写文件 | `git status` 出现非本人改动                          | 核对是否仅 eslint --fix / prettier --write 格式层；确认后允许其随提交进入                                    |
| commitlint 拒收         | commit-msg 钩子非 0                                  | 按规范重写 header（≤100 字符、scope ≤24 小写、subject 不以「。」结尾）                                       |
| Safe-Delete 网关拦截    | SAFE_DELETE_BULK_CONFIRM_REQUIRED                    | §2 的 Move-Item 预移走兜底；绝不递归强制删除                                                                 |
| 打包闸门红              | pre-dist-check / verify:dist / verify:nikkisync 非 0 | 按各脚本输出定位（@nikkisync 产物缺失 / CHANGELOG bullet / 文档版本），修复后重跑对应命令                    |
| e2e N3c 无法本机复验    | 无 `link:nikkisync` 链接                             | 以 `npm run typecheck:e2e` 静态守卫 + 计划文档如实声明挂账，不伪造通过                                       |

日志规范：所有命令输出（退出码、用例计数、校验标记）逐条记入 §7 执行记录，作为一票否决闸门判定依据。

## 4. 参数校验

- **版本号写入范围**：仅 `package.json` 的 `version` 与 `package-lock.json` 的顶层 `version` / `packages[""].version` 两个文件；其他任何文件（README、docs、CHANGELOG、源码常量）一律不因本次任务改动。实测两者均已为 `2.5.5` —— 相符则记录证据、零改动；不符则仅改版本字段本身，改完复跑 `npm run pre-dist-check` 的 changelog 闸门确认不误伤。
- **提交信息约束**：Conventional Commits；type ∈ {feat, docs, refactor, fix}；scope ≤24 字符小写；header ≤100 字符；subject 不以「。」结尾；正文说明「做了什么 + 为什么」。
- **变更范围约束**：只提交本次 32 项变更及其计划文档；不夹带未提及文件；`release/` 旧安装包（2.5.2/2.5.3）不清理、不入库。
- **构建产物校验**：`release/NikkiGallery-Setup-2.5.5.exe` 时间戳必须晚于本次提交时间；`verify:dist` 的 @nikkisync 产物断言全 ✔。

## 5. 基础测试用例（正常 / 异常 / 边界）

**正常路径**：

1. `npx vitest run` 局部 7 个测试文件全绿（sync-gallery 目录、SettingsPage.test.tsx、App.view-registry.test.ts、uiStore.test.ts、两个 i18n 守卫、PairingQrDialog.test.tsx、Sidebar.test.tsx）；
2. `npm run typecheck` / `typecheck:e2e` / `lint` / `i18n:guard` / `i18n:check` 退出码 0；
3. `npm test` 全量通过且无新增失败（基线 397 files / 6177 passed / 2 skipped）；
4. `git commit` 两个 commit 均被 commitlint 接受，`git log --oneline -2` 可见；
5. `npm run dist:win` 退出码 0，`verify:dist` / `verify:nikkisync` 全 ✔。

**异常路径**：6. 任一命令非 0 → 按 §3 对应行处置，修复后重跑该命令 + 其下游依赖命令，不允许带着红进下一步；7. Safe-Delete 拦截 → Move-Item 兜底后重跑，记录拦截与兜底双方证据；8. pre-commit 钩子改写 → 人工核对 diff 仅格式层后放行。

**边界条件**：9. 版本核验：`package.json` 与 `package-lock.json` 双文件一致为 2.5.5，且无第三处版本字段被误改（`git diff --stat` 审查）；10. 提交后 `git status --porcelain` 为空（钩子改写已被二次暂存或已处理）；11. 覆盖率四指标不低于阈值（66/58/59/68），不低于基线余量；12. 产物时间戳晚于 HEAD 提交时间，证明「重新打包」而非复用旧包。

---

## 6. 子任务拆解

### T-0 · 计划文档落盘

- **涉及文件**：`.zcode/plans/2026-10-16-uncommitted-review-commit-2.5.5-repack.md`（新建，用户指定目录）；`docs/plans/2026-10-16-uncommitted-review-commit-2.5.5-repack.md`（同内容镜像，仓库约定）。
- **输入 / 输出**：输入 = §0 审查取证结论；输出 = 含五必备节（依赖声明/启动运行/错误处理/参数校验/测试用例）+ 每子任务三要素的可执行计划文档。
- **验收标准**：两文件存在且内容一致；文档命名对齐既有 `YYYY-MM-DD-<slug>.md`；§7 执行记录初始为「待回填」占位。

### T1 · 独立复审 + 全量回归基线

- **涉及文件**：无仓库文件改动（只读 + 命令执行）。
- **输入 / 输出**：输入 = 32 项变更；输出 = open-code-review 审查报告 + 七条校验命令的退出码与计数。
- **验收标准**：审查报告无 critical/high 未处置项；七条命令全绿（任一红 → 转 T1b TDD 闭环，修复后重跑全链）。

### T1b · 条件任务：TDD 修复（仅 T1 失败时触发）

- **涉及文件**：最小化的问题文件 + 对应测试文件。
- **输入 / 输出**：输入 = 失败的测试/检查；输出 = 先红后绿的回归用例 + 最小修复。
- **验收标准**：新回归用例在修复前实测失败（留证），修复后转绿；局部子集 + 全量复跑通过。

### T2 · 提交代码变更

- **涉及文件**：26 个已修改文件 + 2 个 rename + 4 个新增测试/计划文件（即 T2a 快照的全部变更，计划文档除外）。
- **输入 / 输出**：输入 = 已验证的工作树；输出 = commit `feat(sync-gallery): ...`。
- **验收标准**：commitlint 通过；`git show --stat HEAD` 文件数与 §0 清单一致（计划文档不在内）；钩子改写差异已核对。

### T2b · 提交计划与执行记录文档

- **涉及文件**：`docs/plans/2026-10-16-uncommitted-review-commit-2.5.5-repack.md`、`.zcode/plans/` 同名文件、`docs/plans/2026-10-16-sync-service-to-sync-gallery.md`（仅追加 §10.7 执行记录，不改 §0–§9）。
- **输入 / 输出**：输入 = 回填了执行记录的计划文档；输出 = commit `docs(plans): ...`。
- **验收标准**：`git status --porcelain` 仅剩预期文档变更；提交后工作树干净。

### T3 · 版本号核验

- **涉及文件**：`package.json`、`package-lock.json`（仅核验；实测已 2.5.5，预期零改动）。
- **输入 / 输出**：输入 = 两个版本文件当前值；输出 = 核验证据（双文件 version 均为 2.5.5）或最小版本字段修改。
- **验收标准**：`node -e` 读出双文件版本均为 `2.5.5`；`git diff --stat` 证明无第三处版本相关改动。

### T4 · 重新打包

- **涉及文件**：`dist/`（构建输出）、`release/`（安装包产物，仅新增 2.5.5 产物）。
- **输入 / 输出**：输入 = 已提交代码；输出 = `release/NikkiGallery-Setup-2.5.5.exe`（时间戳晚于 T2 提交）+ `dist:win` 全链退出码 0。
- **验收标准**：`npm run dist:win` 退出码 0；`verify:dist` @nikkisync 产物断言全 ✔；`verify:nikkisync` 全 ✓； Safe-Delete 拦截与兜底留证。

### T5 · 全局收口

- **涉及文件**：计划文档 §7 执行记录回填（replace_in_file，仅追加）。
- **输入 / 输出**：输入 = T1–T4 全部证据；输出 = 回填后的计划文档 + 收口结论。
- **验收标准**：`git status --porcelain` 为空；`npm run verify` 5 项全 ✓；`npm test` 复跑与 T1 同数；安装包时间戳核验通过；§7 记录每条命令实测输出。

## 7. 执行记录（2026-10-16）

### 7.1 T-0 计划文档落盘

- 新建 `.zcode/plans/2026-10-16-uncommitted-review-commit-2.5.5-repack.md`（主文档，`.zcode/` 在 .gitignore 内，为本地产物）；
- 同内容镜像 `docs/plans/2026-10-16-uncommitted-review-commit-2.5.5-repack.md`（Get-FileHash 两文件一致，True）；
- 文档含五必备节 + 每子任务三要素，命名对齐既有 `YYYY-MM-DD-<slug>.md`。

### 7.2 T1 独立复审 + 全量回归基线（全部实测通过）

**OCR delegate 审查**（open-code-review v1.13.0，delegate 模式，本机 LLM 行级审查，23 个可审查文件）：结论 **无 critical / high / medium 问题**。唯一低severity 观察为既有代码逐字搬运的 `SyncServicePage.tsx` 状态点三元两支同值（`var(--text-tertiary)`）与状态文案嵌套三元——均原样存在于搬迁前的 `sync-sections.tsx`，按最小化改动原则不处理。其余按规则逐项核过：无死代码新增、无 `var`/`==`/`any`、Hooks 规则合规、effect 依赖与 cleanup 正确、异步错误处理完备、无 XSS/innerHTML/eval 面。

| 校验命令                                                                                                                                                           | 实测结果                                                                | 判定 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---- |
| 局部回归（sync-gallery 目录 + SettingsPage.test.tsx + App.view-registry.test.ts + uiStore.test.ts + 两个 i18n 守卫 + PairingQrDialog.test.tsx + Sidebar.test.tsx） | 11 files / 96 tests 全过（2.70s）                                       | 绿   |
| `npm run typecheck`                                                                                                                                                | 退出码 0                                                                | 绿   |
| `npm run typecheck:e2e`                                                                                                                                            | 退出码 0                                                                | 绿   |
| `npm run lint`                                                                                                                                                     | 0 errors / 11 warnings（既有 DEBT-030 BOM 警告，与基线一致，未新增）    | 绿   |
| `npm run i18n:guard`                                                                                                                                               | ✅ 白名单只减不增、key 已同步                                           | 绿   |
| `npm run i18n:check`                                                                                                                                               | ✅ 12 包对齐（3933 keys/包）                                            | 绿   |
| `npm test`                                                                                                                                                         | 397 files / 6177 passed / 2 skipped（56.26s），与基线逐项一致           | 绿   |
| `npm run test:coverage`                                                                                                                                            | 退出码 0；All files 67.68 / 59.26 / 60.34 / 69.25，高于阈值 66/58/59/68 | 绿   |
| `npm run verify`                                                                                                                                                   | 5 项全 ✓（typecheck/lint/core-gate/format/test），0 失败                | 绿   |

**计划外发现并处置（1 处）**：`npm run test:coverage` 首跑被 Safe-Delete 网关拦截（V8CoverageProvider.clean 删 `coverage/` 目录 517 项 > 阈值 500，`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）——这是本机第三个网关命中点（前两个为 dist/main 862 项、release/win-unpacked 753 项，均来自项目记忆）。兜底：`Move-Item coverage` 至 `%TEMP%/cov-backup-20261016` 后重跑即过，未改任何配置。

**T1b（TDD 修复）未触发**：审查无缺陷、回归全绿，无「修复前失败」用例需要编写。

### 7.3 T2 提交（commit 1）

- `git add -A` 后 `git restore --staged` 排除本任务计划文档，暂存区精确为 31 个功能文件；
- commit `676fd39`：`feat(sync-gallery): 同步服务从设置页迁入板块内二级子页`，33 files changed, 2207 insertions(+), 1159 deletions(-)；rename 检测生效（`sync-sections.test.tsx → SyncServicePage.test.tsx` 79%）；
- header 40 字符 ≤100、scope `sync-gallery` 13 字符 ≤24、subject 不以「。」结尾，符合 commitlint 与仓库先例；
- 提交后 `git status --porcelain` 仅剩计划文档未跟踪项，无钩子改写差异。

（T3 版本核验 / T4 重新打包 / T5 全局收口记录见 7.4–7.6，完成后回填。）
