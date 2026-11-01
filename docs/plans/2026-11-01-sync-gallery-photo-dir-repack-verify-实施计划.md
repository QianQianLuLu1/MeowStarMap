# 同步图库「照片目录保存即生效」— 真机验证与重新出包 实施计划（经批准后落盘，按节点红→绿执行）

> 生成日期：2026-11-01 · 本仓 `main` @ `41ce32f`（`meow-star-map 2.5.6`）
> 真相源：`docs/plans/2026-11-01-sync-gallery-photo-dir-apply-on-save-实施计划.md`（上一轮，代码侧已交付）· `e2e/nikkisync-runtime.e2e.ts`（真实窗口用例范式）· `src/main/nikkisync/AGENTS.md` · `docs/CODING_CONVENTIONS.md` · `AGENTS.md`
> 路线：源码零改动，只做「产物侧收口 + 真机判据自动化 + 重新出包 + 包内取证」。
> 落盘状态：本文于 2026-11-01 经批准后落盘于 `docs/plans/`；执行读数见 §10。

---

## 1. Context：本轮真正要解决的问题

需求原文是「移除自定义照片目录需先选择并重启才能扫描的限制，改为保存即重扫」。**这条限制在源码里已经不存在了**，由 2026-11-01 18:53–19:09 三笔提交交付并已全量回归：

| 站点                                                      | 现状                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/nikkisync/runtime-manager.ts:567`               | `applyGameRoot(gameRoot)` = 刷 `deps.defaults` 快照 → 复用既有 `scan({gameRoot})`（换根重建 + `fullScan`）→ `finally` 复原 LAN 服务                           |
| `src/main/ipc/handlers/nikkisync-handler.ts:916`          | `set-game-root` 落库后**同一次 IPC 内**调 `applyPersistedGameRoot`（`:483`），成功返回 `{applied:true, needRestart:false}` 并广播 `nikkisync:library-changed` |
| `src/renderer/pages/sync-gallery/SyncServicePage.tsx:648` | `announceGameRootApply` 按 `applied` 分流：即时生效文案，**不弹**重启询问                                                                                     |
| `src/renderer/i18n/locales/zh-CN.json`                    | `photoDirectories.description` 已写「保存后当场重建同步库并触发扫描，无需重启」                                                                               |

上一轮回归读数：`npm test` 463 文件 **7315 passed / 20 skipped / 0 failed**；`lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `verify:dist` 全绿。

**真正的缺陷在产物侧**，四条实测证据：

1. `release/MeowStarMap-Setup-2.5.6.exe` 时间戳 **11-01 17:40**，比修复提交（18:53）**早 1 小时 13 分** ⇒ 用户装的那个包里没有 `applyGameRoot`，走的仍是旧的「落库 → 弹重启询问」。用户复现环境经确认正是「已安装的 2.5.6 包」。
2. `dist/` 从未重建：`grep -rl applyGameRoot dist` **零命中**。
3. 上一轮计划 §10.6 的 **5 条真机验证清单一条都没执行过**——该修复至今只有单测背书，没有任何「真实应用会话里点保存」的证据。
4. `npx tsx scripts/check-changelog-release.ts` 实测**红**：`✖ [Unreleased] 含 1 条待发布条目（行 24）` ⇒ `npm run dist:win` 会在 `pre-dist-check`（`pre-dist-check.ts` + `check-doc-versions.ts` + `check-changelog-release.ts`）硬失败，压根到不了 electron-builder。**这是本轮出包的第一个真实卡点。**

**用户已裁决的三项边界**：

- 复现环境 = 已安装的 2.5.6 包（⇒ 本轮主体是重建 + 出包 + 取证，不是再改一遍代码）。
- **保留**三类兜底：Runtime 未装配 / NikkiSync 未建链 / 换根重扫故障仍退回「重启后生效」询问——当场确实无法生效时不谎称已生效。
- 版本号**保持 2.5.6**，把 `[Unreleased]` 条目并入既有 `## [2.5.6]` 节（先例 `951c235`）。

**意图结果**：拿到一个真的含修复的 2.5.6 安装包，并且「保存即生效」这件事有一条可复现、可重跑的自动化真机判据，而不是文档里的一句「应该正常」。

---

## 2. 本轮做什么 / 不做什么

**做**：CHANGELOG 收口 → 新增 e2e 真机用例（先红）→ 重建 `dist` 转绿 → 出包 → 包内字节取证 → 打包态复验 → 全量回归与提交。

**不做**（最小化改动的字面要求）：

- **不改 `src/**` 任何代码**。上一轮已交付，本轮验证若发现新缺陷才另议。
- 不动三类兜底支的语义与文案。
- 不修上一轮 §9 明记的四条残留（独立照片文件夹语义、`resource-allowlist` 与 `media://` realpath 不对称、额外目录节静默消失、Program Files 形态被 `isSensitivePath` 拒）。
- 不 push `origin/main`（本地领先 14 个提交）——属发布动作，需另行批准。

---

## 3. 依赖声明

**零新增 / 零变更依赖，无需 `npm install`。** 全部复用仓内既有工装：

| 复用项                                            | 位置                                                                        | 用途                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `launchBuiltApp()` / `launchApp()` / `closeApp()` | `e2e/helpers.ts:164` / `:71` / `:208`                                       | 未打包态与打包态启动；`closeApp` 带 `process().kill()` 兜底 |
| `launchEnv()`（剥 `ELECTRON_RUN_AS_NODE`）        | `e2e/launch-env.ts`                                                         | 宿主泄漏该变量时 Electron 退化成 Node、`exitCode=9`         |
| `decideNikkiSyncGate()` + `hasNikkiSyncLink()`    | `e2e/nikkisync-guard.ts`                                                    | 未建链整件 skip（AGENTS §6：未链接是受支持的默认态）        |
| `readMainLogTail()`                               | `e2e/nikkisync-runtime.e2e.ts:196`                                          | 主进程日志取证（本地复制，不动 N 套件）                     |
| 上游安装根判据                                    | `@nikkisync/pc-companion/dist/src/game-directory-discovery.js:40` `valid()` | 合成假安装根的依据（见 §5.1）                               |
| `runtime.status()` 的 `installation` / `lastScan` | `runtime-manager.ts:366-376`                                                | 比 toast 更硬的功能判据                                     |
| `@electron/asar` `listPackage` / `extractFile`    | 既有出包取证形态                                                            | 包内字节级验收                                              |
| `npm run docs:links`                              | `scripts/check-md-links.ts`                                                 | 新计划文档死链闸门                                          |

> **禁止 `npm install`**：任何一次 `npm install` / `npm update` 都会静默剪掉 `node_modules/@nikkisync/*` 四条 junction（它们不是声明依赖），导致**安装包静默缺整个内嵌同步运行时**（体积掉约 608KB，`verify:dist` 的 `nikkiSyncPackedVerdict` 会 fail）。出包前必跑 `npm run link:nikkisync:check`。

---

## 4. 启动说明

环境：本机 Node `v24.18.0`；`@nikkisync` 已建链（指向 `../NikkiSync`，其 `dist/` 已构建）；目标平台 Windows x64。

```bash
npx tsx scripts/check-changelog-release.ts                                 # CHANGELOG 收口闸门
npx playwright test --config e2e/playwright.config.ts nikkisync-game-root   # 新增真机用例（未打包态）
NIKKI_E2E_PACKAGED=1 npx playwright test --config e2e/playwright.config.ts nikkisync-game-root  # 打包态复验
npm run build / npm run verify / npm test / npm run lint
npm run typecheck / npm run typecheck:e2e / npm run i18n:guard
npm run link:nikkisync:check / npm run pre-dist-check / npm run dist:win / npm run verify:dist
```

`e2e/playwright.config.ts` 口径：`testMatch: '*.e2e.ts'`、`workers=1` 串行、单用例 60s、`expect` 15s、`retries` 仅 CI 生效。

**阶段 A 的唯一动作**：本文落盘 + `git add` + 单独提交 `docs(plans): ...`，随后**明确停下等用户读过**；回「继续」才进阶段 B。会话内的 plan 文件不算交付物。落盘顺序必须是「文档先 add 进 tracked 集 → 再动 CHANGELOG」，否则 `check-md-links` 的契约测试会因引用未跟踪路径把全量 `npm test` 打红。

---

## 5. 参数校验（入参 / 必填 / 边界 / 非法值）

本轮不新增 IPC 通道，校验集中在 **e2e 的合成根构造** 与 **打包前置** 两处。

### 5.1 合成安装根（决定 `applied` 能否为 true）

上游 `valid(root)`（`game-directory-discovery.js:40-47`）要求：`root/X6Game` **是目录**，且下列三者之一是**文件**：`root/InfinityNikki.exe` / `X6Game/Binaries/Win64/X6Game-Win64-Shipping.exe` / `X6Game/Binaries/Win64/X6Game.exe`。

`ScannerService.start()` 的唯一 throw（`scanner/ScannerService.js:39-58`）只在 `installation` 为假 **且** `allowMissingInstallation` 未设 **且** `extraDirectories` 为空时触发，**与媒体根是否存在无关** ⇒ 空占位文件即可拿到 `applied:true`。但 `photoRoots` 为空会让 `getScanRoots()` 返回 `[]`、扫描短路成零动作（`:141-144`），削弱证据。故最小可用树（落在 `.cache/`，被 gitignore、不脏 git）：

```
.cache/e2e-game-root-<ts>/
├── InfinityNikki.exe              # 0 字节，只为过 isFile
└── X6Game/Saved/GamePlayPhotos/   # 空目录 ⇒ photoRoots[0] 非空
```

- 上游 `excluded`（`:29`）里的 `\.cache` 只约束 `children()` 的 BFS **下潜**，不影响 manual 根本身；`isSensitivePath`（`src/main/utils/ipc-validate.ts:53-75`）不拦。
- **不要**同时建 `ScreenShot`：它进 `supplementalRoots` 并被去重逻辑特殊对待。
- 下传链已核实：`applyGameRoot:567` → `scan({gameRoot})` → `start(rootOptions)` → `deps.createSession` → `runtime-facade.ts:693` `...(options.gameRoot ? { selectedInstallRoot: options.gameRoot } : {})`。

| 入参                  | 判据                                                                                                                                                                                     | 非法值处置                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `setGameRoot({path})` | **不变**：必填、trim 后 1..512、绝对路径正则；非敏感目录 + 存在 + 是目录 + 可读（`validatePhotoSourceDirectory`）                                                                        | 通道整体失败（`VALIDATION_ERROR` / `PATH_FORBIDDEN`），不落库不 apply                                      |
| G3 边界路径           | 只建 `X6Game/`、不建 exe ⇒ 过 `validatePhotoSourceDirectory` 但上游 `valid()` 为假                                                                                                       | 期望 `applied:false` + `applyError:'installation-not-found'`，且**值仍已落库**（`get-game-root` 回读相等） |
| `installRoot` 比较    | 两侧同用 `path.win32.resolve` + 小写折叠（NTFS 不区分大小写是产品事实）                                                                                                                  | 禁止用宿主 `path.posix` 解释 Windows 形态串（AGENTS 第 6 条路径语义三分法）                                |
| 打包前置              | `link:nikkisync:check` 必须四链齐；`release/win-unpacked.tmp`（17:39 的 EPERM 残留）必须不存在或可整树删除——`resolveVerifyAsarTarget` 明确拒绝 `*.tmp` 段（`pre-dist-check.ts:432-435`） | 链不在 ⇒ 先 `npm run link:nikkisync` 再继续，不得带缺链状态出包                                            |

---

## 6. 错误处理（异常分支 / 兜底 / 日志输出）

| 分支                                                                                                                                                                        | 判据                                                                                                                                                                                                                 | 兜底行为                                                                                                                                                                                                                                                                                                                                                                                                                                      | 输出                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **红阶段原生模态阻塞**                                                                                                                                                      | 旧 dist 返回体无 `applied` ⇒ 渲染层走 `savedDeferred` 支，随后 `await promptRestart()` → `dialog.showMessageBox` 是**主进程原生模态**（`dialog-handler.ts:125-149`），该 IPC promise 永不 resolve，Playwright 收不到 | 把**零模态判据排在最前**：G1 用 `page.evaluate` 直调 `window.electronAPI.nikkisync.setGameRoot()`（不经组件逻辑 ⇒ 不触发对话框），第一条 `expect` 就红、永不进入模态支。G2 放其后，红时靠 `expect` 15s 超时 + `closeApp()` 的 `kill()` 兜底收场                                                                                                                                                                                               | 用例失败截图（`screenshot: only-on-failure`）+ 断言 message 写明原因 |
| 主进程日志不能当红判据                                                                                                                                                      | electron-log **异步落盘**，`app.close()` 之前读不到（`nikkisync-runtime.e2e.ts:522-523` 已明文承认）                                                                                                                 | 红判据只用返回值与 DOM；日志只在 close 后作辅助取证                                                                                                                                                                                                                                                                                                                                                                                           | `readMainLogTail()` 输出进 test-results                              |
| 未建链                                                                                                                                                                      | `hasNikkiSyncLink(REPO_ROOT)` 为 false                                                                                                                                                                               | 整件 skip 并给出可执行修复命令 `npm run link:nikkisync`，不得把环境缺失伪装成逻辑失败                                                                                                                                                                                                                                                                                                                                                         | `gate.reason`                                                        |
| `dist` 被 `tsc -b` 覆写成 per-file CJS                                                                                                                                      | `dist/main/main/preload.d.ts` 存在                                                                                                                                                                                   | `e2e/dist-guard.ts` 主动拦并给中文提示；处置是先确认 `src/main/tsconfig.json` 的 `outDir` = `.cache/tsmain`，再 `npm run build` 重生成，**不改任何代码**                                                                                                                                                                                                                                                                                      | 抛错文案                                                             |
| 出包死在 `EPERM rename('release\win-unpacked.tmp' -> 'release\win-unpacked')` / `EBUSY`（腾讯电脑管家对新解压 asar 主动加锁，历史多轮必现；**出包前探针 FREE 也预测不了**） | 标准配方 `npm run dist:win` 失败                                                                                                                                                                                     | 已验证旁路：官方 electron 缓存解到 `.cache/electron-dist-clean`（排除 `resources/default_app.asar` 与 `version`）→ `npx electron-builder --win --publish never --config.electronDist=<该目录> --config.directories.output=release/build-20261101-apply` → 用 **`cp -rf`（不是 `mv`）** 搬成 `release/win-unpacked`（被锁文件只挡 rename/unlink，读取与就地覆盖允许）→ 裸跑 `npm run verify:dist` 应自己变绿。汇报里必须写明这是绕锁而非改配方 | 构建日志：读内层 `EXIT=` 与 `⨯` 行，**不信后台通知摘要**             |
| 出包成功但产物其实没变（空重跑）                                                                                                                                            | `latest.yml` 的 `size` 与 `sha512`                                                                                                                                                                                   | 两轴**都**必须与归档的旧包不同，否则判为没真出包                                                                                                                                                                                                                                                                                                                                                                                              | 读数写进 §10                                                         |
| 不可再生的历史安装包被覆盖                                                                                                                                                  | `release/` 整目录被 gitignore ⇒ 安装包在 git 里**没有任何副本**                                                                                                                                                      | 出包前把现役 `MeowStarMap-Setup-2.5.6.exe` 三件移到 `_safe_backup_release-20261101-1740/` 留底                                                                                                                                                                                                                                                                                                                                                | 备份路径                                                             |
| 新增 `*.e2e.ts` 把全量 `npm test` 打红                                                                                                                                      | `e2e/__tests__/timeout-budget.test.ts:35` 的 `SMOKE_COVERAGE` 是**硬编码清单**，`:174` 逐字 `toEqual(smokeCoveredFiles(readdirSync(e2eDir)))`                                                                        | 同批把 `nikkisync-game-root.e2e.ts` 登记进该清单；该守卫还要求每个 `timeout:` 字面量 ≤ `test.setTimeout − 15_000`                                                                                                                                                                                                                                                                                                                             | `npm test`                                                           |
| CHANGELOG 并入后 `[Unreleased]` 仍判红                                                                                                                                      | `ENTRY_LINE_RE`（`:52`）也匹配**缩进子条目**                                                                                                                                                                         | 必须清掉 `[Unreleased]` 节内一切 `- ` / `* ` 行（保留标题与说明散文——缺日期只是 warning）                                                                                                                                                                                                                                                                                                                                                     | 闸门逐行读数                                                         |

---

## 7. 节点设计（每节点：文件 / 输入输出 / 可判定验收标准，先红后绿，我亲自跑）

### N0（阶段 A）计划落盘 — **做完即停，等用户读过**

- 文件：本文
- 输入/输出：批准的本文 → 入仓文档 + 一笔 `docs(plans)` 提交
- 验收：`git log -1 --stat` 命中本文；`npm run docs:links` 不因此红
- **停点**：不进 N1

### N1 CHANGELOG 收口（打开出包链的前提）

- 文件：`CHANGELOG.md`（行 20–35 区域）
- 输入：`[Unreleased]` 的 1 条条目 + 行 35 末尾 41ce32f 加的「后续修正（2026-11-01，**已移入 `[Unreleased]`**）…」整句
- 输出：按先例 `951c235` 把条目并入 `## [2.5.6]` 的 **`### Added`** 主条目（「同步图库自定义照片目录」）下作**缩进子条目** `  - 后续修正（2026-11-01，保存即重扫）：<原条目全文>`；不放 `### Fixed`（那里是「已出厂代码的独立缺陷」，本条是同一特性的契约订正）；删除 `[Unreleased]` 内的 `### Fixed | 修复` 子节与条目；**整句删除**行 35 那句「已移入 `[Unreleased]`」——并入后该表述自相矛盾，且「按原文保留、不覆写」本轮正被违反
- 验收：`npx tsx scripts/check-changelog-release.ts` 输出 `✔` 且**无任何 `✖` 行**（管道后的 `$?` 是包装层的，必须读 `✔/✖` 标记判定）
- 失败处置：报「版本节缺失/重复」⇒ 检查 `## [2.5.6] - 2026-11-01` 标题是否被误改

### N2 新增 e2e 真机用例（**先红，且红必须在 `npm run build` 之前取到**）

- 文件：`e2e/nikkisync-game-root.e2e.ts`（本节点计划新增，落盘前不存在）；修改 `e2e/__tests__/timeout-budget.test.ts:35`（登记新文件名）
- 骨架：`decideNikkiSyncGate({linked: hasNikkiSyncLink(REPO_ROOT)})` 门控；`beforeAll` 用 `launchBuiltApp([], {})` 启动——**刻意不传 `NIKKI_NIKKISYNC_RUNTIME`**，复刻用户机 `runtimeEnabled` 缺省 false 的真实态（`nikkisync-runtime-setup.ts:289` 先注入句柄、`:292` 才判自启 ⇒ 句柄在、会话不起，保存时走 `scan()` 的惰性 `start`，**这正是老包死掉的那条路**）；`localStorage.setItem('app-language','zh-CN')` + `reload()`；`test.setTimeout(150_000)`（先例 `fullscreen-diagnose.e2e.ts:34`）；`afterAll` 关窗并 `fs.rm` 合成根（`catch` 容忍：上游 `ScannerWatcher` 会握句柄）；按 `process.env.NIKKI_E2E_PACKAGED === '1'` 切 `launchApp()`（约 5 行），使同一条判据既验 `dist` 也验最终产物树
- 为什么不插进 `nikkisync-runtime.e2e.ts` 的 N3c 与 N4 之间：① N1 用 `NIKKI_NIKKISYNC_RUNTIME:'1'` 启动，会话已 `running`，测不到惰性支；② N3c 刻意让 LAN 服务跑到 N4，而 `applyGameRoot` 会 teardown（`nikkisync.restart`）再在 `finally` 重启服务，给 N4 的端口断言引入重绑抖动
- 用例（三条，全部应**先红**）：
  - **G1 零模态主判据**：`page.evaluate(() => window.electronAPI.nikkisync.setGameRoot({path: 合成根A}))` ⇒ 断言 `res.applied === true` 且 `res.needRestart === false`；随后调 `runtimeStatus()` 断言 `installation.installRoot`（两侧 `path.win32.resolve` + 小写折叠）等于合成根 A、`lastScan` 键存在——证明**当场真的换了根并跑了一次扫描**，不只看文案
  - **G2 真实 UI 路径**：`getByTitle('同步图库')` → `getByTitle('同步服务')` → 照片目录节（常驻渲染，`SyncServicePage.tsx:1127`）→ `getByPlaceholder('输入或浏览选择本地目录')` 填合成根 B → **收窄到同一 `div.space-y-2`** 取 `getByRole('button',{name:'保存'})`（裸 `name:'保存'` 在该页有歧义）→ 断言 `照片目录已保存并立即生效` 可见、`未能立即生效` **不可见**；`page.screenshot` 留真窗证据
  - **G3 边界**：填「只建 `X6Game/`、无 exe」的目录 → 保存 → 断言出现 `该目录不是有效的游戏安装根…` 文案、**不**出现重启询问（`SyncServicePage.tsx:650-653` 先 `return`，零模态安全）、且 `get-game-root` 回读仍等于该路径（证明未生效但值不丢）
- 验收（红）：`npx playwright test --config e2e/playwright.config.ts nikkisync-game-root` ⇒ G1 在 `applied` 断言失败（旧 dist 返回体无该字段）。红读数逐条写进提交信息
- **若 G1 直接就绿**：判据没牙或 dist 已被提前重建 ⇒ **停手，不许进 N3**，先重写判据
- 配套：`npm run typecheck:e2e` 与 `npm run lint` exit 0；`npx vitest run e2e/__tests__/timeout-budget.test.ts` 绿

### N3 重建产物并转绿

- 文件：`dist/`（由 `npm run build` 生成；其 `clean` 只删 `dist/main` 与 `dist/renderer/assets`，不动 `.cache/`、不动 junction、不动 `release/`）
- 验收：① `grep -rl applyGameRoot dist` 命中 ≥1；② N2 同一条命令**全绿**；③ `npm run e2e:smoke` 全绿
- 失败处置：见 §6 的 `dist-guard` 支

### N4 出包（标准配方优先，锁旁路为预案）

- 前置（顺序不可换）：备份现役安装包三件到 `_safe_backup_release-20261101-1740/` → `npm run link:nikkisync:check` 四链齐 → 处理 `release/win-unpacked.tmp` 残留 → `npm run pre-dist-check` 无 fail
- 执行：`npm run dist:win`；命中 §6 的 EPERM/EBUSY 支则走旁路并 `cp -rf` 搬正
- 验收：`release/MeowStarMap-Setup-2.5.6.exe` mtime 晚于 N3；`npm run verify:dist` **裸跑** exit 0；`latest.yml` 的 `size` 与 `sha512` 两轴都与备份不同

### N5 包内字节取证（回答「修复到底在不在包里」）

- 手法：`@electron/asar` 的 `listPackage` + `extractFile`。条目名是**反斜杠带前导 `\`**，喂 `extractFile` 前**只能去前导分隔符，绝不能把 `\` 换成 `/`**（换了必报 `was not found in this archive`）
- 三条判据（缺一不算取证）：① 包内主进程 JS 的 `applyGameRoot` 命中 ≥1，且与盘上 `dist/main/main/app/index.js` **逐字节 `equals:true`**；② **渲染层 asset** 能取到文案「照片目录已保存并立即生效」——用户看到的文案在 renderer chunk，只验主进程等于没验；③ 对**备份的旧包**做同样取数应 0 命中 ⇒ 自证判据有牙、不是空转
- 输出：读数写进 §10

### N6 打包态真机复验

- `NIKKI_E2E_PACKAGED=1 npx playwright test --config e2e/playwright.config.ts nikkisync-game-root`（走 `release/win-unpacked/喵星图.exe`）
- 验收：三条用例全绿，且日志 `[e2e] executable:` 打印 `release/win-unpacked/喵星图.exe` 才算验到新树
- 这条也过 ⇒ 用户侧无需再手点；只有环境前提不成立时才如实记 `not-run`，并把唯一剩余动作（装包）交回，且只交回那一个动作

### N7 全量回归与收尾提交

```bash
npm run verify && npm test && npm run lint && npm run typecheck && npm run typecheck:e2e && npm run i18n:guard && npm run docs:links && git status --porcelain
```

- 验收（硬门）：全量 `npm test` **0 failed**，且用「总数差 == 新增例数」核对没有既有用例被静默排除（基线 7315 passed）
- 提交序列：`docs(plans)` → `docs(changelog)` 收口 → `test(e2e)` 新增照片目录即时生效真机用例（附修复前红读数）→ `chore(release)` 回写出包与包内取证读数。本轮**无 `src/**` 改动**，故不触发「红测与修复合并一次」的 lint-staged 约束（红的是 Playwright，不在 vitest 的 `*.test.ts` 收集面内）；仍**禁止 `--no-verify`**
- 未全绿不得标记完成

---

## 8. 基础测试用例（正常 / 异常 / 边界三类）

| 类   | 本轮新增（N2 的 e2e 真机用例）                                                                                                                                                                     | 已在上一轮钉住（不重复造）                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 | G1 保存真实合成根 ⇒ `applied:true` + `needRestart:false` + `status().installation` 换成新根 + `lastScan` 存在；G2 真 UI 点保存 ⇒ 即时生效文案出现、重启文案不出现；N6 打包态同判据                 | `runtime-manager.test.ts`（换根重建 + 快照刷新不回退 + LAN 复原/不误启）；`nikkisync-handler.test.ts`（落库 + apply + `library-changed` 广播）；`SyncServicePage.test.tsx`（applied 支不弹重启框） |
| 异常 | G3 目录不是安装根 ⇒ `applyError:'installation-not-found'` 文案、不弹重启、**值仍已落库**；未建链整件 skip 且给出修复命令                                                                           | 三类 `applyError` 归一（`runtime-unavailable` / `scan-failed`）与「已落库不判失败」；`applyGameRoot` 原样上抛                                                                                      |
| 边界 | 红阶段原生模态不阻塞用例（G1 零模态判据排最前）；`fs.rm` 合成根失败容忍；`SMOKE_COVERAGE` 登记 + `timeout ≤ setTimeout−15s` 守卫；`resolveVerifyAsarTarget` 拒 `*.tmp` 段；`cp` 而非 `mv` 搬被锁树 | 同值重复保存幂等；`''` 回上游自动发现；原本没跑 LAN 则不代为开启；历史脏值回退空串                                                                                                                 |

**硬性要求**：G1/G2/G3 在 N3 之前必须实测为红；改前即绿的用例等于没覆盖，当场重写判据再跑，并把「预期读数与实测不符」显式订正进 §10（不悄悄改判据迁就实现）。

---

## 9. 风险与残留

1. **管家锁导致标准配方失败**（历史多轮必现）：已备好旁路，代价是汇报里必须说明「这是绕锁而非改配方」；旁路产物等价性由 N5 的逐字节 `equals` 与 sha256 证明。
2. **旧安装包不可再生**：`release/` 不在 git 内，覆盖前必须备份，且备份必须在出包**之前**做。
3. **新 e2e 用例拖红全量 `npm test`**：由 `SMOKE_COVERAGE` 硬清单引发，N2 同批登记即可，漏一次就浪费一轮回归。
4. **「保存后永不弹重启」并非绝对成立**：三类兜底支按用户裁决保留，真实故障时仍会弹询问，这是有意为之（不谎称已生效）。汇报时需如实说明这条边界。
5. 上一轮 §9 的四条残留（独立照片文件夹语义、`resource-allowlist` 与 `media://` realpath 不对称、额外目录节静默消失、Program Files 形态被黑名单拒）本轮明确不动，仍在原计划文档里记账。

---

## 10. 执行记录（待回写：每个节点的真实读数）

### 10.1 节点验证链（红→绿）

| 节点         | 验证命令 | 实测读数 |
| ------------ | -------- | -------- |
| N0 落盘      | 待填     | 待填     |
| N1 CHANGELOG | 待填     | 待填     |
| N2 红灯      | 待填     | 待填     |
| N3 绿灯      | 待填     | 待填     |
| N4 出包      | 待填     | 待填     |
| N5 包内取证  | 待填     | 待填     |
| N6 打包态    | 待填     | 待填     |
| N7 回归      | 待填     | 待填     |

### 10.2 与本文的偏差（如实订正，不改判据迁就实现）

待填。

### 10.3 全局回归矩阵

待填。
