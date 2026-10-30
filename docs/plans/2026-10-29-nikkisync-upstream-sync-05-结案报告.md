---
title: NikkiSync 上游同步 · 05 结案报告（第二轮，b422193 → b397e0e）
date: 2026-10-29
series: 01 影响评估 / 02 实施计划 / 03 执行记录 / 05 结案报告
upstream-anchor: b397e0eb6ca1b4748f13a72f13bb1702a549410e = tag v1.0.27-public-beta.1
baseline: b4221933be9714fde0c260b1f19bdaa6d1337fd3 = tag v1.0.23-public-beta.1
---

# NikkiSync 上游同步 · 05 结案报告

## 1. 终局判定

**本轮目标达成**：阶段一遗留的唯一红灯已闭合，且闭合方式是「不再会因上游发版而复红」的派生断言；装载链闸门盲区按实测事实（3 个模块，非评估原记的 1 个）补齐并被两处守卫钉住；上游新增的本机绝对路径外泄面在本仓渲染层一侧关闭并登记进契约。

| 判据                      | 结果                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 域测试绿灯基线            | ✅ `npx vitest run src/main/nikkisync` → `16 files / 276 tests passed`、**0 skipped**（阶段一为 1 failed / 275 passed）                   |
| 全量回归                  | ✅ `npm test` → `453 files / 7077 passed \| 12 skipped`                                                                                   |
| CI 闸门族（本机可代跑者） | ✅ `typecheck` / `typecheck:e2e` / `lint` / `i18n:guard` / `test:coverage`（exit 0，阈值达标：All files `70.02 / 61.42 / 62.78 / 71.64`） |
| 装载链体检                | ✅ `verify:nikkisync` 13 行、`OK (blocking failures: 0)`、exit 0                                                                          |
| 上游零改动铁律            | ✅ `git -C ../NikkiSync status --porcelain \| wc -l` = **0**（执行前 / 上游自测后各复核一次）                                             |
| 提交面                    | ✅ 8 次提交（含 N5 本次），Conventional Commits 全程过 commitlint；`core-path-gate` 四次 `⊘ 跳过`（本轮确实未触碰受保护 glob）            |
| 不达成项                  | `test:ci-linux` 装置红 32 files / 59 tests —— **本轮未引入**，归因见 `03-执行记录` §6，登记为既有现象                                     |

## 2. 新增风险 R12：上游在采纳锚点自带一条确定性红（Q-e 取证结果）

按裁决 Q-e 首次为本轮补跑上游自测（上一轮该项为 `not-run`，即评估 R11）。**结论：上游 `npm test` 退出码 1，1 条失败。**

| 维度         | 实测事实                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失败用例     | `apps/pc-companion/test/extra-scan-directories.test.ts:61` —「default ScreenShot supplements collages without duplicating native photos and updates on native changes」                                                                        |
| 错误形态     | `ScanIndexFailure: Photo index operation failed`，`[cause] Error: UNIQUE constraint failed: resources.path_key`（`packages/database/dist/src/asset-repository.js:141` ← `ScanReconciler.reconcile` ← `ScannerService.runScan`）                |
| 是否串扰     | **不是**。上游 `npm test` 用 `--test-isolation=none`（跨文件共享进程），故单文件隔离复跑：`node --test apps/pc-companion/dist/test/extra-scan-directories.test.js` → `tests 17 / pass 16 / fail 1`，同样失败 ⇒ 确定性缺陷                      |
| 是否本轮引入 | **是**（强证据）。该测试文件在 `b422193..b397e0e` 区间 `+24` 行；`git log -S exportsByImage` 与 `-S path_key` 都命中本轮两个提交（`fc39fd2` 的「ScreenShot 精确字节抑制」、`b397e0e`）；失败语义恰是该用例要防的「重复入库」                   |
| 对本仓的影响 | 本仓装载面只读消费上游 `ScannerService`，**不改上游源码**（`src/main/nikkisync/AGENTS.md` 硬约束 3 明写「不得为规避它改 NikkiSync 源码」）⇒ 无法在本仓修复。本仓链接态套件（含真实扫描入库与本轮新增的 N4 守卫）全绿，说明本仓夹具未触发该形态 |
| 产品可达性   | `ScreenShot` 正是《无限暖暖》存截图的目录。用户库里「拼贴 + 原生照同目录」形态**可能**触发同类 `ScanIndexFailure`，表现为「该目录扫描失败」而非静默错标——失败是显式的，不会污染数据（唯一约束拦住写入）                                        |
| 处置         | 登记 **DEBT-041**（`category: supply-chain`）；下一轮同步的第一步就是复跑上游 `npm test`，若已修则销账，若仍红则需产品裁示：继续采纳（扫描失败诊断已能向用户透出）或退锚到 `fc39fd2`/`b422193`                                                 |

**为什么本轮没有因它退锚**：R12 位于上游自有装配/测试面，本仓四个节点（N1 测试判据 / N2 文档 / N3 闸门 / N4 隐私裁剪）均与 `ScreenShot` 抑制逻辑无耦合；且退锚会使本轮已交付的 N3/N4 前提消失（3 个入链模块与两键泄漏都由 `b397e0e` 引入），等于把一轮工作作废。这是可逆决定：锚点在文档里以 SHA+tag 双记，退锚只需上游 `merge --ff-only` 之前的状态重放。

## 3. 风险登记册销账（对齐评估 §8）

| #         | 风险                                                      | 本轮处置                                                                                                          | 状态                                                             |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| R1        | `npm install` 剪链                                        | 全程未 install；收尾复核 `link:nikkisync:check` = `check OK`、`verify:nikkisync` blocking 0                       | 已守                                                             |
| R2        | 上游可达性不稳                                            | 本轮无需再 fetch（锚点已在位），未触发                                                                            | 不适用                                                           |
| R3        | 「测试钉上游时点数据」反复打红                            | N1 改为从产物派生 + 降序不变式 ⇒ 该类断言不再随发版复红                                                           | **闭环**                                                         |
| R4        | 入链产物不在闸门                                          | N3 新增 `CHAIN_REQUIRED_ARTIFACTS`（3 项）+ 开发态阻断 + 打包态同表断言                                           | **闭环（覆盖面收窄为命名清单，转 DEBT-040）**                    |
| R5        | vendored 契约与上游形状漂移（interface 层运行时不可捕获） | 本轮裁决「不过滤的键也不登记」：`sourcePath`/`sourceFolder` 被裁剪故不入 vendored 类型；其余 7 个新可选键仍未登记 | **未闭环**，继续挂账（上一轮 R4→本轮 R5 同一件事）               |
| R6        | `listSuitSearchResources()` 孤儿资源语义收窄              | 无变化（本仓链接态与桩测试全绿），不预设问题                                                                      | 观察                                                             |
| R7        | `sourcePath`/`sourceFolder` 进入 IPC 载荷                 | N4 委托层裁剪 + 契约 §8.1 登记 + 视图模型注释订正                                                                 | **本仓渲染层面闭环**；LAN 侧仍下发（不改上游），已在契约写明边界 |
| R8        | 新能力接入触碰核心路径闸门                                | 本轮未接入新能力；实测 4 次提交 `core-path-gate` 均跳过                                                           | 不适用                                                           |
| R9        | 批量删除破坏性路径无自动化真机证据                        | **not-run**，见 §4                                                                                                | 未闭环                                                           |
| R10       | 上游新增出站抓取 / 账号作用域                             | 本仓仍从不 arm `GameVersionUpdateService`（只消费日历表纯函数）⇒ 零出站                                           | 已守                                                             |
| R11       | 上游自测未跑                                              | 本轮补跑 ⇒ 转为 **R12（上游 1 条确定性红）**                                                                      | **取证完成**，风险升级登记                                       |
| R12（新） | 上游锚点自带红 + 产品可达性                               | 见 §2，DEBT-041                                                                                                   | open                                                             |

## 4. not-run 清单（显式记账，不当作已通过）

| 项                                           | 状态                                                                                             | 原因                                                                                                                                                    | 复现/补跑命令                                                                                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dist:win` + `verify:dist`（M2）     | not-run                                                                                          | 裁决 Q-a 本轮不重打包；且新块未建链时 `skip`，打包面证据须由下一次既有发布计划覆盖                                                                      | `npm run dist:win`（会真打包，需授权）                                                                                                                                                                                                                      |
| 闸门负向端到端（M3）                         | **部分**：判定核由注入式单测覆盖（修复前 7 红 / 修复后全绿）；「真实缺件时闸门先红」未端到端验证 | 需上游检出的**副本**（禁碰 `../NikkiSync`，porcelain 必须为 0）                                                                                         | 复制检出于 `D:/tmp/NikkiSync-copy` 并删 `apps/pc-companion/dist/src/server/MediaFingerprint.js`，然后 `NIKKISYNC_ROOT=<副本> npm run link:nikkisync && npm run verify:nikkisync` → 期望 exit 1 且点名该文件；验后须重跑 `npm run link:nikkisync` 恢复四条链 |
| K8 真机破坏性删除链（M6，R9）                | not-run                                                                                          | 需已配对手机（删除意图来自手机端 `POST /v1/organizer/sync`），且会真删用户文件；本仓 K8 套件刻意不进 `executing` 态。本轮不做破坏性试验，也不伪造该证据 | 人工：可丢弃副本库 + 回收站备份，按 02 计划 §10-M6 步骤                                                                                                                                                                                                     |
| LAN 隐私边界双读数（M1）                     | not-run                                                                                          | 需起 App + 真配对设备                                                                                                                                   | 人工：02 计划 §10-M1（期望：上游 `GET /v1/assets` **含**两键，`window.electronAPI.nikkisync.getAssets()` **不含**）                                                                                                                                         |
| 渲染层路径需求回归（M4）/ 版本翻牌观察（M5） | not-run                                                                                          | 需 GUI 操作；M5 还需时刻 ≥ `2026-10-30T07:00Z`（`2.11` 生效点，晚于本报告）                                                                             | 人工：02 计划 §10-M4 / M5                                                                                                                                                                                                                                   |
| `npm run test:ci-linux`                      | **run，且红**（非 not-run）                                                                      | 既有装置现象（sharp `linuxnull-x64` + 装置置根不可写 ⇒ `unable to open database file`），本轮未引入；归因证据见 03 §6                                   | `npm run test:ci-linux`                                                                                                                                                                                                                                     |

## 5. 已知失真与刻意不清理项

本轮只解决上游差异引出的问题，以下三处**已核实为失真但不在本轮面内**，留待各自归口轮次：

1. `scripts/pre-dist-check.ts:905` 注释「不跑打包前 11 项」——项数与实际不符（与本轮 N3 无关，N3 改的是 `--verify-asar` 分支内的产物断言）。
2. `src/main/nikkisync/runtime-facade.ts:450` 引用测试文件 `library-paging.linked.test.ts`，该文件不存在（实际承担者是 `runtime-facade.linked.test.ts` / `sync-server.linked.test.ts`）。
3. `src/main/nikkisync/AGENTS.md` 文件职责表列 23 项，目录实有 31 个文件，7 个未入表（`resource-allowlist.ts` 及其套件等）。

另记一处本轮改动**引发的表格重排**：`src/main/nikkisync/AGENTS.md` 因两行职责文本变长，prettier 重排了整表列宽（`--ignore-all-space` 后实际内容改动仅 3 行），已如实写入提交说明。

## 6. 下一轮同步的起手式（避免重复本轮取证成本）

1. 基线双向交叉认定：本轮结案锚点 = `b397e0e`（tag `v1.0.27-public-beta.1`），与检出 HEAD 逐字比对后再决定前进方式；零分叉才 `merge --ff-only`。
2. **先跑上游 `npm test`**（本轮 R12 的销账入口），再跑本仓合并口径，两者读数都写入新评估的 §5。
3. 装载链闭包：若授权 DEBT-040 的闭包化改造，N3 那张人工表可退役为「闭包 ∪ 深入口」，届时须同时处理未链接态的 skip 语义（勿把环境缺失记成逻辑失败）。
4. 隐私面若产品要接入 `sourcePath`（例如导出溯源），顺序应是：先在 `src/shared/sync/protocol.ts` 与 `docs/IPC_CONTRACT.md` 登记，再撤 `stripAssetPathFields` 的对应通道，**不要**反过来留下「载荷有键、声明面无键」的第三种状态。
5. `2.11` 已于 2026-10-30T07:00Z 生效（晚于本报告）：图库版本推断会对既有照片由 `2.10` 变为 `2.11`，落在 `uncertainFrom..effectiveAt` 区间的拍摄返回 unknown ⇒ 属上游合法数据演进，勿当缺陷修。

## 7. 交付物索引

| 文件                                                                             | 内容                                                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [01 影响评估](archive/2026-Q4/2026-10-29-nikkisync-upstream-sync-01-影响评估.md) | 阶段一只读盘点 + `§10.1` 裁决结论与对本文 §4-A/§10-Q3 的事实订正                         |
| [02 实施计划](2026-10-29-nikkisync-upstream-sync-02-实施计划.md)                 | 五节点三要素、验证矩阵、回滚、人工清单、待确认清单                                       |
| [03 执行记录](2026-10-29-nikkisync-upstream-sync-03-执行记录.md)                 | 逐节点命令与实测读数、红→绿对照、提交边界偏离的说明                                      |
| 本文件                                                                           | 终局判定、R12、风险销账、not-run、下轮起手式                                             |
| `docs/debt-registry.json` + `docs/技术债清单.md` §17                             | **DEBT-040**（装载链闸门是命名清单非闭包）、**DEBT-041**（上游锚点自带红，supply-chain） |
