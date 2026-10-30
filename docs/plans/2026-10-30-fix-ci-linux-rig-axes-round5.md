# 2026-10-30 让 `npm run test:ci-linux` 归零（第五轮：node:sqlite 轴收口 + child_process 补桩点）

> 本轮零新增依赖、不动 `package.json`、不动产品代码 `src/main/**` 的非测试文件、不推送、不建 PR、不发版、不打包。
> 上一轮：`2026-10-30-fix-ci-linux-rig-axes-round4.md`（RC-1…RC-7 逐根收口，含本文件接手时仍挂着的 `node:sqlite` Gate-A 探针）。

## 0. 地面真相：开工读数（2026-10-30 本机，HEAD = 045713b + 未提交半成品）

| 命令                                                                                                              | 实测读数                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `npm run test:ci-linux`                                                                                           | **7 文件 / 39 例红**（454 文件收集，7066 passed / 10 skipped）   |
| `npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync`                                            | 5 failed / 11 passed（簇 A 定位）                                |
| `npx vitest run --config vitest.ci-linux.config.ts <两个 EFTYPE 文件>`                                            | 2 failed（簇 B 定位）                                            |
| `npx vitest run src/main/utils/fluent-ffmpeg-shim.test.ts …generator.eftype.test.ts src/main/nikkisync`（真宿主） | **18 文件 / 292 例全绿** ⇒ 两簇都不是产品回归                    |
| `npm run link:nikkisync:check`                                                                                    | OK（四包 junction 在位）                                         |
| 泄漏计数开工基线                                                                                                  | `D:/tmp` 194、`C:/WINDOWS/temp` 10、沙箱 `wxnn-ci-linux\tmp` 112 |

上一轮开工基线是 32 文件 / 59 例红；本轮剩余 39 盏**全部属装置侧**（要么轴没接完，要么轴补齐后暴露出装置自身的失真），分两簇。

## 1. 根因表

| #    | 红数 | 现象                                                                                                                | 真实原因（已取证）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 节点 |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| RC-8 | 35   | `[vitest] No "Database" export is defined on the "node:sqlite" mock`；`expected [Array(12)] to have a length of 20` | `tests/ci-linux.setup.ts:182-194` 挂着上一段会话的**临时 Gate-A 探针**：`DatabaseSync` 桩构造即抛，且返回值没声明 `Database` 键。上游 `../NikkiSync/packages/database/src/database-manager.ts:14-17` 取构造器写的是 `sqliteModule.Database ?? sqliteModule.DatabaseSync`，而 vitest 的 mock 代理读到**未声明的导出直接抛**（本机 Node v26 的 `node:sqlite` 实际导出 `DatabaseSync,Session,StatementSync,backup,constants,default`，无 `Database`）⇒ 四包装载当场失败。轴本体 `tests/mocks/ci-linux-sqlite.ts` 已写好但**没接线**，守卫 token 表与自检例也都没有它。波及 `sync-server.linked`(13) / `runtime-facade.linked`(13) / `runtime-loader`(5) / `probe`(3) / `metadata-resolver.linked`(1 文件级)。`probe` 的 20→12 是纯下游：`src/main/nikkisync/probe.ts:243-266` 只在包**装载成功**时才累加 `exports` 记录 | N1   |
| RC-9 | 5    | `expected 'ENOENT' to be 'EFTYPE'`、`expected [Function] to throw an error`、陈旧 spy 串扰                          | `tests/mocks/ci-linux-child-process.ts:42` 的 `wrapNamespace` 返回真命名空间的**副本**。`src/main/utils/fluent-ffmpeg-shim.test.ts:25,43,75` 与 `src/main/thumbnail/generator.eftype.test.ts:22,108-111` 的桩法前提是被外部化 CJS（fluent-ffmpeg 顶层 `var spawn = require('child_process').spawn`）捕获的那个内置单例；装置态下测试补的是副本、fluent-ffmpeg 用的仍是真单例 ⇒ 桩打空 ⇒ 真 `spawn('/fake/ffmpeg.exe')` 给异步 ENOENT 而非设计要的同步 EFTYPE。其余三盏同因串扰：`fluent-ffmpeg-shim.test.ts:175` 先抛 ⇒ `:176` 的 `origSpy.mockRestore()` 不执行 ⇒ 最后一个用例吃到还在抛 EFTYPE 的陈旧 spy。属提交 fb6f226 补轴 8 带出的**装置失真**，真宿主与 CI 上两者同一对象，故全绿                                                                                                                            | N2   |

## 2. 启动 / 环境准备

```bash
npm run link:nikkisync:check                                                        # 前置真相：junction 缺席会把簇 A 的验收变成 skip 假绿
npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync                # 簇 A 单簇读数
npx vitest run --config vitest.ci-linux.config.ts <两个 EFTYPE 文件>                 # 簇 B 单簇读数
npm run test:ci-linux                                                               # 全量装置读数（目标 0 failed）
node -e "console.log(require('fs').readdirSync('D:/tmp').length)"                   # 泄漏检测，基线 194
```

## 3. 参数校验约定（本轮触碰的契约）

- `ciLinuxSqliteHost(importOriginal)`：第 1 参 `location` 过 `toReal`（`typeof value !== 'string'` 在 `toReal` 内短路 ⇒ Buffer / URL / fd 原样透传）；`':memory:'` 无 CI 前缀 ⇒ 恒等，内存库语义不变；第 2 参 `options` 原样透传给 `super`；宿主 `node:sqlite` 无 `DatabaseSync` 函数导出 ⇒ 返回 `actual` 不接管（比打死整个 profile 更好判）；`Database: undefined` 必须**显式存在**（上游兼容支靠读到 `undefined` 而不是抛）；`default` 与具名形态同一对象；其余导出（`StatementSync` / `backup` / `constants` / `Session`）透传不包装。
- 簇 B 补丁点契约：`createRequire(import.meta.url)('child_process')` 取到的必须是真内置单例（`vi.mock` 拦不到 `createRequire`，同 `tests/ci-linux.setup.ts:45-49` 对 `os` 的处理）；`import.meta.url` 在这两个文件成立（`node` project、文件内已有顶层 `await import()`）。`ctl.mode` / `makeEftypeError()` 与全部断言语义不动。

## 4. 错误处理与兜底

- 临时哨兵**彻底删除**，不留环境变量开关：留着就是永久红。
- 簇 A 收口后若 linked 套件仍有红 ⇒ 按装置轴逐条归因继续修；`docs/CODING_CONVENTIONS.md` §6 明令**不许** `it.skip` / 放宽断言 / 调低阈值。
- 簇 B 不新增 `afterEach` 重构：串扰随主因消失而消失，若仍复现则视为独立缺陷另开节点。`afterAll` 还原点（`:96`、`:121`）改后必须仍成立。
- 装置头注释「已知失真」补两条（`tests/ci-linux.setup.ts:31-37`）：① 轴 7 的 sqlite 库路径属宿主轴、与 `fs` 同层、落点在沙箱真目录；② 轴 8 在装置态给出**两个 `child_process` 身份**（测试图 = 包装副本，`createRequire` = 真单例），靠给内置单例打桩拦截外部化 CJS 的测试必须补真单例那一份——CI 上只有一个身份，所以这是装置失真而不是产品事实。
- 顺手项（同文件既有缺陷，一行）：`tests/ci-linux.setup.ts:172` 的轴 8 标题注释与下一行被上一段会话粘成一行，复原。

## 5. 节点分解

### N0 计划落盘（本文件）

- 文件：`docs/plans/2026-10-30-fix-ci-linux-rig-axes-round5.md`
- 验收：`git ls-files` 能列出本文件；`npx tsx scripts/check-md-links.ts` 绿。

### N1 簇 A：把哨兵换成注册第 7 轴

- 红灯先行：`src/main/utils/ci-linux-emulation.test.ts` 在轴 8 例之后新增 `it.skipIf(!ACTIVE)('轴 7：node:sqlite 的库路径经装置翻译（真原生句柄落在沙箱里）')`，逐字复刻上游装载序列（变量式 `specifier` → `await import` → 先读 `Database` 得 `undefined` 而不抛 → `mkdtemp` 目录下建库 → `CREATE TABLE` + `INSERT`/`SELECT` → 再开 `':memory:'` → `close()` → `rmSync` → 用 `realSandbox()` + `path.win32` 断言真宿主落点存在）；`scripts/__tests__/path-semantics-guard.test.ts:214-229` 轴 token 表追加 `"vi.mock('node:sqlite'"`。两盏均确认先红。
- 改动：`tests/ci-linux.setup.ts` 删探针、按其余轴同形逐条内联注册 `ciLinuxSqliteHost`（只注册 `node:sqlite`，`bun:sqlite` 上游不可达）、补头注释；`tests/mocks/ci-linux-sqlite.ts` 头注释由「探针结论」改「正式结论」。
- 验收：`npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync` ⇒ **0 failed 且 skipped = 0**；`metadata-resolver.isolation.test.ts`（走 `createRequire`，不经该轴）保持绿；真宿主 `npx vitest run src/main/nikkisync` 与 §0 的 18/292 一致；`npm run typecheck` / `npm run lint` / `npm run verify` 绿。

### N2 簇 B：补桩点换成真内置单例

- 红灯先行：`scripts/__tests__/path-semantics-guard.test.ts` 新增登记表 `RIG_PATCHES_REAL_CHILD_PROCESS`（两个 EFTYPE 文件必须含 `createRequire(import.meta.url)('child_process')` 且不再用静态 `import childProcess from 'child_process'` 当打桩对象）；`src/main/utils/ci-linux-emulation.test.ts` 新增装置态可见性自检例（真单例 ≠ 装置命名空间、`real.spawn !== mocked.spawn`，把「两个身份」失真永久化）。确认先红。
- 改动：`src/main/utils/fluent-ffmpeg-shim.test.ts:25`、`src/main/thumbnail/generator.eftype.test.ts:22` 换成 `createRequire` 取真单例，并在既有注释处补一句原因（轴 8 给副本、外部化 CJS 捕获真单例、真宿主与 CI 两侧同一对象）。
- 验收：装置态两文件 `4→0`、`1→0`（最后一个「正常路径」用例不再吃陈旧 spy）；真宿主两文件保持 `0 failed`；登记表例与自检例转绿；`npm run typecheck` / `npm run lint` 绿。

### N3 全量归零 + 泄漏核对 + 读数回写

- `npm run test:ci-linux` 目标 **0 failed**；`D:/tmp`（194）与沙箱条目数不增长；`npm test` 与第 4 轮 §0 的 454 files / 7094 passed / 12 skipped 对比，出现 delta 即说明装置改动漏进了普通 profile。
- 本文件回写实跑读数与逐簇归因。

### N4 用户点名的五闸门（顺序不可缩短，install 后先复位 junction 防假绿）

```bash
npm run link:nikkisync:check
npm install
npm run link:nikkisync && npm run verify:nikkisync && npm run doctor
npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync   # skipped 必须为 0，否则 N1 记「未验证」而不是绿
npm run build
npm run test
npm run typecheck
npm run typecheck:e2e && npm run lint && npm run i18n:guard && npm run verify
npm run e2e:smoke
```

`e2e:smoke` 结论必须落在现场读数（汇总行、`.last-run.json`、`test-results/` 时间戳），不看管道退出码：本 shell 实测会吞 Playwright 全部 stdout，且 `env -u ELECTRON_RUN_AS_NODE …` 静默不执行。`ELECTRON_RUN_AS_NODE=1` 当前确实在环境里，`e2e/helpers.ts` 的 `launchEnv()` 会自行剥离，无需手工 unset。

## 6. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                            | 判据                                                                                                                         |
| ---- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 正常 | 轴 7 变量式 specifier 也被接管  | `await import(specifier)` 后在 `mkdtemp` 目录建库 + `CREATE TABLE` + 回读成功                                                |
| 正常 | 上游 `Database ?? DatabaseSync` | 读 `mod.Database` 得 `undefined` 而**不抛**，构造器落 `DatabaseSync`                                                         |
| 正常 | linked 套件真绿                 | 装置态 `src/main/nikkisync` = 0 failed / **0 skipped**                                                                       |
| 正常 | 簇 B 语义不变                   | `code==='EFTYPE'`、无回调形态同步 rethrow `/spawn EFTYPE/`、`origSpy` 恰好 1 次、正常路径 `err===null` 且 `formats.mp4` 正确 |
| 异常 | 轴 7 不得被拆                   | 守卫 token 表含 `"vi.mock('node:sqlite'"`，删掉即红                                                                          |
| 异常 | 补桩点不得退回副本              | `RIG_PATCHES_REAL_CHILD_PROCESS` 两文件必须含 `createRequire(import.meta.url)('child_process')`                              |
| 异常 | 双身份失真成立                  | 装置态 `real !== mocked.default` 且 `real.spawn !== mocked.spawn`                                                            |
| 异常 | 真宿主不受影响                  | `npm test` 逐字回基线；真宿主两文件 0 failed                                                                                 |
| 边界 | `':memory:'`                    | 装置态可 `exec('SELECT 1')` 并 close（`toReal` 恒等）                                                                        |
| 边界 | 非字符串 / 其余导出             | `toReal` 短路透传；`StatementSync` / `backup` / `constants` 原形                                                             |
| 边界 | 库文件真宿主落点                | `.db` 出现在 `realSandbox()/tmp/…` 下（原生句柄确实吃到翻译后的路径）                                                        |
| 边界 | 宿主无 `DatabaseSync`           | 工厂返回 `actual` 不接管；不造平台开关                                                                                       |

## 7. 结案读数（实跑回写）

| 命令                                           | 开工                                                             | 结案                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run test:ci-linux`                        | 7 文件 / 39 例红（454 收集，7066 passed / 10 skipped）           | **454 文件全绿 / 7115 passed / 3 skipped / 0 failed**（42.89s）               |
| `npm test`（真宿主）                           | —（本轮未重跑开工档，见下方用例账）                              | **454 文件全绿 / 7098 passed / 20 skipped / 0 failed**（52.46s）              |
| `npx vitest run --config … src/main/nikkisync` | 5 failed / 11 passed（RC-8 35 盏）                               | **16 文件全绿 / 286 passed / 0 skipped**（skipped=0 ⇒ junction 在位，非假绿） |
| `npx vitest run --config … <两个 EFTYPE 文件>` | 2 failed（RC-9 5 盏）                                            | **2 文件全绿 / 6 passed**；真宿主同两条文件亦全绿                             |
| `npm run verify`                               | —                                                                | 5 项全 ✓（typecheck / eslint / core-gate / prettier / 相关单测）              |
| 泄漏计数                                       | `D:/tmp` 194、`C:/WINDOWS/temp` 10、沙箱 `wxnn-ci-linux\tmp` 112 | `D:/tmp` 194、`C:/WINDOWS/temp` 10、沙箱跑前 116 / 跑后 116（持平）           |

**用例账**：本轮 5 笔提交新增 3 条用例（`git diff 045713b..HEAD -U0 | grep '^+\s*it'` 可复核）——轴 7 自检例与轴 8b 自检例各 1（装置闸门 ⇒ 真宿主读作 skipped）、`path-semantics-guard` 的轴 8 登记表例 1（两侧都跑）。装置态 7115 passed / 3 skipped、真宿主 7098 passed / 20 skipped，总数同为 7118；与第 4 轮 §0 的 7094/12 之差来自第 4 轮自己补的自检例（那些在真宿主全部读作 skipped），不是本轮带出的漂移。

**RC-8 收口过程中轴本体的真缺陷**：`tests/mocks/ci-linux-sqlite.ts` 原写 `super(toReal(location), options)`，把 `undefined` 显式传给原生第二参 ⇒ Node 的 `DatabaseSync` 抛 `ERR_INVALID_ARG_TYPE: The "options" argument must be an object`（实测 `new DatabaseSync(':memory:', undefined)` 红、`new DatabaseSync(':memory:')` 绿），而上游正是单参形态。改为 `options === undefined` 时只传一路径参。这一条是新写的轴 7 自检例抓出来的——它先红（哨兵态）后绿（接线态），并在结案前用「把 specifier 改成 `node:sqliteXX`」的变异检验证明拆轴即红。

**变异检验记录（判据有牙齿的证据，均已复原）**

| 判据                               | 变异                                                                 | 结果                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 守卫 token `vi.mock('node:sqlite'` | 轴的注册 specifier 改为 `node:sqliteXX`                              | `path-semantics-guard` 红：`装置缺少轴：vi.mock('node:sqlite'`                                      |
| 轴 7 自检例                        | 同上（撤掉轴）                                                       | 装置态红：`unable to open database file`（真句柄拿到 `D:\tmp\…`）                                   |
| 轴 8 登记表例                      | 补桩的 `createRequire` specifier 改为 `child_processXX`              | 红：`必须经 createRequire 取真 child_process 单例再打桩`                                            |
| 轴 8b 自检例                       | 两根 `vi.mock('child_process'…)` 的 specifier 改为 `…XX`（等于撤轴） | 装置态红：`expected { …(9) } not to be { …(9) }`（撤轴后两侧同一对象，恒等式不再成立）；轴 8 同批红 |

**顺带清掉的两项**：`tests/ci-linux.setup.ts:172` 被上一段会话粘成一行的轴 8 标题注释已复原；K3 会话面用例的库文件改为自己收尾（见提交「K3 会话面用例自收尾库文件」），否则轴 7 打通后每轮在沙箱留 3 个 180KB 的 `.db`。

## 8. 明确不做

- 不改 `package.json` 依赖与 scripts，不动 `node_modules`，不引入第三方方案（正解在 vitest mock 语义内部）。
- 不动产品代码 `src/main/**` 非测试文件（含 `src/main/utils/fluent-ffmpeg-shim.ts`）。
- 不加 `it.skip` / `it.skipIf(平台)`、不放宽断言、不动覆盖率阈值；新自检例只沿用本文件既有 `it.skipIf(!ACTIVE)` 装置闸门形制。
- 不改 `tests/mocks/ci-linux-child-process.ts` 的「返回副本」语义：就地改会把 `toReal` 推给全部外部化 CJS，属装置自造 CI 不可能出现的分叉。
- 不动姊妹装置 `tests/posix-host.setup.ts` / `vitest.posix-host.config.ts`（刻意只开一根轴，已核实与 `node:sqlite` 无交集）。
- 不把沙箱搬到盘根去「迁就」原生模块。

## 9. 用户点名的五闸门实跑读数（按 §5-N4 的顺序）

| 步骤                                                               | 读数                                                                                                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run link:nikkisync:check`（install 前真相）                   | OK，四包在位                                                                                                                                                                     |
| **`npm install`**                                                  | exit 0，`removed 4 packages in 1s` ⇒ **四个 junction 被清掉**（已知陷阱）；`package-lock.json` 未被改写（`git status` 干净）                                                     |
| `npm run link:nikkisync` → `verify:nikkisync`                      | 4 link(s) written；`[verify:nikkisync] OK (blocking failures: 0)`，含「node:sqlite 在 node 26.x 可 import」一条                                                                  |
| `npm run doctor`                                                   | 总计 5 项 / OK 5 / DEGRADED 0                                                                                                                                                    |
| 装置态 `src/main/nikkisync`（install 后防假绿复读）                | 16 文件全绿 / 286 passed / **0 skipped**                                                                                                                                         |
| **`npm run build`**                                                | exit 0，`✓ built in 8.10s`，产物齐；`dist/main/main/app/index.js` 时间戳晚于 HEAD                                                                                                |
| **`npm run test`**                                                 | exit 0，**454 文件全绿 / 7098 passed / 20 skipped**（与 install 前逐字一致）                                                                                                     |
| **`npm run typecheck`**                                            | exit 0（`tsc -b` + `tsc -p tsconfig.scripts.json`）                                                                                                                              |
| `npm run typecheck:e2e` / `npm run lint` / `i18n:guard` / `verify` | 全部 exit 0；lint 零输出；i18n 白名单只减不增；verify 5 项全 ✓                                                                                                                   |
| **`npm run e2e:smoke`**                                            | exit 0，**16 passed (23.8s)**，`test-results/.last-run.json` = `status: passed, failedTests: []`；日志两处 `[e2e] stripped ELECTRON_RUN_AS_NODE=1` 说明宿主泄漏已被 helpers 收敛 |

一条必须交代的读数边界：S1–S8 那 8 条跑的是 `release/win-unpacked/喵星图.exe`（时间戳 2026-10-30T01:12Z，**早于**本轮提交），N 套件走 `launchBuiltApp()` 用的是 `npm run build` 刚出的 `dist/main` 与 `node_modules/electron`。本轮改动全在测试与装置层（`git diff 045713b..HEAD --stat` 只含 `tests/`、`scripts/__tests__/`、`src/main/**/*.test.ts`、`docs/plans/`），没有产品代码，因此打包态与源码态在这一点上没有差别；若要打包态也吃进本轮提交，需另跑 `npm run dist:win`（本轮按 §8 未做）。
