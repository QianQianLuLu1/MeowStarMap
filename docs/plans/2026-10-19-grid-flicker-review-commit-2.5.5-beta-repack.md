# 网格闪烁提交复核、发布轮与 2.5.5-beta 重新打包（2026-10-19）

- 日期：2026-10-19
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `86b4b8c`
- 状态：执行中；逐节点读数见 §11 执行记录
- 上一轮同类工作：`docs/plans/2026-10-18-uncommitted-review-commit-2.5.5-beta-repack.md`（提交 `acdea69`）；被复核的那轮修复计划为 `docs/plans/2026-10-18-fix-gallery-grid-scroll-flicker.md`（提交 `8491ff7` / `8f0e427` / `86b4b8c`）

## 0. 背景（Context）

本轮请求是「审查所有未提交的代码并提交 → 版本号改为 2.5.5-beta → 重新打包」。三条前提先做只读取证，**两条不成立**，据实改道：

| 前提（请求的假设）      | 取证命令                                                           | 现场输出                                                                                                                                      | 判定                                 |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 存在未提交代码          | `git status --porcelain=v1`、`git diff --cached --stat`            | 两条输出皆空                                                                                                                                  | **不成立**                           |
| 版本号待改为 2.5.5-beta | `git grep -n '"version"' -- package.json`、读 `release/latest.yml` | `package.json:3`、`package-lock.json:3` 与 `:9`、`src/renderer/preview/mock/database-mock.ts:664`、`release/latest.yml` 全部已是 `2.5.5-beta` | **不成立**（一处不改）               |
| 安装包需重出            | `ls -l release/` 对比 `git log -1 --date=iso-local 8f0e427`        | exe 构建于 2026-10-18 21:37，`fix(gallery)` 提交于 23:04                                                                                      | **成立**：现存安装包不含网格闪烁修复 |
| 该修复未经发布轮复核    | `git log -1 --stat`、`git grep -n 闪烁 -- CHANGELOG.md`            | `8f0e427` 之后只进过 1 个 docs 提交；变更日志 0 命中                                                                                          | **成立**                             |

用户对本轮范围选定三项：① 复核「图库网格闪烁」相关最新提交；② `stash@{0}`（`phase7-wip-parked`，6 文件 972 行，来自 `feature/sync-integration-07-bidirectional-sync`）**保持原样不动**；③ 重打包后跑 smoke + perf + 一次性打包态探针。

## 1. 审查结论（逐条给证据）

复核对象 `8f0e427`：`ThumbReveal.tsx` / `VirtualImageGrid.tsx` / `useFailedImages.ts` / 新增 `useIsScrolling.ts` + 三个配套测试文件。

### 1.1 通过项（不需要改动，附实测证据）

| 检查面                    | 结论                                                                                                                                                                                      | 证据                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 监听器与定时器清理        | `useIsScrolling` 卸载时 `removeEventListener`（同 capture 选项）+ `clearTimeout`，无残留                                                                                                  | `useIsScrolling.ts:41-46`                                                   |
| 渲染环路                  | 无裁剪时 `setFailedImages` 返回**原引用**，打断「effect → setState(新 Set) → 再渲染」环；旧实现在每次渲染新建数组的调用方上会打到 OOM                                                     | `useFailedImages.ts:46,51`                                                  |
| 脏数据防御                | `items` 非数组时直接 return，既不裁剪也不抹掉现集（抹掉会立刻整屏重闪）                                                                                                                   | `useFailedImages.ts:40`                                                     |
| 冻结 `onHover` 是否丢状态 | 不丢。两个渲染方传的确实是空函数：`GalleryPage.tsx:440` 为 `useCallback(() => {}, [])`，`SyncGalleryPage.tsx:121` 为 `useCallback(() => undefined, [])`；驱动遮罩的是网格内部 `hoveredId` | 两处实测行号                                                                |
| 记忆写入的可信信号        | 只在 `onLoad` 与 `complete && naturalWidth > 0` 两处写入，`onError` 分支永不写入，坏图不被掩盖                                                                                            | `ThumbReveal.tsx:80-83,103-108`                                             |
| 空 src 污染               | `rememberLoadedSrc` 首行 `if (!src) return`，回收站/封面空态不会进 Set                                                                                                                    | `ThumbReveal.tsx:29`                                                        |
| 内存上界                  | 512 条 FIFO 淘汰，最坏退化为「再闪一帧骨架」                                                                                                                                              | `ThumbReveal.tsx:24-35`                                                     |
| 主题 / IPC / i18n 规范    | 零硬编码色值、零新增 IPC 通道与 i18n 键、未触及四组受保护路径                                                                                                                             | 改动文件清单不含 `preload/api`、`ipc/handlers`、`services`、`shared/errors` |

### 1.2 本轮修的规范缺陷（两处注释与事实不符）

| #   | 位置                                                       | 问题                                                                                                                                                                                                                                                                                                                                                        | 依据                       |
| --- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| C1  | `src/renderer/components/gallery/VirtualImageGrid.tsx:214` | 注释仍写「items 变化时自动清空」，而同一提交把语义改成了「只裁剪已消失的 id」，注释描述的是被自己废弃的行为                                                                                                                                                                                                                                                 | `useFailedImages.ts:18-24` |
| C2  | `src/renderer/components/common/ThumbReveal.tsx:23`        | 注释称记忆 key「含 `&r=N` 重试代次」，实测 `&r=` 仅在 `VirtualImageGrid.tsx:492` 一处生成，其余 6 个调用方（`TimelineView:227`、`EventTimelineView:318`、`ListView:133`、`MasonryView:103`、`RecycleBinPage:545`、`OutfitGalleryPage:95`）传裸 URL；且缩略图按**内容哈希**命名（`generator.ts:262,576` 的 `${fileHash}.jpg`），两张重复照片本就共用同一 src | 全仓 grep `&r=` 实测       |

### 1.3 登记但不修（超出用户选定范围，不顺手改）

- **F3 行为权衡**：`useFailedImages` 收窄后，`TimelineView` / `ListView` / `EventTimelineView` / `MasonryView` 四个视图不调用 `clearFailed`（只有网格调，见 `VirtualImageGrid.tsx:292`），坏图警告态会整会话停留，直到该 id 真的离开列表；改前任意列表变更即整表抹掉。这是「消除翻页重闪」的直接代价，方向正确但恢复通道缺失。
- **F2 行为权衡**：`loadedSrcs` 没有失效钩子，`invalidateMediaPathCache`（`src/main/app/media-protocol.ts:435`）不触碰它。被记住的 src 若后续加载失败（缩略图被 LRU 驱逐等），首帧会以 `opacity-100` 绘制一张还没有位图的 `<img>`，即「空白」取代了「shimmer」，直到 `onError` 命中由父级换占位图标。`media://` 缩略图带 `public, max-age=300, must-revalidate` + 弱 ETag，300 秒内的重挂载走 Chromium HTTP 缓存，越过该窗口要付一次条件请求。

两项均写入本节留档，不在本轮改代码：修 F3 要给四个视图引入恢复信号（触及 5 个调用点与语义设计），修 F2 要把记忆 key 换成带失效通道的结构，都不是「最小改动」，且需各自先有红灯测试。

## 2. 依赖声明

**零新增依赖。** 全部改动落在既有栈与本仓脚本上：

| 依赖                                                                                                                                | 版本              | 用途                                        | 引入方式                 |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------- | ------------------------ |
| `playwright` + `@playwright/test`（已装）                                                                                           | 见 `package.json` | `e2e:smoke` / `e2e:perf` / 一次性打包态探针 | 已存在，不安装           |
| `scripts/pre-dist-check.ts`、`check-changelog-release.ts`、`check-doc-versions.ts`、`verify-nikkisync-link.ts`、`link-nikkisync.ts` | 本仓              | 打包前后闸门与 NikkiSync 链接诊断           | 经 npm scripts 调用      |
| `e2e/helpers.ts` 的 `launchApp()`                                                                                                   | 本仓              | 安装包态（`app.isPackaged=true`）真机驱动   | 直接复用，不新写启动逻辑 |

**禁止** `npm install` / `npm ci` / `npm prune` / `npm audit fix`（见 §4 错误处理第 1 条）。

## 3. 启动与运行说明

```bash
# 基线（全部排在打包之前，因为其中含 tsc -b 步骤）
npm test && npm run typecheck && npm run typecheck:e2e && npm run lint
npm run i18n:check && npm run i18n:guard && npm run docs:links
npm run preview:check && npm run audit
npm run link:nikkisync:check && npm run verify:nikkisync

# 打包（唯一不可逆步骤）
npm run dist:win

# 打包态复验（必须在新产物之上）
npm run e2e:smoke
npm run e2e:perf
```

验证方式：每个命令取**真实退出码**（先把 `$?` 写进文件再打印，不让管道尾命令掩盖）。

## 4. 错误处理

1. **`@nikkisync` 链接被清 ⇒ 闸门会假绿**。四条 junction 不是声明依赖，`npm install` 会把它们清掉；而 `scripts/pre-dist-check.ts` 的 `nikkiSyncPackedVerdict()` 在「未建链且产物缺失」时判 `skip` 并退出 0 —— 安装包缺整个内嵌运行时却全绿出货。兜底：`dist:win` 前后各跑一次 `npm run link:nikkisync:check`，并逐项确认 `verify:dist` 的 `@nikkisync` 是 ✔ 而非 ⊘；一旦为 ⊘ 立即停手，用 `npm run link:nikkisync`（幂等）恢复后重打包，不改 `build.files`。
2. **`tsc -b` 覆盖 rollup 产物**。`dist/main` 内没有 `.tsbuildinfo`，任何 `tsc -b` 都整份重写入并覆盖 `dist/main/main/app/index.js`，打红 `pre-dist-check.ts` 的 11.5/11.6。策略：所有含 tsc 的步骤与本轮唯一的 `.tsx` 提交一律排在 `dist:win` 之前；`chore(release)` 只暂存 `.md`，`.husky/pre-commit` 的 tsc 步骤自然跳过。
3. **变更日志写法错即阻断打包**。新条目若写成 `- ` 项目符号会落进 `[Unreleased]`，`check-changelog-release.ts` 退出 1 阻断 `dist:win`；必须用既有引用块形态 `> YYYY-MM-DD 追加：…`。
4. **`release/` 下的临时目录会让 `verify:dist` 校验错树**。`findAsarUnpacked` 取首个命中，`alt-stage` 字典序排在 `win-unpacked` 之前，故不备份旧 `win-unpacked`，旧安装包按既定口径直接覆盖。
5. **探针的观测口径**。不带 `NIKKI_NIKKISYNC_RUNTIME=1` 启动时，`src/main/nikkisync/runtime-manager.ts` 会抛既有的「runtime is not ready (state is idle)」告警，与新功能无关；因此探针断言收窄到「与被测链路相关的错误为 0」，并把无关噪声条数一并打印，不用「全窗口 0 console error」当判据。
6. **文档类改动没有闸门覆盖**。`npm run verify` 的 test 与 format 两步都不含 `docs/**`，且干净工作区下它按 `git diff --name-only HEAD` 取目标、零目标即五步全跳过（`scripts/verify-changes.ts:107`）。文档节点必须手动指名跑 `npm run docs:links` 与 `npx vitest run scripts/__tests__/check-md-links.test.ts`。

## 5. 参数校验

- 本轮不改任何函数签名、IPC 通道、zod schema、设置键与主题变量 ⇒ `docs/IPC_CONTRACT.md` 与 i18n 键预期零变更。
- C1 / C2 两处改动限于注释文本，不得新增 `// @core-change:`（`scripts/core-path-gate.ts` 的 PROTECTED_GLOBS 不含 `src/renderer/**`，且守护测试禁止无关占位授权注释）。
- CHANGELOG 追加行的硬约束：位于 `## [2.5.5-beta]` 节内、以 `>` 开头、日期用绝对日期、引用的计划文档路径必须已在 git index 中（否则 `check-md-links` 判 dead）。
- 探针文件命名 `e2e/gallery-grid-scroll-probe.e2e.ts`，跑完即删，并以 `npx playwright test --config e2e/playwright.config.ts --list` 证明套件里查不到它——残留会被 `lint`、`typecheck:e2e` 与 `e2e:smoke` 本身再次拾起。

## 6. 基础测试用例（三类齐备）

| 面                              | 正常                                          | 异常                                                      | 边界                                                             |
| ------------------------------- | --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| N1 复用记忆（既有套件）         | 同 src 重挂载首帧即 `opacity-100` 且无骨架    | `onError` 后重挂载同 src 仍回骨架                         | 513 个不同 src 后首个被淘汰；`a.jpg` 与 `a.jpg&r=1` 视为两个 key |
| N2 滚动期冻结 hover（既有套件） | 滚动中鼠标扫过卡片不触发整网格重渲染          | 卸载后监听与定时器无残留                                  | `scroll` 与 `mouseEnter` 同批次时序仍冻结                        |
| N4 失败态裁剪（既有套件）       | 触底翻页保留既有失败 id                       | `items` 非数组不抛错、不抹掉现集                          | 项被删除才裁剪，集合不无界增长                                   |
| C1 / C2 注释订正（本轮）        | 两个文件的注释与实现一致；`git diff` 仅注释行 | 若 prettier 判定注释换行不合规即失败（由 `--check` 兜住） | 不加 `@core-change`；`core-path-gate` 必须仍为跳过/通过          |
| 发布轮                          | `npm test` + 全量静态闸门 + `dist:win` 退出 0 | `@nikkisync` 项为 ⊘ ⇒ 立即停手按 §4 第 1 条恢复           | 探针删除后 `--list` 命中数为 0                                   |

本轮为注释与文档改动，**没有可先红的功能断言**：判别力由「`git diff` 只含注释行 + 三个既有套件全绿 + `check-md-links` 死引用为 0」承担；若后续要修 F3/F2，必须先写出在改前失败的用例，再动代码。

## 7. 子任务拆分（每项：涉及文件 / 输入输出 / 验收标准）

| #   | 涉及文件                                                                                                 | 输入 → 输出                                | 验收标准（可判定）                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| T0  | `docs/plans/2026-10-19-grid-flicker-review-commit-2.5.5-beta-repack.md`                                  | 取证台账 → 本计划入库                      | `npm run docs:links` 退出码 0；`npx vitest run scripts/__tests__/check-md-links.test.ts` 全绿                       |
| T1  | `src/renderer/components/gallery/VirtualImageGrid.tsx`、`src/renderer/components/common/ThumbReveal.tsx` | C1/C2 注释 → 与实现一致                    | `git diff` 仅注释行变化；`npx vitest run` 三个相关套件全绿；`npx eslint` 对两文件 0 问题                            |
| T2  | —                                                                                                        | §3 基线命令全集 → 退出码集合               | 每条退出码 0；任一非 0 即停，不进 T3                                                                                |
| T3  | 暂存 `CHANGELOG.md` 之外全部本轮改动                                                                     | 计划文档 + 两文件 → 1 个提交               | `git log -1 --stat` 恰含这 3 个文件；`git status --porcelain` 干净                                                  |
| T4  | `CHANGELOG.md`                                                                                           | 在第 41 行后插两条 `>` 行                  | `npx tsx scripts/check-changelog-release.ts` 退出 0；`git diff --stat` 恰 `2 ++`                                    |
| T5  | `release/`（不入仓）                                                                                     | `npm run dist:win` → 新 exe + `latest.yml` | 真实退出码 0；`verify:dist` 全 ✔ 且 `@nikkisync` 非 ⊘；`latest.yml` 的 sha512 与 exe 实测一致、`releaseDate` 为新值 |
| T6  | 临时 `e2e/gallery-grid-scroll-probe.e2e.ts`                                                              | `launchApp()` 驱动网格向下滚动 → 读数      | `npm run e2e:smoke` 与 `npm run e2e:perf` 退出 0；探针读数写入 §11；删除后 `--list                                  | grep -c probe` = 0 |
| T7  | `CHANGELOG.md`、本计划文档                                                                               | 读数回填 → 1 个 `chore(release)` 提交      | `git status --porcelain` 空；`git stash list` 仍显示 `stash@{0}: phase7-wip-parked`；不执行 push                    |

## 8. 验证与自测顺序

T0 → T1 → T2（全绿方可继续）→ T3 → T4 → T5 → T6 → T7 → 收尾复跑 `npm test` / `npm run lint` / `npm run docs:links` / `npx prettier --check --end-of-line auto` 覆盖本轮改动的 md。

## 9. 交付说明要点

- 现存的 2026-10-18 21:37 安装包**不含**网格闪烁修复，装到该 ASUS 设备仍会逐格闪；本轮重出的包才包含 N1/N2/N4。
- 版本号无改动：五处声明位实测已是 `2.5.5-beta`，本轮只做「补录 + 重打包」，与 `acdea69` 等历史发布轮口径一致。
- 问题设备复验方法沿用上一轮计划的 §5 D0 脚本（`docs/plans/2026-10-18-fix-gallery-grid-scroll-flicker.md`）。

## 10. 未纳入本轮的既有事实（避免误读为已处理）

- `stash@{0}` 的 `phase7-wip-parked`（6 文件 972 行）属另一分支的搁置工作，本轮不弹出、不提交，收尾时须仍能在 `git stash list` 看到。
- `feat/gallery-runtime-embed` 无上游分支，相对 `origin/main` 领先 174 个提交；push 不在本轮范围。
- 仓库无任何 git tag（`git tag --sort=-creatordate` 空输出），`CHANGELOG.md` 底部的 compare 链接指向尚不存在的 tag，属既有状态。

## 11. 执行记录（逐项回填实测读数）

### 11.1 T2 基线闸门（2026-10-19 实测，逐条取真实退出码）

| 命令                                                       | exit | 读数                                                                                                                           |
| ---------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                                                 | 0    | 6461 passed / 2 skipped（41.23s），与上一轮 §12.4 读数一致；含 `scripts/__tests__/check-md-links.test.ts` 被跟踪文档死引用契约 |
| `npm run typecheck`                                        | 0    | `tsc -b` + `tsc -p tsconfig.scripts.json`                                                                                      |
| `npm run typecheck:e2e`                                    | 0    | `tsc --noEmit -p e2e`                                                                                                          |
| `npm run lint`                                             | 0    | 0 errors / 11 warnings，全部为 DEBT-030 登记的存量 `components/common/*.test.tsx` unicode-bom                                  |
| `npm run i18n:check`                                       | 0    | 全部 locale key 对齐（3939 keys）                                                                                              |
| `npm run i18n:guard`                                       | 0    | 白名单只减不增、清零必移除、key 已同步                                                                                         |
| `npm run docs:links`                                       | 0    | 无死引用（140 处提醒为已交代去向的历史路径）                                                                                   |
| `npm run preview:check`                                    | 0    | 10 项：PASS=5 / WARN=5 / FAIL=0，无致命漂移                                                                                    |
| `npm run audit`                                            | 0    | Passed npm security audit（命中项均在 allowlist 内）                                                                           |
| `npx prettier --check --end-of-line auto`（本轮 4 个文件） | 0    | All matched files use Prettier code style（新计划文档先经 `--write` 归一）                                                     |
| `npx eslint`（两个改动文件）                               | 0    | 0 问题                                                                                                                         |
| `npm run link:nikkisync:check`                             | 0    | 四条 junction 全部 ok                                                                                                          |
| `npm run verify:nikkisync`                                 | 0    | blocking failures: 0，electron 41.10.6                                                                                         |
| `npx vitest run` 三个相关套件                              | 0    | `useFailedImages` 11 + `ThumbReveal` 11 + `VirtualImageGrid.grid-cycle` 15 = 37 passed                                         |

单独跑 `npx tsx scripts/pre-dist-check.ts` 的 exit=1 **不是缺陷**，唯一 ✖ 是「renderer 产物比源码旧（src 2026-10-19T04:44Z，dist 2026-10-18T15:08Z）」——由本轮两处注释改动触发，`npm run dist:win` 的第一步 `npm run build` 正是其解法，故不在打包前手工消除。
另核实：`dist/main` 与 `dist/renderer` 的时间戳为 2026-10-18 23:08（+0800），即上一轮 `8f0e427` 之后的构建产物，**已含**网格闪烁修复；本轮基线的 `tsc -b` 未回写 `dist/main/main/app/index.js`（该文件未被本轮改动触及，增量判定跳过），故 §4 第 2 条的覆盖风险本轮未命中。

### 11.2 T5 打包读数

（待回填：exe 字节数、sha512、`verify:dist` ✔ 计数、真实退出码）

### 11.3 T6 真机复验

（待回填：`e2e:smoke` / `e2e:perf` 结果、探针读数。探针为临时 `e2e/gallery-grid-scroll-probe.e2e.ts`，验证后已删除、不入仓）

### 11.4 T3 / T7 提交号

（待回填）
