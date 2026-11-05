# Markdown 全量盘点与订正（round 6 · 2026-11-05）

- 日期：2026-11-05
- 基线：`main` @ `970913b`（meow-star-map 2.5.6），工作区叠加 round 5 未提交的归档移动（15 份 staged rename，已物化到磁盘、无重复副本）
- 状态：已执行完毕，验证五项全绿（读数见 §5）
- 上一轮：`2026-10-30-markdown-inventory-round5-tracked-archive-and-corrections.md`

## 0. 背景

用户要求对全仓 `.md` 做盘点、清理分析与内容更新。范围排除 node_modules/.git 与 AI 工具目录
（`.zcode/`、`.trae/`、`.qoder/`、`.mimosa/`、`.codebuddy/`、`.workbuddy*/`、`.codegraph/`）及
`.cache` 构建缓存。盘点以三路并行探查完成（根目录文档 / docs 活文档 / plans 与归档区），
关键结论经本地抽查与 git log 复核后才落改。

## 1. 盘点结论（全量处置清单）

**总量**：约 130 个项目相关 `.md`（另 `_safe_backup_*/` 5 个打包备份目录与
`wxnn-photo-manager/node20/` 运行时内含第三方 md，不属文档清理范围）。

### 1.1 删除（2 份，均已被 .gitignore 排除）

| 文件                         | 理由                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `.mimosa-feedback-report.md` | 72 字节一次性扫描残留，内容为指向另一工作副本（`d:\Users\Downloads\…`）的死路径        |
| `.cache/_pretty.md`          | `docs/CODING_CONVENTIONS.md` 的 GBK 乱码旧版快照（仍是「四条约定」时代），构建缓存残留 |

### 1.2 保留不动（登记说明）

| 对象                                                         | 理由                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `_safe_backup_*/`（5 个目录）内的第三方 LICENSE/README       | 打包备份目录的组成部分，其去留属整目录备份清理决策，不在文档盘点内擅动 |
| `wxnn-photo-manager/node20/**` 内 Node 自带 README/CHANGELOG | 随 Node 运行时分发的第三方文档                                         |
| `docs/archive/**`                                            | 本机留存区（`.gitignore:188` 排除），维持原状                          |

### 1.3 全部保留（含订正）

- **根目录 7 份**：README / ARCHITECTURE（中英）/ DEVELOPMENT（中英）/ CHANGELOG / AGENTS——AGENTS.md 经全项核实**零失效**（47/4/43、12 locale、9 pages、14 个嵌套 AGENTS 路径全部命中）；其余四份存在计数/路径滞后，订正见 §3。
- **docs/ 活文档**：CODING_CONVENTIONS（30 个引用路径全在位）、IPC_CONTRACT（抽查 10+ 通道全部真实注册）、PLUGIN_API、Storybook 使用指南（.storybook/ 与依赖、CI job 全在位，非死文档）、i18n/fix-sop（自带过期横幅）、manual-smoke-checklist、perf-regression（§7 表 11 项 + 4 script 全在位）、troubleshooting×2、技术债清单 + debt-registry.json（60 条两侧对账一致）、组件文档规范、2.5.0 发版说明（历史快照自声明）。
- **docs/packaged-scan-crash-report.md**：保留原地。一次快照报告虽有归档倾向，但 `docs/archive/` 不入仓（移入即脱管）且有 4 处入站引用；其头部已自带快照声明，:23/:82-85 的更名前旧路径属历史现场、按「归档件按当时快照读」口径成立。
- **docs/sync-integration/ 17 份**：README §3 第 3 条明文禁止移入归档（设计真相源），16 份状态行与 README §2 对账表逐一吻合。
- **docs/plans/ 56 份全部保留（A=0 / D=0）**：归档三判据无一同时成立——判据 1（对外零入站引用）被 CHANGELOG 补录台账与源码注释全面挡住（现存每份在 docs/plans 外均有至少 1 个被跟踪引用）；判据 2 拦下 round4、toolbar-contrast 等 5 份未回填计划；`cloth-outfit-data-contract.md` 是契约/公式唯一出处（9+ 处代码引用）。
- **docs/plans/archive/ 22 份 + 台账**：保留；台账欠账已补（§3.1）。
- **src 系**：14 个模块级 AGENTS.md、share-card/README、shared/sync/README、plugins-samples README——引用路径抽查全部有效。

## 2. 三判据读数（docs/plans/ 活跃区）

- **判据 1（零入站引用）**：56/56 不满足。方法：非 md 侧 `grep -rn "docs/plans/"` 全量 80 条逐条归类（含
  `.github/workflows/build.yml`、`docs/debt-registry.json`、`resources/nikkisync/recycle-helper.cs`）；
  md 侧逐文件按文件名 grep 排除 docs/plans。
- **判据 2（文内已结案）**：5 份未回填——`2026-10-30-fix-ci-linux-rig-axes-round4.md`（全仓唯一零入站引用者，
  但未回填不可移）、`2026-10-26-fix-fullscreen-toolbar-contrast.md`、cloth-outfit phase1-3 三份（代码已落地、
  计划未回写读数）。另 `2026-10-23-qqgroup-fix…` 留「用户侧重启」未收口。
- **判据 3（非唯一出处）**：机制出处保留件照旧——`2026-10-17-markdown-cleanup-guard…`、
  `2026-10-27-markdown-inventory-archive-and-corrections.md`、`2026-08-24-跨模块集成测试设计.md`（唯一开放待办）、
  NikkiSync/align 各轮 `-02-实施计划`（不做项与用户裁示落点）。

## 3. 本轮订正明细

### 3.1 归档流程收口（round 5 移入批次的欠账）

1. **`docs/plans/archive/README.md` §2 台账补登 15 份**（违反 §3.5「移完要同步更新本表」的漏登批次），
   每行含结案 commit（逐份经 `git log -- <旧路径>` 取得）与实质结论落点。
2. **改写 8 处旧路径引用**为 `docs/plans/archive/2026-Q4/<name>.md`（否则 `docs:links` 的 `dead === 0`
   契约红；按 archive/README §1「归档快照时同批改写 CHANGELOG 行」规则）：
   - `CHANGELOG.md`：`:31`（photo-dir-review-fix）、`:38`（gpu-fatal-level3-compat；同行 gpu-ladder 引用仍活跃、未动）、
     `:42`（fullscreen-topbar-fix）、`:43`（fullscreen-switch-jitter-fix）、`:45`（review-fix-verify-2.5.6-release）
   - 活跃计划 3 处：`2026-11-01-sync-gallery-custom-photo-dir-实施计划.md:52`、
     `2026-11-01-sync-gallery-photo-dir-apply-on-save-实施计划.md:190`（均指 photo-dir-review-fix）、
     `2026-11-02-nikkisync-upstream-align-02-实施计划.md:8`（指 align-01）
3. **`CHANGELOG.md:13` 头注**：「（已结案轮次的受跟踪归档，本轮待创建）」→「（…建立于 2026-10-30）」。
4. **`docs/plans/2026-10-17-fix-image-watermark-media-auth.md` 头行**：「状态：待执行」与 §10/§11.5 已回填实况矛盾 →
   订正为已结案（注明订正出处）。

### 3.2 非 md 指针修复（闸门盲区，经用户确认一并修）

| 文件                                                                       | 失效指针                                                     | 订正                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| `src/renderer/components/gallery/FullscreenViewer.topbarFix.test.tsx:19`   | 旧活跃路径 topbar-fix 计划                                   | 改 `archive/2026-Q4/`                 |
| `src/renderer/components/gallery/SlideshowPlayer.topbarNoDrag.test.tsx:12` | 同上                                                         | 改 `archive/2026-Q4/`                 |
| `resources/nikkisync/recycle-helper.cs:1`                                  | 指已移入受跟踪归档的 10-25-nikkisync-04                      | 改 `archive/2026-Q4/…-能力层执行记录` |
| `docs/debt-registry.json:373`                                              | 引用活跃/归档区均不存在的 `2026-10-21-fix-ci-smoke-timeout…` | 改指实际落点 `docs/archive/plans/…`   |

### 3.3 根目录核心文档订正（中英同步）

- **README.md**（:101 中文段 / :229 英文段）：services「13 个」→ 16 个（14 个 `*-service.ts` +
  `cloth-diy-cache.ts` + `cloth-data-config.ts`，`ls` 实测 16）。
- **ARCHITECTURE.md / .en.md**（9 类，两份同病同修）：
  1. 头部「最后更新」2026-10-06 → 2026-11-05；
  2. §4 树 + §5.7 表 services 13→16，补 cloth 三件；
  3. §4 树 renderer/utils 32→51（实测 51 = 顶层 33 + resonance/ 14 + share-card/ 4）；
  4. §6.8 hooks 30→31，补 `useGallerySummaryCounts`（媒体操作类 7→8）；
  5. §12.5 `asarUnpack` 11→14，补 `qrcode` / `dijkstrajs` / `pngjs`（2026-11-05 随外部依赖解包修复追加）；
  6. §12.15 `native-path.ts` → `ffmpeg-paths.ts`（原引用指向不存在的文件，与同文 §5.9 自相矛盾）；
  7. 附录 C.3 静态测试计数 454→471（src 434 + scripts 32 + e2e 5，逐目录实测）；2026-10-30 的 7094 用例实跑读数
     保留为最近一次全量快照、注明其后文件数已增长；
  8. §5.8 handlers 表补 4 行（asset-edits / favorites / sync / nikkisync，通道名逐一经源码核实）；
  9. §4 树枚举补缺：app/ 补 gpu-preference / gpu-status / nikkisync-runtime-setup / sync-server-setup；
     utils/ 补 atomic-file / fluent-ffmpeg-shim / image-encode / path-dialect / physical-file-key /
     spawn-error-log / zip-archive；database/ 补 asset-edits-repository 与 sync 系四件；
     nikkisync/ 补 protocol-contract / runtime-types / resource-allowlist / embedding-paths / runtime-cli /
     runtime-cli-report；§6.9 stores 表补 `syncGalleryStore` 行。
- **DEVELOPMENT.md / .en.md**：
  1. 诊断目录旧名 `MeowStarMap\Diagnostics` → `喵星图\Diagnostics`（与 `user-diag-path.ts:13` 的
     `PRODUCT_DIAG_DIRNAME = '喵星图'` 同源；zh 4 处 :334/:671/:677/:722、en 3 处 :334/:679/:685）；
  2. §7.5 asarUnpack 清单 10→14，补 `@nikkisync` / `qrcode` / `dijkstrajs` / `pngjs`，顺序与 package.json 同步；
  3. 中英漂移对齐：en §2.8 补「脚本名冒号两侧不能有空格」条（e2e-usage 守卫）、en §6.10 补齐 zh 版的
     日志位置 / 崩溃 dump / 诊断包导出三条。

### 3.4 docs/ 其他订正

- `docs/tutorial/用户使用教程.md:89`：「九大板块」→「十大板块」，补「同步图库」（与
  `Sidebar.tsx:40-53` navItems 实序一致，插在共鸣录之后）。**按用户裁示只修事实错误**；
  同步图库 / 搭配码面板 / 自定义照片目录的功能章节覆盖滞后不在本轮展开（§4 登记）。
- `docs/PLUGIN_API.md:3`：核对戳 v2.5.0 → v2.5.6（本轮复核：插件宿主三文件、示例插件与 9 条能力桥通道均实际存在）。

### 3.5 本轮记录落盘

本文件即 round 6 轮次记录；`docs/plans/archive/README.md` §2 台账已同步（§3.1.1）。

## 4. 登记不动项与遗留（供下轮裁决）

1. **教程覆盖滞后**：同步图库（2.5.6 主打）、搭配码面板（2026-10-31）、自定义照片目录（2026-11-01）
   在用户教程中零覆盖；补写需新截图与实机走查，宜单独立项。`:4/:575` 的「版本 2.5.0」自洽保留。
2. **`src/main/app/permission.ts:5` 注释失实**（crash 报告 2026-09-27 已指出）：注释称 manifest 为
   requireAdministrator、实际 asInvoker。属代码债，本轮不动代码，仅在此登记。
3. **5 份未回填计划**（§2 判据 2）：round4、toolbar-contrast、cloth phase1-3、qqgroup 重启收口。
4. **2 份「§10 待填」被取代件**（`2026-11-01-review-fix-verify-repack-2.5.6-`、
   `…photo-dir-repack-verify-`）：本轮判 K（结构完整、被 round2 引用），若后续清理可优先复核。
5. **教程 `:211`「35 个内置套装预设」**：与 `scene-category.ts` 的 `id:` 计数恰合，但该文件混含场景类目，
   未逐项区分，低风险未确证项。
6. **`docs/debt-registry.json` 其余非 md 指针**：本轮只修了 :373 一处死路径；archive/README §3.6 所述
   「55 个非 md 被跟踪文件、18 个真实计划路径」的其余指针经本轮抽验未见新增失配。

## 5. 验证读数（2026-11-05，全部亲自运行）

| 闸门                                       | 读数                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run docs:links`                       | ✅ 无死引用（`dead === 0` 契约达成；另 188 处「本机留存区引用与已交代去向」提醒，均为已知口径）                                                            |
| `npm run verify`                           | ✅ 5/5：typecheck 7825ms / lint 1267ms / core-gate 571ms / format 1265ms / test 2776ms（第一轮 format 红于 3 份 md 表格对齐，prettier --write 归一后全绿） |
| `npm run debt:check`                       | ✅ 变更文件未命中任何已登记技术债条目                                                                                                                      |
| `npx vitest run`（两个被改注释的测试文件） | ✅ 2 文件 / 14 用例全过                                                                                                                                    |
| `git status --porcelain`                   | 改动面 14 文件 + 15 份 staged rename（round 5 遗留）+ 2 个 gitignored 删除；与本计划清单逐项一致                                                           |

## 6. 下轮接续点

- 教程新功能章节（§4.1）立项时，截图与文案产出后同步更新 `:4` 的版本声明。
- 若后续轮次归档 round4 等未回填件：先回填再单步 `git mv`，同批改写 CHANGELOG 行与非 md 指针，
  并按 §3.5 更新 archive/README 台账——本轮台账即为查表起点。
