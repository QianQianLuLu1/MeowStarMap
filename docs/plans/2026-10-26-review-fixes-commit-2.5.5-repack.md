# 近期提交审查收口 + 六处修复 + 2.5.5 重打包

> 日期：2026-10-26 ｜ 状态：已完成（执行记录见文末 §八 与重打包实测 §九）
> 背景：对全部近期提交与未提交代码做全面审查、修复问题、确认版本 2.5.5、重新打包。

## 一、前提取证（先判做不做，再动手）

| 前提（请求自带）                  | 取证命令                                                                                                                                    | 现场输出                                                                                                                                        | 判定                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 存在未提交代码                    | `git status --porcelain=v1`                                                                                                                 | ` M package-lock.json`（唯一一条）                                                                                                              | 成立，但非业务改动                                                       |
| 该改动是真实 diff（非 CRLF 幻影） | `git hash-object` ↔ `git ls-files -s`                                                                                                       | `352d6f1…` ↔ `53b96d1…`，`--numstat` = `0 48`                                                                                                   | 成立                                                                     |
| 版本号待改为 2.5.5                | `git grep -n '"version"' -- package.json`                                                                                                   | `package.json:3: "version": "2.5.5"`                                                                                                            | **不成立，早已达成**                                                     |
| 其它版本声明位待改                | 逐位核对                                                                                                                                    | lock 根 `:3/:9`、`release/latest.yml`、`src/renderer/preview/mock/database-mock.ts:664` 均 `2.5.5`；README 徽章与 ARCHITECTURE/DEVELOPMENT 同值 | **不成立**（本轮四处声明位零改动）                                       |
| 代码质量闸门当前是红的            | `npm run lint` / `npm run typecheck` / `npm test` / `npm run i18n:guard`                                                                    | exit 0 / exit 0 / 444 文件 6942 通过 12 跳过 / exit 0                                                                                           | **不成立**——问题全在闸门覆盖不到的语义层，只能靠人审                     |
| 安装包已过期需重出                | `ls -la release/` + `package.json` 的 `build.files` + `docs/plans/archive/2026-Q4/2026-10-25-nikkisync-upstream-sync-05-结案报告.md` §5.3 Ⓒ | 产物 00:03 产出；其后两提交（`923f86c` / `c89ed5d`）仅 `.md`，不参与 `build.files`；结案报告已明记「安装包对应 HEAD `9a8a1fb`」                 | 当时**未过期**；本轮改 `src/**` 后才过期，故修复后重打包                 |
| 有已提交未推送 / 被搁置的改动     | `git branch -vv`、`git log --oneline @{u}..HEAD`、`git stash list`                                                                          | main ahead 82；`stash@{0}: On feature/sync-integration-07-bidirectional-sync: phase7-wip-parked`                                                | 成立但不在范围：只要求提交不要求推送；stash 属他人分支停放 WIP，绝不 pop |

**审查窗口**：`b8c78e9..HEAD` 共 18 个提交（NikkiSync 上游同步兼容层 C2/C4/C5 + 能力层 K1–K8 + 两次文档收口），代码净增约 8400 行 / 76 文件。

## 二、依赖声明

**零新增、零变更依赖。** 全程禁止 `npm install` / `npm ci`——本机 npm 11 会剥离 `package-lock.json` 的 `libc` 字段（工作区那条 48 行删除即此成因，非本次意图，已 `git checkout --` 还原）。

全部修复复用仓内既有实现：`src/main/ipc/validator.ts` 的 `pathGuard` 单例与 `assertFileReadPath`；`src/shared/types/ipc-types.ts` 的 `IPC_ERROR_CODES.PATH_FORBIDDEN`；`src/renderer/styles/globals.css` 已定义的 `--accent` / `--bg-secondary` / `--danger`；各测试文件既有替身装置（`_test-helpers.ts` 的 `makeCtx`/`getHandler`、`installElectronApi({ persisted })`、`vi.setSystemTime`）。

## 三、启动与运行说明

- 环境：现有 `node_modules` 即可，无需安装。
- 命令链：`npx vitest run <单文件> -t <用例>` 取红 → 改码 → 同命令取绿 → `npm run verify` → `npm test` → `npm run typecheck` / `typecheck:e2e` → `npm run lint` → `npm run i18n:guard` → `npm run test:ci-linux`（只读诊断）→ `git commit` → `npm run dist:win`。
- 唯一触碰路径语义的一项（Node 4）额外用 `npx vitest run --config vitest.ci-linux.config.ts <文件>` 复跑，证宿主无关。
- 改动 `src/**` 一律用 Write/Edit 工具；`docs/IPC_CONTRACT.md` 改表后先 `npx prettier --write` 再提交，避免钩子改写留下意外改动。

## 四、子任务定义与红绿证据

### Node 1：主题色兜底与开关读回收敛

- **涉及文件**：`src/renderer/pages/sync-gallery/SyncServicePage.tsx`（L194、L654-657、L676、L778）、`src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`（新增 `(ai)`）。
- **输入/输出**：`setEnabled(Boolean(value))` → `setEnabled(value === true)`；三处 `var(--x, 字面量)` 去掉兜底；L655-657 两分支同值（均 `var(--text-tertiary)`）的死三元折叠。渲染像素零变化——三个变量在 `:root` 恒有定义，`--danger` 未被 `src/renderer/styles/themes/soft-pink-luxury.css` 覆盖，删兜底不会回落。
- **为何读回不是装饰**：`src/main/app/nikkisync-runtime-setup.ts` 的 `settingsFrom` 注释即写明 `app_settings` 历史值可能是别的类型并做 `typeof value === 'boolean' ? value : fallback` 收敛；渲染层 `Boolean('true')` 显示「已启用」而主进程按关闭处理、不自启 ⇒ UI 与消费点判据分叉。同文件元数据（L229）、整理（L366）两处开关早已用 `=== true`，L194 是漏项。
- **验收标准**：`(ai)` 红灯（`persisted: { 'nikkisync.syncServerEnabled': 'true' }` ⇒ 期望 `aria-checked="false"`）改前实测红 `Received: aria-checked="true"`，改后该文件 40/40 通过。
- **不写测试的部分**：颜色兜底无行为差异，为其造断言即造假；状态点语义（今日为主题 accent 而非作者兜底里的绿色）属既有设计，不在本轮越界重做。

### Node 2：`handleToggle` 持久化失败未捕获

- **涉及文件**：`src/renderer/pages/sync-gallery/SyncServicePage.tsx`（L515-540）、同套测试（新增 `(aj)`）。
- **输入/输出**：`await persistEnabled(value)` 从「只有 `finally` 没有 `catch` 的外层 try」提进**已有的内层 try**，使持久化失败复用同一条回滚分支（尽力 `persistEnabled(!value)` + `setEnabled(!value)` + `showError`），外层 `finally { setBusy(false); void refresh() }` 保持不动。净效果少一层嵌套，非新增代码。
- **验收标准**：`(aj)` 红灯——`settingsSet.mockImplementation(() => Promise.reject(...))` 后点开关，断言开关回 `aria-checked="false"`、`startServer` 未被调用、两键不为 true。实测双重可证：断言失败**且** Vitest 额外报 `Errors 1 error`，栈为 `persistEnabled` → `handleToggle` → `onChange`（正是悬空 rejection）；改后 40/40 通过且 `Errors` 行消失。既有用例 `(b)`（成功）/`(c)`（startServer 失败回滚）继续绿，证明行为保持。

### Node 3：配对二维码过期后的每秒风暴

- **涉及文件**：`src/renderer/components/sync/PairingQrDialog.tsx`（catch 分支与 `offerRef` 声明位）、`src/renderer/components/sync/PairingQrDialog.test.tsx`（新增 `(g)`，`afterEach` 补 `vi.useRealTimers()`）。
- **输入/输出**：重生成失败时同步作废提案——`offerRef.current = null` + `setOffer(null)`；`offerRef` 及其同步 effect 上移到 `generate` 之前（tick 读的是 ref，等 `[offer]` 的 effect 回流要慢一拍）。
- **验收标准**：`(g)` 红灯——假定时器置于 `12:04:59Z`（`QR_OFFER.expiresAt` 为 `12:05:00Z`），首答后改为恒失败，推进 4 秒断言 `getPairingCode` 恰好 2 次。实测改前 5 次（每秒一次）→ 只 `setOffer(null)` 仍 4 次（effect 回流慢一拍，这 2 次是真实发生的）→ 同步作废 ref 后 2 次，7/7 通过。

### Node 4：`nikkisync:inspect-extra-directory` 补路径白名单守卫

- **涉及文件**：`src/main/ipc/handlers/nikkisync-handler.ts`（inspect 通道、`@core-change` 头注释、K6 计数注释、`get-pairing-code` 头部说明）、`src/main/ipc/handlers/nikkisync-handler.test.ts`（新增守卫用例 + 两条既有用例的桩改造）、`docs/IPC_CONTRACT.md`。
- **输入/输出**：`parseAndRun` 回调内、zod 之后加 `if (!pathGuard.isUserPickedDir(input.path)) assertFileReadPath(input.path)`（保证形态错误仍先由 `inspectDirectorySchema` 判 `VALIDATION_ERROR`）；`assertFileReadPath, pathGuard` 追加进既有 `from '../validator'` 一行 import，不新增导入行。判据与 `src/main/ipc/handlers/scanner-handler.ts`、`src/main/ipc/handlers/settings-handler.ts` 的扫描根短路逐字一致。真实流程不受影响：同步服务页「添加目录」走 `dialog:selectDirectory`，主进程 dialog-handler 已登记 `userPickedDirs`，直接短路。
- **为什么必须补**：入参是渲染层给的绝对路径，会交上游真去枚举目录，且返回的提案随后可被 `add` 提升为长期扫描根——其内容便经 `media://` 可读。只校验「是不是绝对路径」等于把一个可信目录选择器换成任意目录探针，违反编码约定第 1 节硬规则。
- **验收标准**：守卫用例红灯实测 `expected undefined to be 'IPC_PATH_FORBIDDEN'`（伪造路径当前直接成功）；改后 `npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts` 66/66 通过，且 `--config vitest.ci-linux.config.ts` 同文件 66/66 通过（宿主无关）。
- **桩改造的取舍**：保留该测试文件对 `../validator` 的**真实**引用，不采用 scanner/settings 的 `vi.mock('../validator')` 路线——`tests/mocks/mock-validator.ts` 的 `wrapHandlerRaw` 以 `unwrap(args)` 位置传参，而本文件按 `handler(event, { path })` 调用、handler 读 `args[0]`，换 mock 会让全部 raw 用例静默拿到 event 对象并绕过 zod，把既有 `VALIDATION_ERROR` 断言整体打死。登记用 `pathGuard.registerUserPickedDir(...)` 且在具体用例内调用（singleton 跨用例污染），守卫用例刻意使用与已登记路径不同的盘符路径。`src/main/ipc/validator.ts` 已固化 `path.win32`，故 `D:\…` 形态在 ubuntu runner 上判定一致。
- **契约同步（第 6 项，同批）**：`docs/IPC_CONTRACT.md` 补 `get-pairing-code` 出参的 `hosts?` 与 `content` 的 `NS1|` / `nikki-sync://pair?` 双格式（K5 `476182b` 引入而未同步文档），`inspect` 通道入参加「须是已登记目录」、失败码加 `PATH_FORBIDDEN` 并补一条契约要点；映射表计数「八」订正为「九」（表体实列 9 个短码，逐码映射用例 5+4 与表一致）。同类漂移一并订正：`src/renderer/components/sync/PairingQrDialog.tsx` 与 `.test.tsx` 顶部注释里「NS1 七段串」的单一格式表述。

### Node 5：最终全量回归抓到的 K1 用例断言竞态（原审查未列入，回归中新发现）

- **触发**：出货前的最后一次 `npm test` 报 `1 failed`——`(s) K1：启动阶段行…` 取不到文本「启动阶段」；紧接的第二次全量跑却全绿。即这是一条随时序抖动的测试缺陷，而非本轮改动引入的行为回归。
- **根因**：该用例只 `await waitFor(() => expect(serverApi.getRuntimeStatus).toHaveBeenCalled())` 就断言渲染结果。`refresh()` 把 `getServerStatus` / `getPairedDevices` / `getRuntimeStatus` 放进同一个 `Promise.all`，`setStartupStages(...)` 落在其后的微任务里——「调用已发起」≠「状态已提交」，全量套件的 CPU 争用把这段窗口拉开就随机读到旧渲染。同文件的 `(s2)`、`(x2)` 本来就是按落地结果等待（先等「运行状态」/「连接诊断」出现），`(s)` 是唯一漏了这一拍的。
- **涉及文件**：`src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`（仅测试层，`src/renderer/**` 的 `*.test.tsx` 不被应用代码引用，不进 bundle、不进出货产物）。
- **输入/输出**：把等待换成结果锚定 `await waitFor(() => expect(screen.getByText('启动阶段')).toBeInTheDocument())`，其后六条断言（五个 i18n 阶段名 + 未知阶段回退原样英文串）逐字保留——只收紧时序，不弱化任何判据。
- **验收标准**：改前实测两轮全量一轮红（`test-final.log` 留 `FAIL … 启动阶段`）；改后单文件 40/40、连续三次 `npm test` 均 6946 通过 / 12 跳过 exit 0。

## 五、参数校验

本轮唯一新增的入参约束是「已登记目录」这一条，其校验次序为固定契约，不得调换：

1. zod 层（`inspectDirectorySchema`）：`string`、`trim`、长度 1..4096、`/^([A-Za-z]:[\\/]|\\\\|\/)/` 形态判绝对路径 ⇒ 不合者 `VALIDATION_ERROR`（相对路径 / 空串 / 超长三条既有断言继续覆盖）。
2. 白名单层：`pathGuard.isUserPickedDir(path)` 命中即放行（用户经系统对话框显式选择的目录视为已授权）；未命中 ⇒ `assertFileReadPath` 走白名单 + 敏感目录黑名单，`isAllowed` 依次判绝对性、`isSensitivePath` 黑名单、用户主目录与 userData 目录、已注册 roots，默认拒绝 ⇒ `PermissionError` → `IPC_PATH_FORBIDDEN`，且**不调用上游句柄**。
3. 边界值：路径不存在时 `registerUserPickedDir` 的 `fs.realpathSync` 抛错被吞、维持原形态登记（既有 fail-open 注释已说明），不影响判定；`details.path` 经 `maskPath` 脱敏，不跨 IPC 回传完整路径。

## 六、错误处理

- 守卫抛的是 `AppError.forbidden`（validator 内部），经 `parseAndRun` 的 `toAppError(error, scope)`——该函数对 `AppError` 实例逐字透传，故错误码与 `userMessage` 不被降级成 `INTERNAL_ERROR`；渲染层照旧经 `extractUserMessage` 展示，无新增文案 key（`i18n:guard` 绿即证零新增）。
- Node 2 的回滚沿用分支既有语义：回滚写失败仅保留本地态（嵌套 catch 静默），不引入 `process.on('unhandledRejection')` 之类兜底——修复后该 rejection 已不可达。
- Node 3 保留「错误态 + 重试」既有出口：作废提案后 `failed` 分支照常渲染「生成配对二维码失败」与重试按钮，用户可显式再试；静默的是风暴而非错误本身。

## 七、审查过但明确不修（附证据，避免越界与臆造）

| 项                                                                                          | 证据                                                                                                                                                                                                                                       | 结论                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `runtime-manager.ts` 的 `scan()` 用 `deps.defaults` 重建会话，疑似丢用户改过的端口          | `deps.defaults.syncServer` 的端口本就取自设置键 `nikkisync.syncServerPort`，且渲染层唯一调用是 `startServer()` 无参                                                                                                                        | 分叉不可达，属为不可能的未来需求改设计，不动                                 |
| `runtime-facade.ts` 开关为真但 `consentFile` 缺失时解析器无守卫（K2 fail-open 疑虑）        | `buildSessionOptions` 无条件构造 `consentFile`；`runtime-facade.test.ts` 已把「裸解析器」钉为双闸门下的有意设计（enabled 默认 false）                                                                                                      | 不可达，不动                                                                 |
| `rescan-extra-directories` 不发 `nikkisync:library-changed`（仅 `start-scan` 发）           | 该通道注释即判据「只在扫描成功返回后发，失败时库可能处于中间态」；`rescan` awaited 的是状态返回，上游摄取未必已完成，补发反而可能刷出半截结果                                                                                              | 需产品决策（图库是否应在额外目录重扫后自动刷新），本轮不动                   |
| `nikkisync:start-scan` 的 `path` / `gameRoot` 同样无守卫                                    | 无调用方传这两个字段；两字段需不同谓词（目录用 `isUserPickedDir`、文件用 `isUserPicked`），而 nikkisync 从不登记游戏根，照抄会把合法文件重扫打成 403；`src/main/nikkisync/**` 也不调 `registerRoots`，scanner 那条「自助提权链」在此不成立 | 早于审查窗口且需逐字段设计，本轮不扩面                                       |
| `refresh()` 无请求编序（2s 轮询理论上可被慢响应倒灌）                                       | 状态快照自纠正周期 ≤2s，`handleToggle` 的 `finally` 已主动 refresh 一次                                                                                                                                                                    | 缺陷真实但影响为亚秒级回跳，引入 generation 计数器与用例的收益/风险不匹配    |
| 整理队列「可批准项」谓词在 `SyncServicePage.tsx` 三处重复（渲染层 AGENTS 要求抽 `useMemo`） | 三处字面同一（`ORGANIZER_ACTIONABLE_STATES.has(state) && online`），当前无计数不一致的可见缺陷                                                                                                                                             | K8 新代码内的规范偏差，抽 `useMemo` 会触及三个断言点，按最小化改动本轮不重构 |

## 八、执行记录

- **Node 1–4 红绿**：逐条先跑出红并留存读数——`(ai)` `Received: aria-checked="true"`；`(aj)` 断言失败 + `Errors 1 error`（悬空 rejection，栈 `handleToggle` → `onChange`）；`(g)` `to be called 2 times, but got 5 times`（只清 state 仍 4 次）；守卫用例 `expected undefined to be 'IPC_PATH_FORBIDDEN'`。修复后各自转绿，未跳过、未放宽任何断言。
- **`npm run verify`**：`typecheck` / `lint` / `core-gate` / `format` / `test` 五项全 ✓，`总计: 5 项, 0 失败`。受保护路径改动与新授权注释同批，`core-gate` 通过。
- **全局回归**：`npm test` 444 文件全过、**6946 通过 / 12 跳过**（较基线 6942 净增 4，正是本轮四条新用例；skipped 零增长）；`npm run typecheck` exit 0；`npm run typecheck:e2e` exit 0；`npm run lint` exit 0；`npm run i18n:guard` exit 0（零新增 key）。**出货前的最后一次全量重跑抓到 Node 5 的断言竞态**（`1 failed`，随后一次全绿——随时序抖动），修复后连续三次 `npm test` 均 6946 通过 / 12 跳过 exit 0。
- **`npm run test:ci-linux`（只读诊断，不进 CI）**：13 文件 / 59 用例红。逐条归因于本机装置的环境缺件而非本轮改动——`scripts/__tests__/check-md-links.test.ts`、`source-encoding.test.ts` 等于 `spawnSync git ENOENT`；三个 `*.linked.test.ts` 与 `media-worker` / `thumbnail` / `scanner` / `sync` 用例于 `unable to open database file`（装置按设计把容器根置为不可写）。本轮改动的三个测试文件**无一出现在失败集合**，且 `nikkisync-handler.test.ts` 在同一装置下 66/66 绿。本机该命令长期为红早有台账（见 `docs/archive/plans/2026-10-23-rename-ui-i18n-pass.md`（已归档，不入仓）记录的 26 文件红集），属已知环境条件，非本轮引入。
- **提交面**：`package-lock.json` 的 48 行 `libc` 剥离在提交前 `git checkout --` 还原，未进入任何提交；每次提交后 `git status --porcelain` 复核钩子无残留改动。已落 `08b171a`（Node 1+2）、`614acdf`（Node 3）、`f4823f5`（Node 4，受保护路径，core-gate 以 1 个受保护文件通过）、`ad65b55`（订正 `f4823f5` 自己在 `nikkisync-handler.ts` 头注释里留下的括号笔误——一句两个闭括号、TTL 与单次消费被挤到括号外；纯注释改动，按约定随批替换授权注释为新原因）、`be6f4b9`（CHANGELOG 补录 + 本计划文档首次入库），Node 5 的测试修复与其文档记录再各落一个提交。

## 九、重打包实测

`npm run dist:win` 五阶段链共执行两次，均 exit 0（取 `$?` 紧接 `npm run`，不经管道）：

| 次序            | 时刻  | 对应源码 HEAD | 结果                                                                               |
| --------------- | ----- | ------------- | ---------------------------------------------------------------------------------- |
| 第 1 次         | 19:29 | `f4823f5`     | `DIST_EXIT=0`，产物 `MeowStarMap-Setup-2.5.5.exe` 183,631,851 字节                 |
| 第 2 次（出货） | 19:31 | `ad65b55`     | `DIST_FINAL_EXIT=0`，产物 183,631,854 字节，SHA256 前缀 `e436e3d60058bec53832b9a9` |

逐阶段读数（第 2 次）：

- `build:recycle-helper`：`node scripts/build-recycle-helper.cjs` 经 .NET Framework 4 `csc.exe` 产出 `resources\nikkisync\nikkisync-recycle-helper.exe`（K8 引入的 fail-closed 构建期闸门，缺编译器即中止打包）。
- `build`：electron-vite 三段构建，renderer 970 modules、main 217 modules、preview 38 modules 转换通过。
- `pre-dist-check`：✅ 全部校验通过；`check-doc-versions`：✅ README 的 Electron 版本全为 41.10，与 `package.json` 的 41.10.6 一致；`check-changelog-release`：✅ 变更日志收口通过（`[Unreleased]` 无条目，本轮条目落在 `[2.5.5-beta]` 节的补录引用块，与 10-24/10-25 两轮同构）。
- `electron-builder --win --publish never`：未配置签名（`signAndEditExecutable:false`），无需证书，不上传。
- `verify:dist`（`--verify-asar`）：✅ 解包产物校验通过——原生二进制与 VC++ 运行库随包、@nikkisync 六个入口与迁移 SQL 解包、管理员清单 `requestedExecutionLevel=asInvoker`、内容禁串 32 条对 `app.asar`（71,746,077 字节）全清。
- `release/latest.yml` 版本仍为 `2.5.5`（安装包名由 `artifactName` 模板生成）。

两点如实登记：

1. 打包时 `pre-dist-check` 提示「git 工作区存在未提交改动」——那是本计划文档与 `CHANGELOG.md`（`.md` 不在 `build.files` 内，不参与 asar），仅告警不阻断；这两份文档随本轮最后一次提交入库，故出货产物与最终 HEAD 的差异仅为不随包的分派文档。
2. 两次构建均未改写 `package-lock.json`（构建链不跑 `npm install`），工作区自始至终只有预期的文档改动。
3. Node 5 之后**不再重打包**：它只改 `src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`，测试文件不被任何应用入口引用，不进 renderer bundle、不进 asar；`be6f4b9` 与本节两份文档同理（`.md` 不在 `build.files` 内）。故 19:31 的产物与最终 HEAD 之间不存在可出货差异。
