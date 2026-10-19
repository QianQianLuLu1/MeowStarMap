# 修复 `npm run e2e:smoke` 报错：`@nikkisync` 链接被 `npm install` 剪断，环境缺失被报成代码缺陷

日期：2026-10-19 ｜ 分支：`feat/gallery-runtime-embed` ｜ 版本：2.5.5-beta
状态：已完成，全部节点红→绿读数见文末「执行记录」
同族问题（先读它可省一轮取证）：`docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md`

## 1. 症状与定位入口

在本机项目根目录执行 `npm run e2e:smoke` 退出码 1，唯一失败是 NikkiSync **N1**，文案为「runtime state 未收敛为 running/degraded（说明启动链没跑或抛错逃逸）」。三条易误判的前提，逐一证伪：

- **不是产物被污染**：`dist/main/main/preload.js` 实测 28422 字节、`dist/main` 内 `*.d.ts` 计数 0，`e2e/dist-guard.ts` 的两个判据都不触发；上一轮那次 `tsc -b` 覆写问题与本条无关。
- **不是 S6 那类既有失败**：`smoke.e2e.ts` 的 S1–S7 与「userData 隔离」本轮全绿，失败点全在 `e2e/nikkisync-runtime.e2e.ts`。
- **不是 5 个新缺陷**：同文件 `test.describe.configure({ mode: 'serial' })` ⇒ N1 失败后 N2/N3/N3b/N3c/N4 报 "did not run"，是级联。

## 2. 取证（全部为实测读数，非推断）

| 项         | 读数                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失败断言   | `e2e/nikkisync-runtime.e2e.ts` 的 `expect.poll(state).toMatch(/^(running\|degraded)$/)` → `Received: "unavailable"`，30s 超时                                                                                              |
| 主进程日志 | `test-results/…N1…/main.log`：`[NIKKISYNC] nikkisync runtime unavailable: the @nikkisync/* links are not ready; run npm run link:nikkisync …`、`embedded runtime start result: state=unavailable linkReady=false tables=0` |
| 环境指纹   | `node_modules/@nikkisync/` 存在但**完全为空**；其 mtime 与 `node_modules` 同为当日 17:43；`package-lock.json` 未暂存改动为 `0 增 / 48 删` 的纯 `"libc"` 剥离 ⇒ 17:43 发生过 `npm install`                                  |
| 只读校验   | `npm run link:nikkisync:check` → 退出码 1、四行 `create`、`root=<同级>/NikkiSync source=sibling`；同级 NikkiSync 四包 `dist/` 齐全                                                                                         |
| 判据落点   | `hasNikkiSyncLink()`（`src/main/nikkisync/runtime-loader.ts`，按包内 `package.json` 可解析判定）为 false → `runtime-manager.ts` 的 `start()` 直接置 `state='unavailable'` 并写 `linkMissingHint`                           |
| 桥面透传   | `nikkisync:runtime-status` 的 handler 逐字返回 `runtime.status()`，`hint` 字段确实能到渲染层（不是被 zod 剥掉）                                                                                                            |

## 3. 根因（两条独立缺陷，不是一条）

1. **环境**：`npm install` 会剪掉 `node_modules/@nikkisync/*` junction——它们不是声明依赖，`src/main/nikkisync/AGENTS.md` §6 已把这一点写进约定。仓库自带的幂等修复命令就是 `npm run link:nikkisync`。
2. **代码**：N 套件没有按 §6 的既有约定做未建链门控。同一约定在仓内已被四处遵守——`src/main/nikkisync/probe.test.ts`、`runtime-facade.linked.test.ts`、`metadata-resolver.linked.test.ts`、`protocol-drift.test.ts` 都以 `hasNikkiSyncLink(projectRoot)` 整件 skip，`e2e/nikkisync-runtime.e2e.ts` 的 N3b 也按 `linkReady` 跳过服务面；**唯独 N1 硬断言状态机收敛**。于是环境缺失被报成逻辑失败（§6 明文禁止），且文案与实际原因相反：真实读数 `state=unavailable` + `linkMissingHint` 已躺在主进程日志里。

**为什么 CI 侧不能当作证据**：`.github/workflows/build.yml` 的 `E2E smoke test on win-unpacked` 之前从不建链，按读码推断 CI 上 N1 也会红——但**未经运行证实**：该 workflow 最近一次运行是 2026-10-11，早于 N 套件落地（2026-10-13），且列出的历史 run 全部 `conclusion=failure`，无法据此归因。本轮只把「CI 上未建链会 skip」这一事实打进日志，不改 CI 的链接策略。

## 4. 方案

- **节点 A（环境，零代码）**：`npm run link:nikkisync` 重建四条 junction，再用 `link:nikkisync:check` 与 `verify:nikkisync` 复验。不改 `package.json` 依赖段、不跑 `npm install`、不动 `build.files`。
- **节点 B（门控 + 真实文案）**：新增 `e2e/nikkisync-guard.ts`，形态完全对齐 `e2e/dist-guard.ts`（只做判定、不做修复、判据全在纯函数里、可单测）：
  - `decideNikkiSyncGate({ linked })` → `run` / `skip`，skip 的 reason 同时点名 `@nikkisync`、`npm run link:nikkisync`、`npm run verify:nikkisync`。判据刻意只取 `linked` 一项：**已建链时任何 `unavailable` 都是真实缺陷，必须继续报红**，不得在此降级为 skip（否则把真实回归藏进 skip，正是 §6 警告的另一半）。
  - `formatNikkiSyncStateDiagnostic({ state, linkReady, hint })` → 单行读数，替换 N1 里写死的那句反向文案。
  - `e2e/nikkisync-runtime.e2e.ts`：模块作用域算一次 `hasNikkiSyncLink(REPO_ROOT)`，`test.skip(gate.action === 'skip', gate.reason)` 置于 describe 内；N1 的 poll 改为在超时时用最后一次真实读数重抛（保留原 matcher 文本与 30s 上限）。其余断言逐字不动。
  - 跨层导入已核：`runtime-loader.ts` 只 import `node:fs`/`node:path`/`./embedding-paths`（后者也只 node 内置），变量式 `await import()` 在 `loadNikkiSyncPackage` 内部、`hasNikkiSyncLink` 不触达，故 e2e 静态导入它无副作用；`eslint.config.js` 的 `@nikkisync` 限制块作用域是 `src/main/**`，`e2e/**` 亦不在核心路径保护清单内。
- **节点 C（N2 判据改造）**：新增 `isUpstreamDbTouched(before, after)` 与 `DbSnapshot`。N2 原断言 `%LOCALAPPDATA%\NikkiSync\nikkisync.sqlite` **必须不存在**，而本机该文件由独立 NikkiSync exe 长期合法持有（实测 11894784 字节），嵌入态并没越界也恒判红。改为「N1 启动前取读数、N2 比对读数一致」，原意（嵌入态绝不写上游默认数据目录，见 §3 硬性约定）不但保留而且更强：**文件被删除同样判违规**。N1 内、`launchBuiltApp()` 之前取快照，窗口最窄。
- **节点 D（CI 可见性）**：`.github/workflows/build.yml` 在冒烟步骤前插入一步 `npm run verify:nikkisync`，只读、warn-only。依据：该脚本除「打包态 migrations」一项在未链接时也降为 warn 外全部 `level: 'warn'`，未链接 ⇒ 无 blocking fail ⇒ 退出码 0，不会新增红灯。
- **未改**：`src/**` 任何业务代码、`runtime-manager.ts` 的 `unavailable` 语义与 `linkMissingHint`、`e2e/dist-guard.ts` 及其调用点、`package.json` 脚本本体、S6 相关断言、本机 `%LOCALAPPDATA%` 下的用户数据。

## 5. 依赖声明

零新增依赖。不跑 `npm install`——那正是本轮故障的触发器（既剪 junction，又留下 `libc` 剥离的 lockfile churn）。节点 A 调用的是仓库自带脚本 `npm run link:nikkisync`。

## 6. 启动说明

```bash
# 前置：release/win-unpacked/*.exe 存在（S7 需要）；dist/main 为干净 electron-vite 产物；
#       同级 NikkiSync 四包已 npm run build
npm run link:nikkisync            # 节点 A
npm run link:nikkisync:check      # 期望 check OK / 退出码 0
npm run verify:nikkisync          # 期望无 ✖ / 退出码 0
npx vitest run e2e/__tests__/nikkisync-guard.test.ts
npm run typecheck:e2e
npm run e2e:smoke                 # 终态：不加 grep 也应全绿
```

判别式一条：`npm run e2e:smoke` 从「必须 `--grep-invert "@perf|N2 库落点"` 才 14 passed」变为**不加 grep 也全绿**（fullscreen-diagnose 1 + NikkiSync 6 + S 套件 8 = 15）。

## 7. 错误处理

- 门控只判定、不修复：未建链 ⇒ `test.skip` + 可执行 reason；已建链 ⇒ 一律继续断言。绝不为「让绿灯好拿」而放宽判据。
- `readUpstreamDbSnapshot()` 只把 ENOENT 归一为「不存在」；权限/占用等异常外抛——把「读不到」当成「没被写」会造出一条恒真的假断言。
- `isUpstreamDbTouched` 对非对象、字段缺失、`NaN`/`Infinity` 一律抛 `TypeError`（判据函数不猜，不把 `undefined` 当放行）。
- N1 poll 超时改为携带真实读数重抛，并用 `{ cause: error }` 保留原错误；原 matcher 文本一并附在末尾，不丢现场。
- `afterAll` 仍会 `collectDiagLogs`，失败时主进程日志继续进 artifact。

## 8. 参数校验

| 入参                         | 类型 / 必填                      | 非法值处理                                                                                                            |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `linked`                     | `boolean`，必填                  | 非真值（`undefined`/`null`/`0`/`''`）一律按未建链 ⇒ skip                                                              |
| `{ state, linkReady, hint }` | `string` / `boolean` / `string?` | `state` 非串或空串 ⇒ `state=<none>`；`hint` 非串或空串 ⇒ `hint=none`，绝不拼出 `undefined` 字样                       |
| `before` / `after`           | `DbSnapshot`，必填               | 非对象 ⇒ `TypeError`；`exists` 非布尔或 `mtimeMs`/`sizeBytes` 非 number ⇒ `TypeError`；`NaN`/`Infinity` ⇒ `TypeError` |
| CI 步骤                      | 固定 `npm run verify:nikkisync`  | 退出码由脚本自身决定；未链接 ⇒ 全 warn ⇒ 0，不阻断发布闸门                                                            |

## 9. 基础测试用例（`e2e/__tests__/nikkisync-guard.test.ts`，18 例）

- 正常：已建链 ⇒ `run`；两侧都不存在 ⇒ 未触碰；机器上本就存在且本次没动 ⇒ 未触碰；`state`/`linkReady`/`hint` 三项原样进单行文案；`running` + `linkReady=true` 也给出读数。
- 异常：未建链 ⇒ `skip` 且 reason 含两条修复命令；运行前不存在、运行后出现 ⇒ 已触碰；运行前存在、运行后消失 ⇒ 已触碰；mtime 变 / size 变 ⇒ 已触碰；非对象与缺字段与 `NaN` ⇒ `TypeError`。
- 边界：falsy 非布尔的 `linked` 仍 skip；reason 必须点名 `@nikkisync`；`hint` 缺省/空串/`undefined` 都不得拼出 `undefined`；`state` 缺省打 `<none>`；同一引用比较仍判未触碰；`exists:true` 且 `sizeBytes:0`（上游空库）仍按读数比较。

## 10. 执行记录（红 → 绿）

- **节点 A**：红——`link:nikkisync:check` 退出码 1、四行 `create`、`NOT linked (4 item(s) need action)`。执行 `npm run link:nikkisync` 后绿——退出码 0、`check OK (all four links in place)`、`ls` 见四条 symlink；`verify:nikkisync` **11 项全 ✔、blocking failures: 0、退出码 0**；`--grep "N1"` **1 passed (3.1s)**。至此用户报的那条报错已消失。
- **基线（仅恢复链接、未改码）**：`npm run e2e:smoke` → `10 passed / 1 failed / 4 did not run`，唯一失败是 N2「库落点」，`SMOKE_EXIT=1`。
- **节点 B 红**：新测试先落地、实现未落地 ⇒ `Error: Cannot find module '../nikkisync-guard'`，`Test Files 1 failed`、`Tests no tests`，退出码 1。实现后 ⇒ **8 passed**。
- **节点 B 判别力**：临时把 `decideNikkiSyncGate` 的判据改成 `if (input.linked || !input.linked)`（未建链也返回 run）⇒ **只有 2 条 skip 路径用例转红**（`Tests 2 failed | 6 passed`），逐字还原后 `grep` 残留计数 0、**8 passed**。
- **节点 B 门控生效**：临时把 e2e 的 `linked` 写成常量 `false` ⇒ `--grep "内嵌 NikkiSync"` 报 `linkGate=skip — 未建链：node_modules/@nikkisync/* junction 缺失…`、**6 skipped、退出码 0**；还原为 `hasNikkiSyncLink(REPO_ROOT)` ⇒ `linkGate=run`、N1 恢复执行。
- **节点 C 红**：追加 `isUpstreamDbTouched` 的 10 条用例、实现未落地 ⇒ `Tests 8 failed | 10 passed (18)`。实现后 ⇒ **18 passed**。
- **节点 C 接线判别力**：临时把 N1 的快照篡改成 `{ ...读数, mtimeMs: 1 }` ⇒ 全 N 套件 `1 failed`，失败文案为 `嵌入态改动了上游默认库：path=…before={"exists":true,"mtimeMs":1,"sizeBytes":11894784} after={"exists":true,"mtimeMs":1792310144048.6045,"sizeBytes":11894784}`；逐字还原 ⇒ **6 passed (5.0s)**，`grep MUT-N2` 残留 0。
- **节点 C 附带发现**：单独 `--grep "N2 库落点"` 会 skip——它依赖 N1 的读数，必须整族跑。改造前也是同样行为（旧断言同样依赖 `launched`/`status`），非本轮引入的回归。
- **typecheck:e2e**：首轮 `TC_EXIT=2`，`Number.isFinite` 不能把 `number | undefined` 收窄成 `number`；改为先 `typeof === 'number'` 再用 `Number.isFinite` 挡 `NaN`/`Infinity` ⇒ 退出码 0。
- **节点 D**：`npx vitest run scripts/__tests__/audit-config.test.ts` **19 passed**（该契约只断言 audit 步骤存在与无内联 allowlist，插入新 step 不触碰）；用 js-yaml 解析 `.github/workflows/build.yml` 得 build job 14 步，顺序为 `… NikkiSync link diagnostics (warn-only) → E2E smoke test on win-unpacked → Performance baseline regression …`。
- **行尾核对**：`git ls-files --eol` 显示 `build.yml` 在 **index 里本就是 `i/crlf`**（HEAD blob 实测 295 行 CRLF），与 `e2e/**` 的 `i/lf` 不同；本轮 `git diff --numstat` 为 `6 0`，即只增 6 行、未改写行尾。不改该文件行尾——它是历史既成事实，转换属无关格式化。
- **全局回归**：`npm test` → **422 个测试文件全绿（0 失败）、6499 passed | 2 skipped**（上一轮基线 421 个文件，本轮新增 `nikkisync-guard.test.ts` 成 422）；`npm run lint` EXIT=0（0 errors，11 warnings 全是既有 DEBT-030 的 `src/renderer/components/common/*.test.tsx` BOM）；`npm run typecheck` EXIT=0；`npm run typecheck:e2e` EXIT=0；`npm run i18n:guard` EXIT=0；`npm run docs:links` EXIT=0；`npm run verify` → typecheck / lint / core-gate / format / test **5 项 0 失败**。
- **落点隔离未被破坏**：跑完 `npm run typecheck` 与 `npm run verify` 之后 `dist/main/main/preload.js` 仍是 **28422 字节**、`dist/main` 内 `*.d.ts` 计数 **0**——上一轮把 `tsc -b` 的 emit 迁到 `.cache/tsmain` 的修复仍然有效，本轮没有把产物树重新污染。
- **新文档的死引用预判**：`npm run docs:links` 只扫 `git ls-files` 集合，未提交的新文档不在作用域内，因此它此刻的 EXIT=0 **不能**证明这份文档将来也是绿的。改用 `check-md-links.ts` 自己的 `extractRefs` + `classifyRef` 预演「三个新文件一起提交后」的判定 ⇒ **18 条引用全部 `ok`，dead=0**。另据 `isPathLike` 的 `PATH_LIKE_ROOTS`（只认 `docs/`、`src/`、`scripts/`、`e2e/`、`plugins-samples/`、`.github/`、`tests/` 开头），文中以裸文件名写的 `runtime-loader.ts`、`smoke.e2e.ts` 等根本不被当作引用，不构成死链。
- **终态**：`npm run e2e:smoke`（**不加任何 grep**）→ **15 passed (21.1s)、退出码 0**：fullscreen-diagnose 1 + NikkiSync 6（N1/N2/N3/N3b/N3c/N4）+ S 套件 8（S1–S7 与 userData 隔离，S6 本轮亦通过）。

## 11. 遗留与如实报告

- **S6「静置 5s 进程仍存活」仍是本机既有失败**：本轮实测通过，但它历史上会间歇让 `proc.exitCode` 由 `null` 变 `0`（干净退出、非崩溃）并级联 S7 与 userData 隔离。不改断言、不启用本地 retries（`e2e/playwright.config.ts` 的 `retries` 仅 CI 生效）。
- **N2 的原判据不是被「放宽」而是被替换**：`文件必须不存在` ⇒ `本次运行不得改动它`。若嵌入态真去写上游默认库，新判据照样报红（已用变异证实），且额外能抓出删除。
- **CI 的 N 套件覆盖面仍为 0（skip 而非红）**：本轮只加只读诊断，不给 CI 建链——那需要额外 checkout 同级 NikkiSync 并构建其 `dist/`，超出「修本机报错」的范围。§3 关于 CI 的表述是**按读码的推断，未经运行证实**。
- **`package-lock.json` 的 48 处 `libc` 剥离**是 `npm install` 的副作用，与本轮功能无关，按既有口径「还原不入仓」处理。
- 契约面：本轮不动 IPC 通道 / preload 方法签名 / `IpcResponse` / 错误码 / 主题变量 / i18n key，`docs/IPC_CONTRACT.md` 无需更新。改动文件均不在「核心路径保护」四清单内（`e2e/**`、`.github/**`、`docs/**`），无需 `@core-change` 授权注释。
- 本轮为取证临时写的两个脚本 `.cache/check-doc-paths.mjs` 与 `.cache/preview-doc-links.ts` 已删除、不入仓（`.cache/` 由 `.gitignore` 排除，且属 `check-md-links.ts` 的 artifact 前缀）；红→绿读数全部誊写进本节，不留可复跑探针。
- 入仓边界：`e2e/nikkisync-guard.ts`、`e2e/__tests__/nikkisync-guard.test.ts` 与本计划文档必须**同批提交**——§10 的死引用预演是按「三者都已被跟踪」做的，只提交文档会让 `e2e/nikkisync-guard.ts` 被判成待新增引用。
