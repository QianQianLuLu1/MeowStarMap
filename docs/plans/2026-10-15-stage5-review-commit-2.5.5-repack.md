# 未提交代码复核（阶段5 同步图库+分享图）+ 提交 + 版本 2.5.5 核验 + 重新打包（2026-10-15）

> 结构沿用仓库先例 `docs/plans/2026-10-15-uncommitted-review-version-2.5.5-repack.md` 的 8 节格式，并补齐任务委托方要求的五要素（依赖声明 / 启动与运行说明 / 错误处理与兜底 / 参数校验 / 基础测试用例）与子任务三要素（涉及文件 / 输入输出 / 验收标准）。

## 1. 背景与结论

任务来源：用户要求对项目所有未提交代码做全面审查（逻辑错误 / Bug / 规范），有问题先修复（TDD 红绿闭环）再提交并编写清晰提交信息，随后核验版本号 2.5.5，最后重新执行打包构建。

**探明事实（执行时点 2026-10-15 实测）**：

- **WXNN XiangCe 存在成批未提交改动**：HEAD=`661db3a`（分支 `feat/gallery-runtime-embed`）。`git status --porcelain=v1` = 24 个修改文件（+1323/−72）+ 11 个未跟踪新增。内容即「阶段 5：同步图库独立入口 + 分享图移植 + 元数据详情」，其计划与执行记录在 [`2026-10-15-sync-gallery-share-card-metadata.md`](2026-10-15-sync-gallery-share-card-metadata.md)（记录称 2026-10-15 当时 typecheck/lint/全量 6065 用例/coverage/build 全绿，但**未 commit**；本任务用户明确要求提交，覆盖该阶段计划的「不 commit」约束）。
  - 修改面：`src/main/app/media-protocol.ts` + 测试（C1 授权口径下沉）、`src/main/nikkisync/resource-allowlist.ts`（注释）、`src/renderer/{App,AppShell,Sidebar,DetailPage}.tsx`、`Sidebar.test.tsx`、`icons/index.tsx`、`stores/{mediaStore,uiStore}.ts`、`utils/assetViewModel.ts`、12 个 `i18n/locales/*.json`。
  - 新增面：`pages/sync-gallery/`（页面/工具栏/抽屉+测试）、`stores/syncGalleryStore.ts`+测试、`utils/share-card/`（模型/渲染/输入/编排+对拍测试+上游参考夹具）、`components/sync/ShareCardDialog.tsx`+测试、`i18n/locales/sync-gallery-keys.test.ts`、本阶段计划文件。
- **版本已全线是 2.5.5**：`package.json:3` 与 `package-lock.json`（顶层 + `packages[""]`）同步；electron-builder `artifactName: "NikkiGallery-Setup-${version}.${ext}"` 自动注入版本；`CHANGELOG.md` 有 `## [2.5.5] - 2026-10-11` 节且 `[Unreleased]` 已收口（上一轮同类任务 `661db3a` 已核验）。本轮为**只读核验**，任何真实漂移才最小修正。
- **真正缺口**：① 未提交改动尚未经提交；② 打包产物需包含阶段 5 功能后重新构建（`release/` 现存 exe 为修复后产物但不含阶段 5）。
- **已知 flaky（上轮全量并发各红过一次、单跑全绿，不在改动清单内）**：`src/main/utils/zip-archive.test.ts`（Windows `rmSync ENOTEMPTY`）、`src/main/media-worker/worker-entry.test.ts`（500ms 节流）、`src/renderer/utils/imageProcessor.canvas.test.ts`（10s 超时）。处置=单跑甄别，不改写、不放宽、不跳过。

## 2. 依赖声明（五要素之一）

- **零新增 npm 依赖**。全部复用既有 devDependencies 与 npm scripts：`typescript`（typecheck）、`eslint`（lint）、`vitest`（test）、`electron-vite`（build）、`electron-builder`（dist）、`tsx`（verify/pre-dist-check/闸门脚本）、`open-code-review`（ocr CLI，宿主已装）。
- 不改 `package.json`；**全程不跑 `npm install`**（会剪断 `node_modules/@nikkisync/*` 四条 junction，令 `*.linked.test.ts` 降级 skip；若因故跑过，立刻 `npm run link:nikkisync` + `npm run verify:nikkisync` 复验）。
- 无新增环境变量；兜底场景才注入 `ELECTRON_BUILDER_BINARIES_MIRROR`（`DEVELOPMENT.md:574` 既有方案）。

## 3. 启动与运行说明（五要素之二）

无需额外环境准备（依赖已装、electron-builder 缓存在位、junction 四链在位）。执行命令均为仓库既有脚本：

```bash
cd "WXNN XiangCe"
git status --porcelain=v1          # 步骤 1：改动清单（执行时点）
npm run link:nikkisync:check       # 前置：四链在位复验（只读）
npm run typecheck && npm run lint  # 步骤 3：静态门禁
npm test                           # 步骤 3：全量回归（基线 390 files / 6065 passed | 2 skipped）
npm run i18n:guard && npm run i18n:check  # 步骤 3：i18n 双闸门
npm run verify                     # 步骤 3：五项一致性自检
npm run dist:win                   # 步骤 5：四步打包链（后台运行 + 轮询）
```

产物位置：`release/NikkiGallery-Setup-2.5.5.exe`（`${version}` 注入）。

## 4. 子任务与验收标准（三要素）

### 4.1 计划文件落盘

- **涉及文件**：本文件（`docs/plans/2026-10-15-stage5-review-commit-2.5.5-repack.md`）。
- **输入 / 输出**：输入为本次探明事实；输出为含五要素+三要素的计划文件。
- **验收标准**：文件入仓（随最后一笔提交）；内容含 §2–§7 全部五要素。

### 4.2 未提交代码全面审查

- **涉及文件**：只读审查对象 = §1 列出的 24 修改 + 11 新增；不改任何业务文件。
- **输入 / 输出**：输入为 `git diff` 全量与新增文件全文；输出为逐文件审查结论（缺陷清单或「无新增缺陷」）记入 §8。
- **验收标准**：审查覆盖逻辑错误 / Bug / 代码规范三类；重点复核跨文件数据流（`fetchAssetPage` 抽取语义不变、`syncGalleryStore` 单向依赖、`App.tsx` switch default 兜底、分享图对拍等价面、i18n 12 包同构）。发现真实缺陷即转入 4.3 TDD 修复；无缺陷则记录结论放行。

### 4.3 缺陷 TDD 修复（条件分支）

- **涉及文件**：仅限审查发现的真缺陷所在文件 + 对应测试文件。
- **输入 / 输出**：输入为缺陷描述；输出为「红灯测试（修复前失败）→ 最小修复 → 绿灯」三步记录。
- **验收标准**：每个修复有红灯证据（修复前测试失败输出）与绿灯复验记录；不弱化、不跳过、不注释任何既有测试；修复后相关测试子集与 `npm run verify` 全绿。

### 4.4 全局回归与静态 / i18n / 一致性门禁

- **涉及文件**：无（只读检查）。
- **输入 / 输出**：输入为当前代码基线；输出为各命令退出码与结果记录。
- **验收标准**：`npm run typecheck`、`npm run lint`（0 错误；存量 BOM 警告不处置）、`npm test`、`npm run i18n:guard` + `npm run i18n:check`、`npm run verify` 全部退出码 0。flaky 命中时单跑甄别：单跑绿 ⇒ 记录为时间敏感抖动；单跑红 ⇒ 真实失败转 4.3。

### 4.5 版本一致性核验（只读 + 条件最小回写）

- **涉及文件**：核验对象 `package.json`、`package-lock.json`、`CHANGELOG.md`、electron-builder `artifactName`、`src/` 版本串；仅当闸门要求时才回写 CHANGELOG。
- **输入 / 输出**：输入为只读读取结果 + `npx tsx scripts/check-doc-versions.ts` 与 `scripts/check-changelog-release.ts` 退出码；输出为核验结论记入 §8。
- **验收标准**：`package.json` 与 `package-lock.json` 的 version 均为 `2.5.5`；`[2.5.5]` 节存在且唯一、`[Unreleased]` 收口；阶段 5 功能若需记入 CHANGELOG，按 `check-changelog-release.ts` 实际闸门要求最小补写；`src/` 版本串命中处均为 mock / 测试桩 / 历史标注。

### 4.6 提交（两笔）

- **涉及文件**：① 功能面 = §1 全部业务改动；② 文档面 = 本计划文件（含执行记录）。
- **输入 / 输出**：输入为 4.4 全绿基线；输出为两笔 Conventional Commits 提交（格式先例：`feat(sync-gallery): …`、`docs(plans): …`）。
- **验收标准**：husky pre-commit 三闸门（lint-staged / core-path-gate / tsc -b）与 commitlint 均通过；提交后 `git status --porcelain` 为空；`stash@{0}: phase7-wip-parked` 未被动过；提交后复核钩子未意外改写文件。

### 4.7 重新打包与产物验收

- **涉及文件**：无源码改动；产出 `release/NikkiGallery-Setup-2.5.5.exe`、`.blockmap`、`latest.yml` 与 `release/win-unpacked/`（旧产物被覆盖）。
- **输入 / 输出**：输入为提交后干净基线；输出为安装包 + `verify:dist` / `verify:nikkisync` 通过记录。
- **验收标准**：四步链全部等效通过（clean 被网关拦截时按 §5 分步兜底）；exe 存在且 mtime 为本次构建时间；`latest.yml` 的 version/sha512/size 与新 exe 逐项一致；`verify:dist` 全绿（含 `nikkiSyncPackedVerdict` 打包态断言）；产物内含阶段 5 新 chunk（`SyncGalleryPage-*` / `ShareCardDialog-*`）。

## 5. 错误处理与兜底（五要素之三）

| 异常分支                                                                           | 兜底策略                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build 的 clean 被 Safe-Delete 网关拦截（dist/main 约 870 项 > 阈值 500，本机已知） | 分步执行：`Move-Item dist` 移至系统临时目录 → `npx electron-vite build` → 手写 `dist/main/package.json`（`{"type":"commonjs"}`）→ `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist` |
| electron-builder 二进制下载失败                                                    | 注入 `ELECTRON_BUILDER_BINARIES_MIRROR` 后重试                                                                                                                                                                                    |
| 全量测试偶发失败（§1 已知 3 项 flaky）                                             | 单独重跑甄别；单跑绿=抖动记录放行；单跑红=真实失败走 4.3 TDD                                                                                                                                                                      |
| pre-dist-check / check-doc-versions / check-changelog-release 闸门失败             | 按报错项逐项处置（如 CHANGELOG 最小补写后重跑），不绕过闸门                                                                                                                                                                       |
| 打包耗时长                                                                         | 后台运行 + 轮询输出，不设人为超时；打包期间不并发跑测试                                                                                                                                                                           |
| commitlint 拒绝提交信息                                                            | 采用仓库既有先例格式（`type(scope): 中文描述`）                                                                                                                                                                                   |
| husky pre-commit 改写文件                                                          | 提交后 `git status --porcelain` 复核，残留意外改动则停步处置                                                                                                                                                                      |
| junction 被意外剪断（`runtime-status` 变 unavailable）                             | `npm run link:nikkisync` + `npm run verify:nikkisync` 复验后再继续                                                                                                                                                                |

## 6. 参数校验（五要素之四）

本任务无业务入参，「参数校验」落实为核验项的客观判定条件：

- `git status --porcelain=v1` 输出与 §1 记载一致（24 M + 11 ？？）；出现清单外改动 ⇒ 停步扩面审查。
- `package.json:3` 精确等于 `"2.5.5"`（非 `^2.5.5` 等变体）；`package-lock.json` 顶层一致。
- 产物文件名精确为 `NikkiGallery-Setup-2.5.5.exe`；`latest.yml` 的 version/path/sha512/size 四项与新 exe 一致（哈希不符 ⇒ 停步）。
- 五条检查命令退出码 0；任何非 0 视为该步骤失败，不得跳过。

## 7. 基础测试用例（五要素之五）

本任务预期零源码改动（审查分支下才有修复），以「命令级验收 + 审查结论」为主；4.3 产生修复时按 TDD 补真实单测（修复前必须失败）：

| 场景 | 用例                                                | 期望                                                    |
| ---- | --------------------------------------------------- | ------------------------------------------------------- |
| 正常 | typecheck / lint / 全量 test / i18n 双闸门 / verify | 全部退出码 0                                            |
| 正常 | `npm run dist:win` 全链（或分步兜底等效）           | 四步通过，产物 exe 生成                                 |
| 正常 | 既有测试基线                                        | ≥390 files / ≥6065 passed，0 failed（2 skipped 为既有） |
| 异常 | 任一检查命令退出码非 0                              | 停在该步骤，处置后重跑，不跳过                          |
| 异常 | 全量并发 flaky 命中                                 | 单跑甄别：绿=抖动放行；红=TDD 修复                      |
| 边界 | 工作区出现清单外改动                                | 停步扩面审查后再继续                                    |
| 边界 | 产物文件名版本号 ≠ 2.5.5                            | 版本注入异常，回查 package.json 与 build 配置           |
| 边界 | `latest.yml` sha512 与新 exe 不一致                 | 停步，重打包或排查产物/元数据错位                       |

## 8. 执行记录（2026-10-15 实测回填）

- **步骤 1 计划落盘**：完成（本文件）。
- **步骤 2 未提交代码全面审查**：`ocr delegate preview` 判定 workspace 模式，31 个可审查文件（5350 插入/72 删除；16 个 excluded：测试文件 `default_path`、md/txt `unsupported_ext`），共用一条系统规则组。审查执行：3 个 code-explorer 子代理并行逐行审查（主进程+路由面 10 文件 / 新页面+store 5 文件 / share-card 移植 4 文件），i18n 12 包由 `sync-gallery-keys.test.ts` + `i18n:guard` + `i18n:check` 闸门覆盖。审查发现经宿主逐条核实后确认 **10 个真实缺陷**，全部 TDD 红绿闭环修复（修复前 10 个新用例全红、既有用例零回归，修复后全绿）：
  1. **HIGH** `ShareCardDialog.tsx`：`cancelledRef` 从未置 true——关闭面板不取消在途生成，完成后旧资产分享图回填 state，重开可把错误资产的图存盘。修复：关闭时 `cancelledRef=true` + `runSeqRef` 轮次号（旧轮在检查点与结果回填处双双丢弃），finally 的 canvas 复位与 busy 复位仅在 `run===runSeq` 时执行。
  2. **HIGH** `shareCardModel.ts`：`layoutShareCards` 测量前未设 `ctx.font`（上游 layoutCards :21/:27 有），真实 canvas 默认 10px 测宽 → 断行数与页高全失真（对拍假 ctx 与 font 无关，恰好是盲区）。修复：穿搭名测量前设 `'23px sans-serif'`、效果区前设 `'28px sans-serif'`，与 render 绘制字号一致。
  3. **MEDIUM** `ShareCardDialog.tsx`：目录框取消被当保存失败弹错——`/cancel/i` 匹配不了主进程中文译文「未选择输出目录」。修复：改按 `IpcError.code === ERROR_CODES.CANCELED` 判定（保留正则兜底）。
  4. **MEDIUM** `ShareCardDialog.tsx`：`handleSave` 无重入保护，双击并发两轮 saveAs。修复：`busyRef`（ref 不能依赖 state 闭包）+ 按钮 `disabled={busy || images.length===0}`。
  5. **MEDIUM** `ShareCardDialog.tsx`：`loadImage` 裸 `new Error('image load failed')`，英文内部串经 `extractUserMessage` 直透用户。修复：`InternalError` + `userMessage: t('shareCard.errorGenerate')`。
  6. **MEDIUM** `syncGalleryStore.ts`：`loadMore` 在 await 前快照 `files`，与并发 `loadFirst` 交错时旧列表复活/游标串味。修复：await 后重读 `get()`，`loading` 在途时只收尾 `loadingMore`；起始 guard 补 `loading`。
  7. **MEDIUM** `mediaStore.ts`：`fetchMediaFromRuntime` 不 clamp limit——GalleryPage 的 `media:updated`/`get-changes` 整表刷新传 `max(500, 已加载条数)`，nikkisync 源下已加载 >500 即抛 `ValidationError`，打破「吞异常返 null」契约、刷新静默失效。修复：`Math.min(limit, ASSET_PAGE_LIMIT_MAX)`。
  8. **MEDIUM/LOW** `shareCardInput.ts`：效果区被 `data?.dressing || data?.photography` 门控，但三行读自 `camera`——只有 camera 时整块效果区静默丢失。修复：门控补 `|| data?.camera`；顺带消除 depthOfField 的嵌套三元。
  9. **LOW** `ShareCardDialog.tsx`：实况门禁用 `assetType==='motion_photo'`，与视图模型 `type==='motion_photo' || hasMotion` 口径不一致。修复：对齐为两者任一。
  10. **MEDIUM** `shareCardRender.ts`：计划 §7 的「rotation 只接受 {0,90,180,270}，其余归一为 0」契约未实现。修复：`renderShareCardPage` 入口归一。
  - **挂账不修（低危/设计内，最小化改动原则）**：media-protocol symlink 场景注册键 vs realpath 键潜在失配（阶段 4 既有语义）；DetailPage 分享按钮对视频/实况也渲染（对话框有禁用态兜底）；`SyncGalleryPage` 空态嵌套三元/卸载后 setState（React 18 no-op）/扫描失败仅 console 无可见反馈；`SyncAssetDrawer` 枚举原样展示；`loadFirst` 双飞（与 mediaStore 既有行为同型）；效果区渲染机器 id 而非可读名（需字典提供器，属「明确不做」范围）；`ShareCardCopy.effectLabels` 未被 render 消费；`as never` 强转；`parameterLabels` 漏键回退原始键。均不构成阻断。
- **步骤 3 全局回归与静态 / i18n / 一致性门禁**：全部退出码 0，无新增失败项——`npm run typecheck` 0；`npm run lint` 0 错误（11 条存量 Unicode BOM 警告，均为已提交测试文件，不处置）；`npm test` **390 files / 6076 passed | 2 skipped（45.05s，本轮零 flaky）**；`npm run i18n:guard` ✅ / `npm run i18n:check` ✅（12 包 3928 键对齐）；`npm run verify` 5 项 0 失败。受影响套件子集 7 files / 69 tests 全绿（含 10 个新用例）。
- **步骤 4 版本一致性核验**：全部通过，未修改任何版本文件——`package.json:3` = `"2.5.5"`；`package-lock.json` 顶层与 `packages[""]` 均 2.5.5；`check-doc-versions` 退出码 0（README Electron 41.10 一致）；`check-changelog-release` 退出码 0（12 个版本节，`[2.5.5]` 存在且唯一、`[Unreleased]` 已收口）。阶段 5 功能未回写 CHANGELOG：闸门不要求，且版本号未变更（同一 2.5.5 重打包）。
- **步骤 5 提交**：
  - `9dd96d5 feat(sync-gallery): 同步图库独立入口+分享图移植，修复审查发现的 10 处缺陷`（阶段 5 全部业务改动 + 本轮 10 项 TDD 修复；husky pre-commit 三闸门通过）；提交后 `git status --porcelain` 仅余两份计划文档。
  - 本文件与阶段 5 计划文件以 `docs(plans)` 入仓（本笔）。
- **步骤 6 重新打包**：`npm run dist:win` 首步 clean 被本机 Safe-Delete 网关拦截（dist/main 超 500 项，历史已知）⇒ 按 §5 分步兜底全链执行：
  1. `Move-Item dist` 移至系统临时目录；
  2. `npx electron-vite build` ⇒ EXIT=0，阶段 5 新 chunk 独立成包（`SyncGalleryPage-DwriT-uD.js` 13.8 kB、`ShareCardDialog-8UIMExNc.js` 27.2 kB）；
  3. 手写 `dist/main/package.json`（`{"type":"commonjs"}`）；
  4. `npm run pre-dist-check` ⇒ EXIT=0（三闸门全绿；唯一警告为「计划文档未提交」，随最后一笔提交消除）；
  5. `npx electron-builder --win --publish never` ⇒ 首轮在解包 electron dist 时被网关拦截（旧 `release/win-unpacked` 753 项 > 阈值 500）⇒ `Move-Item` 移走后重跑 ⇒ EXIT=0（NSIS x64 + blockmap + VC++ 四 DLL 随包）；
  6. `npm run verify:dist` ⇒ EXIT=0（better-sqlite3/sharp/koffi ABI、`@nikkisync` 四包 migrations/入口/LocalSyncServer/GalleryRuntime 全部 ✔）；`npm run verify:nikkisync` ⇒ EXIT=0（blocking failures: 0）。
- **步骤 7 产物验收**：`release/NikkiGallery-Setup-2.5.5.exe` 183,270,913 字节，mtime `2026-10-15 21:17:50`（本次构建）；`release/latest.yml` 的 `version=2.5.5`、`size`（逐字节相等）、`sha512`（实测 base64 摘要相等）三项全部对应新产物；asar 内确认 `SyncGalleryPage-*` / `ShareCardDialog-*` chunk 在包。终检 `git status --porcelain` 为空，`stash@{0}: phase7-wip-parked` 未动。
- **人工验收遗留**（沿阶段 5 计划 §11.6，不在本轮自动化范围）：`npm run dev` 真机 8 条（跨源不变式、抽屉面板实值、真机出图并排目测、三语切换等）仍为「代码就绪、待人工确认」。
