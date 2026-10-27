# 全仓 Markdown 盘点、归档清理与失效内容订正（2026-10-17）

- 日期：2026-10-17
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `5c80a95`
- 状态：已执行（本文档随本轮最后一个提交入库）
- 上一轮同类工作：`docs/plans/2026-10-10-markdown-inventory-and-corrections.md`（其 §8 登记的
  两条自动化遗留风险，本轮已补上）

## 1. 结论摘要

1. **本轮实际移出仓库 30 个 markdown**：`docs/plans/` 里 29 个已回填执行记录的一次性轮次快照，
   加 `docs/archive/CHANGELOG-2.5.3.md`（已归档不入仓；原名 CHANGELOG-2.5.3.md，放在根 `docs/`
   下时与根 `CHANGELOG.md` §2.5.3 重复、零入站引用）。它们经
   `git mv` + `git rm --cached` 落到被 `.gitignore:184` 排除的 `docs/archive/plans/`，
   **本机副本保留、仓库中消失**。被跟踪 `.md` 从 87 降到 59（移出 30、新增 2：`docs/sync-integration/README.md` 与本文档）。
2. **用户请求里的四条前提与仓库现状不符**，已按现状执行：根目录不存在 `SKILL.md` / `使用指南.md`
   （用户手册实为 `docs/tutorial/用户使用教程.md`）；不存在 `_plans/` / `.review/` 目录；
   工作区**没有任何未跟踪的 `.md`**，因此「AI 工具目录不在考虑范围」与「只审被跟踪文件」两个口径等价。
3. **真正的问题仍是内容失真**，且新增了一类：模块指引之间对同一事实互相矛盾（`src/main/sync/`
   与 `src/main/nikkisync/` 就「谁在提供 LAN 服务」各执一词）。根文档与 8 份模块指引的
   计数、表结构、worker 数量、测试规模全部按命令实测刷新，中英双胞胎同步改写。
4. **补齐了自动化机制**：新增 `scripts/check-md-links.ts` + 单测，把「被跟踪文档不得留死引用」
   钉进 `npm test`/CI。它在编写过程中就抓出 5 条真实死链（相对链接少写一层 `../`），
   并在我提交前抓出了自己新写文档里的 2 条。

## 2. 本轮依据的实测真值（全部由命令取得，非推断）

| 项                                               | 真值                                                                                                         | 取得方式                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 应用版本 / Node 引擎                             | `2.5.5-beta` / `>=22.12.0`（`.node-version` = 22）                                                           | `package.json`、直接读取                                    |
| Electron / Vite / Vitest / React / TS / Tailwind | `41.10.6` / `^6.4.4` / `^5.0.3` / `^19.2.7` / `^5.9.3` / `^3.4.19`                                           | `package.json` 依赖表                                       |
| worker 入口数                                    | **6**（scanner / media / thumbnail / video / database / decryption）                                         | `electron.vite.config.ts:87-92`                             |
| preload 命名空间                                 | `api/*.ts` **33** 个；`electronAPI` **34** 个键                                                              | `git ls-files`；`preload.test.ts:119` 用例标题逐字核对      |
| IPC handler 规模                                 | **47** 个非测试域文件；**43** 个 `registerXxxHandlers`（4 个为 `_` 前缀辅助与 `set-dir-handler` 工厂）       | `git ls-files` + `ipc-setup.ts` 计数                        |
| 数据库表                                         | `CREATE TABLE IF NOT EXISTS` 唯一表名 **25** 张；其中共鸣表 **6** 张                                         | `grep -oiE` 全 `src/main/database`                          |
| 共鸣通道                                         | `resonance:*` 唯一 **10** 个（含 `setWishlist`）                                                             | `resonance-handler.ts`                                      |
| `sync:*` / `nikkisync:*`                         | 6 / 9 个通道                                                                                                 | 两个 handler 文件                                           |
| 测试规模                                         | **408** 个文件 / **6312** 通过 + **2** skip（本轮全量实跑；本轮新增 1 个测试文件 24 例，故由 407/6288 变来） | `npm test` 实跑                                             |
| 服务 / 页面 / store                              | `services` **13** 个、`*Page.tsx` **11** 个、Zustand store **7** 个、`utils` 源文件 **31** 个                | `git ls-files`                                              |
| `resonance_banner_wishlist` 出处                 | **2026-10-10 提交 `2545252`，当时 `package.json` 版本 2.5.3**                                                | `git log --all -S` + `git show <c>:package.json`            |
| `asset_edits` 出处                               | **2026-10-14 提交 `0790252`，当时版本 2.5.5**                                                                | 同上                                                        |
| 被忽略的本机脚本                                 | `scripts/` 下 **9 个 `.ps1`** 全部不入仓                                                                     | `git check-ignore -v` 逐条命中 `.gitignore:147/148/149/185` |
| `git tag`                                        | **0 个**                                                                                                     | `git tag \| wc -l`                                          |

## 3. 归档机制的关键结论（决定用哪条命令）

裸 `git mv <tracked> docs/archive/<name>` 会成功，但目标**继续留在索引里**（状态 `R`，
`git check-ignore` 返回 1）——gitignore 无法让已跟踪路径脱管。真正有效的两步是：

```bash
git mv docs/plans/X.md docs/archive/plans/X.md
git rm --cached docs/archive/plans/X.md
```

结果：暂存区为 `D docs/plans/X.md`，磁盘副本留在 `docs/archive/plans/X.md`，
`git check-ignore` 返回 0。全新克隆中该文件不存在，本机可查。已在首个文件上验证后才批量执行；
31 个文件名与 `docs/archive/` 既有 60 个文件零冲突（`comm` 比对）。

## 4. 盘点判定

| 分组                                                                                        | 判定                                                                         | 数量   |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 根目录 7 份（`AGENTS` / `README` / `CHANGELOG` / `ARCHITECTURE(.en)` / `DEVELOPMENT(.en)`） | 保留 + 订正                                                                  | 7      |
| `docs/` 活引用（契约、规范、SOP、故障排查、教程、索引）                                     | 保留 + 订正                                                                  | 15     |
| `docs/sync-integration/` 16 份阶段计划与审计报告                                            | **保留**（已交付代码的设计真相源，非轮次快照）；本轮新增 `README.md` 索引    | 16 + 1 |
| 模块级 `AGENTS.md` / `README.md`（`src/**` 13 + `scripts` 1 + 样例 1）                      | 保留 + 订正（8 份有实质失真）                                                | 15     |
| `docs/plans/2026-08-24-跨模块集成测试设计.md`                                               | 保留（**仍未实施**：无 `test:integration` 脚本、无 `*.integration.test.ts`） | 1      |
| `docs/plans/2026-10-10-markdown-inventory-and-corrections.md`                               | 保留（前轮真相源，被 4 份根文档引用）                                        | 1      |
| `docs/plans/` 其余 29 份 + `docs/CHANGELOG-2.5.3.md`                                        | 移入 `docs/archive/plans/`（不入仓）                                         | 30     |

保留 `docs/plans/` 最少两份的理由：一份是真实待办，一份是被根文档引用的历史取证；
其余 29 份的「执行记录」均已回填且都有落地提交，留在仓库里只会与现状争夺读者注意力。

> **2026-10-27 复核（针对上表第 67 行的判据）**：前半句仍成立——`package.json` 确无 `test:integration` 脚本；
> 后半句「无 `*.integration.test.ts`」**已被证伪**：`git ls-files '*.integration.test.ts' | wc -l` 实为 **5**
> （最早由 `015150b` 于 2026-10-11 sync phase 4 带入），只是那 5 个都不是 08-24 点名的 7 个拟新增套件。
> 结论不变（08-24 仍是开放待办，本轮保留），但**判据必须按套件名逐个核，不能按后缀 glob 判**——
> 这正是「沿用上一轮结论而不重测」的代价，本轮把该口径写进了 08-24 自身的横幅。原表文字按轮次记录保留不改写。

## 5. 执行批次

| 批次 | 内容                                                                                                                                     | 验证                                                             | 结果 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- |
| B1   | 29 份计划 + `CHANGELOG-2.5.3` 归档；改写保留文档中 20 处引用                                                                             | `git status` 仅 30 条暂存删除；`comm` 无重名                     | ✓    |
| B2   | 修 5 条少写一层 `../` 的死链；修 `PLUGIN_SYSTEM_PLAN` / `07-bidirectional` / `GPT_HANDOFF` 三处失真引用                                  | 逐条 `git log` 取证「从未入仓 / 仅存 stash@{0}」                 | ✓    |
| B3   | 新增 `scripts/check-md-links.ts` + 单测 + `npm run docs:links`                                                                           | `tsc -p tsconfig.scripts.json`、24 例通过、真实仓库契约 0 死引用 | ✓    |
| B4   | 根文档订正（中英同步）：worker / 命名空间 / handler / 测试规模 / §9.2 表 15→25 / 共鸣 5→6 与通道 9→10 / 补同步面 / 删 `docs/screenshots` | 每处替换断言命中 1 次；prettier 后核对「非表格行改动 = 0」       | ✓    |
| B5   | 8 份模块指引订正 + `sync-integration/README.md` 索引 + 技术债索引对齐                                                                    | `verify-format-scope` 36 例、`debt:check` 通过                   | ✓    |
| B6   | 全量闸门 + 测试读数回改（407/6288 → 408/6312，因本轮自己新增了测试）                                                                     | 见 §7                                                            | ✓    |

提交三个逻辑单元：`ebbe7bf`（归档 + 守护脚本）、`be99601`（根文档）、`abcd230`（模块指引与索引）。

## 6. 订正要点（选取易被再次写错的）

- **移植面服务器不是「规划中」**：`src/main/sync/server/`（8 个非测试文件）已交付并由
  `lifecycle.ts:340` 的 `initSyncServer()` 装配，但 `sync-server-setup.ts:63`
  `PORTED_SYNC_AUTOSTART_ENABLED = false` 使其**默认静默**；设置页「同步服务」节由上游
  `LocalSyncServer` 接管。`sync/AGENTS.md` 原先写「阶段4（规划中）」「本目录不启动服务器」，
  与 `nikkisync/AGENTS.md` 硬约束 3 互相矛盾，现改为两轨道并存表。
- **`SyncReadRepository` 不是纯只读**：`resolveSourceSha256()` 有一处同步
  `UPDATE media_files SET sha256 = ? WHERE id = ?`（不经 worker bridge），是 `database/AGENTS.md`
  §1.1 读写分离的一处违例。文档已如实登记，未夸大为「唯一违例」（同表 `ResonanceRepository` 亦为直写）。
- **`export-route.ts` 不存在**：只有 `export-route.test.ts`，其经 `api-router.ts` 验证导出端点，
  实现在 `jpeg-export.ts`。
- **`protocol-extension.ts` 从未提交**：与 `07-bidirectional-sync-plan.md` 一起只存于本机
  `stash@{0}`（`feature/sync-integration-07-bidirectional-sync`，`phase7-wip-parked`）。
- **`HIGH_MAX_WIDTH/HEIGHT = 512` 属于 thumbnail**，不属于 media-worker；后者只有 320/64 与
  语义无关的 `SELF_THUMBNAIL_MAX_EDGE_PX`。
- **`scripts/AGENTS.md` 原先把 9 个 `.ps1` 计入代码文件总数**，而那些文件全部被 gitignore；
  「测试覆盖约 8%」也没有读数来源（`scripts/**` 不在 `coverage.include` 内），改为可实测的配对口径。
- `docs/sync-integration/` 内部自相矛盾保留原样并就地注明：`04-http-server-plan.md` 写「执行中」，
  而下游 `05-ui-scanner-integration-plan.md` 记「前置：阶段 4 已验收（commit 015150b）」。

## 7. 验证

| 命令                                                                     | 结果                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `npm run typecheck`（`tsc -b` + `tsc -p tsconfig.scripts.json`）         | ✓ 无输出                                                                                              |
| `npm run lint`                                                           | ✓ 0 error / 11 warning，全部是 DEBT-030 登记的 `common/*.test.tsx` BOM，本轮未触碰                    |
| `npm run i18n:guard`                                                     | ✓ 白名单只减不增、清零必移除、key 已同步                                                              |
| `npm run debt:check`                                                     | ✓ 变更文件未命中技术债条目                                                                            |
| `npm run docs:links`                                                     | ✓ 0 死引用（另有 123 处提醒：`docs/archive/**` 等本机留存区引用与同行已交代去向的历史路径）           |
| `npx vitest run`（`check-md-links` / `verify-format-scope` / `preload`） | ✓ 24 + 36 + 19 例全通过                                                                               |
| `npm test` 全量                                                          | ✓ **408 文件 / 6312 通过 + 2 skip**，62.2s，无 flake（前轮的 `generator.limiter.test.ts` 本轮未复现） |
| BOM 扫描（本轮全部改动 `.md`/`.ts`）                                     | ✓ 首 3 字节逐个核对，零 `efbbbf`                                                                      |
| prettier 语义安全核查                                                    | ✓ 两轮 `--write` 造成的 178 处差异全为表格列宽/分隔行划线，非表格行改动 0                             |

## 8. 遗留风险（本轮不处置）

1. **应用内「关于页」仍显示 Electron 28 / React 18 / TS 5.3**（`about-sections.tsx:65`、`:271-331`），
   与刚刷新的根文档不符。已登记为 DEBT-035（open），属代码改动而非文档改动，本轮不动。
2. 根文档的 408/6312 读数**仍会被下一次新增测试作废**。`check-doc-versions.ts` 只看 README 的
   Electron 版本，没有任何工具守护测试规模类数字——本轮的链接守护不覆盖数值一致性。
3. `docs/archive/**` 有 74 份计划，`docs/plans/` 只剩 2 份。归档判定依赖「执行记录已回填 +
   有落地提交」的人工判断，没有自动化；新会话若继续产出 plan，同一路径会在几轮内再次堵塞。
   根治方式是让计划文档生成时即写入 `docs/archive/plans/`（不入仓），仅在需要长期留存时提升。
4. `docs/sync-integration/` 的 `04` 与 `05` 状态自相矛盾只做了注明，未改写任何一方——
   阶段计划保留当时原文是有意为之，但这意味着本目录的状态字段不能当作现状读取。
5. 落地文件与规划文件名称分叉：实际是 `src/main/scanner/scan-journal.ts` 与
   `src/renderer/pages/sync-gallery/`，而 `03/04/05-*.md` 里规划的是 sync/scan-journal.ts 与
   settings/sync-sections.tsx（这两个规划名不存在，从未以该名落地）。已由「路径作用域」声明
   降级为提醒，属于「设计名与落地名分叉」而非死链，未逐一改写。

6. **守护脚本的「同行标注」判定按物理行生效**：`annotated-gone` 依赖同一行内出现
   已归档 / 不入仓 / 不存在 等标记词，而 CJK 长句会被 prettier 按 `printWidth` 折行，
   把路径与标记词分到两行就会误报死引用（本轮写这份文档时自己撞到两次）。
   规避办法是把标记词紧跟在路径之后、同一物理行内。若要根治，需把上下文判定从「单行」
   改为「同一段落」，代价是允许远处措辞掩盖真死链——暂未采纳。
