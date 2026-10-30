# `docs/plans/archive/` 归档账本

> 这里是**已结案轮次快照的受跟踪归档区**。与本机留存区 `docs/archive/`（被 `.gitignore:188` 的
> `/docs/archive/` 排除、干净克隆里不可解析）不同，本目录**在版本控制内**：文件仍可被引用、仍进
> `git log`、仍随仓库分发。建立于 2026-10-30，判据与取舍出处见
> `docs/plans/2026-10-30-markdown-inventory-round5-tracked-archive-and-corrections.md`。

## 1. 移入判据（三条须同时成立，缺一即留在 `docs/plans/`）

1. **对外零入站引用**——`docs/plans/` 之外没有任何被跟踪文件引用它。计数必须用
   `git -c core.quotePath=false grep -l -F <basename>`：中文文件名在默认 `core.quotepath` 下会被输出成
   `"docs/plans/\350…"` 形态，用 `grep -v '^docs/plans/'` 滤不掉，读数虚高；而**纯否定 pathspec**
   （`-- ':!docs/plans'`）会让 `git grep` 静默返回空，读数全零。本轮两种误判都实际踩到。
2. **文内已自 declared 结案/已交付**——执行记录已回填。注意上一轮记下的反判据：
   **「未 amend ≠ 未回填」**，不得把「创建后没被 amend 过」当判据。
3. **实质结论已被 CHANGELOG 或 git log 覆盖**，且它不是任何决策/机制的**唯一出处**。
   这一条优先于第 1 条：`docs/plans/2026-10-17-markdown-cleanup-guard-and-corrections.md`、
   `docs/plans/2026-10-27-markdown-inventory-archive-and-corrections.md` 与
   `docs/plans/2026-08-24-跨模块集成测试设计.md` 都满足第 1 条但**不移**——分别是本类机制出处、
   归档判据出处、唯一开放待办。NikkiSync 系列的「不做项/用户裁示」落在各轮的
   `-02-实施计划`，故 02 一律保留，01/03/04/05 可移。

## 2. 归档清单

| 归档文件（相对本目录）                                            | 结案 commit                      | 实质结论落点                                                                                  |
| ----------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `2026-Q4/2026-10-24-fix-empty-recyclebin-system-trash.md`         | `4e2a8d6`（2026-10-27 末次回填） | 回收站清空与系统回收站语义修复，已入 `CHANGELOG.md` 对应版本节                                |
| `2026-Q4/2026-10-25-nikkisync-upstream-sync-01-影响评估.md`       | `9a8a1fb`（2026-10-25）          | 同轮决策在 `../2026-10-25-nikkisync-upstream-sync-02-实施计划.md`（保留，含「不做项」与裁示） |
| `2026-Q4/2026-10-25-nikkisync-upstream-sync-03-兼容层执行记录.md` | `6402cb5`（2026-10-25）          | 阶段收口读数已结转至本目录 `-05-结案报告`                                                     |
| `2026-Q4/2026-10-25-nikkisync-upstream-sync-04-能力层执行记录.md` | `9a8a1fb`（2026-10-25）          | 同上；验收矩阵摘要在 `-02-实施计划`                                                           |
| `2026-Q4/2026-10-25-nikkisync-upstream-sync-05-结案报告.md`       | `c89ed5d`（2026-10-26）          | 结案读数复述进 `CHANGELOG.md` 的 2.5.5/2.5.6 节                                               |
| `2026-Q4/2026-10-27-fix-test-suite-under-node26.md`               | `e24648f`（2026-10-27）          | Node 26 适配属环境性一次性工作，终验读数见 `docs/perf-regression.md` 与 git log               |
| `2026-Q4/2026-10-29-nikkisync-upstream-sync-01-影响评估.md`       | `8aea3fd`（2026-10-29）          | 同轮决策在 `../2026-10-29-nikkisync-upstream-sync-02-实施计划.md`（保留）                     |

## 3. 使用约定

1. **归档件按当时快照读**。文中的文件数、覆盖率、通道数、状态字段一律是写入时刻的读数，
   不当现状；要现状就去看代码与活文档。这与 `docs/2.5.0/` 那类历史发版说明同一口径。
2. **移入用单步 `git mv`**，不得再沿用上四轮的 `git mv` + `git rm --cached` 两步法——那会让文件
   从版本历史消失，且把入站引用逼成 `scripts/check-md-links.ts` 的 `dead`（契约断言 `dead === 0`，
   见 `scripts/__tests__/check-md-links.test.ts:232`）。留在本目录的引用改写规则（按引用者所在层算）：
   活文档（`docs/plans/` 顶层）引归档件用 `archive/2026-Q4/<name>.md`；归档件互引直接写裸名（同目录）；
   **归档件回头引留存的活计划必须上跳两级**，写 `../../<name>.md`——归档件在
   `docs/plans/archive/2026-Q4/`，写成 `../<name>.md` 会落到本目录而判死（本轮实际犯过一次，
   由 `npm run docs:links` 抓出 2 处）。本文件自己位于 `docs/plans/archive/`，一层 `../` 才对。
3. **目录段落必须恰为 `archive`**。`scripts/__tests__/old-name-ledger.json:43` 的 `skipDirs` 含 `archive`
   且按路径段匹配（`old-name-ledger.test.ts` 的 `isSkipped`），所以归档件自动豁免旧名终扫；
   改名成 `retired/`、`_archive/` 之类会让这些历史文档重新落入扫描域、当场把台账判红。
4. **本目录不是 `docs/sync-integration/` 的落点**。后者是已交付代码的设计真相源，其
   `README.md` §3 明文禁止移入归档；归档判定只适用于「一轮会话一份执行记录」这种轮次快照。
5. **移完要同步更新本表**。本表是下一轮的唯一查表依据；漏记会让下一轮重复判断、并把
   「零入站引用」这一条判据建立在过期数据上。
