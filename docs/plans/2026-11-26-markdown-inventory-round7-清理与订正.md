# Markdown 全量盘点、清理与订正（round 7 · 2026-11-26）

- 日期：2026-11-26
- 基线：`main` @ `a5acb27`（meow-star-map 2.5.7，Tauri 自研安装器），工作区起步仅有 `M AGENTS.md` 一处未提交改动
- 上一轮：`2026-11-05-markdown-inventory-round6-清理与订正.md`
- 状态：已执行完毕，验证全绿（读数见 §6）
- 备份分支：`backup/docs-inventory-preclean-20261126`

## 0. 用户决策（本轮口径，与既有机制不同）

1. 交付形态：直接改文件 + 输出完整清单；
2. **过时文档全部物理删除，含已在 archive 区受跟踪的 23 份**；入站引用不再是保留理由，而是删除后需清理的工作项；
3. 审查力度：聚焦根目录 7 份 + docs 活文档；活跃区按既有三判据筛查，仅处理命中判据者。

本轮因此**终止**了 round5 建立的「受跟踪归档」机制：归档区与台账整体删除，判据知识迁入 `docs/CODING_CONVENTIONS.md`「校验与提交」。

## 1. 全盘盘点清单

### 1.1 总量

被跟踪 `.md` 基线 **202** → 删除 55 → 现存 **147**。磁盘 `.md` 233（含 release/node_modules 第三方文档，不属清理范围）。排除目录：node_modules / release / dist / .cache / coverage / logs / test-results，及 AI 工具目录 `.zcode/`、`.trae/`、`.mimosa/`、`.codebuddy/`、`.workbuddy*/`、`.codegraph/`、`.qoder/`。

### 1.2 分组处置

| 分组                                                                                                 | 数量     | 处置                 | 理由                                                  |
| ---------------------------------------------------------------------------------------------------- | -------- | -------------------- | ----------------------------------------------------- |
| 根目录                                                                                               | 7        | 全部保留，核实无失效 | 项目门面/开发约定/架构真相源；版本与计数声明属实      |
| `docs/` 活文档                                                                                       | 14       | 全部保留             | 契约/技术债/排障/教程等活真相源                       |
| `docs/sync-integration/`                                                                             | 19       | 全部保留             | 设计真相源，README §3 禁止归档                        |
| `docs/2.5.0/`、`docs/i18n/`、`docs/tutorial/`                                                        | 3        | 保留                 | 历史发版快照 / SOP / 用户教程                         |
| `src/` 各级 AGENTS.md + README                                                                       | 16       | 保留                 | 模块级约定与功能说明                                  |
| `scripts/AGENTS.md`、`installer/README.md`、`plugins-samples/README.md`、`resources/nikkisync/pc/` 4 | 7        | 保留                 | 脚本约定 / 安装器 / 示例 / 上游资源                   |
| `docs/plans/archive/`                                                                                | 23       | **删除**             | 用户决策 2：已结案快照 + 台账，物理删除               |
| `docs/plans/` 活跃区                                                                                 | 114 → 82 | **删 32 / 留 82**    | 命中三判据的结案快照删除；机制/契约/测试钉/未结案必留 |

### 1.3 删除清单（55 份）

**归档区 23 份**（`docs/plans/archive/` 整体）：`2026-Q4/` 下 22 份（10-24 ~ 11-04 各修复/审查/结案快照）+ `archive/README.md` 台账。完整文件名见本轮 `.cache/round7-delete-list.txt`（构建缓存，不入仓）与 git 暂存 D 记录。

**活跃区 32 份**（`docs/plans/`）：2026-11-01-review-fix-verify-repack-2.5.6、11-05-audit-verify-update-fix-2.5.7-beta、11-07-sync-gallery-inspiration-page、11-07-应用图标全槽位生效、11-07-打包前全量审查修复、11-07-未提交改动审查修复、11-11-2.5.7-beta 审查修复与重打包、11-12-nikkisync-ops-review-fix-repack、11-13-2.5.7-beta 审查修复验证、11-13-未提交改动审查修复验证、11-14（内容扩容补章 / 启动单实例与 GPU / 审查修复全量验证 / 未提交改动审查修复 共 4 份）、11-15（双击启动三类异常收尾 / 异常分析 共 2 份）、11-17（取证存储收口补全 / 统一到安装目录 / 未发布变更深度审查 共 3 份）、11-18-未发布变更审查、11-19（nikkisync-pc-parity-console / 未发布变更审查修复全量验证 共 2 份）、11-21（CI 红灯根治 / sync-service-promote / 审查修复与 2.5.7 正式版发版 / 更新错误归类 / 未发布变更复审 / 未打包变更复审 共 6 份）、11-22-全面代码审查与质量保障、11-23（共鸣录身份门审查 / 身份门局部化审查 共 2 份）、11-24-未发布变更审查修复与 2.5.7 重打包。

### 1.4 逆向否决：明确保留的活跃计划

以下命中否决项，未删：

- **机制/判据出处**：10-17-markdown-cleanup-guard、10-27-markdown-inventory-archive、10-30-markdown-inventory-round5、11-05-markdown-inventory-round6（历史快照，头部补现状备注）；
- **唯一开放待办**：08-24-跨模块集成测试设计；
- **契约真相源**：`cloth-outfit-data-contract.md`（源码注释钉住）、10-31-cloth-outfit-phase1/phase2；
- **测试物理钉住**：11-13-nikkisync-windows-shell-full-align（`windows-shell-plan-pin.test.ts` existsSync）、11-08-拍摄参数扩展与地图定位（`legal-notices.test.ts`）、11-08-参考数据 CDN 图片合规接入（`changelog-and-checklist.test.ts`）；
- **NikkiSync 裁示出处**：各轮 `-02-实施计划`（含不做项/用户裁示）；
- **状态未结案**：11-05-precommit-audit-fix-repack（执行中）、11-13-windows-shell 审查修复（执行中）、11-13-开机自启动开关失效修复（待确认）、11-20-nikkisync-pc-upstream-design-align（待确认）等。

## 2. 删除判据（三判据 + 逆向否决）

沿用 round5/round6 判据，按本轮口径调整：

1. 对外零入站引用 → **降级为清理项**，不再单独保命（`git -c core.quotePath=false grep -l -F <basename>`；中文名在默认 quotepath 下转义、纯否定 pathspec 会让 `git grep` 静默返回空，两个坑均规避）；
2. 文内自声明结案/已交付（`执行记录|执行完毕|已交付|已结案|全绿|已实施|红→绿` 等关键词，阈值 ≥3）；
3. 结论已被 CHANGELOG / git log 覆盖，且非任何决策/机制/唯一开放待办的唯一出处。

逆向否决命中任一即保留：测试 `read()`/`existsSync()` 钉住、机制/契约/裁示唯一出处、状态为待确认/执行中/未实施。

## 3. 引用改写记录

删除后立即跑 `npm run docs:links` 抓到 **28 处死引用**（红灯证实闸门有效），逐类清理至 dead=0：

| 引用类别                      | 文件                                                                                                                                                                       | 处理                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| CHANGELOG 机制行              | `CHANGELOG.md:13/:118`                                                                                                                                                     | 改为「轮次结论以本版本节 + commit 为准，快照已清理」                                 |
| CHANGELOG 版本节 6 行         | :133/:142/:146/:147/:149/:177                                                                                                                                              | 保留历史叙述，删失效路径，改「取证见 commit」；:142 保留仍活跃的 gpu-ladder 计划引用 |
| 判据知识迁移                  | `docs/CODING_CONVENTIONS.md:175`                                                                                                                                           | 内联归档三判据 + 非 md 扫描盲区警告，消除台账死链                                    |
| 归档盘点记录                  | `2026-10-30-markdown-inventory-round5...`、`2026-11-05-markdown-inventory-round6...`                                                                                       | 头部补「现状备注」声明快照口径 + 归档区已清理；正文路径改为文字描述                  |
| 活计划互引                    | 10-26-review-fixes、10-29-nikkisync-02/-05、11-01-review-fix-round2、11-01-sync-gallery×2、11-02-align-02、11-05-precommit-audit、11-08-图标轮、11-19-同步图库上游对齐收口 | 死路径改为「轮次快照已清理，取证见 CHANGELOG/commit」                                |
| 非 md 指针（docs:links 盲区） | `resources/nikkisync/recycle-helper.cs:1`、`FullscreenViewer.topbarFix.test.tsx:19`、`SlideshowPlayer.topbarNoDrag.test.tsx:12`                                            | 注释路径改为文字说明                                                                 |

保留的 7 处 basename 提及均在机制/真相源文档的历史决策链中（如 `-02-实施计划` 引用同轮快照），docs:links 未判死，作为审计轨迹保留。

## 4. 根目录核心文档审查结论

| 文档                     | 关键核对点                                                                                                      | 结论                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| README.md                | services=18、ipc handlers=48（44 register+4 辅助）、preload api=34、版本 2.5.7/Electron 41.10/React 19.2/TS 5.9 | 全部属实，未改；`check-doc-versions` 确认版本一致                                                    |
| AGENTS.md                | 未提交 12 行新增（audit/i18n:guard/开发红线/分步闭环/全量收口）                                                 | 逐字保留，`git diff` 哈希前后一致 `9e5d24dfd073118d0d2386c5f3242281d6133068f8b5eb4b3f65c0ce003960aa` |
| ARCHITECTURE.md / .en.md | 旧名命中为 `old-name-ledger.json` 允许项                                                                        | 逐字保留，未改                                                                                       |
| DEVELOPMENT.md / .en.md  | 同上                                                                                                            | 逐字保留，未改                                                                                       |
| CHANGELOG.md             | 8 处归档/台账引用                                                                                               | 按 §3 改写                                                                                           |

登记不改项：`check-doc-versions` 的 `ipc-handler-call-sites` 基线 240 → 实测 248（+8，漂移提醒不阻断）。这是 2026-11-14 后的新增调用点，属脚本基准维护范畴；本轮不强行改基线以避免弱化闸门，留待专门对账轮确认 IPC_CONTRACT.md 是否需补录后更新。

## 5. 闸门适配

闸门代码本身未改：`scripts/check-md-links.ts` 的 `dead===0` 契约、`check-md-links.test.ts`、`old-name-ledger.json`（`expectedTotal=185`、`skipDirs` 含 `archive`）、`core-path-gate.ts` 全部保持原样。删除后靠清理引用恢复 dead=0，未弱化任何断言、未往 skipPaths 塞被删文件消红。

## 6. 验证读数（2026-11-26，全部亲自运行）

| 闸门                                      | 读数                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run docs:links`                      | ✅ dead=0（196 处提醒均为已知的本机留存区/已交代去向）                                                                           |
| `npm run verify`                          | ✅ 5/5：typecheck 151s / lint 31s / core-gate 6.7s / format 8s / test 24s，0 失败                                                |
| `npm test`                                | ✅ 553 文件 / 8980 passed / 20 skipped / 0 failed（退出时沙箱拦截一个测试调用 `reg.exe` 注册表查询，属环境安全策略，非测试失败） |
| `npx vitest run`（7 个闸门/被改测试文件） | ✅ 7 文件 / 77 用例全过                                                                                                          |
| `npm run i18n:guard`                      | ✅ 通过                                                                                                                          |
| `npm run audit`                           | ✅ Passed npm security audit                                                                                                     |
| `npm run debt:check`                      | ✅ 4 条提醒（均为其它既有债务项，非本次改动引入）                                                                                |
| `node scripts/check-doc-versions.ts`      | ✅ 版本一致；1 条计数漂移提醒（见 §4，不阻断）                                                                                   |
| `git diff AGENTS.md \| sha256sum`         | ✅ 与基线一致                                                                                                                    |
| 被跟踪 md                                 | 202 → 147（-55，与删除清单逐项吻合）                                                                                             |

## 7. 下轮接续点

- `check-doc-versions` 的 ipc-handler 计数基线 240 需专门对账（实测 248），确认 IPC_CONTRACT.md 补录后更新基线。
- 教程对新功能（同步图库/搭配码面板/自定义照片目录）的覆盖滞后沿自 round6 遗留，需截图与实机走查，宜单独立项。
- round5/round6 历史快照中的旧路径已加现状备注，后续轮次以本文件为查表起点。
