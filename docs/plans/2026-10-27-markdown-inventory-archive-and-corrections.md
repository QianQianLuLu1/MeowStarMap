# 全仓 Markdown 盘点、归档清理与失效内容订正（2026-10-27）

- 日期：2026-10-27
- 分支 / 基线 HEAD：`main` @ `fb08813`（开工时 `git status --porcelain` 为空）
- 状态：执行中（本文档随本轮第一个提交入库，§7 闸门读数在收尾批回写）
- 上一轮同类工作：`docs/plans/2026-10-17-markdown-cleanup-guard-and-corrections.md`（脱管语义见其 §3，遗留风险见其 §8——
  本轮已复核其 §8 全部五条，逐条结论记在本文 §8）

## 1. 结论摘要

1. **本轮实际移出仓库 7 个 markdown**：`docs/plans/` 里执行记录已回填、且不被任何活文档或源码注释引用的轮次快照，
   经 `git mv` + `git rm --cached` 两步落到被 `.gitignore:186 /docs/archive/` 排除的 `docs/archive/plans/`，
   本机副本保留、仓库中消失。被跟踪 `.md` 由 **92 降到 85**，`docs/plans/` 由 **37 降到 30**。
2. **用户请求里的四条前提再次与仓库现状不符**，与 2026-10-10、2026-10-17 两轮一字不差：不存在 `_plans/`、`.review/`、
   根 `SKILL.md`、`使用指南.md`（用户手册实为 `docs/tutorial/用户使用教程.md`）；`.zcode/plans/` 与 `.trae/documents/`
   磁盘存在但被 `.gitignore:156` / `:152` 排除，天然不在审计范围。工作区没有任何未跟踪 `.md`，
   故「AI 工具目录不计入」与「只审被跟踪文件」两个口径本轮等价。
3. **92 份里没有一份建议删除**：`docs/` 顶层与其子目录的每一份都有 ≥1 入站引用，模块指引全部被根 `AGENTS.md` 导航表点名。
   真正的问题是三件事——`docs/plans/` 每轮膨胀（上轮清完剩 2 份，本轮 37 份）、同一事实的中英双胞胎互相矛盾
   （测试规模在三处写了三个值）、以及一类任何闸门都没看见的失真（下一-）。
4. **新发现一类从未被守护的失真**：源码注释里指向已归档计划的 `docs/plans/*.md` 指针死了 **10 个**，分布在 14 个 `.ts/.tsx`。
   `scripts/check-md-links.ts` 只扫 `git ls-files -z '*.md'`，所以 `src/**` 与 `scripts/**` 的注释从来不在覆盖面上。
   这十个目标文件全部仍在本机 `docs/archive/plans/`，即**前几轮移档时只搬了文件、没改注释**——本仓移档流程的一处系统性漏项。
5. **订正分两批共 15 处文档侧 + 10 处源码注释侧**，其中双语四件（`ARCHITECTURE(.en)` / `DEVELOPMENT(.en)`）
   补出一处**违反根 `AGENTS.md` 硬规则**的反向陈述（`src/main/tsconfig.json` 的 `outDir` 仍写 `dist/main`，实为 `.cache/tsmain`）。

## 2. 本轮依据的实测真值（全部由命令取得，禁止沿用上一轮读数）

| 项                                                          | 真值                                                                                                                                                                                  | 取得方式                                                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 应用版本 / Node 引擎                                        | `2.5.6-beta` / `>=22.12.0`（`.node-version` = 22）                                                                                                                                    | `package.json`                                                                                        |
| Electron / Vite / Vitest / React / TS / Tailwind            | `41.10.6` / `^6.4.4` / `^5.0.3` / `^19.2.7` / `^5.9.3` / `^3.4.19`                                                                                                                    | `package.json` 依赖表                                                                                 |
| main lib 入口                                               | **9**（`index` + scanner/media/thumbnail/video/database/decryption 六个 utilityProcess worker + `nikkisync-probe` + `nikkisync-runtime`）                                             | `electron.vite.config.ts:84-97`                                                                       |
| `src/main/tsconfig.json` 的 `outDir`                        | **`../../.cache/tsmain`**（不是 `dist/main`）                                                                                                                                         | `node -p` 直读                                                                                        |
| preload 命名空间                                            | `api/*.ts` **33** 个；`electronAPI` **34** 个键                                                                                                                                       | `git ls-files`；`preload.test.ts:119`                                                                 |
| IPC handler 规模                                            | **47** 个非测试域文件；**43** 个 `registerXxxHandlers`；`ipc-setup.ts` 里 `import { register… }` **43** 条                                                                            | `git ls-files` + `grep --include='*.ts'`                                                              |
| `IPC_CHANNELS`（`src/shared/types/ipc.ts:447`）             | **86** 个唯一通道 / **23** 个域前缀                                                                                                                                                   | 按块解析（`node -e`）                                                                                 |
| `src/shared/errors/error-codes.ts`                          | **10** 个错误码                                                                                                                                                                       | `grep -cE '^\s+[A-Z_]+:'`                                                                             |
| `FaultType`（`src/main/utils/logger.ts:13-31`）             | **18** 类                                                                                                                                                                             | 直读联合类型                                                                                          |
| `OperationType`（`src/shared/types/editor.ts:290-303`）     | **14** 种                                                                                                                                                                             | 直读联合类型                                                                                          |
| `media_files` 单列索引                                      | **18** 条 `idx_media_files_*`（另有 v3 迁移里的复合/部分索引不在此列）                                                                                                                | `grep -oE … \| sort -u \| wc -l`                                                                      |
| 数据库表                                                    | `CREATE TABLE IF NOT EXISTS` 唯一表名 **25** 张；共鸣表 **6** 张                                                                                                                      | `grep -oiE` 全 `src/main/database`                                                                    |
| `resonance:*` / `sync:*`                                    | **10** / **6** 个通道                                                                                                                                                                 | `grep -rhoE`                                                                                          |
| `nikkisync:*`                                               | **28** 个唯一串 = **27** 条 invoke 通道 + **1** 条推送事件 `nikkisync:library-changed`（`nikkisync-handler.ts:327` `sender?.send?.()` ↔ `preload/api/nikkisync.ts:70` `subscribe()`） | `grep -rhoE "'nikkisync:[a-zA-Z-]+'"`（正则须含 `-`，域用 kebab-case，见 `docs/IPC_CONTRACT.md:383`） |
| `build.asarUnpack`                                          | **11** 项（首项 `**/@nikkisync/**`）                                                                                                                                                  | `node -p`                                                                                             |
| `dist:win`                                                  | **5** 步，首步 `npm run build:recycle-helper`                                                                                                                                         | `node -p "…scripts['dist:win']"`                                                                      |
| 服务 / 页面 / store / locale                                | `services` **13**、`*Page.tsx` **11**、Zustand store **7**、`i18n/locales/*.json` **12**                                                                                              | `git ls-files`                                                                                        |
| `src/main/app` 源文件                                       | **27** 个，其中 **23** 个有同名配套套件                                                                                                                                               | `git ls-files` + 逐名配对                                                                             |
| `src/main/utils` 源文件                                     | **33** 个、**31** 个测试、**29** 个有同名配套                                                                                                                                         | 同上                                                                                                  |
| `scripts/` 入仓代码文件                                     | **67** 个（**61** `.ts` = **35** 非测试 + **26** 单测；另 3 `.cjs` + 2 `.js` + 1 `.json`）；同名配对 **11**                                                                           | `git ls-files scripts \| grep -v '\.md$'`                                                             |
| `scripts/` 下 `.ps1`                                        | **9** 个，全部不入仓（`.gitignore:149/150/151`）                                                                                                                                      | `find scripts -name '*.ps1'` + `git check-ignore`                                                     |
| `src/renderer/components/gallery`                           | **18** 个 `.tsx`（不含 test / stories）                                                                                                                                               | `git ls-files`                                                                                        |
| `src/renderer/icons/index.tsx`                              | **75** 个具名导出                                                                                                                                                                     | `grep -cE '^export (const\|function)'`                                                                |
| `Sidebar.tsx` 的 `navItems`                                 | **10** 项（含 `sync-gallery`）                                                                                                                                                        | 直读                                                                                                  |
| `src/renderer/hooks`                                        | **30** 个非测试 `.ts`                                                                                                                                                                 | `git ls-files`                                                                                        |
| 共鸣卡池                                                    | `banners.json` **77** 个键                                                                                                                                                            | `node -p "Object.keys(…).length"`                                                                     |
| `ThemeConfig`（`src/renderer/styles/themes/index.ts:8-14`） | `{ id, nameKey, className }`（**不是** `name`）                                                                                                                                       | 直读                                                                                                  |
| `*.integration.test.ts`                                     | 仓内实有 **5** 个；`test:integration` 脚本**不存在**                                                                                                                                  | `git ls-files` + `package.json`                                                                       |
| `docs/debt-registry.json`                                   | **37** 条：25 open / 8 done / 4 wont_fix                                                                                                                                              | `node -p`                                                                                             |
| `PORTED_SYNC_AUTOSTART_ENABLED`                             | `false`（`src/main/nikkisync/sync-server-setup.ts:63`），`initSyncServer` 调用点在 `lifecycle.ts:338`                                                                                 | 直读                                                                                                  |
| 测试规模                                                    | **450 个测试文件 / 7021 通过 + 12 skip（共 7033 个用例）**，54.19s，无 flake                                                                                                          | `npm test` 本轮全量实跑                                                                               |
| `npm run lint`                                              | exit 0 且零输出（0 error / 0 warning）                                                                                                                                                | 本轮实跑                                                                                              |
| `npm run docs:links`                                        | 开工基线 **0 死引用 / 161 处提醒**                                                                                                                                                    | 本轮实跑                                                                                              |
| `git tag`                                                   | **8** 个，均无 `v` 前缀                                                                                                                                                               | `git tag \| wc -l`                                                                                    |

## 3. 归档机制的落地结论（决定用哪条命令）

沿用上一轮已验证的语义，本轮再次实测：裸 `git mv <tracked> docs/archive/plans/<名>` 会成功，但目标**继续留在索引里**
（状态 `R`，`git check-ignore` 返回 1）——gitignore 无法让已跟踪路径脱管。真正有效的仍是两步：

```bash
git mv docs/plans/X.md docs/archive/plans/X.md
git rm --cached docs/archive/plans/X.md
```

本轮在首个文件上验完三件事后才批量：暂存区呈 `D docs/plans/X.md`、`git check-ignore` 返回 0、磁盘副本仍在。
7 个候选文件名与 `docs/archive/plans/` 既有 84 个文件名用 `comm` 比对，**零冲突**。

**本轮新增的机制结论（上一轮漏项）**：移档必须同时处理**源码注释侧**。判据不能只跑 `git grep … -- '*.md'`，
要并跑 `git grep -lF <basename> -- '*.ts' '*.tsx'`；否则 `src/**` 里的指路注释会静默变成死指针，
而 `npm run docs:links` 永远看不见（它只扫被跟踪 `.md`）。本轮清掉的 10 处就是这么来的。

## 4. 盘点判定

| 分组                                                                                        | 判定                                                            | 数量 |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| 根目录 7 份（`AGENTS` / `README` / `CHANGELOG` / `ARCHITECTURE(.en)` / `DEVELOPMENT(.en)`） | 保留 + 订正                                                     | 7    |
| `docs/` 契约、规范、SOP、排障、教程、索引、报告                                             | 保留 + 订正（全部 ≥1 入站）                                     | 33   |
| 模块级 `AGENTS.md` / `README.md`（`src/**` 13 + `scripts` 1 + 样例 1）                      | 保留 + 订正                                                     | 15   |
| `docs/plans/` 移出仓库                                                                      | 见本文 §5 清单                                                  | 7    |
| `docs/plans/` 保留                                                                          | 设计/决策真相源、开放待办、被活文档或源码引用、或执行记录未回填 | 30   |

`docs/plans/` 保留的判据逐条写明，避免下一轮重新论证：NikkiSync 上游同步 `01`/`02` 是 §11「不做项」与 §14 六项裁示的唯一决策出处；
`2026-10-17-fix-image-watermark-media-auth.md` 被 `docs/IPC_CONTRACT.md:646` 的行为契约与 7 个源文件注释引用；
`2026-08-24-跨模块集成测试设计.md` 是唯一开放待办；`2026-10-10-*` 与 `2026-10-17-markdown-cleanup-*` 是前两轮真相源
（后者还是本类工作机制与遗留风险的出处）；被 `src/**` 注释引用的 8 份按用户裁示不动（不让文档任务扩散成源码改动）。

## 5. 执行批次

| 批次 | 内容                                                                    | 验证                                                  | 结果 |
| ---- | ----------------------------------------------------------------------- | ----------------------------------------------------- | ---- |
| B0   | 本记录文档入库（先落地，用于随手抓出后续每一步新写的错）                | `npm run docs:links` 不因此新增死引用                 | ☐    |
| B1   | 移档 7 份 + 改写 4 份保留文档里的 8 处引用                              | `git status` 恰 7 条暂存删除；`comm` 零冲突；死引用 0 | ☐    |
| B2   | 源码注释 10 处死指针（14 个 `.ts/.tsx`）改为归档路径并注明去向          | `npm run verify`；相关单测                            | ☐    |
| B3   | 测试规模四处 + 「尚未入仓」两处（含 `.qoder` 镜像同步）                 | 每处替换命中 1 次；`verify-format-scope` 全绿         | ☐    |
| B4   | 模块指引与技术债清单 8 处计数 + 集成测试状态 3 处 + 回收站计划状态 1 行 | 逐条命令复跑读数一致；`debt:check`                    | ☐    |
| B4b  | 双语四件（`ARCHITECTURE(.en)` / `DEVELOPMENT(.en)`）已复验失真订正      | 中英成对同改；`.en` 不混中文行                        | ☐    |
| B5   | 全量闸门 + 本文 §7 读数回写                                             | 见 §7                                                 | ☐    |

移出的 7 份（移后位置记为 `docs/archive/plans/…`，已归档，不入仓）：

| 原路径                                                                                           | 判据                                                  | 落地提交  |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------- |
| `docs/archive/plans/2026-10-23-release-2.5.5.md`（已归档，不入仓）                               | §7「执行记录（2026-10-23 全部通过）」已回填           | `fc06f41` |
| `docs/archive/plans/2026-10-24-batch-mode-favorite-toggle.md`（已归档，不入仓）                  | 状态行「已执行完毕（提交 37bc466）」由 `dc9f085` 补入 | `37bc466` |
| `docs/archive/plans/2026-10-24-review-gpu-hardening-changelog-repack-2.5.5.md`（已归档，不入仓） | §7 执行记录逐项回填，含版本声明位实测清单             | `38c746e` |
| `docs/archive/plans/2026-10-21-fix-ci-smoke-timeout-and-clear-warnings.md`（已归档，不入仓）     | §10 执行记录逐项带真实退出码                          | 3 次提交  |
| `docs/archive/plans/2026-10-23-rename-docs-pass.md`（已归档，不入仓）                            | 「二、红绿读数」                                      | 2 次提交  |
| `docs/archive/plans/2026-10-23-rename-runtime-pass.md`（已归档，不入仓）                         | 「三、提交与红绿读数」                                | 1 次提交  |
| `docs/archive/plans/2026-10-23-rename-ui-i18n-pass.md`（已归档，不入仓）                         | 「三、红绿读数」                                      | 2 次提交  |

**一份从批准清单里剔除的**：`2026-10-24-fix-empty-recyclebin-system-trash.md` 由修复提交 `7d4459f` 同批新建（`--stat` 显示 101 行全新增，
正文至今仍是 101 行 ⇒ 从未回填），标题结构里只有「5. 子任务分解 T0–T5 / 6. 测试用例矩阵 / 7. 明确不做」而**无执行记录节**，
状态行是「已确认」而非「已执行」⇒ 不满足「执行记录已回填」这道前置门禁，本轮只补一行交付说明，不移档。

**别把「创建后没被 amend 过」当判据**：按此筛出的 15 份里，`2026-10-27-fix-duplicate-false-positive.md`（状态「已完成」，§6 逐节点红/绿）
等大多是一次写全、执行记录本就在正文里。未 amend ≠ 未回填。

## 6. 订正要点（选取易被再次写错的）

- **`src/main/tsconfig.json` 的 `outDir` 是 `.cache/tsmain`，不是 `dist/main`**：`ARCHITECTURE.md:1619` 与
  `ARCHITECTURE.en.md:1592` 仍写 `../../dist/main`，这恰好是根 `AGENTS.md`「类型检查的 emit 落点必须与构建产物树隔离」
  那条硬规则**禁止**的回搬态。文档在这里不是过期，是**反向**——照着做会打死 `sandbox: true` 的 preload。
- **易腐数字的正确取数姿势**：`npm test` 汇总行是唯一可信来源（本轮 450 / 7021 + 12 skip）。上一轮写 408 / 6312，
  再上轮 337 / 5331，本轮 437 / 6737 也已作废——三份根文档各留各的快照会互相矛盾，故本轮把四处正文统一到当轮实跑值，
  并把旧值降级进「历史读数」行。
- **两条会让计数失真的命令写法**：① 算非测试脚本数**不能**用 `git ls-files 'scripts/*.ts' | grep -v test`——那会连带删掉
  `scripts/perf-test/` 下 5 个与 `find-related-tests.ts` / `run-precommit-tests.ts`（实得 29），正确判据是
  `grep -v '\.test\.ts$'`（得 **35**）。② `grep -rlE 'export function register[A-Za-z]*Handlers' src/main/ipc/handlers`
  不加 `--include='*.ts'` 会把 `handlers/AGENTS.md` 数进去（44 而非 43）。
- **通道计数正则必须含连字符**：`nikkisync:*` 域按 `docs/IPC_CONTRACT.md:383` 用 kebab-case 命名，
  用 `[a-zA-Z]+` 会得 0 并误判成「文档与代码脱节」。另注意区分 invoke 通道与推送事件，否则 28 会被当成 28 条通道，
  而 `2026-10-25-nikkisync-upstream-sync-05-结案报告.md:227` 写的「实际注册 27 条」才是对的。
- **`docs/plans/2026-08-24-跨模块集成测试设计.md` 的「6 个拟新增套件」是错的，本文 §7 表格自己写「第 5 节 7 个」**：
  同一份文档内自相矛盾，实测点名 7 个路径全部未落地。它的「路径作用域」横幅还有个隐藏约束——
  `check-md-links.ts:158` 的 `SCOPE_DECLARATION` 要求同一物理行内出现「未落地」等标记词且只读前 12 行，
  改写时把这三个字折出该行会让全文拟新增路径集体转成死引用。
- **「未实施」不能按后缀 glob 判**：仓内 `*.integration.test.ts` 实有 5 个（最早 `015150b`，2026-10-11 sync phase 4 带入），
  但没有一个属于 08-24 点名的 7 个拟新增套件，`test:integration` 也确实不存在。判据要落到套件名。
- **中英双胞胎的两处结构性失同步**：`DEVELOPMENT.en.md` 只有 `### 7.9`，缺 `#### 7.9.1 同步检查清单` 与
  `#### 7.9.2 提交前必跑` 两个子节（`DEVELOPMENT.md:872` 与 `:889` 有）。补进去时不得插入中文正文行。
  另 `ARCHITECTURE.en.md:1410` 的共鸣录表总数其实已写「6 in total」，与中文一致——那一条是**误报**，不动。
- **`.qoder/rules/project-conventions.md` 是逐字镜像**：改 `docs/CODING_CONVENTIONS.md` 正文区任一节都必须同步改镜像，
  否则 `scripts/__tests__/verify-format-scope.test.ts` 红。本轮 F2 那处就要改两遍。
- **被跟踪文档里不得写「本轮新增，尚未入仓」**：`docs/CODING_CONVENTIONS.md:131` 的 `source-encoding.test.ts` 限定语
  就是这类失真——该文件现已入仓。这类话在提交那一刻即成假话，`CHANGELOG.md:71` 已为同类问题登记过一次。
- **`annotated-gone` 按物理行判定**：本文与 B1 改写的引用都遵守「标记词紧跟路径、同一物理行」，
  因为 prettier 会按 `printWidth` 折 CJK 长句。

## 7. 验证（收尾批回写读数）

| 命令                                                           | 结果 |
| -------------------------------------------------------------- | ---- |
| `npm run docs:links`                                           | ☐    |
| `npm run typecheck`                                            | ☐    |
| `npm run typecheck:e2e`                                        | ☐    |
| `npm run lint`                                                 | ☐    |
| `npm run verify`                                               | ☐    |
| `npx vitest run scripts/__tests__/check-md-links.test.ts`      | ☐    |
| `npx vitest run scripts/__tests__/verify-format-scope.test.ts` | ☐    |
| `npm run debt:check`                                           | ☐    |
| prettier 表格噪声核查                                          | ☐    |
| BOM 扫描（本轮改动的 `.md` / `.ts` / `.tsx`）                  | ☐    |

## 8. 上一轮遗留风险的复核结论

| 上一轮 §8 的登记                             | 本轮复核                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关于页仍显示 Electron 28 / React 18 / TS 5.3 | **仍然存在**（`about-sections.tsx:65`，另 `:265` `'28.x'`、`:272`/`:279` `'18.x'`），DEBT-035 保持 open，本轮按用户裁示不动                                                  |
| 文档读数会再次过期                           | **已发生**：437 / 6737（2026-10-24）已被 450 / 7021 取代，且 `DEVELOPMENT` 停在 408 / 6312 与 `ARCHITECTURE` 互相矛盾。仍无自动守护                                          |
| 归档判定无自动化、`docs/plans/` 每轮膨胀     | **已发生**：上轮剩 2 份 → 本轮 37 份。本轮移出 7 份后仍留 30 份，根治分支（新计划直接写不入仓目录 / 扩闸门）经用户裁示本轮不采纳                                             |
| 阶段计划的状态字段不可当现状读               | **仍然存在**：`docs/sync-integration/04-http-server-plan.md` 写「执行中」而 `05` 记「前置：阶段 4 已验收」；本轮又新增一例同类（08-24 的「6 个」与自身 §7「7 个」）          |
| 规划名与落地名分叉                           | **仍然存在**：`sync/scan-journal.ts` → `src/main/scanner/scan-journal.ts`，`settings/sync-sections.tsx` → `src/renderer/pages/sync-gallery/`，靠「路径作用域」声明降级为提醒 |
| `annotated-gone` 按物理行判定                | **仍然成立**，本轮据此调整了两处写法（08-24 横幅与 B1 引用改写）                                                                                                             |

## 9. 本轮不处置、新登记的遗留风险

1. `docs/plans/` 膨胀无自动化根治方案落地：判据仍靠人工读「执行记录是否回填 + 是否有落地提交」。
2. 源码注释不在 `npm run docs:links` 覆盖面内：本轮只清存量 10 处，后续移档若不同步跑 `git grep … -- '*.ts' '*.tsx'` 仍会新增。
3. `eslint.config.js:114` 的注释仍写「存量技术债文件在下方 legacy 白名单块中降级为 warn」，而该 warn 块已于 2026-10-21 清偿删除
   （`docs/技术债清单.md` §13 记 DEBT-030 done）。属代码注释，非 `.md`，本轮不动。
4. 双语四件里若干数字未经本轮复验，不写进正文也不改：SettingKey 数、tailwind `theme.extend.colors` 映射数、
   `ALBUM_TYPE_MAP` 键数、`OUTFIT_PRESETS` 条目数、`GROUP_DIMENSION_OPTIONS` 字段形态、worker 协议命令/事件类数、
   共鸣缩略图文件数、`pre-dist-check` 的「时间戳差 ≤5 分钟」判据是否已被「产物比源码新」取代。
   这些是子代理审计报出但我没能用命令独立复验的项，按「取不到就不写上去」的原则登记为待核，不当结论用。
