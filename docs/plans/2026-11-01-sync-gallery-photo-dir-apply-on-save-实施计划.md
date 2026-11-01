# 同步图库「自定义照片目录」保存后立即生效 — 实施计划（经批准后落盘，按节点红→绿执行）

> 生成日期：2026-11-01 · 本仓 `main` @ `d48f2a8`（`meow-star-map 2.5.6`）
> 真相源：`src/main/nikkisync/runtime-manager.ts`（换根重建与局域网服务编排）· `src/main/app/nikkisync-runtime-setup.ts`（`SETTING_GAME_ROOT` 读取端）· `src/main/ipc/handlers/AGENTS.md` · `src/main/nikkisync/AGENTS.md` · `docs/IPC_CONTRACT.md` · `docs/CODING_CONVENTIONS.md`
> 路线：裁决 A（保留安装根语义 + 运行期立即生效）；验证深度：单测 + 组件测（vitest）。
> 落盘状态：本文于 2026-11-01 经批准后落盘于 `docs/plans/`；上一轮同源计划见 `2026-11-01-sync-gallery-custom-photo-dir-实施计划.md`（其 §11 人工清单第 1 条即本轮 bug 的未验判据）。

---

## 1. Context：现象与根因（带证据）

**现象**：在「同步服务」页 ③b「照片目录」选好自定义路径并保存（校验全过、Toast 成功）后，「同步图库」板块仍不显示该路径下的照片。

**根因链（四条，前两条是致命项）**：

1. **保存只落库，全仓没有任何运行期生效通道。** `nikkisync:set-game-root` 的函数体只有校验 + `setSetting` + `return { needRestart: true }`（`src/main/ipc/handlers/nikkisync-handler.ts:873-882`），`reset-game-root` 同理（`:884-890`）。既不调 `runtime.scan/start`，不 `teardown`，也不发 `nikkisync:library-changed`（对比同文件 `:793`/`:815`/`:839` 三个目录通道都发了）。
2. **持久化值只在进程启动那一刻被读一次。** `buildSessionOptions` 读 `nikkisync.gameRoot`（`src/main/app/nikkisync-runtime-setup.ts:141-146`），产物被冻结成 `deps.defaults`（`:278-288`）与 `state.activeRoot`（`src/main/nikkisync/runtime-manager.ts:466`）。此后 `scan()` 只在 `desiredRoot !== activeRoot` 时重建（`runtime-manager.ts:506-516`），而 `startSyncServer` 的重建支用 `...deps.defaults`（`:626`）——**运行期改动的设置键没有任何读者**。
3. **图库工具栏「扫描游戏相册」也救不了。** `SyncGalleryPage.tsx:94` 调 `api.startScan()`（无参），`desiredRoot === undefined` ⇒ `rootOptions = { ...deps.defaults }`（启动快照）⇒ 换根判据恒等 ⇒ 不重建 ⇒ 扫的还是旧根。**结论：应用内不存在任何一个动作能把刚保存的目录推到运行中的会话**（除重启进程）。
4. **重启链路本身也是半截的。** 本机 `app_settings` 实测只有 `nikkisync.gameRoot = "H:\\InfinityNikki Launcher"` 一条 nikkisync 键（`nikkisync.runtimeEnabled` / `syncServerEnabled` 均不存在 ⇒ 缺省 false），所以重启后 `initNikkiSyncRuntime` 直接 `return`（`nikkisync-runtime-setup.ts:293-296`），会话不起、也不会扫描，同步图库落到「内嵌服务未启动」空态（`SyncGalleryPage.tsx:140-148`），其 CTA 是「重新载入」而非「扫描」。
5. **语义错配把失败做成静默。** 该值被当作上游 `selectedInstallRoot` 消费（`src/main/nikkisync/runtime-facade.ts:693`），上游 `InstallationSearch.valid()` 要求目录含 `X6Game` 子目录 + 游戏 exe（`node_modules/@nikkisync/pc-companion/dist/src/game-directory-discovery.js` 的 `valid`/`nearby`）；而 `validatePhotoSourceDirectory` 只验「敏感目录 / 存在 / 是目录 / 可读」（`nikkisync-handler.ts:400-426`）。discovery 失败 ⇒ `ScannerService.start()` 抛 ⇒ `runtime-manager.ts:483-486` 归 `degraded`（不是 `error`）⇒ `get-assets` 照常返回旧表 ⇒ 用户只看到「没图」。
   本机实测（直接跑上游 discovery，只读）：`H:/InfinityNikki Launcher` → `installRoot=H:\InfinityNikki Launcher\InfinityNikki`、photoRoots 命中 `...\X6Game\Saved\GamePlayPhotos`；`H:/CloudMusic` 与 `D:/Workbuddy 项目` → `undefined`。
6. **交付侧缺口**：`docs/plans/2026-11-01-sync-gallery-custom-photo-dir-实施计划.md` §11 人工验证清单第 1 条（「重启后同步图库出该目录照片」）标注为「待真机」，从未执行——本 bug 正落在这条未验的判据上。

**本轮裁决**：失败路径形态为「游戏安装根 / 其父目录」（可在上游 `valid()` 规则下正确解析），因此**主修 1–4（运行期生效通道）**，不引入「任意图片文件夹」语义（那是 K6 额外目录面的职责，明确不做）。

---

## 2. 方案（一句话）

保存 / 恢复默认后，主进程在落库的同一次 IPC 内用**既有** `runtime.scan({ gameRoot })` 完成「换根重建 + 重扫」，刷新 `deps.defaults` 快照，恢复原本在跑的局域网同步服务，并广播 `nikkisync:library-changed` 让同步图库自动取数；生效失败则退回旧「重启后生效」语义，用新可选字段 `applied` / `applyError` 如实告知渲染层。

### 2.1 改动清单

| 文件                                                                   | 做什么                                                                                                                                                                                                                                                                                                        | 受保护路径                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/main/nikkisync/runtime-manager.ts`                                | 新增 `applyGameRoot(gameRoot: string)`：刷新 `deps.defaults.gameRoot` → 复用 `scan({ gameRoot })` → 若 `state.syncAddress` 原为在跑则 `startSyncServer()` 复原                                                                                                                                                | 否                                                 |
| `src/main/nikkisync/runtime-types.ts`                                  | `NikkiSyncRuntimeHandle` 加 `applyGameRoot` 声明（一行 + 注释）                                                                                                                                                                                                                                               | 否                                                 |
| `src/main/ipc/handlers/nikkisync-handler.ts`                           | `set-game-root` / `reset-game-root`：落库后 `requireRuntime` 可用 ⇒ `applyGameRoot`，成功 `applied:true, needRestart:false`；失败/未装配 ⇒ `applied:false, needRestart:true` + `applyError`；两者成功后 `notifyLibraryChanged(event)`（`reset` 需补 `event` 形参，`wrapHandlerNoArgs` 已提供 `(ctx, event)`） | **是**（同批替换顶部 `@core-change` 注释为新原因） |
| `src/shared/types/electron-api.ts`                                     | `NikkiSyncSetGameRootResult` / `NikkiSyncResetGameRootResult` 加**可选** `applied?: boolean`、`applyError?: 'runtime-unavailable' \| 'installation-not-found' \| 'scan-failed'`                                                                                                                               | 否                                                 |
| `src/renderer/pages/sync-gallery/SyncServicePage.tsx`                  | `handleSaveGameRoot` / `handleResetGameRoot` 消费 `applied`：`true` → 即时生效文案、**不弹重启框**；`false` → 走既有 `promptRestart`（保留旧行为兜底）                                                                                                                                                        | 否                                                 |
| `src/renderer/i18n/locales/*.json`（12 包）                            | 改写 3 键 + 新增 1 键（见 §6.3）                                                                                                                                                                                                                                                                              | 否                                                 |
| `docs/IPC_CONTRACT.md`、`CHANGELOG.md`、`src/main/nikkisync/AGENTS.md` | 通道返回体与语义订正；`[Unreleased]` 条目；manager 职责表补 `applyGameRoot`                                                                                                                                                                                                                                   | 否                                                 |

**明确不动**：通道名与入参 zod（`gameRootSetSchema` / `admitDirectorySchema`）、preload `src/main/preload/api/nikkisync.ts`（方法签名不变，返回体是结构化透传）、`buildSessionOptions` 与启动读取链（下次进程仍靠它生效）、`pathGuard`（**不给自定义目录扩任何权**，F1 收窄结论保持）、K6 目录面、`SECURITY_SENSITIVE_KEYS`。

**为什么不复刻 `valid()` 做前置校验**：在 `set-game-root` 里另写一套「含 X6Game + exe」判据就是给上游规则造第二个真相源（正是 F3 那类漂移守卫在防的）。改成**让 apply 的真实结果当校验**：`applyGameRoot` 抛出的 `installation not found` 归一成 `applyError:'installation-not-found'`，UI 给出「已保存但当前目录不是有效安装根，重启也不会生效，请改选游戏安装目录或使用额外照片目录」的可执行提示。

---

## 3. 依赖声明

**零新增 / 零变更依赖，无需 `npm install`。** 全部复用仓内既有实现：

- `runtime.scan()` 换根重建支（`runtime-manager.ts:506-516`）与 `startSyncServer()` 的「先存 `activeRoot` 再重建」先例（`:622-629`）。
- `notifyLibraryChanged(event)`（`nikkisync-handler.ts:456-463`）+ `nikkisync:library-changed` 订阅面（`SyncGalleryPage.tsx:75-82`，页面 keep-alive 于 `App.tsx:371-397`，故在二级页时订阅仍存活）。
- `validatePhotoSourceDirectory`（同一文件 `:400-426`）、`parseAndRun` + `toAppError`（`:359-369` / `:429-447`）。
- 测试工装：`runtime-manager.test.ts` 的 `makeDeps(overrides)` 假 facade（不依赖建链）、`nikkisync-handler.test.ts` 的 `makeCtx` / `createRuntimeStub` / `getHandler` / `makeTempDir`、`SyncServicePage.test.tsx` 的 `window.electronAPI` 桩、`sync-service-keys.test.ts` 的 12 包等集守卫。
- i18n 批量工具：`npm run sync-i18n-keys`（`scripts/sync-i18n-keys.ts`）与 `npm run i18n:guard`。

---

## 4. 启动说明

- 环境：本机 Node（`v24.18.0`，仓库无 `engines` 硬门）；`node_modules/@nikkisync/*` 已建链（实测指向 `../NikkiSync`）。**注意**：本轮单测一律不依赖建链（假 facade 注入），若中途跑过 `npm install` 需 `npm run link:nikkisync` 复原，否则链接态用例会集体降级 skip。
- 单节点验证：`npx vitest run <测试文件路径>`；分层：`npm run test:main` / `npm run test:renderer`。
- 只读预检：`npm run verify`（typecheck + eslint 只读 + core-gate + prettier --check + 相关单测；不改文件）。
- 真机人工（可选，本轮不作为闸门）：`npm run dev` → 同步图库 → 同步服务 → 照片目录 → 浏览并保存 → 回同步图库应直接出图。
- 不在范围：`npm run e2e:smoke` / `e2e/nikkisync-runtime.e2e.ts`（需 `npm run build`，按裁决不进本轮闸门；若单测判据不足以定论再单独评估）。

---

## 5. 参数校验（入参 / 必填 / 边界 / 非法值）

| 项                        | 口径                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set-game-root.path`      | **不变**：必填、`trim` 后 1..512、绝对路径正则 `/^([A-Za-z]:[\\/]                                                                                                                                                          | \\\\ | \/)/`；非法 ⇒ `VALIDATION_ERROR`（`parseAndRun` 既有） |
| `reset-game-root`         | 无入参（仍是 `wrapHandlerNoArgs`，只补 `event` 形参）                                                                                                                                                                      |
| `applyGameRoot(gameRoot)` | 类型 `string`；`''` = 合法值语义「回退上游自动发现」（facade 用 `options.gameRoot ? ... : {}` 下发布尔短置，`''` 与 `undefined` 同效）；非字符串由 TS 拦住，不进运行时分支                                                 |
| 新增返回字段              | `applied?: boolean`、`applyError?: <三字面量>` 全为**可选**，旧客户端读不到即按 `needRestart` 走旧路径（向后兼容，符合契约稳定性规则）                                                                                     |
| 幂等与边界                | 同值重复保存：`scan()` 判据相等 ⇒ 不重建、只做一次 `fullScan()`（不产生会话抖动）；会话不存在 ⇒ 走惰性 `start`（这条正是本机 `runtimeEnabled=false` 的常态）；`state === 'unavailable'`（未建链）⇒ 不外抛，`applied:false` |
| 不做的事                  | 不给 `pathGuard` 登记任何集合（不扩权）；不改 `isSensitivePath` 黑名单语义（Program Files 形态的取舍本轮不动，见 §9）                                                                                                      |

---

## 6. 节点设计（每节点先红后绿，我亲自跑）

### N0 计划落盘

- 文件：`docs/plans/2026-11-01-sync-gallery-photo-dir-apply-on-save-实施计划.md`（本文）+ 新建执行记录节。
- 输入/输出：批准的本文 → 入仓文档。
- 验收：`ls docs/plans/ | grep apply-on-save` 命中；`npm run docs:links`（`scripts/check-md-links.ts`）不因新文档红（需 `git add` 后才算 tracked，与既有先例一致）。

### N1 manager 复现红灯

- 文件：`src/main/nikkisync/runtime-manager.test.ts`（新增 `describe('applyGameRoot：照片目录运行期生效')`）。
- 用例（三条，全部应**先红**）：
  1. 会话以旧根在跑 → `applyGameRoot(新根)` ⇒ `createSession` 第二次收到的 `options.gameRoot === 新根`、`scanner.fullScan` 被调一次（证明「换根 + 重扫」一体）。
  2. `applyGameRoot('')` ⇒ 新会话 `options.gameRoot` 为空（回自动发现），且随后 `scan({})` 不再退回旧 `deps.defaults.gameRoot`（钉住快照刷新——这条就是根因 2 的直接复现）。
  3. `state.syncAddress` 在跑时 `applyGameRoot` ⇒ 重建后 `session.server.start()` 再被调一次（服务不被换根悄悄掐掉）。
- 输入/输出：`applyGameRoot` 尚不存在 ⇒ 用例红。
- 验收：`npx vitest run src/main/nikkisync/runtime-manager.test.ts` 输出「新增 3 例 failed、既有用例 0 failed」，红灯计数如实写进提交信息。

### N2 manager 实现转绿

- 文件：`src/main/nikkisync/runtime-manager.ts`、`src/main/nikkisync/runtime-types.ts`、`src/main/nikkisync/AGENTS.md`（manager 职责行补一句）。
- 实现要点（ ≤ 20 行）：`deps.defaults = { ...deps.defaults, gameRoot: gameRoot || undefined }` → 记 `wasServing = Boolean(state.syncAddress)` → `await scan({ gameRoot })` → `wasServing && await startSyncServer()` → 返回 scan 结果。
- 先读确认再决定：`runtime-facade.test.ts` 是否已有能捕获 `RuntimeCtor` 入参的假面；**有**才补一条 `scanner.selectedInstallRoot === gameRoot` 的特征化用例，**没有**就以「`createSession` 收到 `options.gameRoot`」为断言边界（不为此改造假面）。
- 输入/输出：N1 三例转绿。
- 验收：`npx vitest run src/main/nikkisync` 全绿（0 failed）；红灯不复现。

### N3 handler 复现红灯

- 文件：`src/main/ipc/handlers/nikkisync-handler.test.ts`（`createRuntimeStub` 补 `applyGameRoot: vi.fn(...)`）。
- 用例：① `set-game-root` 成功 ⇒ `setSetting` 被调 **且** `applyGameRoot` 以同一路径被调 **且** 返回 `{applied:true, needRestart:false}`；② 广播断言：`event.sender.send` 收到 `'nikkisync:library-changed'`；③ `applyGameRoot` 抛 `installation was not found` ⇒ 仍 `success:true`、`applied:false`、`needRestart:true`、`applyError:'installation-not-found'`、**仍已落库**；④ 抛其他错 ⇒ `applyError:'scan-failed'`；⑤ `ctx.nikkisyncRuntime` 未注入 ⇒ 不调 apply、`applied:false`；⑥ `reset-game-root` ⇒ `applyGameRoot('')` + `applied` + 广播。
- 验收：新增 6 例 failed / 既有全绿；**特别确认既有「四通道均不依赖运行时装配」用例（`:1256`）不因实现而语义漂移**（它只断言 `success`，应继续绿）。

### N4 handler + 契约实现转绿

- 文件：`nikkisync-handler.ts`（`@core-change` 替换为「照片目录保存/恢复默认后运行期换根重扫并广播库变更」）、`src/shared/types/electron-api.ts`、`docs/IPC_CONTRACT.md`（§8.2.6 两通道返回体补 `applied`/`applyError`，并订正 `needRestart` 语义为「未能立即生效时才为 true」）。
- 验收：`npx vitest run src/main/ipc/handlers` 全绿；`npm run typecheck` 绿。

### N5 渲染层 + i18n 复现红灯

- 文件：`src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`、`src/renderer/i18n/locales/sync-service-keys.test.ts`。
- 用例：① stub 返回 `applied:true` ⇒ **不调** `dialog.showMessageBox`、成功 Toast 用即时生效文案；② stub 返回 `{applied:false, needRestart:true}` ⇒ 调重启框（旧行为保留）；③ `applied:false, applyError:'installation-not-found'` ⇒ 展示可执行提示键 `applyFailedInstallRoot` 且保留输入；④ 恢复默认消费返回值（今天整个丢弃返回值，必红）；⑤ 键守卫：等集断言先加新键 ⇒ 红。
- 验收：新增/改写用例 failed 计数如实记录，既有 (a)–(bb) 全绿。

### N6 渲染层 + 12 语包实现转绿

- 文件：`SyncServicePage.tsx`（`handleSaveGameRoot` / `handleResetGameRoot` 分支）、`src/renderer/i18n/locales/zh-CN.json`（基准）→ `npm run sync-i18n-keys` → 其余 11 包。
- 键位（净增 2 个键）：
  - 改写：`syncService.photoDirectories.description`（去掉「需重启应用生效」）、`.saved`（「已保存并立即生效」）、`.resetDone`（同口径）
  - 新增：`.savedDeferred`（已保存但未能立即生效，重启后生效）、`.applyFailedInstallRoot`（该目录不是有效游戏安装根，请改选安装目录或改用额外照片目录）
  - `restartTitle/restartMessage/restartNow/restartLater` 原样保留给 deferred 支。
- 验收：`npx vitest run src/renderer/pages/sync-gallery` 全绿 + `npx vitest run src/renderer/i18n/locales` 全绿 + `npm run i18n:guard` 绿。

### N7 全局回归与提交

命令矩阵（全部我亲自跑，逐项贴读数）：

```
npm run verify
npm test                 # 全量（当前基线 7296 passed / 20 skipped / 0 failed）
npm run lint
npm run typecheck
npm run typecheck:e2e
npm run i18n:guard
git status --porcelain   # 复核 pre-commit 钩子是否改写文件
```

提交策略（本仓既有硬约束）：一节点一提交、Conventional Commits；**红测与修复合并同一笔**（`lint-staged` 对 `src/**` 跑匹配套件，刻意留红的提交会被自家闸门拒 ⇒ 不用 `--no-verify`，把红灯计数写进提交信息）；受保护文件改动同批携带新的 `@core-change` 注释。

---

## 7. 错误处理（异常分支 / 兜底 / 日志）

| 分支                                                   | 判据                                                                      | 行为                                                                                                                                                                      | 日志                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 入参非法（相对 / 不存在 / 非目录 / 敏感目录 / 不可读） | 既有 zod + `validatePhotoSourceDirectory`                                 | 通道整体失败（`VALIDATION_ERROR` / `PATH_FORBIDDEN`），**不落库、不 apply**                                                                                               | 既有 `wrapHandler` 通道              |
| 未装配 runtime（`ctx.nikkisyncRuntime` 为空）          | `requireRuntime` 会抛，这里改为**显式判空跳过**                           | 落库成功、`applied:false`、`needRestart:true`，UI 走重启兜底（等价当前行为）                                                                                              | —                                    |
| 未建链（`state='unavailable'`）                        | `applyGameRoot` 抛 `not ready`                                            | `applied:false` + `applyError:'runtime-unavailable'`，不落 `scan-failed`                                                                                                  | manager `deps.log('warn', ...)` 既有 |
| 目录不是安装根                                         | 上游 `installation was not found`（`/not found/i`，同 `toAppError` 判据） | `applied:false` + `applyError:'installation-not-found'`；**值仍已持久化**（下次进程按旧语义仍可读到，不谎称丢配置）                                                       | manager `:486` warn 既有             |
| 重建/重扫其他异常                                      | 其余 error                                                                | `applied:false` + `applyError:'scan-failed'`，绝不把已成功的保存判成失败                                                                                                  | manager `:528` warn 既有             |
| LAN 服务被换根重建掐掉                                 | `state.syncAddress` 原为真                                                | `applyGameRoot` 内 `startSyncServer()` 复原；复原失败**不改**本次 `applied`（端口占用由 `syncStatus().error` 如实呈现，与本文件既有「startSyncServer 永不上抛」口径一致） | `:651` warn 既有                     |
| 渲染层                                                 | `applied !== false` 才认定即时生效                                        | `applied:false` → `savedDeferred`/`applyFailedInstallRoot` + 既有重启询问；`promptRestart` 在 `dialog.showMessageBox` 缺席时静默 return 的行为保留，但不再是主路径        | —                                    |
| 长任务                                                 | apply 内含 `fullScan`，`set-game-root` 由毫秒级变为秒/数十秒级            | 与既有「扫描游戏相册」(`startScan` 同一条 `scan()`) 完全同口径；`busy` 锁覆盖输入框与按钮，不新增取消语义（避免半途换根留下旧根会话 + 新库的中间态）                      | —                                    |

新增日志为零（复用 manager 既有 `deps.log`），handler 不引入 logger 依赖。

---

## 8. 基础测试用例（三类）

| 类   | manager（N1）                                                             | handler（N3）                                                                 | 渲染层（N5）                                                                            |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 正常 | 换根重建 + 一次 fullScan；`''` 回自动发现；服务复原                       | set/reset 立即生效：落库 + apply + `applied:true` + `library-changed` 广播    | applied 支不弹重启框、走即时生效文案；回到图库订阅自动取数                              |
| 异常 | 未建链时不外抛、状态如实                                                  | not-found / 其他 / 未装配三类 `applyError`，且**已落库**                      | 失败保留输入、展示可执行提示、`applied:false` 仍弹重启框                                |
| 边界 | 同值不重建只重扫；`scan({})` 不再退回旧快照；服务原本没跑则**不**被启起来 | 同一 path 重复保存幂等；trim 前后空白入库；历史脏值 `get-game-root` 回退 `''` | `resetGameRoot` 返回值今天被整体丢弃 ⇒ 必须改为消费；`dialog.showMessageBox` 缺席时不崩 |

**硬性要求**：每条用例在改动前必须实测为红（含 `scan({})` 退回旧快照那条——它是根因 2 的钉子）；若某条改前即绿，说明没覆盖到 bug，当场重写判据再跑，并把订正写进 §10 记录。

---

## 9. 已知残留（本轮不修，如实记账）

1. 「独立照片文件夹」形态仍不被 `photoDirectories` 支持（上游 `selectedInstallRoot` 语义所限）——本轮按裁决 A 明确不扩，UI 文案改为点名「游戏安装目录」并指向「额外照片目录」。
2. `resource-allowlist.ts:65-67` 的 `path.win32.resolve` 与 `media-protocol.ts:112` 的 `realpath` 两侧不对称：目录位于 junction / SUBST / 映射盘 / OneDrive 重定向时，手输同步域的照片可能整批 403（本机 H: 实测 `realpath == resolve`，不受影响）。
3. 「额外照片目录」整节在会话未装配时因 `extraDirs === null` 而静默消失（`SyncServicePage.tsx:1164` + `refreshExtraDirs` 吞错），是用户被推向「只有重启可用」控件的成因之一——留待下一轮单独裁决。
4. 官方启动器装在 `Program Files` 时 `isSensitivePath` 会拒绝手工设为 gameRoot（`validatePhotoSourceDirectory:401` 前置黑名单）。
5. 上述 2/3/4 与 `docs/plans/2026-11-01-photo-dir-review-fix-2.5.6-repack-实施计划.md` 记录的「未跑的人工回归」同源，本轮在计划里显式留痕，不悄悄吞掉。

## 10. 执行记录（实施时逐节点回写红灯/绿灯实测读数与命令输出）

（待回写）
