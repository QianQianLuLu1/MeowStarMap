# 2026-10-27 修复 `npm run e2e:smoke`：宿主 env 泄漏、级联噪声与产物陈旧

本轮范围：用户在终端执行 `npm run e2e:smoke` 报错的定位与修复。三层原因全部来自本机实测读数，逐条给出处置与验收判据。

## 一、前提取证（台账）

| 前提（请求隐含的假设）        | 取证命令 / 读数位置                                                                                                          | 现场读数（2026-10-27）                                                                                                       | 判定                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 报错来自产品缺陷              | `npm run e2e:smoke`（带毒 shell，22:12）                                                                                     | `Running 16 tests` → **10 failed / 6 skipped**，首条 `bad option: --remote-debugging-port=0`、`exitCode=9`，`0` 条断言失败   | **不成立**：全部倒在 `electron.launch` 之前，属环境态                |
| 报错与宿主 env 相关           | `printenv \| grep -iE '^(ELECTRON\|QODER\|VSCODE)'`；`grep -RnE 'ELECTRON_RUN_AS_NODE' ~/.bashrc ~/.bash_profile ~/.profile` | `ELECTRON_RUN_AS_NODE=1` 与 `QODER_*`、`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 同批存在；profile 里 **0 命中** | 成立：变量由 Qoder 宿主进程注入，不是本机 shell 配置引入             |
| 剥掉该变量后即可全绿          | `(unset ELECTRON_RUN_AS_NODE; npm run e2e:smoke)`（22:14）                                                                   | **4 passed / 6 failed / 6 skipped**，唯一真失败 S4 `Expected "2.5.6-beta" / Received "2.5.5"`                                | 不成立：还剩一条真实信号（产物陈旧）                                 |
| S4 是断言写坏                 | `stat -c '%y' release/win-unpacked/喵星图.exe`；`head -1 release/latest.yml`；`git log -1 --format='%h %ad' fb08813`         | exe `2026-10-26 22:56`；`latest.yml: version: 2.5.5`；`fb08813`（10-27 19:37）才把 `package.json` 定为 2.5.6-beta            | 不成立：**断言工作正常**，本地产物确实早于版本号变更                 |
| `TypeError: undefined` 是缺陷 | `npx playwright test e2e/smoke.e2e.ts --grep "S1\|S4\|S5"`（22:20）                                                          | `S1 ok (693ms)` → `S4 x（版本号不符）` → `S5 x TypeError: Cannot read properties of undefined (reading 'evaluate') (1ms)`    | 不成立：失败后 worker 被回收、模块重新求值，跨用例共享态清零，属噪声 |
| 6 条 skip 需一并处置          | 运行首行 `[e2e-nikkisync] linkGate=skip — 未建链`                                                                            | `node_modules/@nikkisync/*` junction 缺失；日志自陈「未链接是受支持的默认态，本轮不据此判红」                                | **本轮不处置**（非缺陷，且建链属另一条工作流）                       |
| 产物与测试报告入仓            | `git check-ignore -v release test-results .cache`                                                                            | `.gitignore:7 release/`、`:10 test-results/`、`:26 .cache/`                                                                  | 被忽略 ⇒ 不能用 `git status` 判产物状态；重打包不可 revert           |

### 验证口径陷阱（本轮实测，写下来防止后续误读）

1. **`env -u ELECTRON_RUN_AS_NODE npm run e2e:smoke` 在本 shell 静默不执行**：exit 0、stdout 零字节、`test-results/.last-run.json` 时间戳仍停在失败那次。旁证实验：`env -u … npm run e2e:smoke -- --list` 同样零输出，而 `npm run e2e:smoke -- --list` 正常列出 16 条。⇒ 一律用 `(unset …; …)` 子 shell。
2. **管道取结论不可信**：`… | tail` / `… | grep` 让退出码落到管道尾，且本 shell 实测会吞掉 Playwright 全部 stdout。
3. 读数只认现场：`ok/x/-` 行、汇总行、`.last-run.json`、产物 mtime。

## 二、根因

- **环境态（唯一代码缺陷）**：`e2e/helpers.ts:69`（`launchApp`）与 `:181`（`launchBuiltApp`）以 `env: { ...process.env, NODE_ENV: 'production' }` 原样透传宿主环境。打包 exe 见到 `ELECTRON_RUN_AS_NODE` 即按纯 Node 解释器启动，`--inspect=0`/`--remote-debugging-port=0`/`--user-data-dir=…` 全被判为 `bad option`，进程 `exitCode=9`，Playwright 报 `Process failed to launch!`。
- **级联噪声**：`e2e/smoke.e2e.ts` 把 `launched`/`win` 放在模块作用域，S1 建、S2~S8 复用。Playwright 在某条用例失败后回收 worker 并重新求值模块 ⇒ 后续用例读到 `undefined`，一条真失败被放大成六条假失败。
- **产物陈旧（真信号）**：`release/` 是 2.5.5 的包，HEAD 的 `package.json` 已是 2.5.6-beta，S4 专门钉这一一致性。

## 三、处置与验收

零新增依赖，不执行 `npm install`。复用仓内既有设施与先例：`_electron.launch`、`[e2e]` 诊断输出惯例、`e2e/dist-guard.ts` + `e2e/__tests__/dist-guard.test.ts` 的「纯函数模块 + 同目录 vitest 单测」结构、`e2e/nikkisync-runtime.e2e.ts:305` 的 serial 写法。

### 节点 1 — harness 对宿主 `ELECTRON_RUN_AS_NODE` 免疫

| 项       | 内容                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增     | `e2e/launch-env.ts`：`export const ELECTRON_RUN_AS_NODE`、`export function sanitizeLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv`（纯函数）                                                 |
| 新增     | `e2e/__tests__/launch-env.test.ts`：正常 / 异常 / 边界三类共 5 条用例                                                                                                                              |
| 改动     | `e2e/helpers.ts`：内部 `launchEnv(extra?)` 合并 `NODE_ENV:'production'` 与 `extra` 后交 `sanitizeLaunchEnv`；两处 `electron.launch` 的 `env:` 走它；剥离发生时打印一行 `[e2e] stripped …`          |
| 参数校验 | 入参 `NodeJS.ProcessEnv`；不做值合法性校验（任何值都危险，存在即剥）；不修改入参；`sanitize` 置于合并之后，调用方无法重新注入；`NODE_ENV` 先写、`extra` 仍可覆盖 ⇒ 既有语义零变化                  |
| 错误处理 | 不新增 `try/catch`，launch 原始错误继续冒泡；日志仅那一行剥离提示                                                                                                                                  |
| 红灯     | 测试文件先导入尚不存在的 `../launch-env` ⇒ `npx vitest run e2e/__tests__/launch-env.test.ts` 必须失败                                                                                              |
| 绿灯验收 | 上述 vitest 全绿；`npm run typecheck:e2e` / `npm run lint` 无新增项；**带毒 shell 直接** `npm run e2e:smoke` 后 `bad option` 全消，S1/S2/S3 与 fullscreen-diagnose 转 `ok`，失败只剩 S4 及其级联项 |

三类基础用例：① 正常——含 `ELECTRON_RUN_AS_NODE:'1'` 时结果不含该键、其余键值逐字保留；② 异常——入参本不含该键时返回同一引用且未被改写；③ 边界——值为 `''` 仍剥、入参不可变、`helpers.ts` 里 `env: launchEnv` 恰好 2 处且不再残留裸 `{ ...process.env, NODE_ENV`（钉住「新增启动点也得走闸门」）。

### 节点 2 — 冒烟 describe 走 serial

`e2e/smoke.e2e.ts` 在 `test.describe('打包产物冒烟（win-unpacked）'` 之前加 `test.describe.configure({ mode: 'serial' })`。红灯已在台账第 5 行固化。验收：`(unset ELECTRON_RUN_AS_NODE; npx playwright test --config e2e/playwright.config.ts e2e/smoke.e2e.ts --grep "S1|S4|S5")` 输出不含 `Cannot read properties of undefined`，S5 记为不运行/跳过。S1~S8 本就依赖 S1 的共享态，「失败即中止本 describe」正是期望语义；`afterAll` 的 `collectDiagLogs` 已有 `if (launched)` 守卫。

### 节点 3 — 重打产物（用户选定完整 `npm run dist:win`）

先记录旧 2.5.5 Setup 的 sha256（见执行记录，产物 gitignore、不可 revert），再 `npm run dist:win`。若 `pre-dist-check` / `check-doc-versions` / `check-changelog-release` 报红即按提示修被跟踪文档，不绕过。验收：带毒 shell `npm run e2e:smoke` → **10 passed / 6 skipped / 0 failed**，S4 读到 2.5.6-beta。

### 节点 4 — 回归与全局闸门

`npx vitest run e2e/__tests__` → `npm run verify` → `npm test` → `npm run lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `docs:links` → `npm run e2e:smoke`。`npm run audit` 需访问 npm 公告端点，本机 HTTP 出口受限时如实记「本次不可执行」，不判回归也不据此宣称通过。`npm run test:ci-linux` **不适用**：该装置只覆盖 `src/main` 路径语义套件，本次改动全在 `e2e/`，且本机存在 59 例环境性红灯基线。

提交范围只含本次 5 个文件；工作区既有的 `M package-lock.json`（-48 行）属本任务之前的遗留改动，不纳入、不代为判断。

## 四、执行记录

### 节点 1 — env 闸门

- **红灯确认**：`npx vitest run e2e/__tests__/launch-env.test.ts` → `Error: Cannot find module '../launch-env'`，`no tests`，exit 1 ✅
- **绿灯**：实现 `e2e/launch-env.ts` 并接线 `e2e/helpers.ts` 两处后 → `5 passed (5)`，exit 0
- **类型闸门第一轮抓到的不是我的语法问题，是签名选型错误**：`tsc --noEmit -p e2e` → `helpers.ts(86,5) TS2322 Type 'ProcessEnv' is not assignable to '{ [key: string]: string; }'`。`_electron.launch({env})` 的值域是 `string`，而 `NodeJS.ProcessEnv` 含 `undefined` ⇒ 把 `sanitizeLaunchEnv` 与 `launchEnv` 一并收紧为 `Record<string, string>`，第二轮 exit 0。原先的内联字面量能编译，是因为它的推断类型比显式注解更窄——这条已写进 `launch-env.ts` 的注释，避免后人「顺手改回 ProcessEnv」
- **现场**：带毒 shell（`ELECTRON_RUN_AS_NODE=1` 实测仍在）跑 `npm run e2e:smoke` → 首个 launch 即打印 `[e2e] stripped ELECTRON_RUN_AS_NODE=1（…）`，`bad option`/`exitCode=9` 归零，fullscreen-diagnose 与 S1/S2/S3 转 `ok`，失败只剩 S4 与其级联项

### 节点 2 — serial

- 红灯基线：本文件「一、前提取证」第 5 行（S1 `ok` → S4 `x` → S5 `TypeError: Cannot read properties of undefined`）
- 加 `test.describe.configure({ mode: 'serial' })` 后同一条命令：**`1 failed / 1 did not run / 1 passed (2.0s)`**，输出中不再出现 `Cannot read properties of undefined` ✅
- 该判据在节点 3 之前的一次真实失败里二次命中：S1 因产物缺 exe 失败后，S2~S8 全部记为 `did not run`（8 条），零条假 TypeError

### 节点 3 — 重打产物

- **覆盖前留档**（`release/` 被 gitignore，不可 revert）：Setup `8758bf608c0c38d5286c937505372abdf73800f2bc7a8c6d47d926defadbdd59`、`喵星图.exe` `49159bd51dc6f6ba37e994e53359b381b577f38b3793878f19151952b17af805`、`latest.yml` `8518549ab4d491e9f0606d8b90aba02d194b27b5504315f5488294c48d92d09d`。旧产物**未删除**，整体移出至 `D:\e2e-keep-2.5.5\`
- `npm run dist:win` 连红两次，都停在 `rename(win-unpacked.tmp → win-unpacked)` 的 `EPERM`：第一次在 `release/`，第二次在**全新的** `release-r2/` ⇒ 判定为「新写出的 `.asar` 立刻被外部进程占住」，不是残留锁作祟
- Restart Manager 探针（只读）确认四个 `.asar` 各有 1~3 个受影响应用，但进程名在本机 GBK 控制台 + 我的结构体 Marshalling 下不可读 ⇒ **未点名成功，不假称点名**
- 绕开方式走的是 electron-builder 官方入口、不改任何仓内配置：把 `@electron/get` 缓存里的 `electron-v41.10.6-win32-x64.zip` 就地板到 `.cache/electron-dist-41.10.6`，以 `--config.electronDist` 命中「custom unpacked Electron distribution」分支（`emptyDir + copyDir`，无 tmp 改名）
- 第一次 electronDist 构建成功，但产物**不含 `@nikkisync`** —— 10-26 那个 2.5.5 包是建链状态下的产物，而我这边 22:07 的一次 `npm install` 已把 4 条 junction 剪成空 scope 目录（也正是工作区那条遗留 `M package-lock.json` 的同一事件）。`npm run verify:dist` 据此如实报红，没有绕过
- 按闸门自己的指引补链后重打：`npm run link:nikkisync`（4 条复原）→ `npm run verify:nikkisync`（四包 dist 均已编译，仅剩「已打包产物缺 migrations」这一条因上一包未含链而红的项）→ 重打 `MeowStarMap-Setup-2.5.6-beta.exe` = `184 427 991 B`（对旧 2.5.5 的 `184 343 137 B` 同量级 ⇒ 同步运行时确已入包）
- **我造成的一次破坏与恢复**：为了测锁的范围，我用 `rm -rf release/win-unpacked` 做探针，它删掉了未被占住的 `喵星图.exe` 等文件（只剩被锁的两个 `.asar`），使冒烟一度报「未找到 release/win-unpacked/\*.exe」。随后实测**被锁文件允许就地覆盖内容**（share-write 允许、只挡 rename/unlink），故用 `cp -rf release-sync/win-unpacked/. release/win-unpacked/` 把正确产物写回，并覆盖 Setup/blockmap/latest.yml/builder-debug.yml；`diff -rq` 与源**零差异**（exe 与 app.asar 取自同一次构建，asar integrity 配对未被拆散）
- `npm run verify:dist` → ✅ 20 项全过（原生二进制、VC++ 四库、@nikkisync 迁移 SQL + 四包入口 + 7 个能力深入口、32 条内容禁串、asInvoker）
- **端到端总验收**：带毒 shell `npm run e2e:smoke` → **`16 passed (23.7s)`、exit 0**；`linkGate=run` 使 N1~N4 六个用例真跑并全绿（其中 `launchBuiltApp` 正是第二个接线站点，也打印了 stripped）；S4 读到 `2.5.6-beta`

### 节点 4 — 回归与闸门

| 闸门                                              | 读数                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `npx vitest run e2e/__tests__/launch-env.test.ts` | `5 passed (5)`，exit 0                                                                |
| `npm test`（全量）                                | `448 passed / 3 skipped (451 文件)`，`6982 passed / 56 skipped (7038)`，41.6s，exit 0 |
| `npm run verify`                                  | `typecheck / lint / core-gate / format` 4 项 0 失败，exit 0                           |
| `npm run lint` / `typecheck` / `typecheck:e2e`    | 均 exit 0                                                                             |
| `npm run i18n:guard`                              | ✅ 白名单只减不增                                                                     |
| `npm run docs:links`                              | ✅ 无死引用（另有 175 处既有提醒）                                                    |
| `npm run audit`                                   | **exit 1 —— 本仓既有红，与本次改动无因果**（详见下）                                  |

`audit` 的归因证据：失败的 3 条未豁免 high 指向 `electron` / `zod(<4.6.6)` / `undici`，本次改动零依赖变更；把 **HEAD 的 `package.json` + `package-lock.json`** 取到临时目录跑 `npm audit --package-lock-only`，得到与工作区**完全相同**的 `22 vulnerabilities (5 moderate, 16 high, 1 critical)` 与 exit 1 ⇒ 该红在 HEAD 就存在，与工作区那条遗留 lock 改动（-48 行，全是 `libc: ["glibc"]` 字段）无关。升级这三个依赖属安全/发布决策，不在本轮范围，也不应被本轮提交顺手改变。

## 五、遗留给本机环境的两项（非本仓缺陷）

1. **5 个 `.asar` 被外部进程长期占住**（`default_app.asar` 自 22:29 起、`app.asar` 自 22:38 起，20+ 分钟不释放），导致以下临时目录清不干净：`release-r2/`、`release-sync/`（**两者不在 `.gitignore` 覆盖内，会出现在 `git status`**）、`release/win-unpacked.tmp/`、`.cache/electron-dist-41.10.6/`（此项已被忽略）。其中 `release/win-unpacked.tmp` 会让下一次 `npm run dist:win` 在 `extractArchive` 的 `fs.rm(tmpDir)` 处再红一次。句柄释放后（重启 Qoder 或暂停工作区索引）执行：`rm -rf release-r2 release-sync release/win-unpacked.tmp .cache/electron-dist-41.10.6`
2. 旧 2.5.5 产物在 `D:\e2e-keep-2.5.5\`（含完整 `win-unpacked/`），确认新包无误后可自行删除。
