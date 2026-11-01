# 2.5.6 全面审查修复 → 六门全绿 → 提交 → 重打包 实施计划

> 生成：2026-11-01 · 仓 `main` @ `64e0adb`（工作树干净，本地领先 origin 15 个提交）· 目标 Windows x64
> 真相源：`docs/plans/2026-11-01-sync-gallery-photo-dir-repack-verify-实施计划.md`（HEAD 已落盘、**§10 全为「待填」= 未执行**）· `.qoder/rules/project-conventions.md` · 各模块 `AGENTS.md`
> 已裁决四项（均取推荐档）：修复范围 = **P1 三项 + 契约漂移** · 真机 e2e = **照做（含打包态复验）** · `npm install` = **跑 + 复原四链 + lock 抖动还原不提交** · 出包 = **标准配方优先，撞锁走旁路**

---

## 1. Context：本轮真正要解决的问题

1. **审查对象是「最后一次出包之后的提交」**，不是 `git diff`（工作树干净）。现役 `release/MeowStarMap-Setup-2.5.6.exe` 出包于 11-01 **17:40**，其后 `a732c2b / f3f7b35 / e1fa82c` 三笔改了 `src/**`（2579 行增），实测：`dist/main/main/app/index.js` mtime **17:38**、`grep -c applyGameRoot dist/...` = **0** ⇒ 源码与产物分叉，用户装的包里根本没有「保存即生效」。
2. **出包链的第一个真实卡点已实测确认**：`npx tsx scripts/check-changelog-release.ts` 现报 `✖ [Unreleased] 含 1 条待发布条目（行 24）` ⇒ `npm run dist:win` 会在 `pre-dist-check` 硬失败。
3. **审查（两个子代理 + 我逐条读码复核）查出 3 项 P1 缺陷**，全部可达、均有具体失效场景（见 §2）；另有 3 项已核实的契约/注释漂移。
4. **版本号无需改动**：实测四处声明位 `package.json` / `package-lock.json` 根 / `packages[""].version` / `release/latest.yml` 与 preview mock `database-mock.ts:664` **已全是 `2.5.6`** ⇒ 该项按「零编辑」如实交付，不造改动凑数。

意图结果：拿一个**真的含全部修复**的 2.5.6 安装包，且「保存即生效」有可复现的真机判据；六项验证全绿并如实逐项报读数。

---

## 2. 缺陷账本（逐条读码核实过，含判据落点）

| #   | 严重度 | 站点                                                                                                                                                                              | 失效场景（已核实可达）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | P1     | [SyncServicePage.tsx:648-656](file:///D:/Workbuddy%20项目/WXNN%20YD%20-%20副本/WXNN%20XiangCe/src/renderer/pages/sync-gallery/SyncServicePage.tsx) `announceGameRootApply`        | 「恢复默认」时 `reset-game-root` → `applyPersistedGameRoot(runtime,'')` → 上游 `fullScan()` 在 `!installation && extraDirectories.length===0` 抛 `Infinity Nikki installation was not found`（上游 `ScannerService.js:75`）→ `applyError:'installation-not-found'` 命中第一条分支 ⇒ 用户刚清空输入框，却被告知「**该目录**不是有效的游戏安装根，请改选游戏安装目录」，且这条分支先 `return` **吞掉了原有的「重启后生效」询问**。测试桩 `gameRootApplyNotInstallRoot` 同时喂 set/reset 两条 mock（test.tsx:329/337），但只有 set 路有断言 ⇒ 无覆盖。 |
| D2  | P1     | [runtime-manager.ts:506-516](file:///D:/Workbuddy%20项目/WXNN%20YD%20-%20副本/WXNN%20XiangCe/src/main/nikkisync/runtime-manager.ts) `scan()` 无在途互斥 + `:527` 失败分支覆写状态 | 同一页 `handleGallerySourceToggle:325` 刻意 `void api.nikkisync.startScan({})` **不 await**；全量扫描在途时用户点「保存」→ `applyGameRoot` → `scan({gameRoot})` → 根不相等 → `teardown('nikkisync.restart')` 关掉**正在扫描的会话**（库被 close）→ 在途 scan 以原生错误 reject 并 `showError` 弹错误 toast；其 `catch` 把 `state.state` 写成 `error`/`degraded`（`:527`），覆盖新会话的真实状态 ⇒ 状态机谎报。另一支：`state.starting` 共享时 A 的根建出的会话被 B 复用，`applied:true` 与实际生效根不一致。                                        |
| D3  | P1     | [nikkisync-handler.ts:940-949](file:///D:/Workbuddy%20项目/WXNN%20YD%20-%20副本/WXNN%20XiangCe/src/main/ipc/handlers/nikkisync-handler.ts) `nikkisync:admit-directory`            | `validatePhotoSourceDirectory` 只查敏感目录/存在/是目录/可读，`isSensitivePath` **不拦盘根** ⇒ `admit(D:\)` 全过并 `registerSyncPhotoDir('D:\')`；`matchesPicked` 按**前缀**命中（validator.ts:320-327）⇒ 本会话内 `inspect-extra-directory` 对整盘任意子目录跳过 `assertFileReadPath`；随后「添加」把整盘升为同步库扫描根（且 `extraDirectories` 非空会让上游 `start()` **容忍** installation 缺失），扫出的照片经 `media://` 出字节并可被 LAN 客户端拉取。上一轮已把全局 `registerUserPickedDir` 收窄为同步域集合，这一档是其残留。               |
| D4  | P2     | handler `:488` `if (!runtime) return { applied:false, needRestart:true }`                                                                                                         | `docs/IPC_CONTRACT.md:661` 声明 `runtime-unavailable` = 「Runtime 未装配 / 未建链」，但未装配支**不回** `applyError` ⇒ 契约与实现分叉（渲染层分支不受影响，只丢诊断信息）。                                                                                                                                                                                                                                                                                                                                                                         |
| D5  | P2     | `docs/IPC_CONTRACT.md:660` · `vite-env.d.ts:1147`                                                                                                                                 | 契约称 `applied` 是「新增**可选**字段」，而 `electron-api.ts:736` 里 `applied: boolean` 是**必填**（只有 `applyError` 可选）；`vite-env.d.ts` 注释仍写「重启后由 `buildSessionOptions` 生效」，与 `a732c2b` 起的运行期生效通道矛盾。                                                                                                                                                                                                                                                                                                                |

**本轮明确不修（§9 记账，附理由）**：`resource-allowlist.ts:102-106` 的 `previewPaths` 跨 revision 回填存活（上一轮为治「样例 403 裂图无自愈」刻意设计，收窄会复活旧缺陷）；`syncPhotoDirs` 无上限/无撤销（会话内内存集合，仅随用户显式动作增长，最坏形态已由 D3 掐掉）；`set-game-root` 的 IPC 会阻塞一次全量扫描时长（生效语义要求同步回报 `applied`，与 `start-scan` 同形态）；`applyGameRoot` 惰性拉起整个 Runtime（这正是 `runtimeEnabled=false` 真实用户态下唯一能生效的路径，HEAD 计划明确采用）；cloth-outfit 缓存无 TTL / `fetchJson` 体积上限后判 / `protocol-drift` 在 CI 恒 skip / `FullscreenViewer` 离屏 probe 未取消与 `slideshow` 整体进依赖数组。

---

## 3. 依赖声明

**零新增、零变更依赖。** 全部复用仓内既有工装：`launchBuiltApp()` / `launchApp()` / `closeApp()`（`e2e/helpers.ts`）、`launchEnv()`、`decideNikkiSyncGate()` + `hasNikkiSyncLink()`（`e2e/nikkisync-guard.ts`）、`readMainLogTail()`（`e2e/nikkisync-runtime.e2e.ts:196`）、`@electron/asar` 的 `listPackage`/`extractFile`、`scripts/check-changelog-release.ts`、`scripts/link-nikkisync.ts --check`。

`npm install` 的同源后果（必须成对处置，见 N8）：按锁收敛 `node_modules` 会**剪掉 `node_modules/@nikkisync/*` 四条 junction**（现测 mtime 11-01 17:32，四链齐），后果不是报错而是静默降级——安装包缺整个内嵌同步运行时（体积掉约 608KB）；本机为 **Node v26.3.0 + npm 11.16.0**（CI 钉 `.node-version=22`），install 会重写 `package-lock.json`（删 ffmpeg-static/ffprobe-static 的 `libc` 字段），属工具链抖动，按既定口径**还原、不提交**。

---

## 4. 启动与运行说明（每条命令均已核实存在于 `package.json`）

```bash
npx tsx scripts/check-changelog-release.ts                                  # CHANGELOG 收口闸门（出包前提）
npx vitest run src/renderer/pages/sync-gallery/SyncServicePage.test.tsx      # 单节点单测
npx vitest run src/main/nikkisync/runtime-manager.test.ts
npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts
npx playwright test --config e2e/playwright.config.ts nikkisync-game-root    # 新增真机用例（未打包态）
NIKKI_E2E_PACKAGED=1 npx playwright test --config e2e/playwright.config.ts nikkisync-game-root  # 打包态复验
npm install && npm run link:nikkisync && npm run link:nikkisync:check
npm run build / npm test / npm run typecheck / npm run typecheck:e2e / npm run e2e:smoke / npm run test:ci-linux
npm run lint / npm run i18n:guard / npm run docs:links / npm run verify
npm run link:nikkisync:check / npm run pre-dist-check / npm run dist:win / npm run verify:dist
```

`e2e/playwright.config.ts` 口径：`testMatch: '*.e2e.ts'`、`workers=1` 串行、单用例 60s、`expect` 15s。

**停点约定**：N0（计划落仓 + 单独提交）之后**不再二次停等**，直接进 N1——本会话已经一次计划批准与四项裁决。若你要「落盘即停、先读文档」，请在批准时说明。

---

## 5. 节点设计（每节点：涉及文件 / 输入输出 / 可判定验收；先红后绿，我亲自跑）

### 阶段 A — 文书

**N0 计划落仓**

- 文件：`docs/plans/2026-11-01-review-fix-verify-repack-2.5.6-实施计划.md`（本文）
- 输入/输出：批准的本文 → 入仓文档 + 一笔 `docs(plans): ...`
- 验收：`git log -1 --stat` 命中本文；`npm run docs:links` 绿。**顺序硬约束**：文档先 `git add` 进 tracked 集，再动任何被跟踪 md（`check-md-links` 的契约测试用 `git ls-files` 判存在，引用未跟踪路径会把全量 `npm test` 打红）。

### 阶段 B — 缺陷修复（每项 TDD 红→绿）

**N1 修 D1：「恢复默认」不再误报为「目录不是安装根」**

- 文件：`src/renderer/pages/sync-gallery/SyncServicePage.tsx`（`announceGameRootApply` + `handleSaveGameRoot` / `handleResetGameRoot` 两个调用点）；`SyncServicePage.test.tsx` 新增 1 例
- 输入/输出：`announceGameRootApply(result, successMessage, kind: 'set' | 'reset')`；`kind==='reset'` 时**跳过** `installation-not-found` 专属文案支，未生效一律落 `savedDeferred` + 重启询问（即修前行为，值已持久化、下次进程按启动消费点读到）；`kind==='set'` 行为不变。零新增 i18n 键（复用 `savedDeferred`）。
- 红（新例 `bf`）：`installElectronApi({ gameRoot:'D:\\CustomRoot', gameRootApplyNotInstallRoot:true })` → 点「恢复默认」→ 断言**不出现**「该目录不是有效的游戏安装根…」**且** `dialogShowMessageBox` 被调用。现实现先命中该支并 `return` ⇒ **必红**。
- 验收：`npx vitest run .../SyncServicePage.test.tsx` 由红转绿，既有用例（az/be/bc）不减少、不弱化。

**N2 修 D2：`scan()` 串行化，在途扫描未落地不得换根重建**

- 文件：`src/main/nikkisync/runtime-manager.ts`（`scan()` 顶部 settle + 一个 `scanInFlight` 句柄，`finally` 清空）；`runtime-manager.test.ts` 新增 1 例
- 输入/输出：不变量——同一 manager 内**在途 `fullScan` 峰值 ≤ 1**；`applyGameRoot` 的 teardown 绝不作用在仍在扫描的会话上；两次 apply 串行落地；终态 `status().state` 如实为 `running`。实现取最小互斥：`scan()` 入口 `await` 既有在途 scan（吞其失败，落地后再走既有换根判据）。
- 红：测试桩把 `fullScan` 换成可控 deferred，并发调用 `scan({})` + `applyGameRoot('/new')`，断言峰值 ≤1 与 `createSession` 序列 ⇒ 现实现峰值 = 2、teardown 命中在途会话 ⇒ **必红**。
- 验收：`npx vitest run src/main/nikkisync/runtime-manager.test.ts` 全绿；既有的「换根重建 / 快照刷新不回退 / LAN 复原 / 不误启」四条不红。
- 提交纪律：`src/**` 刻意留红的提交会被自家 lint-staged（`test:precommit`）拒 ⇒ **红测与修复合并同批提交**，修复前红读数写进 commit message，**禁止 `--no-verify`**。

**N3 修 D3：`admit-directory` 拒绝盘根 / UNC 根**

- 文件：`src/main/ipc/handlers/nikkisync-handler.ts`（新增一个**零 path 绑定**的导出纯判据 `isBareDirectoryRoot(p)`，串形态正则判定：`^[A-Za-z]:[\\/]*$` / `^\\\\[^\\]+\\[^\\]+$` / 恰为 `/`）+ admit 支在 `validatePhotoSourceDirectory` 之前调用；`nikkisync-handler.test.ts` 新增例
- 输入/输出：`admit({path:'D:\\'})` / `'C:/'` / `'\\\\nas\\share'` / `'\\'` ⇒ `VALIDATION_ERROR`（不落库不登记）；`'D:\\Photos'`、`'D:\\X6Game'`、`os.tmpdir()` 下的真实临时目录 ⇒ 行为不变。`set/reset-game-root` **不收窄**（安装根由上游 `valid()` 自限，避免误伤装在盘根的合法形态）。
- 落点选择理由：纯串形态判定 ⇒ 不引入 win32 钉也不引入方言引用，无需登记 `path-semantics-guard`，Linux CI 与 Windows 同判据。
- 红：先只加测试断言 ⇒ 现实现放行 ⇒ **必红**；再补 guard 转绿。
- 验收：`npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts` 全绿；受保护路径改动随同一批带**替换后的** `// @core-change: <真实中文原因>`（至多一条、置于文件前 5 行），`npm run verify` 的 `core-gate` 步 ✔。

**N4 修 D4 + D5：契约与注释漂移**

- 文件：`src/main/ipc/handlers/nikkisync-handler.ts:488`（未装配支补 `applyError:'runtime-unavailable'`，让契约成真是；渲染层分支不变——它只对 `installation-not-found` 特殊分流）；既有用例「runtime 未装配时不调生效通道」补 `applyError` 断言（先红）；`docs/IPC_CONTRACT.md:660`（`applied` 措辞由「新增可选字段」订正为「新增必填字段，旧调用方读不到按 `needRestart` 走重启兜底」——类型侧 `applyError` 才可选，向后兼容语义不变）；`src/renderer/vite-env.d.ts:1147` 注释订正为「落库后当场经 `applyGameRoot` 生效，未生效才回退重启」。
- 验收：`npx vitest run .../nikkisync-handler.test.ts` 全绿；`npm run typecheck` 绿；`grep -n "重启后由 buildSessionOptions 生效" src/renderer/vite-env.d.ts` 零命中。

### 阶段 C — 产物侧收口 + 真机判据（HEAD 计划 §N1/§N2/§N3）

**N5 CHANGELOG 收口**（打开出包链的前提）

- 文件：`CHANGELOG.md` 行 20–35 区
- 输入/输出：按先例 `951c235` 把 `[Unreleased]` 那 1 条并入 `## [2.5.6]` 的 **`### Added`** 主条目「同步图库自定义照片目录」下作**缩进子条目**；删除 `[Unreleased]` 内的 `### Fixed` 子节；整句删掉「后续修正（2026-11-01，已移入 `[Unreleased]`）」——并入后该表述自相矛盾。**同时**为 N1–N4 的三处行为订正补一条缩进子条目（放既有 2.5.6 节内，不新建版本节）。
- 验收：`npx tsx scripts/check-changelog-release.ts` 输出 `✔` 且**无任何 `✖`**（判读看 `✔/✖` 标记，不看管道 `$?`）。注意 `ENTRY_LINE_RE` 也匹配缩进子条目 ⇒ `[Unreleased]` 节内一切 `- ` / `* ` 行必须清空。

**N6 新增 e2e 真机用例（先红，红必须在 `npm run build` 之前取到）**

- 文件：`e2e/nikkisync-game-root.e2e.ts`（本节点计划新增，落盘前不存在）；改 `e2e/__tests__/timeout-budget.test.ts:35` 的 `SMOKE_COVERAGE` 硬清单登记新文件名（现值 `['fullscreen-diagnose.e2e.ts','nikkisync-runtime.e2e.ts','smoke.e2e.ts']`，`:174` 逐字 `toEqual` ⇒ 漏登记即把全量 `npm test` 打红）
- 骨架：`decideNikkiSyncGate({linked: hasNikkiSyncLink(REPO_ROOT)})` 门控（未建链整件 skip 并给 `npm run link:nikkisync`）；`beforeAll` 用 `launchBuiltApp([], {})`——**刻意不传 `NIKKI_NIKKISYNC_RUNTIME`**，复刻 `runtimeEnabled` 缺省 false 的真实用户态（保存时走 `scan()` 的惰性 start，正是老包死掉的那条路）；`localStorage.setItem('app-language','zh-CN')` + `reload()`；`test.setTimeout(150_000)`；`afterAll` 关窗 + `fs.rm` 合成根（`catch` 容忍：上游 `ScannerWatcher` 握句柄）；按 `process.env.NIKKI_E2E_PACKAGED === '1'` 切 `launchApp()`，同一判据既验 `dist` 也验最终产物树。
- 合成安装根落 `.cache/e2e-game-root-<ts>/`（gitignore）：`InfinityNikki.exe`（0 字节只为过 `isFile`）+ `X6Game/Saved/GamePlayPhotos/`（空目录 ⇒ `photoRoots[0]` 非空）；**不要**建 `ScreenShot`。
- 三条判据：
  - **G1 零模态主判据**：`page.evaluate(() => window.electronAPI.nikkisync.setGameRoot({path: 根A}))` ⇒ `applied===true` 且 `needRestart===false`；再 `runtimeStatus()` 断言 `installation.installRoot` 等于根A（两侧 `path.win32.resolve` + 小写折叠——这是**比较层**，按约定第 6 条钉 win32）与 `lastScan` 键存在。
  - **G2 真实 UI 路径**：同步图库 → 同步服务 → 照片目录节 → 占位「输入或浏览选择本地目录」填根B → 收窄到同一 `div.space-y-2` 取「保存」→ 断言「照片目录已保存并立即生效」可见、「未能立即生效」不可见；`page.screenshot` 留真窗证据。
  - **G3 边界（D1 修复的真机背书）**：点「恢复默认」+ 游戏未装形态 ⇒ 断言**不出现**「该目录不是有效的游戏安装根」文案、走 `savedDeferred`；`get-game-root` 回读为 `''`（值不丢）。
- 验收（红）：`npx playwright test --config e2e/playwright.config.ts nikkisync-game-root` ⇒ G1 在 `applied` 断言失败（旧 dist 返回体无该字段）。**若 G1 直接就绿**：判据没牙或 dist 已被提前重建 ⇒ 停手重写判据，不进 N8。
- 配套：`npm run typecheck:e2e` 与 `npm run lint` exit 0；`npx vitest run e2e/__tests__/timeout-budget.test.ts` 绿。
- 红阶段防模态阻塞：`dialog.showMessageBox` 是主进程原生模态（promise 永不 resolve）⇒ 零模态判据 G1 排最前，G2 靠 `expect` 15s 超时 + `closeApp()` 的 `kill()` 兜底。

### 阶段 D — 六门验证 + 提交 + 定版 + 出包

**N7 全量静态门（打包前先跑，按既定偏好宁可多花几分钟）**

- `npm run lint` / `npm run typecheck` / `npm run typecheck:e2e` / `npm run i18n:guard` / `npm run docs:links` / `npm run verify` 全绿。

**N8 `npm install`（用户明令）+ 两项善后（已裁决：还原、不提交）**

`npm install` 本身照跑、读数照报，但它会顺带做出两件不是你我本意的事，必须当场收尾：

- **善后 ①（必做，不是选项）**：npm 会把 `node_modules/@nikkisync/*` 四条软链接当"多余文件"删掉——它们不在 `package.json` 里，是 `npm run link:nikkisync` 手工建指隔壁 NikkiSync 仓库的。删掉**不报错**，只会让安装包静默缺整个内嵌同步运行时。⇒ install 跑完立刻 `npm run link:nikkisync` 重建，再 `npm run link:nikkisync:check` 确认四链齐，这一条是进 N9 的硬闸门。
- **善后 ②（本轮裁决＝还原、不提交）**：本机 Node 26 + npm 11 与 CI 钉的 Node 22 写出的 `package-lock.json` 形态不同（新版删掉 ffmpeg-static/ffprobe-static 的 16 处 `libc` 字段），这是工具链抖动、不是代码变更。⇒ 取完真实读数后 `git restore package-lock.json`，**不为其造 `chore(deps)` 提交**，汇报里写清"install 跑过、lock 抖动已还原"。
- 例外：若 `git diff package-lock.json` 显示的**不是** `libc` 字段那一类（例如依赖增删、版本变动），说明 install 真的动了依赖树 ⇒ 停下报给你，不擅自还原。
- 附带风险已排查：仓库无 `postinstall` / `install-app-deps` 脚本，`better-sqlite3` 二进制 mtime 为 10-09，install 一般不会重编原生模块；万一 Electron ABI 被打回 Node ABI，暴露点是 N9/N10 的 `e2e:smoke`（加载 `better_sqlite3.node` 即报 `NODE_MODULE_VERSION` 不匹配），届时用 `npx electron-builder install-app-deps` 复原并如实记账。

验收：`link:nikkisync:check` 末行 `check OK (all four links in place)`；`git status --porcelain` 除本轮预期改动外为空（`package-lock.json` 不在其中）。

**N9 `npm run build` 重建产物 → N6 转绿**

- 验收：① `grep -c applyGameRoot dist/main/main/app/index.js` ≥ 1；② N6 同一条 playwright 命令**全绿**；③ `npm run e2e:smoke` 全绿。
- 失败处置：`e2e/dist-guard.ts` 报 `dist/main/main/preload.d.ts` 存在 ⇒ 是 `tsc -b` 覆写产物树，先确认 `src/main/tsconfig.json` 的 `outDir` = `.cache/tsmain` 再 `npm run build` 重生成，**不改任何代码**。

**N10 用户点名的六门矩阵**（逐项记录真实读数，任一红不得进 N11）

| #   | 命令                    | 判据                                                                                                             |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | `npm install`           | exit 0 + 四链已复原（`:check` OK）                                                                               |
| 2   | `npm run build`         | exit 0 且 `dist` 含 `applyGameRoot`                                                                              |
| 3   | `npm test`              | **0 failed**；用「总数差 == 新增例数」核对没有既有用例被静默排除（基线 463 文件 / **7315 passed** / 20 skipped） |
| 4   | `npm run typecheck`     | exit 0（另附 `typecheck:e2e`，因动了 `e2e/`）                                                                    |
| 5   | `npm run e2e:smoke`     | 全绿；此刻验的是 17:40 旧 `win-unpacked` ⇒ **N14 出包后必须再跑一次**，最终结论以新树那次为准                    |
| 6   | `npm run test:ci-linux` | 全绿（只读诊断，验 Linux 宿主语义；本轮 D3 判据刻意零 path 绑定，正应在此门自证不随宿主漂移）                    |

**N11 提交序列**（Conventional Commits，逐笔只含本节点改动；每笔提交后 `git status --porcelain` 复核钩子是否留下未预期改写）

1. `docs(plans): 落盘 2.5.6 审查修复与重打包实施计划`
2. `fix(sync-ui): 恢复默认不再误报为「目录不是安装根」`（N1，附红→绿读数）
3. `fix(nikkisync): scan 串行化，禁止拆掉正在扫描的会话`（N2，附红读数，同批红测）
4. `fix(nikkisync): admit-directory 拒绝盘根/UNC 根并补 runtime-unavailable 分类`（N3+N4，含 `@core-change` 与契约/注释订正）
5. `docs(release): CHANGELOG 收口并入 2.5.6`（N5）
6. `test(e2e): 照片目录即时生效真机判据`（N6，附修复前红读数）

- 验收：`git log --oneline` 六笔在位、`git status` 干净。

**N12 版本号 = 2.5.6：如实报「零编辑」**

- 判据（已实测，N12 复跑一遍取数）：`node -e` 读 `package.json` / `package-lock.json` 根 / `packages[""].version`、`grep getVersion src/renderer/preview/mock/database-mock.ts`、`grep version release/latest.yml` ⇒ 五处**全是 `2.5.6`**；`check-changelog-release` 的「版本节存在且唯一」✔。
- 不新建版本节、不动任何声明位（目标值已是当前值 ⇒ 造改动即违「最小化改动」）。

**N13 出包（标准配方优先，撞锁走旁路）**

- 前置**顺序不可换**：① 把现役 `MeowStarMap-Setup-2.5.6.exe` + `.blockmap` + `latest.yml` 移到 `_safe_backup_release-20261101-1740/`（`release/` 被 gitignore，安装包在 git 里没有任何副本，不可再生）；② `npm run link:nikkisync:check` 四链齐；③ 清 `release/win-unpacked.tmp`（17:39 残留，`resolveVerifyAsarTarget` 明确拒 `*.tmp` 段）；④ `npm run pre-dist-check` 无 fail。
- 执行 `npm run dist:win`；命中 `EPERM rename('release\win-unpacked.tmp' -> 'release\win-unpacked')` / `EBUSY ... default_app.asar` ⇒ 走已验证旁路：官方 electron 缓存解到 `.cache/electron-dist-clean`（排除 `resources/default_app.asar` 与 `version`）→ `npx electron-builder --win --publish never --config.electronDist=<该目录> --config.directories.output=release/build-20261101-reviewfix` → 用 **`cp -rf`（不是 `mv`）** 搬成 `release/win-unpacked` → 裸跑 `npm run verify:dist` 应自己变绿。汇报必须写明「这是绕锁而非改配方」。
- 旁路时**必须**处理 `findAsarUnpacked` 字典序陷阱：`build-*` 排在 `win-unpacked` 之前，若旁路树仍留 `app.asar.unpacked` 在 `release/` 内，`verify:dist` 的原生二进制步会验到上一轮旧树形成假绿 ⇒ 取证完成后清掉旁路树（现测 `release/` 下仅 `win-unpacked/resources/app.asar.unpacked` 一处，本轮不得新增第二处）。
- 验收：`release/MeowStarMap-Setup-2.5.6.exe` mtime 晚于 N9；`npm run verify:dist` **裸跑** exit 0；`latest.yml` 的 `size` 与 `sha512` **两轴都**与备份不同（同大小同哈希 = 空重跑）。

**N14 包内字节取证 + 打包态真机复验**

- 手法：`@electron/asar` `listPackage` + `extractFile`。条目名是**反斜杠带前导 `\`**，喂 `extractFile` 前**只去前导分隔符、绝不能把 `\` 换成 `/`**（换了必报 `was not found in this archive`）。
- 四条判据（缺一不算取证）：① 包内主进程 JS 的 `applyGameRoot` 命中 ≥1 且与盘上 `dist/main/main/app/index.js` **逐字节 `equals:true`**；② 渲染层 asset 取到文案「照片目录已保存并立即生效」（用户看到的文案在 renderer chunk，只验主进程等于没验）；③ 对备份旧包同取应 **0 命中** ⇒ 自证判据有牙；④ 包内渲染层 asset 里「恢复默认」支不再与 `applyFailedInstallRoot` 同帧命中 ⇒ 证明 N1 的修复真的进了包。
- 复验：`NIKKI_E2E_PACKAGED=1 npx playwright test --config e2e/playwright.config.ts nikkisync-game-root` 三条全绿，且日志 `[e2e] executable:` 打印 `release/win-unpacked/喵星图.exe` 才算验到新树；再跑 `npm run e2e:smoke`（覆盖 N10 第 5 门的旧树读数）。

**N15 收尾**

- 全量复跑：`npm test` + `npm run lint` + `npm run typecheck` + `npm run typecheck:e2e` + `npm run i18n:guard` + `npm run verify` + `npm run verify:dist`，全部 exit 0。
- 回写读数：本文 §10 表格 + HEAD 那份计划的 §10（N0–N7 逐节点真实读数、与计划预写「预期读数」不符处**显式订正并解释**，不悄悄改判据迁就实现）；一笔 `chore(release)` 提交。
- 验收（一票否决）：以上全绿 + `git status --porcelain` 为空 + 未 push（发布动作需另行批准）。

---

## 6. 参数校验（入参 / 必填 / 边界 / 非法值）

| 入参                                              | 判据                                                                                                            | 非法值处置                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `nikkisync:admit-directory {path}`                | **本轮新增**：非盘根/UNC 根/`/`；其余不变（必填、trim 后 1..4096、绝对路径正则、非敏感 + 存在 + 是目录 + 可读） | `VALIDATION_ERROR`，**不落库不登记**                                  |
| `nikkisync:set-game-root {path}`                  | 不变：必填、1..512、绝对路径；`isSensitivePath` + 存在/目录/可读；可写探测失败仅提示不阻断                      | `VALIDATION_ERROR` / `PATH_FORBIDDEN`，通道整体失败、不落库不 apply   |
| `nikkisync:reset-game-root`                       | 无入参；语义 = 值清为 `''` 交上游自动发现                                                                       | 生效失败仍**已持久化**，不回判成保存失败                              |
| `announceGameRootApply(result, msg, kind)` 新形参 | `kind` 取 `'set'                                                                                                | 'reset'`，调用点各传字面量；不传即类型错误（TS strict 编译期拒）      | 渲染层无回退分支需要兜底（两个调用点全在本文件内） |
| `scan()` 在途互斥                                 | 单 manager 内在途 `fullScan` ≤ 1；settle 吞掉在途扫描的失败（其错误已如实落 `state`/日志），不改既有返回形态    | 不新增错误码；失败仍由 `applyPersistedGameRoot` 归一三类 `applyError` |
| `installRoot` 比较（e2e 判据）                    | 两侧同用 `path.win32.resolve` + 小写折叠（NTFS 不区分大小写是产品事实；比较层 ⇒ 钉 win32，见约定第 6 条）       | 禁止用宿主 `path.posix` 解释 Windows 形态串                           |
| 打包前置                                          | 四链齐；`release/win-unpacked.tmp` 不存在或可整树删；`[Unreleased]` 无列表项                                    | 缺链先 `npm run link:nikkisync`，不得带缺链出包                       |

---

## 7. 错误处理（异常分支 / 兜底 / 日志）

- **生效失败不谎报也不误判**：三类 `applyError`（`runtime-unavailable` / `installation-not-found` / `scan-failed`）+ 「值已持久化」不变；`runtime` 未装配支本轮补回 `applyError`（D4），语义仍与文档一致。
- **兜底保留**（用户裁决）：Runtime 未装配 / 未建链 / 换根重扫故障仍退回「重启后生效」询问——当场无法生效时不谎称已生效。
- **N2 的 settle 吞错口径**：只吞「已被上一次扫描如实记录过」的失败，不吞新扫描自己的错误；`scan()` 对调用方的异常形态不变（原样上抛，由 handler 归一）。
- **N3 判据零依赖**：纯字符串形态判定，不 `import node:path`、不触磁盘，两侧宿主同判据；失败信息经 `AppError.validation` 表达（约定第 2 条），`userMessage` 走翻译，`details` 不含完整路径。
- **e2e 环境失败与逻辑失败分开**：未建链整件 skip 并给可执行修复命令，绝不把环境缺失伪装成逻辑失败；`fs.rm` 合成根失败容忍；日志异步落盘 ⇒ 红判据只用返回值与 DOM，`readMainLogTail()` 只在 close 后作辅助取证。
- **出包不可再生风险**：备份先于出包；旁路产物等价性由 N14 的逐字节 `equals` + `latest.yml` 双轴证明；后台命令读日志内层 `EXIT=` / `⨯` 行。
- **红线**：不 `--no-verify`、不 `it.skip`、不放宽断言、不调低覆盖率阈值、不为凑任务造空提交或假红灯。

---

## 8. 基础测试用例（正常 / 异常 / 边界三类，全部我亲自跑）

| 类   | 本轮新增                                                                                                                                                                                                                                                   | 复用既有（不重复造）                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 正常 | `bf` reset 即时生效文案（既有 az 保持）；e2e G1 `applied:true` + `installRoot` 换根 + `lastScan` 存在；e2e G2 真 UI 点保存出即时生效文案且无重启询问                                                                                                       | `runtime-manager.test.ts` 换根重建/快照不回退/LAN 复原；`SyncServicePage.test.tsx` (az)/(bc) |
| 异常 | **D1**：reset × `installation-not-found` ⇒ 不给「该目录不是安装根」、走 `savedDeferred` + 重启询问（**修前必红**）；**D2**：在途扫描峰值 >1 ⇒ 红；**D3**：`admit(D:\)` 被拒且不登记；**D4**：runtime 未装配回 `applyError:'runtime-unavailable'`           | 三类 `applyError` 归一、已落库不判失败、`applyGameRoot` 原样上抛                             |
| 边界 | 盘根四形态 `D:\` / `C:/` / `\\nas\share` / `\` 全拒，而 `D:\X6Game`、`D:\Photos`、tmpdir 深路径放行；e2e G3「游戏未装 + 恢复默认」；`SMOKE_COVERAGE` 登记 + `timeout ≤ setTimeout−15s` 守卫；`test:ci-linux` 证 Linux 宿主同判据；红阶段原生模态不阻塞用例 | 同值重复保存幂等、`''` 回自动发现、原本没跑 LAN 不代为开启、历史脏值回退空串                 |

**硬性要求**：N1–N4、N6 的新判据在修复/重建前**必须实测为红**；改前即绿的用例等于没覆盖，当场重写判据再跑。计划里预写的预期读数若与实测不符，保留原预期并另写一行「按实况订正」，不销毁取证。变异抽查做两次：M1 还原被修的实现 ⇒ 证缺陷例有牙；M2 撤掉调用点 ⇒ 证夹具真在被覆盖；两次后都用 `sha256sum` 证恢复是逐字节还原。

---

## 9. 风险与残留

1. **`npm install` 是本轮最高风险单条命令**：它同时（a）剪掉四链 → 安装包静默缺运行时，（b）重写 lock。处置成对（N8），并把 `link:nikkisync:check` 设为进 N9 的硬闸门。
2. **杀软锁**：历史多轮必现，出包前探针 FREE 也预测不了 rename 成败；旁路已验证（`cp` 而非 `mv`），代价是汇报须写明绕锁、且产物等价性由 N14 自证。
3. **新增 `*.e2e.ts` 拖红全量 `npm test`**：由 `SMOKE_COVERAGE` 硬清单引起，N6 同批登记。
4. **「保存后永不弹重启」并非绝对成立**：三类兜底支按裁决保留，真实故障时仍会弹询问——汇报需如实说明这条边界。
5. **§2「不修」清单**逐条带理由记账，其中 `previewPaths` 回填与 `set-game-root` 阻塞是本轮**明知不动**的取舍（动了会复活上一轮修掉的缺陷 / 破坏 `applied` 的同步语义）。
6. 不 push `origin/main`（本地领先将增至 17 笔）——属发布动作，需另行批准。

---

## 10. 执行记录（逐节点回写真实读数）

> **本文已被取代并按取代方执行完毕（2026-11-02）**：`docs/plans/2026-11-01-review-fix-2.5.6-repack-round2-实施计划.md`
> 落盘时即声明取代本文（其 §2.3 对本文 D3 放大机制等预判做了实测订正）。本文 §10 各节点
> **未按原表执行**，全部修复与验证工作已由取代方完成——逐节点真实读数、偏差订正（含杀软
> 间歇性拦截合成 exe 的夹具改道、判据落点订正、asar 备份竞态）与全局回归矩阵见取代方 §10 /
> §10.1 / §10.2；最终产物 `MeowStarMap-Setup-2.5.6.exe`（184,655,711 B，sha512 `luOCEAnq…`），
> 提交序列 `bcf442d` / `5f0b0d0` / `600a996` / `f29bd5a` / `19088bc` / `d94a3b1` / `20ff20f` / `d86c7c2`。
> 本表原样保留「待填」即为历史事实：未执行，不补假读数。

| 节点                  | 验证命令                                        | 实测读数 |
| --------------------- | ----------------------------------------------- | -------- |
| N0 落盘               | 待填                                            | 待填     |
| N1 D1 红→绿           | 待填                                            | 待填     |
| N2 D2 红→绿           | 待填                                            | 待填     |
| N3 D3 红→绿           | 待填                                            | 待填     |
| N4 D4/D5              | 待填                                            | 待填     |
| N5 CHANGELOG          | 待填                                            | 待填     |
| N6 e2e 红灯           | 待填                                            | 待填     |
| N7 静态门             | 待填                                            | 待填     |
| N8 install + 四链     | 待填                                            | 待填     |
| N9 build + 转绿       | 待填                                            | 待填     |
| N10 六门矩阵          | 待填                                            | 待填     |
| N11 提交序列          | 待填                                            | 待填     |
| N12 版本 2.5.6        | 待填（已预取：五处声明位全为 `2.5.6` ⇒ 零编辑） | 待填     |
| N13 出包              | 待填                                            | 待填     |
| N14 包内取证 + 打包态 | 待填                                            | 待填     |
| N15 收尾回归          | 待填                                            | 待填     |

### 10.1 与本文的偏差（如实订正，不改判据迁就实现）

待填。

### 10.2 全局回归矩阵

待填。
