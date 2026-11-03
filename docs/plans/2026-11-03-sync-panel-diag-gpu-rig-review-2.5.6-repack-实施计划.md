# 同步面板/诊断包/GPU 工装批次复查、九处修复与 2.5.6 重打包 · 实施计划

> 计划落盘时间：2026-11-03。本轮由用户下达「全面审查近期提交与未提交代码 → 修复 → 六道闸门全绿 → 提交 → 版本号 2.5.6 → 重新打包」触发。
> 本文是**阶段 A 的唯一动作**：单独提交后停下等用户读过，回「继续」才动 `src/**`。

---

## 1. Context：为什么是这几件事

审查对象**不是**「未提交改动」（工作树是干净的），而是**最后一次出包之后的全部提交**——这是本仓同类任务的正确口径（上一轮 10-23 曾因只读 `git diff` 而漏掉「包内字节仍是旧实现」的真实缺陷）。

### 1.1 现场读数（全部实测，非推断）

| 项               | 命令                                         | 读数                                                                                                                      |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 未提交代码       | `git status --porcelain`                     | 空 ⇒ **无未提交改动**                                                                                                     |
| HEAD             | `git log -1`                                 | `e2bae38`（2026-11-02 22:31）                                                                                             |
| 最后一次出包     | `release/latest.yml`                         | `size 184657459`、`sha512 iQTDyktm…`、`releaseDate 2026-11-02T11:46:54Z`；`MeowStarMap-Setup-2.5.6.exe` mtime 11-02 19:46 |
| 出包时的源码锚点 | 提交时间轴比对                               | ≈ `f7a3b79`（19:45:06，出包前最后一个提交）                                                                               |
| 代码面复查范围   | `git diff --stat a283eec..HEAD`              | **22 个提交 / 66 文件 / +3943 −208**                                                                                      |
| 包是否等于源码   | `git diff --name-only f7a3b79..HEAD -- src/` | 36 个 `src/` 文件晚于出包，含 `cf1364f` 新建的同步面板与 12 语包 ⇒ **包已过期，重打包是实质需求而非仪式**                 |
| 版本号现状       | `package.json:3` + 各声明位                  | 全部 `2.5.6` ⇒ 「设定为 2.5.6」是**零编辑**                                                                               |
| NikkiSync 链接   | `npm run link:nikkisync:check`               | 四条 junction 全 ok（但 `npm install` 会剪掉，见 §4）                                                                     |

### 1.2 审查落出的缺陷（三位并行读码代理 + 本人逐条复核取证）

复核纠正了**我自己三处误判**，都记在这里以免后续当成既有结论：

1. GPU 工装污染点不止「落盘只判 `forced === null`」——`requestSelfHeal`（`:534`）在工装闸（`:538`）**之前**先调了 `markGpuProcessCrash`（`:535`），后者无条件写盘。**只补落盘那一处不够。**
2. `photoCount` 无复数形的问题**不含 vi/ru**——`1 ảnh` 是量词语言、`фото` 不变格，本就正确；真错的是 en/de/es/fr/pt 五种。
3. `sync-server-view.ts` 的注释矛盾是**纯注释、零行为变化**，按本仓已立口径（DEBT-048 原句：「零行为变化 ⇒ 造不出改前必红的复现用例，本仓禁止用空转守卫冒充红灯」）**如实标注为无红灯可造**，不编造守卫。

| #   | 判据                                                                                                                                                                                                                                                                                                                                                                                                                     | 出处                                                                       | 分级                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------- |
| B1  | 检索无代次计数：两条在途 `searchSuits`/`searchClothing` 后到者胜，旧响应改写新命中；`finally` 里的 `setSearching(false)` 同样未守卫 ⇒ 旧响应还会掐掉新查询的 loading                                                                                                                                                                                                                                                     | `src/renderer/pages/sync-gallery/SyncInsightPanel.tsx:45-99`、`:94-96`     | BUG（用户可见）                    |
| B2  | 切「套装→服装」只 `setScope` 不清 `hits` ⇒ 服装作用域里仍显示套装行（且把套装的部件名当服装的所属套装名展示）                                                                                                                                                                                                                                                                                                            | 同上 `:150-153`                                                            | BUG（用户可见）                    |
| B3  | `if (stats \|\| statsFailed) return` 永久缓存：本页 keep-alive 且 `SyncGalleryPage.tsx:75-83` 收到库变更就重取第一页，面板却停在旧数据 ⇒ 同一个库存两副面孔                                                                                                                                                                                                                                                              | 同上 `:101-113`                                                            | BUG（用户可见）                    |
| B4  | 诊断包一个 `try` 罩住 3 文件循环 ⇒ `chromium-debug.log` 被占用（本机 AV 锁文件是常态）就连 `diag.log` 一起丢，而导出仍报 `success: true`。缺的正是 `6d633f8` 特意补进来的原生 FATAL 证据                                                                                                                                                                                                                                 | `src/main/services/log-service.ts:209-217`                                 | BUG（证据静默丢失）                |
| B5  | 头注释仍写「mDNS：本仓默认关」与同文件 `:52` 的 `SYNC_SERVER_DEFAULT_MDNS = true` 直接冲突（`2531316` 只改了常量注释、漏改头部口径清单）；`:287`/`:289` 是同一条中文注释重复（`d5afded` 合并残留）                                                                                                                                                                                                                       | `src/main/nikkisync/sync-server-view.ts:13-14`、`:52`、`:287-289`          | CONVENTION（注释与实现分叉）       |
| B6  | `syncService.status.inspirationOn` 契约明说这是**挂载事实**（`runtime-manager.ts:682-688` 服务没起也下发该键，`SyncServicePage.tsx:968` 不 gate `running`），而 9 语写成「公開中 / 게시됨 / bereitgestellt / en ligne / disponible / disponível / доступна / เปิดใช้ / đã công bố」= 停着的服务谎报在线；fr 另把 endpoint 误译成「point d'entrée」（入口点）。zh-CN/en/zh-TW 的「已挂载 / mounted」才是准的              | 9 个 `src/renderer/i18n/locales/*.json`                                    | BUG（用户可见的假陈述）            |
| B7  | 验证工装污染**持久态**：`:400` 的落盘只判 `NIKKI_GPU_FORCE_LEVEL`，跑 `NIKKI_FORCE_GPU_COMPAT=1` 时 `:312` 使 `compatDisabled=true` ⇒ 落 `compatLevel` + `fallbackActive` + 真版本戳 ⇒ 用户装机从此停在软件渲染，直到下次改版才复位；且 `requestSelfHeal` 不认 `FORCE_LEVEL` ⇒ 写 `compatLevel+1`（`:564`）后 relaunch，新进程被强制回原档 = 重启死循环                                                                  | `src/main/app/gpu-fallback.ts:400`、`:534-538`、`:564`                     | BUG（工装跨污染真实状态）          |
| B8  | 崩溃关键态写盘非原子：裸 `writeFileSync` 先截断后写，`readState` 的 catch 返回 `DEFAULT_STATE` ⇒ 半截 `gpu-fallback.json` 把 `compatLevel` 静默清零 = **阶梯要防的那个崩溃循环本身**；而最可能被写一半掐掉的正是专为抢在 FATAL 前落盘的 `markGpuProcessCrash`（`:511`）。取证面同形：半截 `last-exit.json` 会让 `classifyPreviousExit` 判成 `native` ⇒ 给没崩的机器白升一级（DEBT-047 的失效形态由半截写入**制造**出来） | `gpu-fallback.ts:192-198`、`:163-190`；`exit-forensics.ts:161`、`:247-261` | BUG（低概率高后果）                |
| B9  | `clockSkewMs` 不 clamp：`auth-service.ts:13` 自陈「默认 5 分钟，**硬约束上限**」、`src/main/sync/AGENTS.md` 硬约定 2 同述，而 `:105` 是 `options.clockSkewMs ?? DEFAULT`，无任何收口 ⇒ 该安全红线目前**只靠约定维持**                                                                                                                                                                                                    | `src/main/sync/auth-service.ts:105`                                        | CONVENTION（安全约定未被代码承担） |

**登记不修（3 条，见 §7 N11）**：全仓复数形系统性缺口（DEBT-050）、GPU 状态卡在 `FORCE_LEVEL` 下与真实档位分叉（DEBT-051，仅工装可达、永不影响用户、且诚实修法要动 IPC 契约 + 12 语）、nonce 表无容量上限（DEBT-052，clamp 后驻留已有界，硬加淘汰会重开重放口子）。

### 1.3 预期结果

九处修复各自「红→绿」可证，六道用户点名的命令 + 四项 CI 链式闸门全绿，14 条提交入仓，2.5.6 重打包后**包内字节等于 HEAD**（不是只换 `releaseDate` 的空重跑）。

---

## 2. 依赖声明

**零新增 / 零变更 npm 依赖**；不开新 IPC 通道、不加新 i18n **键**（只改 9+5 处 locale 的**值**）。

| 复用项                              | 位置                                                                                                                              | 用途                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `generationRef` 计数丢包模式        | `src/renderer/components/sync/PairingQrDialog.tsx:36,49,54,61,66,89`                                                              | B1 不自造防抖/不引库，直接抄同域既有形状                                                                                                 |
| `nikkisync:onLibraryChanged` 订阅面 | `src/renderer/pages/sync-gallery/SyncGalleryPage.tsx:75-83`                                                                       | B3 面板自订阅，**不改** `SyncGalleryPage.tsx`                                                                                            |
| `tempSiblingPath()`（同步、已导出） | `src/main/utils/atomic-file.ts:13-17`                                                                                             | B8 的同步原子写复用其命名；`writeFileAtomic` 本体是 async 且**不得改**——这两处写盘必须同步抢在 Chromium FATAL 前完成，异步会丢掉时序保证 |
| 值守卫形状                          | `sync-gallery-keys.test.ts:171-202`（`RUNTIME_OFF_BEFORE` 负面清单）+ `sync-service-keys.test.ts:322`（「插值占位随键搬运到位」） | B6/B7 的改前必红守卫照此形状写                                                                                                           |
| 假时钟注入缝                        | `src/main/sync/auth-service.test.ts:86-91` 已参数化 `clockSkewMs` / `now`                                                         | B9 一行注入即可复现                                                                                                                      |
| 计数中立文案先例                    | en `"Permanently deleted {{count}} item(s)"`、ru `"Экспортировано файлов: {{count}}"`                                             | B 类复数收口不另造形态                                                                                                                   |
| `debt-registry.json` item schema    | `docs/debt-registry.json`（现 49 条；字段 `id/category/section/status/priority/title/description/files/lines/issue`）             | N11 三条登记照 DEBT-049 写法                                                                                                             |

---

## 3. 启动与运行说明

```bash
# 节点级（改完即跑，局部回归）
npx vitest run src/renderer/pages/sync-gallery/SyncInsightPanel.test.tsx
npx vitest run src/main/services/log-service.test.ts
npx vitest run src/main/nikkisync/sync-server-view.test.ts
npx vitest run src/renderer/i18n/locales/sync-service-keys.test.ts src/renderer/i18n/locales/sync-gallery-keys.test.ts
npx vitest run src/main/app/__tests__/gpu-fallback.test.ts src/main/app/__tests__/gpu-selfheal.test.ts
npx vitest run src/main/app/__tests__/exit-forensics.test.ts src/main/utils/atomic-file.test.ts
npx vitest run src/main/sync/auth-service.test.ts

# 提交前（每节点一次）
npm run verify:staged

# 全局收口（一票否决）
npm install && npm run link:nikkisync && npm run link:nikkisync:check   # 见 §4 拆链坑
git restore package-lock.json                                          # 工具链抖动不进提交
npm run build
npm test
npm run typecheck && npm run typecheck:e2e && npm run lint && npm run i18n:guard
npm run verify
npm run test:ci-linux

# 出包与产物验证（阶段 D）
npx tsx scripts/check-changelog-release.ts
npm run dist:win            # build:recycle-helper → build → pre-dist-check → electron-builder → verify:dist
npm run verify:dist         # 旁路时需确认回显路径落在 release/win-unpacked/ 下
npm run e2e:smoke           # 必须看到 [e2e] executable: release/win-unpacked/喵星图.exe
```

**顺序订正（用户给的清单里两处前提不成立）**：

- `e2e:smoke` **不得排在重打包之前**。它走 `launchApp()` → `findUnpackedExe()` → `release/win-unpacked/*.exe`（`e2e/helpers.ts:36-42`），早跑验的是 11-02 19:46 那棵**过期树**，绿了不代表新代码——上一轮同因把 smoke 判为作废重跑。
- `npm install` 必须**紧跟**两条 link 命令，且其 lock 副作用要在任何提交前还原。

---

## 4. 错误处理

| 分支                                                                                                                                    | 行为 / 兜底                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4：单个诊断文件被占用/不可读                                                                                                           | `try` 下沉到循环体——**只丢那一个文件**，其余照常入包，`exportLogsAsZip` 仍返回 `success: true`（导出成功不该因缺一份可选证据而失败）；每个 catch 内 `logger` 记一行归属，不静默吞                                                 |
| B8：`renameSync` 失败（AV/EPERM）                                                                                                       | **回落今日的直接 `writeFileSync`** 并吞异常——绝不因原子化改造而丢写入（`src/main/app/AGENTS.md`「全部同步写入、全部容错」）。落盘后目录内不得残留 `.tmp-*`                                                                        |
| B3：库变更事件到货时面板是收起态                                                                                                        | 只复位缓存、**不发请求**；展开时才重取。不得简单删掉 `:102` 的缓存闸——那会把每次开合都变成一次 IPC（既有断言 `SyncInsightPanel.test.tsx:166-168`「两次开合只取一次」当场红）                                                      |
| B1：过期响应到货                                                                                                                        | 代次不符 ⇒ `hits`/`searchFailed`/**`searching`** 三处一律不改写；提交新检索时 `generationRef.current++` 立即作废在途请求                                                                                                          |
| B9：注入非法 `clockSkewMs`                                                                                                              | `NaN` / `-1` / `Infinity` 归到安全值；收口方向是**只收紧不放宽**（`Math.min(DEFAULT_CLOCK_SKEW_MS, Math.max(0, finite))`），既不放宽窗口也不造成全锁死                                                                            |
| B6/B7：locale 值改动                                                                                                                    | 只改值、不动键 ⇒ `sync-service-keys.test.ts:258-272` 的 12 语键集同构、`:88` 的 REQUIRED_KEYS、`npm run i18n:guard`（只查键与白名单）三侧天然绿；`SyncServicePage.test.tsx:1342` 钉了 zh 值 ⇒ zh-CN 的 `inspirationOn` **不得动** |
| `npm install` 静默剪掉 `@nikkisync` 四条 junction                                                                                       | 同批 `npm run link:nikkisync` + `--check` 复原。识别信号是输出里的 `removed 4 packages`；不修好**不报错**，而是出一个缺整个内嵌同步运行时的包（少 608,615B），拦它的只有 `verify:dist` 的 `nikkiSyncPackedVerdict`                |
| `package-lock.json` 被本机 node v26.3.0 / npm 11.16.0 重写（删 `libc` 字段）                                                            | `git restore` 还原、**不提交**（CI 钉 `.node-version=22`，工具链抖动不进提交）                                                                                                                                                    |
| 全量 `npm test` 出现非本轮引入的既有红                                                                                                  | 不 `it.skip`、不弱化断言、不 `--no-verify`；先定位归属，属本轮则回修，非本轮则如实上报并停在该节点                                                                                                                                |
| `dist:win` 死在 `electronGet.js:186` 的 `fs.rm`（`force` 只吞 ENOENT 不吞 EBUSY）或 `EPERM rename('win-unpacked.tmp' → 'win-unpacked')` | 走既有旁路（§8 风险表给了具体目录与命令）。旁路是**绕锁不是改配方**，须在汇报里写明                                                                                                                                               |
| 出包后包内 marker 计数仍为 0 / `latest.yml` 两轴未变                                                                                    | 判为「包不等于源码」，停下重出，**不得宣称交付完成**                                                                                                                                                                              |

---

## 5. 参数校验

- **不动**任何 IPC 通道名 / preload 暴露签名 / `IpcResponse`·`IpcError` 结构 ⇒ `docs/IPC_CONTRACT.md` 本轮无需再改。
- **受保护路径核对**（`scripts/core-path-gate.ts:40` 的 `PROTECTED_GLOBS`）：本轮只有 **N4 落在 `src/main/services/**`** ⇒ 必须把 `log-service.ts:1` 的既有 `@core-change` **替换**为本次真实中文原因（至多一条、非批量占位、原因非空）；`src/main/app/**`、`src/renderer/**`、`src/shared/**` 不在保护集内，无需注释。
- `nikkisync:search-suits` / `:search-clothing` 的 zod 已是 `min(1).max(128)`；B1/B2 属渲染层状态治理，**不**改校验口径。（输入框缺 `maxLength` 一事登记于 §7 N1 备注，不夹带进本轮竞态修复。）
- B9 是本轮**唯一新增的入参收口**：`AuthService` 构造处 clamp，其余归一口径（`normalizeCompatLevel`、`readState`、`parseForcedLevel` 只认字面量 `'0'|'1'|'2'`）一律不动。
- B8 不新造状态文件格式：`gpu-fallback.json` / `last-exit.json` / `heartbeat.json` 的字段与向后兼容语义不变，只换写入手法。

---

## 6. 基础测试用例（正常 / 异常 / 边界）

「改前必红」列是 TDD 硬判据：**填「是」的用例必须在撤掉修复的树上真的失败过**，实测读数写进 commit message。填「否（守卫）」的是本仓允许如实标注、不许冒充红灯的那一类。

| 编号  | 套件                                                | 类型 | 断言                                                                                                                                                                                                                                                                   | 改前必红                               |
| ----- | --------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `p1`  | `SyncInsightPanel.test.tsx`                         | 异常 | 两次提交、慢响应后到 ⇒ 仅最新代次可改写 `hits` 与 `searching`（需新增 deferred-promise 夹具；既有 `install():36-53` 是立即 resolve，构造不出乱序）                                                                                                                     | **是**                                 |
| `p2`  | 同上                                                | 异常 | 检索套装后切到服装 ⇒ `hits` 为空、渲染 `searchIdle`，套装行文本从 DOM 消失                                                                                                                                                                                             | **是**                                 |
| `p3`  | 同上                                                | 正常 | 库变更事件到货 ⇒ `profileStats` 由 1 次变 2 次（且仅在展开态）                                                                                                                                                                                                         | **是**                                 |
| `p4`  | 同上                                                | 边界 | 收起态收到库变更 ⇒ 只复位缓存、不发 IPC；既有「两次开合只取一次」不变                                                                                                                                                                                                  | 否（守卫）                             |
| `p5`  | `log-service.test.ts`                               | 异常 | 只让 `chromium-debug.log` 的 copyFile reject ⇒ `.old` 与 `diag.log` 仍入包、导出仍 `success: true`                                                                                                                                                                     | **是**                                 |
| `p6`  | `sync-server-view.test.ts`                          | 正常 | 既有用例逐条不变（纯注释改动，行为零变化）                                                                                                                                                                                                                             | 否（**纯注释，造不出红灯，如实标注**） |
| `p7`  | `sync-service-keys.test.ts`                         | 正常 | 9 语 `inspirationOn` ∉ 旧值负面清单 ∧ 含各语正向 token（zh 挂载 / en mounted / ja マウント / ko 마운트 / de montiert / fr monté 且不得为 point d'entrée / es·pt montead\|montad / ru смонтирована / th·vi mount 族）                                                   | **是**（改前 9 语全红）                |
| `p8`  | `sync-gallery-keys.test.ts`                         | 边界 | en/de/es/fr/pt 的 `insight.photoCount` 为计数中立形态且仍含 `{{n}}`；vi/ru/ja/ko/zh 族不变                                                                                                                                                                             | **是**                                 |
| `p9`  | `gpu-fallback.test.ts`                              | 异常 | `NIKKI_FORCE_GPU_COMPAT=1` ⇒ `recordBootLevel()` 后状态文件**不出现**                                                                                                                                                                                                  | **是**                                 |
| `p10` | `gpu-selfheal.test.ts`                              | 异常 | `NIKKI_GPU_FORCE_LEVEL` 下 `requestSelfHeal` 返回 `false`、`relaunch`/`exit` 未被调、文件未被写（断言点在 `markGpuProcessCrash` 之前那一步）                                                                                                                           | **是**                                 |
| `p11` | 两套既有                                            | 边界 | 真实自愈路径不变（`gpu-selfheal.test.ts:73-136` 写盘并重启、`:117-136` 到顶不重启、`:172-199` 原生杀死升一级）；非法 `FORCE_LEVEL='01'` 仍回落真判据（`gpu-fallback.test.ts:570-584`）⇒ 工装判定必须以 `parseForcedLevel(...) !== null` 为准，不能写成 `!== undefined` | 否                                     |
| `p12` | `atomic-file.test.ts`（拟新增同名配套）+ 两套消费方 | 边界 | 真 fs（`mkdtemp`，**不得改成 mock fs**）+ spy `writeFileSync` 只写前缀且不 rename ⇒ `readGpuFallbackState().compatLevel` 旧值完好；落盘后目录无 `.tmp-*` 残留                                                                                                          | **是**                                 |
| `p13` | `auth-service.test.ts`                              | 异常 | 注入 `clockSkewMs = 10*60_000`、`ts = now + 6min` ⇒ `{ok:false, reason:'clock_skew'}`                                                                                                                                                                                  | **是**                                 |
| `p14` | 同上                                                | 边界 | 推进过窗后同 nonce 可再次接受（钉住 prune 确实执行）；`NaN`/`-1`/`Infinity` 归安全值                                                                                                                                                                                   | 否（守卫，如实标注）                   |
| 全量  | 仓库                                                | 回归 | `npm test` / `typecheck` / `typecheck:e2e` / `lint` / `i18n:guard` / `verify` / `test:ci-linux` 全绿                                                                                                                                                                   | —                                      |

**变异抽查做两次**（第五轮已固化口径）：M1 撤掉被修实现，证明缺陷例真有牙；M2 撤掉一个调用点/包裹（本轮即「只补 `:400` 落盘、不动 `requestSelfHeal` 顶部」），证明各修点不是重复劳动。两次之后用 `sha256sum` 证明恢复是逐字节还原。

---

## 7. 子任务分解（每节点：涉及文件 / 输入输出 / 客观验收标准）

> **提交切分硬约束**：`.husky/pre-commit:17` → `lint-staged` → `npm run test:precommit`，`src/**/*.{ts,tsx}` 键会跑匹配套件 ⇒ **刻意留红的 `src/` 提交会被自家闸门拒**（上一轮实测 Step 1 FAILED）。故红测试与修复**合并一次提交**，改前红读数写进 message 留痕；`--no-verify` 属红线禁用。
> **同名匹配的坑**：`scripts/find-related-tests.ts:47-60` 只按**文件基名**配对 ⇒ 改 `gpu-fallback.ts` 只触发 `gpu-fallback.test.ts`、**不触发** `gpu-selfheal.test.ts`。⇒ p9 必须落在 `gpu-fallback.test.ts`（才受提交闸门保护），p10 落 selfheal 套件，提交前两套都要显式跑齐。

### N0 计划落仓（本节点，之后**停下**）

- 涉及文件：本文。
- 输入/输出：`docs/plans/` 新文档 → `git add` 进入 tracked 集 → 单独提交。
- 验收：`git ls-files` 能列出本文；`git check-ignore` 对其退出码 1；`npx tsx scripts/check-md-links.ts` 绿。
- **写作约束（踩过）**：`check-md-links.ts:340` 用 `git ls-files` 判存在（明确写了不用 `fs.existsSync`），而 `scripts/__tests__/check-md-links.test.ts:227` 在 `npm test` 内断 `dead === 0` ⇒ **本文必须先进 tracked 集**，CHANGELOG 才能引用它。带行号的路径只放反引号，**不得**做 `[x](...)` 链接目标（`isPathLike` 只剥 `#`/`?`，`src/x.ts:192` 形态当链接目标即判死引用）；拟新增文件写在围栏块内或同行带「拟新增」。

### N1 B1 检索代次计数

- 涉及文件：`SyncInsightPanel.tsx`（`runSearch` 全体 + `finally`）、`SyncInsightPanel.test.tsx`（新增 deferred 夹具与 `p1`）。
- 输入/输出：入 = 两次提交、响应乱序；出 = 仅最新代次可改 `hits`/`searchFailed`/`searching`。
- 验收：`p1` 绿；既有 7 例逐条不变。
- 红证：`p1` 改前红（旧命中重回列表）。变异 M1 删 `generation` 判定 ⇒ 恰好该例红。
- 附带记录不夹带的项：输入框缺 `maxLength={128}`（zod `min(1).max(128)` 超限会被归进通用 `searchFailed`、掩盖真实原因）⇒ 交 N11 一并记 DEBT-050 备注或单独一行，**本轮不混入竞态提交**。

### N2 B2 切范围清空命中

- 涉及文件：`SyncInsightPanel.tsx:150-153` + 同名测试新增 `p2`。
- 输入/输出：入 = 套装检索后 `change` 作用域 select；出 = `hits === null`。
- 验收：套装行文本从 DOM 消失、渲染 `searchIdle`。
- 红证：`p2` 改前红。**注意** `:105-128`「切范围再检索」那条既有例两侧都绿，**不得**当作回归证据充数。

### N3 B3 库变更后统计失效重取

- 涉及文件：`SyncInsightPanel.tsx:101-113` + `loadStats`/`detailsRef`；同名测试 `p3`/`p4`（`install()` 夹具增 `onLibraryChanged`，返回退订函数）。**`SyncGalleryPage.tsx` 不动。**
- 输入/输出：入 = 订阅回调到货；出 = `stats`/`statsFailed` 复位，且**仅展开态**重取。
- 设计取舍（在此写明、不等执行期再问）：面板**自订阅**而非由页面下传 `resetKey`——同一桥对象上已有该订阅面（`:117` 已在防 `nikkisync` 缺席），下传方案要为触达面板把 `SyncGalleryPage.test.tsx:106` 的夹具补成「可捕获回调 + 非空文件列表」，同样的断言多出一倍夹具。保留 `if (!subscribe) return`，页面侧的部分 mock 不会炸。
- 验收：`p3` 断 `profileStats` `toHaveBeenCalledTimes(2)`；`:166-168` 仍绿。
- 红证：改前到货后仍 1 次 ⇒ 红。
- 范围克制：只失效 `stats`，**不**清用户主动发起的 `hits`（在用户眼前抹掉他刚查的结果是错的方向）。

### N4 B4 诊断包逐文件容错（受保护路径）

- 涉及文件：`log-service.ts:209-217`（`try` 下沉到 `for` 体内 + 每文件失败记一行归属）、`log-service.test.ts` 的 `exportLogsAsZip` 块新增 `p5`（复用 `stagedNames()` 助手与 `mockDiagDir` 夹具）；**`log-service.ts:1` 的 `@core-change` 替换为本次真实原因**。
- 输入/输出：入 = 仅 `chromium-debug.log` reject；出 = `.old` 与 `diag.log` 仍入包，`success: true`。
- 验收：`expect(names).toContain('diag.log')` 且导出成功。
- 红证：改前循环在 `:209` 的单个 try 内整体中断 ⇒ 红。变异 M2：把 `try` 挪回循环外 ⇒ 同例红。
- 记账：本节点移动了 `log-service.ts` 的行号 ⇒ N11 同步订正 DEBT-048 / DEBT-049 的 `lines` 数组。

### N5 B5 注释与常量同源

- 涉及文件：`sync-server-view.ts:13-14`（改写为「mDNS：本仓默认开，589b932 复测裁决；历史关档理由见下方实测记录」）+ 删 `:289` 的重复注释行。
- 验收：`grep -c '灵感同步 v1：只在观测到挂载时下发键'` === 1；头部含「默认开」；`sync-server-view.test.ts` 绿。
- **无红灯可造（纯注释、零行为变化）**，按 §6 `p6` 的如实标注交付，不造空转守卫。

### N6 B6 九语 `inspirationOn` 语义收口

- 涉及文件：`locales/{ja,ko,de,fr,es,pt,ru,th,vi}.json` 的 `syncService.status.inspirationOn`；`sync-service-keys.test.ts` 新增 `p7` 值守卫。zh-CN / en / zh-TW **不动**。
- 输入/输出：入 = 旧值（负面清单逐字）；出 = 「端点已挂载」义（fr 同时纠正 endpoint 误译）。
- 验收：`p7` 绿 + 12 语键集同构 + `npm run i18n:guard` 绿。
- 红证：守卫含「∉ 旧值 ∧ 含正向 token」双条件 ⇒ 改前 9 语全红。
- 闸门提示：locale `*.json` 只命中 `src/**/*.{js,jsx,json,css,md}` 的 **prettier** 键、不跑测试 ⇒ 红绿牙口来自同批暂存的 `.test.ts`（测试文件被直接收集）。

### N7 photoCount 计数中立收口

- 涉及文件：`locales/{en,de,es,fr,pt}.json` 的 `syncGallery.insight.photoCount`；`sync-gallery-keys.test.ts` 新增 `p8`。
- 验收：中立形态且仍含 `{{n}}`；`:71/:119` 的 REQUIRED_KEYS 字符串断言与 `:139-147` 的 12 语同构不变。
- 明确**不做**：`_one/_other` 正式复数改造（会破上述两条断言，且 en 全仓 64 处同类字符串属独立一轮 i18n 架构改动）⇒ 交 N11 记 DEBT-050。

### N8 B7 GPU 验证工装不落盘

- 涉及文件：`gpu-fallback.ts` 新增 `isGpuVerificationRig()`（`NIKKI_FORCE_GPU_COMPAT === '1' || parseForcedLevel(NIKKI_GPU_FORCE_LEVEL) !== null`），三处消费：`:400` 落盘闸、**`requestSelfHeal` 顶部且在 `:535` 的 `markGpuProcessCrash` 之前**、`:294`/`:529` 文档口径；测试拆 `__tests__/gpu-fallback.test.ts`（`p9`）与 `__tests__/gpu-selfheal.test.ts`（`p10`）。
- 输入/输出：入 = 两把工装 env 各自开启；出 = 状态文件不出现 / `requestSelfHeal` 返回 false 且 relaunch、exit 未被调。
- 验收：`p9`+`p10` 绿，`p11` 既有用例逐条不变。
- 红证：(a) 改前 `existsSync(statePath())` 为 true；(b) 改前 FORCE_LEVEL 下写 `:564` 并 relaunch。变异 M2：**只补 `:400`** ⇒ (a) 绿、(b) 仍红（这条正是「污染点在 `markGpuProcessCrash` 之前」那处自我纠正的牙口证明）。

### N9 B8 状态文件同步原子写

- 涉及文件：`src/main/utils/atomic-file.ts` 新增同步 `writeFileAtomicSync(finalPath, text)`（复用既有 `tempSiblingPath`；`writeFileAtomic` 保持 async 不动）+ 同名配套 `atomic-file.test.ts`；消费点 `gpu-fallback.ts:194`（`writeState`）与 `:253`、`exit-forensics.ts:161`（`writeHeartbeat`）与 `:257`（`flushLastExitRecord`）。
- 输入/输出：入 = 一段完整 JSON 文本；出 = temp-sibling + `fs.renameSync`（Windows 上 rename 会替换已存在目标）；**rename 失败回落直接 `writeFileSync` 并吞异常**。
- 验收：`p12` 绿；两套既有套件仍用 `mkdtemp` 真 fs（**不得为省事改成 mock fs，否则判据失效**）；目录无 `.tmp-*` 残留。
- 红证：spy `writeFileSync` 只写前缀且不 rename ⇒ 改前 `compatLevel === 0`（被静默复位）红、改后 `=== 2`（旧态完好）绿。

### N10 B9 nonce 窗口 clamp

- 涉及文件：`auth-service.ts:103-107` 构造 + `:13`/`:55` 注释；`auth-service.test.ts` 新增 `p13`/`p14`。
- 验收：`p13` 绿、`DEFAULT_CLOCK_SKEW_MS` 路径逐字节不变、`2d881a6` 的 `max(now,ts)+skew+1` 用例（`:341`）不动。
- 红证：改前 10 分钟注入被接受 ⇒ 红。prune 断言（`p14`）属守卫、改前后皆绿，如实标注。
- **不加容量上限**：淘汰在途 nonce 会重开重放口子（`src/main/sync/AGENTS.md` 硬约定 2 禁止）⇒ 交 N11 记 DEBT-052。

### N11 技术债登记

- 涉及文件：`docs/debt-registry.json`（**DEBT-050/051/052**，接 049 之后；`updatedAt` → 2026-11-03）+ `docs/技术债清单.md` 新增 `## 20. 本轮复查属实不修项（2026-11-03）`，表格形状抄 §19（`:624-628`），**不**动 §0 索引（49 项对 39 行，DEBT-045…049 本就无 §0 行）；顺带订正 DEBT-048/049 的 `lines`。
- 三条内容与理由见 §1.2 末尾。`description` 内必须带**本轮不修的原因 / 修法 / 撤销条件**三要素。
- 验收：`npx tsx scripts/check-md-links.ts` 绿；`npm test`（含 `dead === 0` 契约）绿；`npx tsx scripts/debt/check-debt-fix.ts` 咨询性始终 exit 0。

### N12 CHANGELOG 收口 + 全局回归

- 涉及文件：`CHANGELOG.md`。
- **落点（精确）**：新条目追加为 `## [2.5.6]` 节内 `### Fixed | 修复` 的**最后几条**（现末条在 `:44`，其后 `:45` 是 `---`）。`## [Unreleased] | 未发布` 下**不得**出现任何列表行——`check-changelog-release.ts:52` 按 `^\s*[-*]\s+\S` 计待发布条目即报错并阻断 `pre-dist-check`（`package.json:41`）；`:20` 现有散文保持散文。不得造第二个 `## [2.5.6]`（`:107` 判版本节重复）；`[Unreleased]: …/compare/v2.5.6...HEAD` 链接定义由 `check-changelog-release.test.ts:314-321` 钉住，勿动。
- 验收：`npx tsx scripts/check-changelog-release.ts` 三条 ✔；§3 全局收口全绿。

### N13 重打包 + 新鲜度取证 + 回写（见 §8）

---

## 8. 风险与回退

| 风险                                                     | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU 阶梯与退出取证是**保命状态机**，本机无故障硬件可实测 | N8/N9 只收紧「工装不落盘」与「写盘原子化」两件事；真实崩溃 / 升档 / 阈值 / 原生杀死路径由 `p11` 逐条钉住不得改变，任一条变绿即停。N9 的 rename 失败回落原写法，永不丢写入                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 计划里预写的预期读数与实测不符                           | 保留原预期、另起一行「按实况订正」并解释原因，**不悄悄把计划改成与实际一致**（那是销毁取证）。执行记录写进本文 §9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 重打包被 AV 句柄卡死（本机反复出现）                     | 先试标准链**一次**；失败即转旁路：`.cache/electron-dist-clean2`（实测 19 项、连 `resources/` 都不存在，与「排除 `default_app.asar` 与 `version`」的配方一致；注意 `electron-dist-clean` 有 20 项且**仍含** `default_app.asar`，不要用错）→ `--config.directories.output=release/zz-20261103-reviewfix`（目录名要排在 `win-unpacked` **之后**，避开 `findAsarUnpacked` 的 readdir 首命中假绿）→ **`cp -rf .../win-unpacked/. release/win-unpacked/`**（必须带尾部 `/.`，否则产出嵌套 `win-unpacked/win-unpacked/` 让 `findUnpackedExe` 的 glob 落空；用 `cp` 不用 `mv`：被锁文件只挡 rename/unlink，读与就地覆盖允许）→ `diff -rq` 必须空输出 → 裸跑 `verify:dist` 并确认回显路径全在 `release/win-unpacked/` 下。仍不通则如实报「前提不成立」，把唯一用户侧动作（工作区加实时防护白名单，**不必重启**）列清，**不拿旧包冒充成功** |
| 旧包是不可再生孤本                                       | 先 `cp` 留底到 gitignored 的 `_safe_backup_20261103-reviewfix/`（安装包在 git 里零副本），再出包覆盖到标准名                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 版本已被指定为 2.5.6 而现状已是 2.5.6                    | 如实报「零编辑」并附读数，**不为凑任务造改动**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 某处造不出真红灯                                         | 不编造假红灯（N5 纯注释、N10 的 prune 守卫）——按 §6 的「否（守卫，如实标注）」交付                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| lint-staged 会改写文件                                   | 提交前 `npm run verify:staged`、提交后 `git status --porcelain` 复核残余，并对提交后的最终内容**复跑**受影响判据（提交前读数 ≠ 提交后读数）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 9. 执行记录（2026-11-03，待回写）

阶段 B/C/D 的逐节点红绿读数、变异抽查、六道闸门与旁路出包读数，执行后写入本节。
