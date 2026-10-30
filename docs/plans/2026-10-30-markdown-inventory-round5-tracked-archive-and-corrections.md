# 全仓 Markdown 盘点、受跟踪归档与失效内容订正（2026-10-30，第 5 轮）

- 日期：2026-10-30
- 分支 / 基线 HEAD：`main` @ `a678393`（开工时 `git status --porcelain` 为空）
- 状态：**已执行**（提交序列 S0–S8 全部落地，逐节点实跑；§5 结果列与 §6 读数为实测回填，§7 记未验证项）
- 上一轮同类工作：`docs/plans/2026-10-27-markdown-inventory-archive-and-corrections.md`
  （归档判据取自其 §1.1，反判据警告「未 amend ≠ 未回填」取自其 §5，遗留项取自其 §8/§9——本轮逐条复核见下）
- 基线计数：被跟踪 `.md` **97**，`docs/plans/` 活目录 **42**

## 1. 结论摘要

1. **本轮删除 0 份，改为「受跟踪归档」7 份**。前四轮的落点是 `docs/archive/plans/`，靠
   `git mv` + `git rm --cached` 两步实现——那等于让文件从版本历史消失，只在本机留副本（10-27 §1 明写
   「本机副本保留、仓库中消失」）。本轮改用 `docs/plans/archive/2026-Q4/`（S7 待创建），**单步 `git mv`**，文件仍在仓：
   - `git check-ignore docs/plans/archive/2026-Q4/x.md`（探针用假路径，该文件不存在）实测退出码 **1**（不被忽略 ⇒ 可跟踪）；
   - `scripts/__tests__/old-name-ledger.json:43` 的 `skipDirs` 含 `archive`，而 `old-name-ledger.test.ts:69-70`
     的 `isSkipped` 按**路径段**匹配 ⇒ 归档件自动豁免旧名终扫，不需要为它们增设 `skipPaths` 条目；
   - 移动后仍是 tracked ⇒ `check-md-links.ts:288-318` 的 `classifyRef` 判 `ok`，**不需要**给任何入站行
     补 GONE_MARKER。反面前四轮的两步法：`docs/plans/X.md`（示意占位，本仓不存在同名文件）形态的入站引用在未跟踪时会落进 `dead`，
     而 `:232` 断 `dead === 0` 是硬阻断。
   - 命名是承重的：路径段必须恰为 `archive`（`docs/plans/retired/` 是反例占位，仓库中不存在该目录，
     且这类命名会被旧名终扫收录）。
2. **撤销 10-27 §9 的裁示**。上一轮记「归档判定无自动化……根治分支经用户裁示本轮不采纳」。本轮经用户
   在四个候选里明确选择「移入受跟踪归档目录」，裁示已变，故本文件即变更出处。`docs/plans/archive/README.md`（S7 待创建）
   随本轮建立，登记「名称 → 结案 commit → 后继文档」，下轮按表操作而非重新判断。
3. **用户请求里的四条前提第五次与仓库现状不符**，与 10-10、10-17、10-24、10-27 五轮同：不存在 `_plans/`、
   `.review/`、根 `SKILL.md`、`使用指南.md`（用户手册实为 `docs/tutorial/用户使用教程.md`）。
   `.zcode/plans/`、`.trae/documents/` 磁盘存在但被 `.gitignore:158` / `:154` 排除，天然不在审计范围。
   `git ls-files --others --exclude-standard` 为空 ⇒ 没有任何未跟踪 `.md`，「AI 工具目录不计入」与
   「只审被跟踪文件」两个口径本轮仍等价。
4. **97 份里没有一份达到删除标准**。判据三条须同时成立才允许移出活目录：① 对外零入站引用、② 文内已自
   declared 结案、③ 实质结论已被 CHANGELOG 或 git log 覆盖且不是任何决策/机制的唯一出处。
   `docs/` 顶层与其子目录每一份都有 ≥1 入站引用，14 份模块指引全部被根 `AGENTS.md` 导航表点名。
5. **本轮新查出一类上一轮没抓到的失真**：测试规模读数在**两套根文档里差了一整轮**——
   `ARCHITECTURE.md:2044` / `.en.md:2017` 已是 453 / 7063 + 12（2026-10-28 快照），
   `DEVELOPMENT.md:740` / `.en.md:743` 仍停在 450 / 7021 + 12（2026-10-27 快照）。
   静态实测现为 **454 = src 421 + scripts 28 + e2e 5**（`59b3377` 于 10-30 新增
   `src/renderer/styles/app-drag-region.test.ts`）。四处本轮同批改齐，缺一处即为假绿。

## 2. 已核实的假陈述清单（逐条都到代码里对过，不是推测）

| #   | 位置                                                                      | 文档现写                                                                                                | 实测真相                                                                                                                                    | 证据                                                                         |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A   | `ARCHITECTURE.md:1585`、`ARCHITECTURE.en.md:1556`                         | `"dist:win": "npm run build && npm run pre-dist-check && …"`                                            | 缺首步 `npm run build:recycle-helper &&`，且与自家 §11.3（`:1652` / en `:1624`）自相矛盾                                                    | `package.json` `scripts["dist:win"]`                                         |
| B   | `ARCHITECTURE.md:388`                                                     | `repair-legacy-data-v1..v6.ts`                                                                          | **无 v2**，实为 v1/v3/v4/v5/v6                                                                                                              | `git ls-files \| grep repair-legacy`                                         |
| C   | `ARCHITECTURE.md:561`                                                     | 目录树列 `tools/image-decode-analysis/`                                                                 | 该目录不存在，`tools/` 下只有 `scripts/` 两个 `.ps1`                                                                                        | `git ls-files tools`                                                         |
| D   | `ARCHITECTURE.md:2044`、`.en.md:2017`、`DEVELOPMENT.md:740`、`.en.md:743` | 453 / 450 两套并存                                                                                      | 454 文件（静态可核）；用例数须实跑                                                                                                          | `git ls-files '*.test.ts*'` 分目录计数                                       |
| E   | `DEVELOPMENT.md:210-229`（含 en）                                         | components 树缺 `sync/`，pages 树缺 `sync-gallery/`                                                     | 两者都在仓且已被 `AGENTS.md:81,83`、`README.md:108` 列出                                                                                    | `src/renderer/components/sync/`、`src/renderer/pages/sync-gallery/`          |
| F   | `DEVELOPMENT.md:249`                                                      | `icons/ 应用图标（.ico/.svg）`                                                                          | 只有 `icon.ico` + `icon-master.png`；占位 SVG 于 2026-10-26 退役，同文档 `:824` 已写对 ⇒ 自相矛盾                                           | `git ls-files resources/icons`                                               |
| G   | `DEVELOPMENT.md:520-540` §5.7                                             | 「四项全绿才可提交」，全文不提 `npm run verify`                                                         | `AGENTS.md:112-118` 把 `verify` 定为变更后主环                                                                                              | `scripts/verify-changes.ts`                                                  |
| H   | `CHANGELOG.md` `[2.5.6-beta]` 节                                          | 停在 10-27                                                                                              | `59b3377`/`69b0420`/`1d20801`/`bcd6f44`/`a678393` 五笔未入账，违反其自订补录义务（`:463`）；2.5.6-beta 已于 10-30 重打包出货 ⇒ 改动确在包里 | `git log --since=2026-10-28`                                                 |
| I   | `CHANGELOG.md` 13 处                                                      | 引 `docs/archive/plans/*.md` 无「未入仓」限定                                                           | `check-md-links` 判 `ignored-local` 不判红 ⇒ 纯读者信任问题，不是闸门问题；`DEVELOPMENT.md:1056` 是正确写法                                 | `check-md-links.ts:72-82`                                                    |
| J   | `ARCHITECTURE.en.md`                                                      | 缺 zh `:1472` 的「导航防护与 preload 授信源」与 `createManagedReadStream` 读流约束段 ⇒ 其后节号整体错位 | 两个源文件都在仓                                                                                                                            | `src/main/app/navigation-guard.ts`、`src/main/preload/origin-guard.ts`       |
| K   | `docs/troubleshooting-spawn-eftype.md:3-4,28-31,87`                       | 指引查 `Documents\NikkiGallery\Diagnostics`                                                             | 现为 `文档\喵星图\Diagnostics`；旧名候选**保留并加时间限定**（改名前的产物确实写过 NikkiGallery）                                           | `src/main/utils/user-diag-path.ts:13,50-52`、`src/main/index.ts:55,262`      |
| L   | `docs/PLUGIN_API.md:3`                                                    | 「对应 NikkiGallery v2.3.0+」                                                                           | 项目 2026-10-23 更名，现 2.5.6-beta。**只加字不删字**：台账钉该文件 `NikkiGallery:2 / nikkiGallery:10`，删一处即红                          | `old-name-ledger.json` `allowed`、`package.json:213`                         |
| M   | `.storybook/main.ts:11` 注释                                              | 「`docs/storybook` 下的 MDX 文档（目录暂不存在，glob 为空即可）」                                       | 3 份 `.mdx` 已跟踪并被 `:16` 的 glob 装入                                                                                                   | `git ls-files docs/storybook`                                                |
| N   | `docs/sync-integration/04-http-server-plan.md`                            | 状态「执行中」                                                                                          | 与 `05` 记「阶段 4 已验收」矛盾；实况是已交付但默认不自启                                                                                   | `src/main/app/sync-server-setup.ts:63 PORTED_SYNC_AUTOSTART_ENABLED = false` |
| O   | `docs/manual-smoke-checklist.md`                                          | 仍是 2.5.0 时代项                                                                                       | 缺 10-29 无边框窗口拖拽、10-30 2.5.6-beta 复装两格                                                                                          | `AGENTS.md:112-118`、`build.yml:210`                                         |

## 3. 归档集（7 份）与保留集（6 份零引用件）

零入站引用实测：**必须**用 `git -c core.quotePath=false grep -l -F <basename>` 并排除 `docs/plans/` 自身。
两个坑本轮都踩过：① 纯否定 pathspec（`-- ':!docs/plans'`）会让 `git grep` 静默返回空，读数全零；
② 不开 `core.quotePath=false` 时中文路径被输出为 `"docs/plans/\350…"`，`grep -v '^docs/plans/'` 滤不掉，
读数虚高。42 份里真零引用的恰 13 份。

移出：`2026-10-24-fix-empty-recyclebin-system-trash`、`2026-10-25-nikkisync-upstream-sync-01/03/04/05`、
`2026-10-27-fix-test-suite-under-node26`、`2026-10-29-nikkisync-upstream-sync-01-影响评估`。

零引用但保留原位，逐条给理由以防下轮误删：

- `2026-08-24-跨模块集成测试设计.md` — 10-10 §5.5/§8.6 认定「唯一开放待办」，判据 ② 不成立。
- `2026-10-17-markdown-cleanup-guard-and-corrections.md` — 本类机制（GONE_MARKERS、归档判定、两步法）唯一出处。
- `2026-10-27-markdown-inventory-archive-and-corrections.md` — 本轮判据 ① ② 的出处，且本轮撤销其 §9 裁示，须留原件供对照。
- `2026-10-29-fix-window-drag-region.md`、`2026-10-30-review-repack-2.5.6-beta.md` — §2-H 的补录会**为它们新建**入站引用；归档判定必须在补录之后重算，本轮不据当前零引用移档。
- `2026-10-29-nikkisync-upstream-sync-02-实施计划.md` — 「不做项」与用户裁示在此，是该轮决策唯一出处（实测「不做项/裁示」文本落在 `-02-实施计划` 而非 `-01-影响评估`，故移 01 留 02）。

## 4. 闸门与锁步项（本轮不可违反）

- `check-md-links.test.ts:232` 断 `dead === 0`；`:237` 断 `totals.docs > 50`（基线 97）。受跟踪 `.md` 净数本轮 **+1**（归档账本 `docs/plans/archive/README.md`，S7 待创建）。
- 同测试 `:27,28,29,125,158,216` 钉住 5 个路径必须存在：`docs/CODING_CONVENTIONS.md`、`docs/IPC_CONTRACT.md`、`docs/plans/2026-10-10-markdown-inventory-and-corrections.md`、`docs/packaged-scan-crash-report.md`、`docs/sync-integration/05-ui-scanner-integration-plan.md` ⇒ 全部留在原位。
- `verify-format-scope.test.ts`：`docs/CODING_CONVENTIONS.md` 正文须与 gitignored 镜像 `.qoder/rules/project-conventions.md` **逐字节相同**。本轮**刻意不改其正文**（§2-G 的口径差在 DEVELOPMENT 侧收口即可）；若必须改，同批重投镜像。
- `old-name-ledger.test.ts` + `.json`：逐文件**精确**命中数，多一处少一处都红（`expectedTotal` 现 172）。域内受钉 md 含 `ARCHITECTURE(.en).md`、`DEVELOPMENT(.en).md`、`docs/PLUGIN_API.md`、`docs/技术债清单.md` ⇒ 订正一律就地括注、不删旧名。`docs/troubleshooting-spawn-eftype.md` 与 `docs/2.5.0/`、`docs/sync-integration/`、`docs/plans/`、`CHANGELOG` 均在 `skipPaths`，改这些零连锁。
- `check-changelog-release.ts`（在 `pre-dist-check` 内，阻断打包）：要求版本节存在 **且 `[Unreleased]` 零列表条目** ⇒ H 的补录进 `[2.5.6-beta]` 节，`[Unreleased]`（`:13`）保持只有一句散文。
- `check-doc-versions.ts`（同在 `pre-dist-check` 内）：只按正则扫 `README.md` 的 `Electron x.y`，须与 `devDependencies.electron` 的 major.minor 一致 ⇒ README 的 Electron 41.10 表述不动。10-10 §8.1 登记过「ARCHITECTURE/DEVELOPMENT/.en 的版本号无人守护」，本轮仍未扩展，继续留作待办。
- `.github/workflows/build.yml:74,77-103,210,215` 按**文件名**认 `docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md`、`docs/IPC_CONTRACT.md`、`docs/manual-smoke-checklist.md`、`docs/perf-regression.md` ⇒ 四个都不动位置。

## 5. 执行计划与结果

| 步  | 内容                                                                    | 验证                                                       | 结果                                                                 |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| S0  | 本计划入库                                                              | `npm run verify`                                           | ✅ `c2a1524`，另补 `3235f99` 收口（见 §9 偏差 1）                    |
| S1  | A/B/C/D 的静态部分（含 DEVELOPMENT 两处）                               | `format:check` + `old-name-ledger` 命中数仍 172            | ✅ `b74f8be`；台账 5 例通过                                          |
| S2  | E/F/G，zh 与 en 孪生同批                                                | `verify-format-scope` + `npm run verify`                   | ✅ `15bd21f`；`verify-format-scope` 36 例通过，镜像未破              |
| S3  | J 补译两节入 en                                                         | `npm run docs:links`                                       | ✅ `ef49bd8`；两版 `#### 10.1.x` 各 5 条，节号恢复对齐               |
| S4  | K 诊断目录订正                                                          | `docs:links`                                               | ✅ `f1ea78c`；顺带查出 ARCHITECTURE 双语共 9 处同一失真（§2-Q）      |
| S5  | L/M/N                                                                   | `npx vitest run scripts/__tests__/old-name-ledger.test.ts` | ✅ `7b18ed8`；PLUGIN_API 改前改后均 NikkiGallery 2 / nikkiGallery 10 |
| S6  | H + I                                                                   | `npx tsx scripts/check-changelog-release.ts`               | ✅ `e6d439a`；14 个版本节、`[Unreleased]` 零列表条目                 |
| S7  | 7 份 `git mv` → `docs/plans/archive/2026-Q4/` + 归档账本 + 入站路径改写 | `docs:links` → 全量 `npm test`                             | ✅ `2c25067`；改写 20 处、git 识别 7 个 rename、454 文件全绿         |
| S8  | 实跑读数回填、O 补格、未验证记账、结案                                  | 全量回归                                                   | 见 §6 与 §9                                                          |

## 6. 读数（实跑回填，未跑到的一律记 not-run）

- 基线（开工前实测）：`npm run docs:links` ⇒ **0 死引用 / 177 提醒**；被跟踪 `.md` 97；`docs/plans/` 42。
- 终态（S8 实测）：`npm run docs:links` ⇒ **0 死引用 / 183 提醒**；被跟踪 `.md` **99**（+2：本轮计划文档、归档账本）；
  `docs/plans/` 活目录 **36**，`docs/plans/archive/2026-Q4/` **7**。提醒数从 186 降到 183，是因为 5 条原本
  「已交代去向」的归档引用在移动后变成可解析的 `ok`。
- **真宿主（`win32 / node-v26.3.0 / vitest 5.0.3`）全量 `npm test`**：`Test Files 454 passed (454)`、
  `Tests 7094 passed | 12 skipped (7106)`、耗时 53.45s。文件数与静态计数 454 = src 421 + scripts 28 + e2e 5 逐项闭合。
  S8 结案前又复跑一次同一命令，得到**完全相同的 454 / 7094 + 12**，但耗时 64.42s ⇒ 用例读数可复现、
  **耗时不是稳定读数**，引用它时必须同宿主同轮次成对给出，不得单列当性能基线（性能基线的口径见 `docs/perf-regression.md`）。
- **`npm run test:coverage`**：退出码 **0**，汇总 `All files 70.02 / 61.41 / 62.79 / 71.64`
  （statements / branches / functions / lines），阈值 `66 / 58 / 59 / 68` 四项均过；同一轮用例读数与上条一致。
  本轮**未**改 `vitest.config.ts` 阈值、未扩大 `exclude`、未增删 skip。
- **装置侧 `npm run test:ci-linux`**：本轮 HEAD 为 `32 failed | 422 passed (454)`；为判定「本轮是否引入新红」，
  另在临时 worktree 检出轮前 `a678393`（junction 复用同一 `node_modules`）跑同一命令，得
  `33 failed | 421 passed (454)` ⇒ **本轮 0 新增红**。两次唯一差异是
  `scripts/__tests__/logger-escape-ledger.test.ts` 在两次同命令跑出不同结果，属时序敏感 flaky，
  不得记作改善或回归。红项两类根因：`Could not load the "sharp" module using the linuxnull-x64 runtime`
  （原生二进制按模拟 Linux 宿主查找）与 `spawnSync git ENOENT`（`execFileSync` 的 cwd 被轴 4e 翻成
  `/home/runner/…`，本机不存在——已由 `docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md`
  的对照表记为已知限制）。按 `docs/CODING_CONVENTIONS.md` §6，本机装置红 **不等于** Linux 红，终判在 CI。

## 7. 未验证记账（不得写成结论）

| 项                                                 | 为何没跑                                                                                                               | 本可证明它的命令   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `dist:win` / `verify:dist` / `pre-dist-check` 全链 | Windows 专属：`build-recycle-helper.cjs` 需 `csc.exe`、`after-pack-vc-runtime.cjs` 需 VC 运行时 DLL、asar 校验需产物树 | `npm run dist:win` |
| `build.yml:77-103` 的 IPC 变更集闸门、perf job     | 仅 ubuntu-latest 有                                                                                                    | 推送后看 Actions   |
| `manual-smoke-checklist` 人工勾选                  | 需真实安装包与人工操作                                                                                                 | 按清单逐格         |
| 教程 48 张截图、`docs/2.5.0` 产物名                | 需打包态 UI；且本轮订正范围不含历史快照（经用户选定）                                                                  | 打包后逐图复核     |

## 8. 待办移交（本轮不修，登记）

- `docs/2.5.0/RELEASE_NOTES_v2.5.0_illustrated.md:1` 标题与 `NikkiGallery-Setup-2.5.0.exe` 产物名，对现 `artifactName`（`MeowStarMap-Setup-${version}.${ext}`，`package.json:288`）已失真；属历史发版说明，按「名称与事实分离」应在下一轮以时间限定语处理。
- `docs/tutorial/用户使用教程.md:4` 版本横幅 2.5.0 落后 6 个 beta，48 张图为更名前 UI。
- DEBT-035：应用内「关于」页仍显示 Electron 28 / React 18 / TS 5.3（`src/renderer/pages/settings/about-sections.tsx:65`），是**用户可见**的文档失真，10-27 §8 已登记、仍未修。
- 10-10 §8.3：`src/main/media-worker/bktree-js.ts:9` 指向不存在的 `docs/archive/BKTREE-REPLACE-PLAN.md`。
- 10-10 §8.1：`check-doc-versions.ts` 仍只守 README 的 Electron 版本。
- 归档自动化：本轮已建立 `docs/plans/archive/README.md` 账本（S7 落地），把「移档」变成查表操作，但**仍未有脚本闸门**判定「已结案 ∧ 零入站 ∧ 非唯一出处」，膨胀根因未除。可按该账本 §1 的口径写只读诊断脚本，复用 §9.3 的正确 grep 方法。
- **新增｜`%TEMP%` 兜底文件名收口**（见 §9.1-Q2）：`early-crash-guard.ts:64` 与 `startup-diagnostic.ts:38` 的
  `MeowStarMap-startup-errors.log` 应统一走 `PRODUCT_DIAG_DIRNAME`，属代码侧改动需单独立项；注意兼容性——
  改完后老用户 `%TEMP%` 里会同时存在新旧两个文件，需要一个「两者都读」的过渡或直接认新名。

## 9. 执行中发现的新失真与偏离计划的处置

### 9.1 计划外新发现（除 Q2 外均已修，且都是「文档自述与自身矛盾」类）

- **P1｜测试规模读数在两套根文档里差了一整轮**：`ARCHITECTURE.md:2044` / `.en.md:2017` 已是 453 / 7063（10-28 快照），
  而 `DEVELOPMENT.md:740` / `.en.md:743` 仍停在 450 / 7021（10-27 快照）。上一轮记的是「中英双胞胎互相矛盾」，
  实际是**跨文档双胞胎**也矛盾。处置：DEVELOPMENT 的复述行不再各写数字，改指 `ARCHITECTURE.md` 附录 C.3 为
  **唯一登记处**——这是消除复发根因，而不只是刷新一次数字。
- **Q1｜诊断目录名写错共 9 处**：`ARCHITECTURE.md` 4 处 + `.en.md` 5 处把诊断目录写成 `MeowStarMap/Diagnostics`，
  而 `src/main/utils/user-diag-path.ts:13` 的 `PRODUCT_DIAG_DIRNAME = '喵星图'`（该模块注释自称「单一权威」）、
  `package.json` 的 `build.productName` 亦为 `喵星图`。排障指南另有同族问题（K 项）。
- **Q2｜应急兜底文件名与目录名不同源**：订正过程中查出，`%TEMP%` 兜底走的是 `MeowStarMap-startup-errors.log`
  （`early-crash-guard.ts:64`、`startup-diagnostic.ts:38` 各自硬写英文产品名），而前三候选是中文 `喵星图-*`。
  **本轮只在文档里如实记录该不一致、未改代码**，移交见 §8。
- **R1｜`resources/nikkisync/` 整条漏计**：DEVELOPMENT 的 `resources/` 树只有 `icons/` 与 dll，
  漏了 `nikkisync/recycle-helper.cs`（`build:recycle-helper` 的输入，`extraResources` 要拷进产物）。
- **R2｜口径澄清**：`docs/storybook/` 下是 3 份 `.mdx` 而非 `.md`，故**不在**本次「所有 `.md` 盘点」的 99 份计数内
  （`.storybook/main.ts:11` 却长期声称该目录不存在，即 M 项）。这个扩展名口径值得写清，否则下轮会重复追问。
- **S1｜版本声明五处实测一致**：`ARCHITECTURE.md:1696` 自订「改版本号需同步 README 徽章 + ARCHITECTURE±en 头部 +
  DEVELOPMENT±en 头部」，本轮逐处核对，五处均已是 `2.5.6-beta`、与 `package.json` 一致——记为**已验证为真**，
  但 10-10 §8.1 登记的「除 README 外无人守护」仍成立，`check-doc-versions.ts` 未扩展。

### 9.2 偏离计划的三处处置（明示，不含隐性改动）

- **偏差 1｜S0 的提交一度不自洽**：`git add` 之后我又补了两处示意路径的行内交代，导致 `c2a1524` 提交的内容
  仍含 2 条死引用（`docs/plans/X.md`、`docs/plans/retired/`，两者均为反例占位、仓库中从未存在）。单独 checkout 该提交会让
  `check-md-links.test.ts:232` 的 `dead === 0` 判红。已用 `3235f99` 补齐交代语使 HEAD 自洽，未用 `--amend`、
  未用 `--no-verify`。**教训**：暂存后若再改文件必须重新 `git add`；提交前看 `git status --porcelain` 是否仍有 `M`。
- **偏差 2｜I 项从「逐行加限定」改为「一处全局说明」**：原计划在 13 处超长行内逐个插 `（已归档，不入仓）`。
  实测其中 8 处缺字，但这些行单行长度达数千字符，逐条改写风险高于收益；且 `docs/archive` 已在
  `check-md-links.ts:72-82` 的 `IGNORED_LOCAL_PREFIXES` 内，判级本就是 `ignored-local` 而非 `dead`，
  逐行加字对闸门毫无作用。改为在 `CHANGELOG.md` 头部加一段统一口径说明，一次覆盖全部 16 条引用及将来新增。
- **偏差 3｜归档件的回填引用少写一级**：pass2 把归档件里指向「留在 `docs/plans/` 的活计划」的裸名补成 `../<name>`，
  但归档件在 `docs/plans/archive/2026-Q4/`，正确写法是 `../../<name>`。`docs:links` 当场抓出 2 处死引用并已在
  S7 提交前修正，规则也已写进 `docs/plans/archive/README.md` §3.2，供下轮查表。

### 9.3 判据修正：上一轮「零入站引用」的统计方法有两个坑

`docs/plans/` 的入站引用统计**必须**用 `git -c core.quotePath=false grep -l -F <basename>` 并排除 `docs/plans/` 自身。
两个坑本轮都实际踩到并纠正：

1. **纯否定 pathspec**（`-- ':!docs/plans'`）会让 `git grep` 静默返回空 ⇒ 42 份全部读数 0，会把
   9 份**有外部引用**的计划误判成可删（含被 CI 的 `build.yml:74` 按文件名认的
   `2026-10-19-fix-e2e-smoke-dist-pollution.md`）。
2. **默认 `core.quotepath`** 会把中文文件名输出成 `"docs/plans/\350…"`，用 `grep -v '^docs/plans/'` 滤不掉 ⇒ 读数虚高。

按正确方法重算，42 份中真零外部引用的是 13 份。移档判据的第 ④ 条补充：**当前零引用但本轮将新建入站引用的
不得移**（`2026-10-29-fix-window-drag-region.md` 与 `2026-10-30-review-repack-2.5.6-beta.md` 即因 §2-H 的补录
而获得入站引用，故留原位）。
