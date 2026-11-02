# GPU 三级阶梯批次复查、六道闸门收口与 2.5.6 重打包 · 实施计划

> 状态：已确认（2026-11-02，用户四问全部选推荐档）｜审查窗口：`a283eec..HEAD`（出包后 7 个提交 / 20 个文件）
> 交付口径：**先修 B1/B2 两处真实缺陷（TDD 红-绿）→ 六道闸门全绿 → 分节点提交 → 版本号 2.5.6（实测为零编辑）→ 重新打包并对新产物跑 `e2e:smoke`**。

---

## 1. Context：为什么是这几件事

任务模板要求「审查近期提交与未提交代码 → 修复 → 六道闸门全绿 → 提交 → 版本号设 2.5.6 → 重新打包」。开工前先把真实状态探清，避免按模板空转或造改动。

### 1.1 现场读数（全部实测，非推断）

| 探测项                                                                                                     | 读数                                                                                                                                                                      | 结论                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `git status --porcelain`                                                                                   | 空，`nothing to commit, working tree clean`                                                                                                                               | **没有未提交代码**，可审查对象只有提交历史                                                                                                                               |
| `git log origin/main..HEAD`                                                                                | 领先 38 个提交；最后一次出包收口于 `a283eec`（`chore(release): 2.5.6 重打包收口`）                                                                                        | 审查窗口取 `a283eec..HEAD` 的 **7 个提交 / 20 个文件**（GPU 三级兼容阶梯批次）；其余 31 个提交已在 `66fada5`/`a283eec` 两轮逐提交审查并记账（DEBT-044/045/046 即其产物） |
| `package.json` version + 声明位                                                                            | `2.5.6`；README 徽章、`AGENTS.md`、`ARCHITECTURE(.en).md`、`DEVELOPMENT(.en).md`、`docs/manual-smoke-checklist.md` 全部同值                                               | 「把版本号设定为 2.5.6」= **零编辑**，交付形式是有判据的结论                                                                                                             |
| `npx tsx scripts/check-changelog-release.ts`                                                               | ✔ 15 个版本节（最新 2.5.6 = package.json）/ ✔ `[2.5.6]` 唯一 / ✔ `[Unreleased]` 已收口                                                                                    | 出包的版本闸门当前即绿                                                                                                                                                   |
| `npx tsx scripts/link-nikkisync.ts --check`                                                                | 四条 junction 全 ok                                                                                                                                                       | 链路完好；`npm install` 会把它拆掉（见 §4）                                                                                                                              |
| **包内字节取数** `release/win-unpacked/resources/app.asar` 的 `dist\main\main\app\index.js`（Nov 2 16:01） | `recordBootLevel`=0、`disable-software-rasterizer`=0、`compatLevel`=0、`getPreviousExitEvidence`=0、`BOOT_SUCCESS_SETTLE`=0；仅旧布尔路径 `disableHardwareAcceleration`=1 | **现役 2.5.6 安装包完全不含本轮 GPU 阶梯** ⇒ 重打包是真实交付缺口，且给出「0 → >0」的前后对照验收判据                                                                    |

### 1.2 审查落出的缺陷（含一位独立架构代理复核，逐条给出处）

**B1 用户开关被残留失败计数架空（确定缺陷，本轮修）**

- `writeHardwareAccelPref(true)` 复位了 `fallbackActive` 与 `compatLevel`，**漏了 `consecutiveFailures`**（`src/main/app/gpu-fallback.ts:268-281`）。
- 当计数已达 `FAILURE_THRESHOLD=2`（`:53`）时，下次启动 `shouldDisableHardwareAcceleration()` 的阈值分支（`:315-319`）当场回手置 `fallbackActive=true` 并返回 `true` ⇒ 用户在设置页明确要硬件加速却仍进软件渲染，且与同文件自述口径（`:289-291`「用户开启仅通过 `writeHardwareAccelPref(true)` 清空 fallbackActive … 故正常启动会落入下方返回 false」）**直接矛盾**。
- 这正是 `25c80a7`（T5）修「陈旧档位架空开关」时留下的**同一类缺陷的另一条轴**。既有测试 `gpu-fallback.test.ts:231` 的用例 b 以 `consecutiveFailures: 0` 起步，未覆盖计数轴 ⇒ 红灯可造、可复现。

**B2 主动退出可能被下次启动当成「被原生层杀死」（先实测再改）**

- GPU 自愈重启走 `app.relaunch()` + `app.exit(0)`（`gpu-fallback.ts:561-572`），**不删 `heartbeat.json`**；下次启动 `getPreviousExitEvidence()`（`exit-forensics.ts:192-197`）判 `native` 还是 `js`，取决于 Electron 41 的 `app.exit()` 是否真的执行 Node 的 `process.on('exit')` 处理器——`last-exit.json` 只由该处理器写（`:304-318`）。
- 若**不执行** ⇒ 已在 `:551-558` 升过一次的档位，会被 `resolveCompatLevel` 的 `prevNativeKill` 再加一级（`:349`）：「0 级崩一次 → 落盘 compatLevel=1 → 重启 → 证据再叠一级 → 直接跳 2」，**三级阶梯塌成两级，恰好在这轮要救的设备上失效**。同一歧义命中 `lifecycle.ts:545` 清理超时后的 `app.exit(1)`。
- 独立成因：心跳定时器 `heartbeatTimer`（`exit-forensics.ts:74`/`:275`）**全仓无 `clearInterval`**——`markCleanShutdown()`（`:339-346`）删完心跳后仍可能被 5s tick 复活，形成第二枚假 `native` 证据。

**属实但不修（用户裁决：保持现状 + 登记技术债）**

1. 任务管理器强杀 / 断电同样留下陈旧心跳 ⇒ 被认成升档证据：`will-quit`（`:321-328`）与 `markCleanShutdown()`（`:339-346`）都没跑 → `getPreviousExitEvidence()` 判 native → `index.ts:98-100` 传 `prevNativeKill` → `gpu-fallback.ts:349` 升一级 → `:399` 连带置 `fallbackActive` → 从此软件渲染，解锁只有版本级复位（`:339-347`）或用户手动。本轮目标是先把被困设备救出来，不收窄出口。
2. `'gpu-fallback.json'` 字面量双写：`gpu-fallback.ts:150` 的私有 `getStatePath()` 与 `log-service.ts:221` 的诊断包步 3.6。同批刚为同类问题立了 `CHROMIUM_LOG_BASENAME`（`utils/user-diag-path.ts:21`）三方同源先例。零行为变化 ⇒ 造不出红灯，且不宜让 `services/` 反向依赖 `app/`。
3. `getUserFacingDiagDir()` 每次重算：`chromium-debug.log` 路径在启动时一次性烤进 `--log-file`（`index.ts:69`），而 `log-service.ts:206` 在导出时重算同一目录；Documents 中途可用性变化（OneDrive 漫游 / 重定向）会让诊断包静默漏收该文件（被 `catch {}` 吞）。

**判过但不算缺陷（如实记，避免下轮重复怀疑）**

- `copyBounded` 忽略 `FileHandle.read` 的 `bytesRead`（`log-service.ts:284-297`）：日志只增长、或在启动时被 rename 成 `.old`（`index.ts:71-78`），读点 `size - maxBytes` 恒在 EOF 内 ⇒ 无短读来源。按约定⑥「不为不可能发生的场景加防御」不动。
- `early-crash-guard.ts:136` 用 `path.dirname(logPath)` 推 chromium 日志路径**是同源正确的**：`startup-errors.log`（`startup-diagnostic.ts:35`）、`diag.log`（`:55`）与 `chromium-debug.log`（`index.ts:69`）都走 `resolveDiagDir()`/`getUserFacingDiagDir()`；`:37`/`:57` 的 tmpdir 回落在该候选链内部全捕获、必返回，属死码，不会分叉。
- dev 模式不注册 `did-finish-load` ⇒ `consecutiveFailures` 只增不清零，是被 `window-manager.test.ts:499` 用例 16 显式钉住的既有不变量，且已在上一轮计划 §10.3 记账。

### 1.3 预期结果

- B1/B2 修复进包；六道闸门（`npm install` / `build` / `test` / `typecheck` / `e2e:smoke` / `test:ci-linux`）全部真跑真绿，其中 `e2e:smoke` 打在**重打包后的新树**上（用户裁决），避开上一轮「产物早于代码改动 ⇒ 读数作废」的坑。
- 交付一个包内字节可自证含 GPU 阶梯的 2.5.6 安装包（marker 计数 0 → >0）。

---

## 2. 依赖声明

**零新增 / 零变更 npm 依赖**；B1/B2 全部落在既有模块内部，不开新通道、不加新 i18n 键（12 语包不动 ⇒ `i18n:guard` 天然绿）。

| 复用项                                              | 位置                                                                                                          | 用途                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `markCleanShutdown()`                               | `src/main/app/exit-forensics.ts:339-346`                                                                      | N3 复用它做心跳/定时器清理，**不新写清理函数**                  |
| `classifyPreviousExit` / `getPreviousExitEvidence`  | 同上 `:172-197`                                                                                               | 既有判定口径，N3 只改「主动退出不得留下 native 证据」，不改判据 |
| `readState` / `writeState` / `normalizeCompatLevel` | `src/main/app/gpu-fallback.ts:118-198`                                                                        | B1 只在既有 `writeHardwareAccelPref` 的写盘补丁里多带一个字段   |
| `FAILURE_THRESHOLD` 阈值分支                        | 同上 `:53`、`:315-319`                                                                                        | 语义不动，只消除「用户显式开启后被计数架空」                    |
| `requestSelfHeal` 的升档落盘                        | 同上 `:551-558`                                                                                               | 保持「先落盘再重启」次序，N3 只在 relaunch 前加清理             |
| `debt-registry.json` item schema                    | `docs/debt-registry.json`（46 条，`id/category/section/status/priority/title/description/files/lines/issue`） | N4 三条登记照 DEBT-046 写法                                     |

---

## 3. 启动与运行说明

```bash
# 节点级（改完即跑）
npx vitest run src/main/app/__tests__/gpu-fallback.test.ts
npx vitest run src/main/app/__tests__/exit-forensics.test.ts src/main/app/__tests__/gpu-selfheal.test.ts
npm run test:main

# 全局收口（一票否决）
npm install && npm run link:nikkisync && npm run link:nikkisync:check   # 见 §4 拆链坑
npm run build
npm test
npm run typecheck && npm run typecheck:e2e && npm run lint && npm run i18n:guard
npm run verify
npm run test:ci-linux

# 出包与产物验证（阶段 D）
npx tsx scripts/check-changelog-release.ts
npm run dist:win            # 内含 build:recycle-helper → build → pre-dist-check → builder → verify:dist
npm run e2e:smoke           # 必须看到 [e2e] executable: release/win-unpacked/喵星图.exe
```

N1 探针（不污染仓库，落 `.cache/exit-probe/`，gitignored，跑完即删）：用 `node_modules/electron/dist/electron.exe` 拉起一个最小 main，注册 `process.on('exit')` 写 marker 文件后调 `app.exit(0)`，据 marker 是否在，判定 B2 的「双跳」是否成立。后台执行时成败读日志内层 `EXIT=`，不信通知摘要。

---

## 4. 错误处理

| 分支                                                                                                                                    | 行为 / 兜底                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1 探针起不来（无桌面会话 / 被安全软件拦截）                                                                                            | 不猜结论：B2 降级为「只做心跳定时器清理 + 把该歧义登记为技术债并附复现命令」，读数如实记 `not-run`                                                                                                                                                                     |
| `heartbeatTimer` 已为 `null` 时再次清理                                                                                                 | 幂等短路，不重复 `clearInterval`                                                                                                                                                                                                                                       |
| 清理心跳抛错（userData 不可写等）                                                                                                       | 沿用取证面 `try/catch` 静默口径，**绝不阻塞自愈重启**（`app.relaunch`/`app.exit` 仍要执行）                                                                                                                                                                            |
| `writeHardwareAccelPref(true)` 计数清零后再次真崩                                                                                       | 观测路径照旧：`markGpuProcessCrash`（`:502-511`）同步落盘 `fallbackActive` + 抬档；观测事件丢失则由 `consecutiveFailures>=2` 慢路径兜底（重新攒够两次才降级，符合「一次干净重试」原意）                                                                                |
| `npm install` 静默拆掉 `@nikkisync` 四条 junction                                                                                       | 同批 `npm run link:nikkisync` + `--check` 复原。识别信号是输出里的 `removed 4 packages`；不修好会出一个**缺整个内嵌同步运行时**的包（`verify:dist` 的 `nikkiSyncPackedVerdict` 是 fail 分支，不会放过）                                                                |
| `package-lock.json` 被本机 node v26 / npm 重写（删 `libc` 字段）                                                                        | `git restore` 还原、**不提交**（工具链抖动不进提交）                                                                                                                                                                                                                   |
| 全量 `npm test` 出现非本轮引入的既有红                                                                                                  | 不 `it.skip`、不弱化断言、不 `--no-verify`；先定位归属，属本轮则回修，非本轮则如实上报并停在该节点                                                                                                                                                                     |
| `dist:win` 死在 `electronGet.js:186` 的 `fs.rm`（`force` 只吞 ENOENT 不吞 EBUSY）或 `EPERM rename('win-unpacked.tmp' → 'win-unpacked')` | 走既有旁路：官方缓存 zip 解一份排除 `default_app.asar`/`version` 的 `electronDist` → 输出到 `release/build-<当天标签>` → **`cp -rf`（不是 `mv`）**建标准名树 → 两侧 `app.asar` sha256 全等自证 → 裸跑 `npm run verify:dist` 应绿。旁路是绕锁不是改配方，须在汇报里写明 |
| 出包后包内 marker 计数仍为 0                                                                                                            | 判为「包不等于源码」，停下重出，不得宣称交付完成                                                                                                                                                                                                                       |

---

## 5. 参数校验

- 入站归一口径**不变**：`normalizeCompatLevel`（`:118-121`，非数字/非有限/负数 → 0，越界夹取，小数向下取整）、`readState`（`:174-176`，非有限/负计数 → 0）。B1 只是多写一个 `consecutiveFailures: 0`，不新造校验、不改阈值。
- `NIKKI_GPU_FORCE_LEVEL` 仍只接受字面量 `'0'|'1'|'2'`（`:124-126`），其它值忽略并 `diagLog`；探针目录不引入任何新环境变量约定。
- N3 若新增/复用清理入口：无入参、无返回值、内部全 `try/catch` 静默（取证 fail-open 契约），并在 `heartbeatTimer === null` 时短路。
- **不动**任何 IPC 通道名 / preload 暴露签名 / `IpcResponse`·`IpcError` 结构 ⇒ `docs/IPC_CONTRACT.md` 本轮无需再改（`app:gpu-status` 的 `compatLevel?` 可选字段已由 `25c80a7` 登记）。
- 受保护路径核对：本轮改动仅落在 `src/main/app/**` 与测试（`src/main/services/**` 不动 ⇒ 无需 `@core-change` 注释）。

---

## 6. 基础测试用例（正常 / 异常 / 边界）

| 编号 | 套件                     | 类型 | 断言                                                                                                                                                                                                         | 改前必红                                                 |
| ---- | ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `b2` | `gpu-fallback.test.ts`   | 异常 | 预置 `{consecutiveFailures: 2, fallbackActive: true, fallbackVersion: <当前版本>}` ⇒ `writeHardwareAccelPref(true)` 后计数归零、`shouldDisableHardwareAcceleration()` 为 `false`、`recordBootLevel()` 为 `0` | **是**                                                   |
| `b3` | 同上                     | 边界 | 同场景但 `consecutiveFailures: 1`（未达阈值）⇒ 修复前后行为一致（守卫用例，防「过度清零」把慢路径兜底拆掉）                                                                                                  | 否（守卫，如实标注）                                     |
| `h1` | `exit-forensics.test.ts` | 异常 | `markCleanShutdown()` 之后再走一次心跳 tick ⇒ `heartbeat.json` **不被复活**                                                                                                                                  | **是**                                                   |
| `h2` | 同上                     | 正常 | 既有 `classifyPreviousExit` 四分支（none / js / native / bootId 不匹配）语义不变                                                                                                                             | 否                                                       |
| `s8` | `gpu-selfheal.test.ts`   | 边界 | 预置 `compatLevel=1` + 陈旧心跳：`requestSelfHeal` 的重启路径使下次 `getPreviousExitEvidence().kind` ≠ `native`，`recordBootLevel({prevNativeKill})` 停在 `1` 不跳 `2`                                       | 视 N1 读数（成立则必红；否则降级为不变量守卫并如实标注） |
| `s7` | 同上                     | 正常 | 既有用例 7「陈旧心跳且无 last-exit → native → 升一档」语义**不得改变**                                                                                                                                       | 否                                                       |
| 全量 | 仓库                     | 回归 | `npm test` / `typecheck` / `typecheck:e2e` / `lint` / `i18n:guard` / `verify` / `test:ci-linux` 全绿                                                                                                         | —                                                        |

---

## 7. 子任务分解（每节点：涉及文件 / 输入输出 / 客观验收标准）

### N0 计划落仓

- 文件：本文件。输入：会话计划；输出：tracked 的评审文档 + `docs(plans):` 提交。
- 验收：`git ls-files` 可列出；`git check-ignore` 退出码 1；`npm run verify` 不因文档失败（`docs/**` 不在闸门格式范围内）。

### N1 实测 `app.exit()` 的退出痕迹

- 文件：`.cache/exit-probe/*`（gitignored 草稿，跑完删除），**不改仓库任何文件**。
- 输入 / 输出：Electron 最小 main → marker 文件存在与否的二值读数。
- 验收：读数原样写进 §9；并据此确定 N3 是否包含 `requestSelfHeal` 那条改动。

### N2 B1 修复

- 文件：`src/main/app/__tests__/gpu-fallback.test.ts`（新增 b2/b3）、`src/main/app/gpu-fallback.ts:268-281`（`writeHardwareAccelPref`）与 `:289-291` 注释口径。
- 输入 / 输出：入 = 状态文件三轴 + 用户开关；出 = `{fallbackActive:false, compatLevel:0, consecutiveFailures:0}`，`shouldDisableHardwareAcceleration()` → `false`，`recordBootLevel()` → `0`。
- 验收：b2 改前红、改后绿；`npx vitest run src/main/app/__tests__/gpu-fallback.test.ts` 全绿（既有 b/c/d/L1–L9 语义不变）；`npm run test:main` 全绿。
- 提交：`fix(gpu): 硬件加速开关不再被残留失败计数架空`（红测与修复**合并一次提交**——`src/**` 刻意留红会被自家 lint-staged 拒，禁 `--no-verify`，改前红读数写进 commit message 留痕）。

### N3 B2 修复

- 文件：`src/main/app/exit-forensics.ts`（`markCleanShutdown()` / `will-quit` 清理 `heartbeatTimer`；必要时导出窄口径清理供复用）、`src/main/app/gpu-fallback.ts`（`requestSelfHeal` 在 `app.relaunch()` 前清心跳）、`src/main/app/__tests__/exit-forensics.test.ts`、`src/main/app/__tests__/gpu-selfheal.test.ts`。
- 输入 / 输出：入 = 心跳文件 + 定时器句柄 + 自愈重启时机；出 = 主动退出不产生 `native` 证据（判为 `js` 或 `none`），`prevNativeKill` 不再叠加已落盘的升档。
- 依赖检查：`gpu-fallback → exit-forensics` 无循环依赖（后者只依赖 fs/path/crypto/electron/logger/startup-diagnostic）；`gpu-selfheal.test.ts` 用 vi.mock 工厂逐依赖替换，新增 import 需同步补该套件 mock。
- 副作用如实记：被自愈重启的那次不再留「原生杀死」证据（本应如此），代价是丢掉一次心跳时刻定位；`last-exit.json` 仍在。
- 验收：`npx vitest run` 两套件全绿 + `npm run test:main` 全绿 + 用例 7 / h2 语义不变。
- 提交：`fix(forensics): 心跳定时器与 GPU 自愈重启不再伪装成原生层杀死`。

### N4 技术债登记

- 文件：`docs/技术债清单.md`、`docs/debt-registry.json`。
- 输入 / 输出：三条 `status: "open"`（DEBT-047 强杀误判 / DEBT-048 文件名字面量双写 / DEBT-049 诊断目录重算与 `--log-file` 烤定路径竞态），每条含逐跳行号证据、修法、撤销条件。
- 验收：`npm test` 不因登记变红（`check-md-links` 用 `git ls-files` 判存在 ⇒ 先 `git add` 再提交）。
- 提交：`docs(debt): 登记本轮 GPU 阶梯审查属实但不修的三条`。

### N5 全局回归

- 顺序与判据见 §3 / §4；任一不绿不得进 N6。
- 验收：六道闸门逐条读数 + `npm run verify` 五项全绿；全量测试的通过数与基线之差必须能用「本轮新增例数」解释。

### N6 版本收口 + 重打包 + smoke + 回写

- 文件：`CHANGELOG.md`（B1/B2 bullet 追加到既有 `## [2.5.6]` 的 `### Fixed` **首位**）、`release/*`（产物）、本文件 §9。
- 输入 / 输出：入 = 已提交的 HEAD + `package.json` version；出 = NSIS 安装包 + `latest.yml` + 回写读数。
- 验收（四条硬判据）：
  1. 版本零编辑：`node -e "console.log(require('./package.json').version)"` = `2.5.6` + `check-changelog-release.ts` 三条 ✔；
  2. `npm run dist:win` 成功且 `npm run verify:dist` 裸跑绿；
  3. `npm run e2e:smoke` 对新树全绿，日志出现 `[e2e] executable: release/win-unpacked/喵星图.exe`；
  4. 新鲜度两轴：包内 `dist\main\main\app\index.js` 的 `recordBootLevel`/`disable-software-rasterizer`/`compatLevel` 计数由 §1.1 的 **0 变为 >0** 且与盘上 `dist/main/main/app/index.js` 逐字节相等（asar 条目名要去掉前导分隔符、**不能把 `\` 换成 `/`**）；`latest.yml` 的 `size` 与 `sha512` 两轴都不同于 Nov 2 16:02 的旧包。
- 提交：`docs(plans): 回写 GPU 阶梯复查与 2.5.6 重打包执行读数`；提交后 `git status --porcelain` 复核钩子残余（lint-staged 会改写文件 ⇒ 提交前读数 ≠ 提交后读数，对最终内容复跑受影响判据）。

---

## 8. 风险与回退

| 风险                                        | 处置                                                                                                   | 回退                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| B1 清零计数让「观测丢失」的设备更难攒够阈值 | 慢路径阈值仍是 2，且真崩时 `markGpuProcessCrash` 走的是快路径；b3 守卫用例钉住「未达阈值不得过度清零」 | revert N2（退回计数保留，用户开关继续被架空）                          |
| N3 清心跳后丢掉一次「上次死亡时刻」定位     | `last-exit.json` 与事件 journal 仍在；主动退出本就不该留 native 证据                                   | revert N3 的 `requestSelfHeal` 部分，保留定时器清理                    |
| Electron 版本升级改变 `app.exit` 语义       | N1 的探针命令写进 §9，任何一轮可用同一条命令复现                                                       | 把判据从「依赖 exit 处理器」改为显式清心跳（正是 N3 做的事）           |
| 杀软锁死出包                                | §4 的 `electronDist` 旁路 + `cp` 建标准名树                                                            | 如实报「前提不成立」并列出唯一剩余的用户侧动作，不重复出第二棵树凑成功 |
| 包内容等于源码却因旁路换名                  | 用 §1.1 的 marker 计数与逐字节相等两条轴自证，不以文件名判成败                                         | —                                                                      |

---

## 9. 执行记录（逐节点真跑后回写）

> 待执行。每个节点记：命令、退出码、关键计数、红→绿证据、与计划的偏差（偏差要保留原预期并另写订正，不得销毁取证）。
