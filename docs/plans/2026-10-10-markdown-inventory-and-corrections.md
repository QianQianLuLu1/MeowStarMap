# 全仓 Markdown 盘点、清理判定与失效内容订正（2026-10-10）

> 本文为 2026-10-10 轮次快照，当前口径以主规约文档为准（生命周期/约定见根 AGENTS.md 与 docs/CODING_CONVENTIONS.md；通道见 docs/IPC_CONTRACT.md）。

## 1. 背景与结论

对仓库全部 `.md` 做了盘点、根文档准确性审查与失效内容订正。三条结论：

1. **本轮不删任何文件。** 43 个被 git 跟踪的 markdown 全部具备长期价值；60 个 `docs/archive/**` 文件已被 `.gitignore:184` 排除在仓库之外，且被 8 处跟踪代码注释引用，删除只会把注释变成孤儿；AI 工具目录属本机/工具状态而非仓库资产。
2. **真正的问题是内容失真。** 根文档与嵌套 AGENTS.md 中有一批已被代码推翻的硬事实（Electron / Vite / Vitest / Node 四个版本号、worker 数量与产物路径、preload 命名空间数、测试文件与用例数、IPC 通道规模），`docs/技术债清单.md` 有 2 条已清偿却仍标 open 的债务，面向玩家的用户手册有 6 处错误陈述（其中 2 处涉及数据安全）。
3. **自动化闸门只能测到路径存在性，测不到语义正确性。** `scripts/check-doc-versions.ts` 只正则扫 README 的 Electron 版本，本次错值几乎全部从 ARCHITECTURE / DEVELOPMENT 及其 `.en` 双胞胎漏出。

本轮共改动 **34 个文件**（33 个 `.md` + `docs/debt-registry.json`），另新增本盘点文档 1 个。根 `AGENTS.md` 的大小写修正经两步 `git mv` 后**索引与 blob 均无变化**（`dfdf30e1a1fa15b82e88fe2a0d7a2729d3ef6ed8`，前后一致），仅把工作区磁盘名从 `agents.md` 归一回 `AGENTS.md`，因此**不产生任何 diff、无需单独提交**——比原计划预期的「rename + 内容双重大 diff」更干净。

---

## 2. 依赖声明

### 2.1 本轮依据的实测真值（全部由命令取得，非推断）

| 项                           | 真值                                                                 | 取得方式                                                                        |
| ---------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 应用版本                     | `2.5.3`                                                              | `package.json` `version`                                                        |
| Node 引擎下限                | `>=22.12.0`                                                          | `package.json` `engines.node`                                                   |
| `.node-version`              | `22`                                                                 | 直接读取                                                                        |
| Electron / Vite / Vitest     | `41.10.6` / `^6.4.4` / `^5.0.3`                                      | `package.json` 依赖表                                                           |
| React / TS / Tailwind        | `^19.2.7` / `^5.9.3` / `^3.4.19`                                     | 同上                                                                            |
| worker 入口数                | **6**（scanner / media / thumbnail / video / database / decryption） | `electron.vite.config.ts:87-92`，产物 `dist/main/main/app/*-worker.js` 实测存在 |
| preload 命名空间             | **30** 个 `api/*.ts`；`electronAPI` **31** 键                        | `ls`；`preload.test.ts:72` 用例标题逐字核对                                     |
| `IPC_CHANNELS` 规模          | 23 个域前缀 / 91 个键 / 86 个唯一通道名                              | 脚本解析 `src/shared/types/ipc.ts`                                              |
| 全量测试                     | **334 个文件 / 5269 个用例，全绿**（33.62s）                         | `npm test` 实跑                                                                 |
| `registerXxxHandlers` 注册数 | 40                                                                   | `grep -c` `src/main/app/ipc-setup.ts`                                           |
| locale                       | 12 个 JSON；`SUPPORTED_LANGUAGES` 13 条（含 `auto`）                 | `ls` + `src/renderer/i18n/index.ts`                                             |
| `vite-env.d.ts`              | 1184 行                                                              | `wc -l`                                                                         |
| git tag                      | **0 个**                                                             | `git tag \| wc -l`                                                              |
| 远端                         | `github.com/QianQianLuLu1/NikkiGallery`                              | `git remote -v`                                                                 |

### 2.2 必须绕开的自动化闸门

| 闸门                                            | 约束                                                                                                                                                                 | 本轮的处置                                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/build.yml:76-99`             | 改 IPC handler / preload 必须同批带 `docs/IPC_CONTRACT.md`                                                                                                           | 未动任何 `.ts`；该文件只增不删                                                                                                                                                                                                                   |
| `scripts/__tests__/verify-format-scope.test.ts` | `docs/CODING_CONVENTIONS.md` 正文区（锚 `^# 项目编码约定`）与 `.qoder/rules/project-conventions.md` **逐字相等**（实测各 8498 字节）                                 | **未编辑** CODING_CONVENTIONS.md（`.qoder/` 属免动区，无法同步镜像）；审查亦确认该文件无事实错误                                                                                                                                                 |
| 同上                                            | 根 AGENTS.md 须逐字含全部含 prettier 的 lint-staged 键、导航表每行可解析、不得出现「与 pre-commit 钩子等效」「project-conventions.md」                               | 未触碰导航表与口径段                                                                                                                                                                                                                             |
| 同上                                            | 只校验：根 AGENTS.md 导航表每行 `](path)` 可解析、CODING_CONVENTIONS 正文与 `.qoder` 镜像逐字相等、AGENTS.md 逐字含全部 prettier 键、指引文件不得指向 `.qoder/` 规则 | **未编辑** CODING_CONVENTIONS.md（`.qoder/` 属免动区，无法同步镜像）；未触碰导航表与口径段。注意：**没有任何工具校验其余被跟踪文档（README / ARCHITECTURE / docs/**）的 `[x](path)` 链接**，反引号内联路径更是不被解析，故 §8 单独登记为遗留风险 |
| prettier 作用域                                 | 根 `*.{ts,js,json,md}` 与 `src/**/*.{js,jsx,json,css,md}` 在闸门内；`scripts/AGENTS.md`、`docs/**` 不在                                                              | 仅对闸门内文件跑 `--write`；**未**对 `docs/**` 跑 `--write`（会重排批次外内容）                                                                                                                                                                  |
| `scripts/debt/*`                                | 硬编码 `docs/技术债清单.md` + `docs/debt-registry.json`；`check-debt-fix.ts:181` 跳过 `done`/`wont_fix` 且恒 `exit 0`                                                | 状态双写，改后实跑 `npm run debt:check` = exit 0                                                                                                                                                                                                 |

---

## 3. 启动与运行说明（实际执行顺序与验证）

| 批次 | 内容                                  | 验证                                                               | 结果            |
| ---- | ------------------------------------- | ------------------------------------------------------------------ | --------------- |
| B0   | 基线取数                              | 逐项命令实测                                                       | 完成，见 §2.1   |
| B1   | 根文档版本号与规模订正                | `prettier --check` + `git diff --stat`                             | ✓               |
| B2   | README 断链 + CHANGELOG tag 注记      | 同上                                                               | ✓               |
| B3   | 嵌套 AGENTS.md 订正（9 个文件）       | `prettier --check`（app/AGENTS.md 需重排表格，已 `--write`）       | ✓               |
| B4   | `docs/` 事实订正 + registry JSON 同步 | `npm run debt:check`、JSON.parse 校验、表格列宽实测                | ✓               |
| B5   | 用户使用教程专批                      | 逐条源码取证 + 48 张配图引用全部命中                               | ✓               |
| B6   | 轮次快照注记（12 个文件）             | BOM 扫描 + 列宽一致性校验                                          | ✓               |
| B7   | 本文档                                | —                                                                  | —               |
| B8   | 终局全量验证                          | typecheck / lint / i18n:guard / debt:check / 两套守卫 / `npm test` | ✓ 全绿，见 §7.2 |

每批通用验证：`npx prettier --write <闸门内文件>` → `npx prettier --check --end-of-line auto <本批文件>` → `npm run verify`。各批 `[VERIFY] ✓ 全部通过`（exit 0）。

---

## 4. 盘点清单

### 4.1 被 git 跟踪的 43 个 markdown —— 全部保留

**根目录（7）**：`AGENTS.md`、`README.md`、`CHANGELOG.md`、`ARCHITECTURE.md`、`ARCHITECTURE.en.md`、`DEVELOPMENT.md`、`DEVELOPMENT.en.md` —— 保留 + 订正。

**`docs/` 活引用（12）**：`CODING_CONVENTIONS.md`（受镜像闸门保护，禁改正文）、`IPC_CONTRACT.md`（CI 闸门要求，禁删）、`PLUGIN_API.md`、`channel-discovery.md`、`perf-regression.md`（被 `save-perf-baseline.ts`/`e2e/perf.e2e.ts` 引用）、`troubleshooting-npm-audit-mirror.md`、`troubleshooting-spawn-eftype.md`、`Storybook使用指南.md`、`组件文档规范.md`、`技术债清单.md`、`manual-smoke-checklist.md`、`tutorial/用户使用教程.md`。

**嵌套 `AGENTS.md`（13）**：根 + `scripts/` + `src/main/{app,database,ipc/handlers,media-worker,preload,scanner,services,thumbnail,utils}/` + `src/{renderer,shared}/`。

**轮次快照 / 一次性记录（14）**：`docs/plans/*.md` 10 个 + `docs/packaged-scan-crash-report.md` + `docs/i18n/fix-sop.md`（自带「历史文档」banner，未重复添加）+ `docs/2.5.0/RELEASE_NOTES_v2.5.0_illustrated.md` + `docs/plans/2026-08-29-resonance-offline-data-report.md`。

**样例包（1）**：`plugins-samples/custom-watermark-template/README.md` —— 保留·本轮不审（需另轮以插件实际加载路径取证）。

### 4.2 未跟踪 / 被忽略 —— 仅登记，不处置

| 分组                                                                                     | 数量          | mtime 范围      | 忽略规则                                    |
| ---------------------------------------------------------------------------------------- | ------------- | --------------- | ------------------------------------------- |
| `.codebuddy/`（plans 119 + memory 29）                                                   | 148           | 09-14 → 10-09   | `.gitignore:153`                            |
| `.qoder/`（repowiki 124、better-harness* 123、canvases 18、skills 18、rules 1、specs 1） | 141           | 09-14 → 10-04   | `:122`                                      |
| `.zcode/plans/`（**55 个 `plan-sess_*` 自动会话产物** + 9 个手写名）                     | 64            | → 10-08         | `:154`                                      |
| `docs/archive/`（60 md + 2 py）                                                          | 60            | 09-14 → 10-06   | `:184`                                      |
| `release/`                                                                               | 21            | 2019-06 → 10-10 | `:7`                                        |
| `.trae/documents/`                                                                       | 5             | 09-14 → 10-08   | `:150`                                      |
| `.cache/`、`wxnn-photo-manager/node20/`、`.workbuddy*`、`.mimosa*`                       | 5 / 2 / 2 / 2 | —               | `:26` / `node20/` / `:103-104` / `:145-146` |

`wxnn-photo-manager/` 父目录本身**未**被忽略，仅其 `node20/` 被 `:58` 命中——该 Node 20.18.1 便携包与当前 `>=22.12.0` 引擎要求已不符，属本机遗留，登记不处置。

### 4.3 重复对（登记为可维护性债务，本轮按口径不收敛）

`archive/项目架构全景.md`(41KB) ↔ `ARCHITECTURE.md`(161KB)；`archive/plans/2026-09-29-fix-thumbnail-loading-latency.md`、`archive/plans/THUMBNAIL_OPTIMIZATION_PLAN.md` ↔ `docs/plans/2026-10-09-*`；`archive/plans/2026-09-25/28 spawn-eftype` ↔ `troubleshooting-spawn-eftype.md`；`archive/plans/2026-09-26-npm-audit-mirror-bypass.md` ↔ `troubleshooting-npm-audit-mirror.md`；`archive/packaged-scan-crash-diagnosis-plan.md` ↔ `packaged-scan-crash-report.md`。根 README 的技术栈表 / 目录树 / 常用命令与 ARCHITECTURE §2.1·§4、DEVELOPMENT §三·§二·附录C 三份并存。

---

## 5. 订正明细（共 34 个文件）

### 5.1 根文档

| 位置                         | 原文（错）                                                                              | 现文                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ARCHITECTURE(.en) 技术栈表   | Electron `40.10` / Vite `5.4` / Vitest `1.6`                                            | `41.10` / `6.4` / `5.0`                                             |
| ARCHITECTURE(.en) §2 正文    | `Electron 40 提供 utilityProcess…五个 worker（scanner/database/media/thumbnail/video）` | `Electron 41`；**六个** worker，补 `decryption`                     |
| ARCHITECTURE(.en) 附录       | `Electron 40.10 + … + Vite 5`                                                           | `Electron 41.10 + … + Vite 6`                                       |
| ARCHITECTURE(.en) 测试规模   | `Vitest 1.6，263 个测试文件 / 4476 个用例（2026-09-06 实测，全绿）`                     | `Vitest 5.0，334 个测试文件 / 5269 个用例（2026-10-10 实测，全绿）` |
| ARCHITECTURE(.en) shared 表  | `IPC_CHANNELS`（13 域 ~60 个通道名常量）                                                | （23 个域前缀 / 86 个唯一通道名常量）                               |
| ARCHITECTURE(.en) preview 表 | 列 `install.ts`；漏 `resonance-mock.ts`                                                 | 改 `mock/install.ts`，补 `mock/resonance-mock.ts`                   |
| README 中英两半              | Vite 5.4 / Vitest 1.6 / Node `>= 20`                                                    | Vite 6.4 / Vitest 5.0 / `>= 22.12.0`                                |
| README 中英两半              | `[Releases 页面](../../releases)`（解析到仓库外）+「下载最新版安装包」                  | 完整 URL + 「尚未推送版本 tag，该页面可能暂无内容」                 |
| DEVELOPMENT(.en) §1.1·§1.3   | Node `20.x（LTS）`、`.node-version` 锁定为 20、预期 `v20.x.x`                           | 三处均为 22 / `v22.x.x`                                             |
| CHANGELOG 链接定义区         | 5 条 compare/tag 链接指向不存在的 tag                                                   | 保留原链接，上方补「本仓库尚未推送任何 git tag」注记                |

### 5.2 嵌套 AGENTS.md

- `thumbnail/AGENTS.md`、`media-worker/AGENTS.md`：产物路径 `dist/main/main/<模块>/worker-entry.js` → `dist/main/main/app/<name>-worker.js`，fork 参数同步；worker 数量口径统一为 6 个入口。
- `scanner/AGENTS.md`：`4 个 worker + database-worker` → `6 个 worker 入口`。
- `services/AGENTS.md`：删除不存在的 `share-clipboard-service.*.ts` 行，渠道检测并入主文件说明。
- `preload/AGENTS.md`：29 → 30 个命名空间；引用的测试标题改为逐字实测的「包含全部 31 个键（reportReady + 30 个命名空间）」。
- `utils/AGENTS.md`：测试文件数与「源文件有配套测试数」区分表述；`ProgressThrottle` 100ms → 200ms（实测默认值，钳制 [100,1000]）。
- `app/AGENTS.md`：「23 个源文件全部有对应测试」→ 20 个（`app-context.ts`、`auto-update.ts`、`renderer-bridge.ts` 实测无测试）；`setupIPC` 「30+」→ 40。
- `scripts/AGENTS.md`：`21/25 为 TypeScript` → `15/25`，并补齐其余 10 个（2 cjs / 2 js / 6 ps1）的归属说明。
- `renderer/AGENTS.md`：「其余 12 种语言」（实枚举 11）→ 11 种，另注 `auto`。

### 5.3 `docs/`

- **技术债清单 + registry JSON 双写**：DEBT-019（主题变量提权 `html.soft-pink-luxury` 已在 `soft-pink-luxury.css:8,270` 落地）、DEBT-022（缩略图行为级测试已补齐）状态 `open` → `done`，并在正文以 `>` banner 形式记录清偿证据（沿用文档既有「✅ 白名单全量清偿」写法，避免整表重排）；DEBT-012 行数 930 → 1184（两处）。死路径 `docs/plans/2026-09-29-fix-gallery-stack-overflow.md` 补「已归档、不入仓」说明。
- **IPC_CONTRACT**：§2.5「检查 `res.success` 的调用方共 4 处」→ 实测 **6 处**（补 `DuplicatesPage.tsx` 两处），并把写死行号改为按调用点符号检索；§2 开头补「本节仅为重复/相似检测与回收站链路，不构成完整通道清单」。
- **channel-discovery**：`13 用例` → 实测 9；`既有 34 用例` → 实测 42；结尾「预先失败项」注记改为「该失败现已不存在（附 2026-10-10 全量结果）」。
- **troubleshooting-spawn-eftype**：`early-crash-guard.ts:139-235` → `141-244`；`game-directory-discovery.ts:409,506,919` → `411,508,966`；`share-clipboard-service.ts:414,542,609,644,802,871` → 实测 7 处 `315,434,562,629,664,822,891`；表上加「行号会漂移，请以调用点符号定位」提示。`lifecycle.ts` 与 `desktop-shortcut.ts`、`permission.ts` 三行经复核仍准确，未改。
- **manual-smoke-checklist**：2 处 `docs/archive` 引用补「不入仓」说明。

### 5.4 用户使用教程（面向玩家）

| 原文（错）                                              | 现文                                                                                      | 举证                                                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 「四种视图」                                            | 五种，补**活动时间轴**                                                                    | `GalleryToolbar.tsx` `viewModes`、`uiStore.ts:73`、locale `gallery.toolbar.viewMode.eventTimeline` |
| 视频「编辑入口尚未开放」                                | 已提供裁剪 / 调速 0.25x–4.0x / 水印 / 调色 / 导出 MP4·MOV·WebM / Live Photo，均输出新文件 | `EditorPage.tsx:757-759`、`VideoEditor.tsx:56-57`                                                  |
| 插件「显示不可用，等后续版本开放」                      | 已开放安装（npm 包名或本地 `.tgz`）、启用、禁用、卸载、检查更新、权限与扩展点详情         | `plugin-sections.tsx`、locale `settings.plugin.*`                                                  |
| 「彻底删除后系统回收站里也还有一份」（正文 + FAQ 两处） | 直接 `fsp.unlink` 物理删除并释放空间，**系统回收站没有备份**，只剩软件回收站一道保险      | `file-service.ts:423-430`、commit `80d910a`、IPC_CONTRACT §2.7/§2.8                                |
| 「13 种语言」                                           | 12 种语言 + 「跟随系统」选项                                                              | `locales/*.json`=12、`SUPPORTED_LANGUAGES`=13                                                      |
| 「按分组整理了全部配置项」（实缺诊断组）                | 明确 9 个分组，补「日志与诊断」（扫描链路诊断 / 日志管理 / 崩溃报告，可一键导出日志）     | `SettingsPage.tsx:140-160`、`scan-log-diagnostic-section.tsx:83-87`                                |

### 5.5 轮次快照处理（12 个文件）

每个文件一级标题下插入一行「本文为 X 轮次快照，当前口径以主规约文档为准…」；历史数字**不覆写、就地括注**，形如 `331 个文件、5236 个用例（现 334 / 5269，2026-10-10 实测）`、`39 个 registerXxxHandlers（现 40）`。`round2` 的「执行中」状态保留并补后续落地提交号；`2026-09-30-electron-40-eol` 的「待排期」保留并补「已由 `fd81fef` 升级完毕」。**唯一例外**：`2026-08-24-跨模块集成测试设计.md` 经复核**确未实施**（无 `test:integration` 脚本、无 `sqlite-adapter`/`ipc-transport`/`ctx-factory`、6 个拟新增 `*.integration.test.ts` 一个都没有），banner 写明「仍是开放待办」而非「已完成」。

---

## 6. 错误处理（本轮实际遇到的两处自身失误，均已修）

1. **改宽度导致整表重排**：`IPC_CHANNELS` 单元格加长使 ARCHITECTURE 的 shared 表 13 行被 prettier 重排。已确认为 prettier 规范结果且限于单张表，接受之（计划 §三.3 已预告「会被 `--write` 重排表格列」）。
2. **误删换行**：给 `2026-09-30-electron-40-eol` 插快照行时，一次 Edit 把 `- 日期：…` 与 `- 状态：…` 合并成一行。已 `git diff` 定位并拆回两行，复核无残留合并行。
3. 另修正了自己新引入的两处不实引用：备份小节应为 **16.6**（初写成 16.5）；诊断子项名为**扫描链路诊断 / 日志管理 / 崩溃报告**（初写成 扫描日志 / 运行日志 / 崩溃记录）。均以源码与 locale 复核后改正。

结论性约束：**任何写进文档的数字、路径、小节号、命令，落笔前后必须实测或复读源码**；对 `docs/**` 只用 Edit 或宽度校验脚本，不用 `--write`。所有脚本化改写均以 UTF-8 无 BOM 写回并保留原 EOL（已对 34 个改动文件逐个 `head -c 3` 扫 BOM，零命中）。

---

## 7. 验证

### 7.1 每批（已通过）

```bash
npx prettier --write <闸门内文件>
npx prettier --check --end-of-line auto <本批文件>   # All matched files use Prettier code style!
npm run verify                                       # [VERIFY] ✓ 全部通过 — 可以安全提交
```

### 7.2 全量（终局，2026-10-10 实测结果）

| 命令                                              | 结果                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck`                               | ✓ `tsc -b` + `tsc -p tsconfig.scripts.json` 无输出                                                                             |
| `npm run lint`                                    | ✓ exit 0；**0 error**，11 warning 全部是 DEBT-030 登记的 `src/renderer/components/common/*.test.tsx` BOM（本轮未触碰这些文件） |
| `npm run i18n:guard`                              | ✓ 「白名单只减不增、清零必移除、key 已同步」                                                                                   |
| `npm run debt:check`                              | ✓ exit 0（registry 改 done 后仅减少提醒，不影响门禁）                                                                          |
| `verify-format-scope.test.ts` + `preload.test.ts` | ✓ 2 files / **52 tests passed**（镜像逐字、导航表可解析、lint-staged 键清单、31 键断言均未破）                                 |
| `npm test`                                        | ✓ **334 个文件 / 5269 个用例全绿**，34.43s，exit 0                                                                             |

### 7.3 判定式断言（实跑）

- `grep -rn "40\.10|Vite 5\.4|Vitest 1\.6|>= 20|../../releases" README.md ARCHITECTURE*.md DEVELOPMENT*.md` → **零命中**。
- `grep -n "四种视图|尚未开放|（体验功能）|13 种语言|系统回收站里也还有" docs/tutorial/用户使用教程.md` → **零命中**。
- `git diff --stat docs` → 19 个文件 **56 insertions / 27 deletions**，与订正处数相称，无整文件重排（证明未对 `docs/**` 误用 `--write`）。
- 34 个改动文件逐个 `head -c 3 | od` 扫 BOM → **零命中**（符合「UTF-8 无 BOM」硬约定）。
- **反向验证镜像闸门真实有效**：临时往 `docs/CODING_CONVENTIONS.md` 追加一行 → `verify-format-scope.test.ts` 立刻 `1 failed | 34 passed`；`git checkout --` 还原后复跑 `35 passed`，并与 `HEAD` blob 逐字节 `cmp` 一致。这既证明该闸门不是摆设，也证明本轮**确实没有**改动该文件正文。
- 大小写修正前后 `git hash-object` 均为 `dfdf30e1a1fa15b82e88fe2a0d7a2729d3ef6ed8`，`git status` 对该文件无记录。

---

## 8. 遗留风险与本轮不处置项

1. `scripts/check-doc-versions.ts` 只覆盖 README 的 Electron 版本；ARCHITECTURE / DEVELOPMENT / `.en` 的版本号**无人守护**，本轮错值正是从此漏出。建议下轮以白名单形式扩展并配套单测。
2. **文档链接完全没有自动化校验。** 本轮逐一读过 `scripts/__tests__/verify-format-scope.test.ts` 的全部用例：它只守护根 AGENTS.md 导航表、CODING_CONVENTIONS 镜像、lint-staged 键清单与「指引出处」四类，**不解析 README / ARCHITECTURE / DEVELOPMENT / docs/\*\* 里的 `[x](path)`**，反引号内联路径更是任何工具都不看。因此 `docs/技术债清单.md` 里指向已归档文件的路径、README 原先指向仓外的 `../../releases` 这类死引用可以长期存活——本轮靠人工审查发现。建议下轮新增一个覆盖全部被跟踪 md 的链接/内联路径守护脚本（并配套单测）。
3. `src/main/media-worker/bktree-js.ts:9` 注释指向不存在的 `docs/archive/BKTREE-REPLACE-PLAN.md`——属代码注释，改它违反最小改动且牵动 eslint/prettier，仅登记。
4. `CHANGELOG.md` 的 `## [Unreleased]` 已积压 27 个提交未升版本号；仓库**无任何 git tag**，导致 CHANGELOG 全部版本比较链接 404。属发布流程，非文档错误。
5. `docs/archive/**`（60）与跟踪文档存在 9 组主题重复；根 README / ARCHITECTURE / DEVELOPMENT 三份技术栈表与目录树并存。按既定口径不做重复收敛。
6. `docs/plans/2026-08-24-跨模块集成测试设计.md` 仍未实施，是真实的测试缺口而非文档问题。
7. AI 工具目录内的内容错误（含 `.qoder/skills/**/SKILL.md` 的路径引用）本轮不审不改。
8. `wxnn-photo-manager/node20/`（Node 20.18.1）与 `engines.node >=22.12.0` 不符，父目录未被 gitignore 覆盖；本机遗留，未处置。
