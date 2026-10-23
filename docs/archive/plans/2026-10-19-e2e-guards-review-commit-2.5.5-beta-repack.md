# 未提交代码审查、CI e2e 类型闸门空档补口与 2.5.5-beta 重新打包（2026-10-19）

- 日期：2026-10-19
- 分支 / 基线 HEAD：`feat/gallery-runtime-embed` @ `8140a80`
- 状态：已执行完毕。审查与两处修复逐条红→绿见 §11.1 / §11.2，全量闸门与一处格式红灯见 §11.3，提交 1 见 §11.4（`514e8ab`），打包（含一次本机 EPERM 阻塞与仓内既定解法）见 §11.5，打包后两条 e2e 闸门见 §11.6
- 同族上一轮：`docs/plans/2026-10-19-grid-flicker-review-commit-2.5.5-beta-repack.md`（提交 `808926f` / `48603b9`）
- 本轮被审查的两项修复计划：`docs/plans/2026-10-19-fix-e2e-smoke-dist-pollution.md`、`docs/plans/2026-10-19-fix-e2e-smoke-nikkisync-links.md`

## 0. 背景（Context）

本轮请求是「审查所有未提交的代码并提交 → 版本号改为 2.5.5-beta → 重新打包」，并在审查报出既有空档后追加一项：**修复该空档**。三条前提先做只读取证，其中**两条不成立**，据实改道：

| 前提（请求的假设）                     | 取证命令                                                                                                                                                                                                                             | 现场输出                                                                                              | 判定                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 存在未提交代码                         | `git status --porcelain=v1`                                                                                                                                                                                                          | 17 项（14 暂存 / 3 未暂存 / 3 未跟踪）                                                                | **成立**，本轮主体                           |
| 版本号待改为 2.5.5-beta                | `git grep -n '"version"' -- package.json`；`node -e "require('./package-lock.json').packages[''].version"`；`git grep -n "getVersion: async" -- src/renderer/preview/mock/database-mock.ts`；`grep -n '^version' release/latest.yml` | 四处**全部**已是 `2.5.5-beta`（`package.json:3` / lock 根 / `database-mock.ts:664` / `latest.yml:1`） | **不成立，已达成 → 一处不改**                |
| 产物需重出                             | `release/NikkiGallery-Setup-2.5.5-beta.exe` mtime = 2026-10-19T04:54:06Z（本机 12:54），183332146 字节                                                                                                                               | 早于 HEAD `8140a80`（16:10）与本批未提交改动                                                          | **成立**（但见 §10「运行内容等价」）         |
| `package-lock.json` 是真实改动         | `git diff --numstat -- package-lock.json`                                                                                                                                                                                            | `0 增 / 48 删`，逐条为 `"libc"` 字段剥离                                                              | **不成立**：`npm install` 副作用，还原不入仓 |
| `@nikkisync` 链接被 `npm install` 清空 | 遍历 `node_modules/@nikkisync/*/package.json`                                                                                                                                                                                        | core / database / pc-companion / protocol 四包 `pkg.json= true`                                       | **不成立**，无需 `link:nikkisync`            |
| 本批代码当时是绿的                     | 两份计划文档 §10 执行记录；`npx vitest run scripts/__tests__/typecheck-emit-isolation.test.ts`                                                                                                                                       | 「状态：已完成」+ 逐节点红→绿；基线 **6 passed**、EXIT=0                                              | **成立**，仅未提交                           |
| `dist/main` 处于干净产物态             | `dist/main/main/preload.js` 字节数 + 全树 `.d.ts` 计数                                                                                                                                                                               | 28422 字节、`preload.d.ts` 不存在、`.d.ts` 计数 0                                                     | **成立**，基线可信                           |
| CI 从不类型检查 `e2e/`                 | 读 `pkg.scripts.typecheck` = `tsc -b && tsc -p tsconfig.scripts.json`；`grep -n typecheck .github/workflows/build.yml`                                                                                                               | 仅 1 处命中（`npm run typecheck`）；`typecheck:e2e` 不在任何 job 内                                   | **成立**，本轮修复项（§1.2）                 |
| 补上即可能让 CI 变红                   | `npx --no-install tsc --noEmit -p e2e`                                                                                                                                                                                               | **EXIT=0、0 行输出**                                                                                  | 不成立：e2e 侧当前无类型错误，可安全入门     |

## 1. 审查结论（逐条给证据）

### 1.1 通过项（不需要改动，附实测证据）

| 项                                                                  | 证据                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5 个新文件编码与行尾合规                                            | 逐文件读前 3 字节与 `\r\n` 计数：全部 no-bom、LF-only                                                                                                                                                                  |
| `vitest.config.ts` 新收 `./e2e/**/*.test.ts` 不会拖入从未跑过的用例 | `git ls-files 'e2e/**/*.test.ts'` 只返回 `dist-guard.test.ts` 与 `nikkisync-guard.test.ts` 两个本批新文件                                                                                                              |
| `e2e/nikkisync-runtime.e2e.ts` 静态导入主进程模块无副作用           | `hasNikkiSyncLink`（`src/main/nikkisync/runtime-loader.ts:203`）只 `existsSync` + `path.join`，`await import` 在 `loadNikkiSyncPackage` 内；本地 `tsc --noEmit -p e2e --listFiles` 的 307 个文件里 `@nikkisync` 命中 0 |
| N1 失败文案改造与 N2 判据替换的类型契约成立                         | `NikkiSyncRuntimeStatus`（`src/main/nikkisync/runtime-types.ts:28`）确有 `state` / `linkReady` / `error?` / `hint?`；e2e 局部 `RuntimeStatus`（同文件 :75）字段齐                                                      |
| `verify:nikkisync` 作为 warn-only CI 步骤不会新增红灯               | `scripts/verify-nikkisync-link.ts:238` `level: … !linked ? 'warn' : 'fail'`；:430 只把 `level ?? 'fail'` 为 fail 的失败计入 blocking；:449 `process.exit(blocking.length === 0 ? 0 : 1)`                               |
| 改动文件全部不在「核心路径保护」清单内                              | `PROTECTED_GLOBS` 只覆盖 `src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors` 四树                                                                                                |

### 1.2 本轮修的两项（各先红灯后改码）

**D1｜`emitTargetFor` 的 `sourceFile` 基准错配（路径二次拼接）**

`scripts/__tests__/typecheck-emit-isolation.test.ts` 的纯函数 `emitTargetFor(configDir, rootDir, outDir, sourceFile)` 三个路径入参本应同以 `configDir` 为基准（与 tsconfig 自身解析规则一致），但调用点把 `sourceFile` 按**仓库根**写成 `'src/main/preload.ts'`，而函数体内 `path.resolve(configDir, sourceFile)` 再解析一次 → 拼出 tsc 永不产出的形状。用 node 对真实 `src/main/tsconfig.json` 复算：

| 形态                             | 按现写法（基准错配）                       | 正确基准                          |
| -------------------------------- | ------------------------------------------ | --------------------------------- |
| 隔离态（outDir `.cache/tsmain`） | `.cache/tsmain/main/src/main/preload.d.ts` | `.cache/tsmain/main/preload.d.ts` |
| 覆写态（outDir `dist/main`）     | `dist/main/main/src/main/preload.d.ts`     | `dist/main/main/preload.d.ts`     |

影响面判定：主回归（outDir 搬回 `dist/main`）在两种写法下都落在产物树内，**原有守卫不是恒真假绿**；它没钉住的是 electron-vite 真实被覆写的那一个文件（`dist/main/main/preload.js` 的声明落点），且违背本函数自己的文档契约。修法为一行——调用点改传 `'preload.ts'`，并把这个基准写进 docstring；同时把两条断言从「在不在树里」钉到「完整落点等于什么」。

**D2｜CI 从不类型检查 `e2e/`（既有空档，用户裁定本轮一并修）**

`npm run typecheck` = `tsc -b && tsc -p tsconfig.scripts.json`：根 `tsconfig.json` 的 include 是 `src/renderer/**` 与 `src/common/**`、reference 是 `src/main`，`tsconfig.scripts.json` 只收 `scripts/` —— 两者都覆盖不到 `e2e/**`，而 `e2e/` 下是真实源码（`dist-guard.ts`、`nikkisync-guard.ts`、`helpers.ts`、各 `*.e2e.ts` 与其 `__tests__` 配套单测）。仓内已有 `typecheck:e2e`（`tsc --noEmit -p e2e`）却不在任何 job 里，所以这一层此前只靠本机手动跑。

修法：`.github/workflows/build.yml` 的 `lint-typecheck` job 在 `- run: npm run typecheck` 之后插入一步 `npm run typecheck:e2e`。刻意**不**把它折进 `npm run typecheck`——那要么给被 `references` 引用的 composite 项目塞 `--noEmit`（直接 TS6310），要么改掉本地 verify / pre-commit 已约定的 `tsc -b` 覆盖面口径。

### 1.3 登记但不修（不顺手扩大范围）

- `e2e/dist-guard.ts` 在 `preload.js` 整体缺失时返回 null：`npm run build` 必然产出该文件，且 `e2e/helpers.ts:157` 已对缺失的 `app/index.js` 抛错；为不可能态加校验属过度设计。**不改**。
- `detectTscOverwrittenDist` 内的局部变量名 `window`：`npx --no-install eslint e2e/dist-guard.ts` 实测 EXIT=0，无规则命中。**不改**。
- 两份已完成计划文档的执行记录：改它等于重开已被实测否证的读数。**不改**。
- `npm run typecheck:e2e` 未接入本地 `npm run verify` / `.husky/pre-commit`：本轮只补 CI 面，本地检查集不动（避免把 3 秒的 `tsc -b` 变成两次全量）。
- CI 上仍不给 NikkiSync 建链：N 套件在 CI 上依旧是 `linkGate=skip`，覆盖面为 0（见 §10）。
- S6「静置 5s 进程仍存活」是本机既有未定位失败，不改断言、不开本地 retries。
- 5 个既有测试文件里的 `expect(…click).not.toThrow()` 恒真写法（DEBT 类），属另起一轮。

## 2. 依赖声明

**零新增依赖**，`package.json` 依赖段未动，**全程未跑 `npm install`**（那正是 `libc` 剥离与 `@nikkisync` 链接被剪断的触发器）。复用清单：

| 复用项                                    | 位置                                                 | 用途                                                                                             |
| ----------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run typecheck:e2e`                   | `package.json` scripts（既有）                       | D2 新 CI 步骤的调用体，不在 workflow 里裸写 tsc 命令行                                           |
| CI 契约测试的「读文件 + `toContain`」形态 | `scripts/__tests__/audit-config.test.ts:247`         | D2 的红→绿断言沿用同形态，不引入 yaml 解析依赖                                                   |
| 类型检查调用点契约套件                    | `scripts/__tests__/typecheck-emit-isolation.test.ts` | D1、D2 同处扩展；**未新建测试文件**，避免 `scripts/AGENTS.md` 的入仓文件计数与测试表三处同时失真 |

## 3. 启动与运行说明

```bash
git restore package-lock.json                    # 还原 libc churn（不入仓）
npx --no-install tsc --noEmit -p e2e             # 基线：EXIT=0
npx --no-install vitest run scripts/__tests__/typecheck-emit-isolation.test.ts   # 基线 6 passed
# D1 / D2：先红灯 → 改码 → 转绿 → 跑相关子集（读数见 §11.1 / §11.2）
npm test ; npm run lint ; npm run typecheck ; npm run typecheck:e2e
npm run i18n:guard ; npm run docs:links ; npm run preview:check ; npm run audit   # docs:links 须在 git add 之后
npm run dist:win      > .cache/gates/pack.txt   2>&1; echo "PACK_EXIT=$?"   >> .cache/gates/exits.txt
npm run e2e:smoke     > .cache/gates/smoke.txt  2>&1; echo "SMOKE_EXIT=$?"  >> .cache/gates/exits.txt
npm run e2e:perf      > .cache/gates/perf.txt   2>&1; echo "PERF_EXIT=$?"   >> .cache/gates/exits.txt
```

判别式三条：① D1/D2 两条新断言在改码前必须红；② 补完 CI 步骤后 `npm run typecheck:e2e` 仍 EXIT=0 且 `git diff --numstat -- .github/workflows/build.yml` 第二列为 0；③ 打包后 `.cache/gates/smoke.txt` 必须出现 `[e2e-nikkisync] linkGate=run`——出现 `skip` 时「6 skipped + 退出码 0」是**无覆盖**，不得当绿灯。

## 4. 错误处理

- **红灯未出现即判测试无效**：D1/D2 若加断言后仍绿，按硬性口径重写断言而不是直接改实现；D1 的期望值一律由 `SANCTIONED_EMIT_ROOT` / `VITE_ARTIFACT_TREE` 常量拼装，禁止用 `emitTargetFor` 的返回值反推期望（会退化成恒真比较）。
- **加固断言的判别力用临时变异证明**：D1 的第二条断言（覆写态精确落点）面对的是「基准约定」而非现网缺陷，天然直接绿；故把函数体 `absSource` 的基准由 `configDir` 篡改为 `repoRoot`（标记 `MUT-D1-BASIS`），确认只有两条新断言转红、其余不动，再逐字还原并 grep 残留计数 0。
- **`build.yml` 行尾**：该文件 `i/crlf w/crlf`，且 yml 不在 prettier / lint-staged 作用域内，闸门不会替我挡。判定用两个独立读数：CRLF 行数与裸 LF 行数（必须恒 0），加 `git diff --numstat` 只增不删。
- **新 CI 步骤的 CI 侧风险**：本地 `--listFiles` 307 个文件中 `@nikkisync` 命中 0、仓库内 `dist/` 与 `release/` 命中 0（21 处 `dist/` 全是 node_modules 依赖自带的 `.d.ts`），故该步在 CI 上不依赖 build 产物也不依赖建链，`npm ci` 后即可跑。若 CI 仍红，只如实报告并保留，不放宽 e2e 覆盖面。
- **shell 包装层的假信号**（本轮现场命中一次）：`grep -c "MUT-D1-BASIS" <file>` 在**无匹配**时退出码为 1，用 `&&` 串起来的后续 `vitest` 整条被截断、`$?` 读到的 1 与「测试失败」无关，输出文件也因此不存在。判定链一律用 `;` 分隔并让每条命令自己 `echo EXIT=$?`。
- **长任务退出码**：先把真实 `$?` 写进文件再读，不经 `tee` / `tail` 管道，避免失败被包装成 exit 0。
- `dist:win` 若在 `check-changelog-release` 处红 ⇒ 补录写进了 `[Unreleased]`，移回 `## [2.5.5-beta]` 节的 `> 2026-10-19 追加：…` 引用块。
- S6 若红并级联 S7 / userData 隔离：按未定位既有失败如实报告，不改断言、不弱化、不删用户数据。

## 5. 参数校验

| 入参                                                                 | 类型 / 必填                       | 非法值处理                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `emitTargetFor` 的 `configDir` / `rootDir` / `outDir` / `sourceFile` | 四个 `string`，均必填             | 统一以 `configDir` 为基准（已写进 docstring）；`outDir` 缺失为 `''` 时 `path.resolve` 落到 configDir，会先被既有的 `expect(outDir).not.toBe('')` 拦住 |
| D1 新增断言的期望值                                                  | `string`，由常量拼装              | 禁止由被测函数自产期望；覆写态断言写死 `` `${VITE_ARTIFACT_TREE}/main/preload.d.ts` ``                                                                |
| `pkg.scripts['typecheck:e2e']`                                       | `string`，取自 `package.json`     | 缺失为 `undefined` → `?? ''` 后 `toContain('-p e2e')` 直接红，不静默放行                                                                              |
| `pkg.scripts.typecheck`                                              | `string`                          | 断言其**不含** `--noEmit`，堵住「把 e2e 折进 typecheck」这条会撞 TS6310 的歧路                                                                        |
| build.yml 新步骤                                                     | 固定 `run: npm run typecheck:e2e` | 只增 8 行、不重排既有步骤；`audit-config.test.ts` 的三条断言（引用 `./audit-ci.jsonc`、无 `--allowlist`、无 `GHSA-`）实测不受影响                     |

## 6. 基础测试用例（三类齐备，全部落在 `scripts/__tests__/typecheck-emit-isolation.test.ts`）

- 正常：隔离态下 `preload.ts` 的类型检查产物必须等于 `.cache/tsmain/main/preload.d.ts`，且不得落进 `dist/main`。
- 异常：outDir 回到 `dist/main` 时必须精确命中 `dist/main/main/preload.d.ts`（覆写的那一个文件）；CI workflow 必须包含 `npm run typecheck:e2e` 这一步，且 `typecheck` 脚本不得被塞进 `--noEmit`。
- 边界：既有 5 条继续生效（落点判定的四种形态、隔离目录必须等于约定值、`tsconfig.json` 保持严格 JSON 可解析、`dist/main` 存在时不得残留 `.d.ts`、三处 `tsc -b` 调用点不得被删）。

## 7. 子任务拆分（每项：涉及文件 / 输入输出 / 验收标准）

| #   | 涉及文件                                                                                   | 输入 → 输出                                                                                          | 验收标准（可判定）                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | `package-lock.json`、`.cache/*` 探针                                                       | 未暂存的 48 处 `libc` 剥离 → 还原；探针文件 → 删除                                                   | `git diff --numstat -- package-lock.json` 空输出；`git status --porcelain` 不再含该文件                                                                                                   |
| N2  | `scripts/__tests__/typecheck-emit-isolation.test.ts`（D1）                                 | 追加两条精确落点断言 → 调用点 `'src/main/preload.ts'` 改 `'preload.ts'` + docstring 写明基准         | 改码前 1 failed / EXIT=1 且 received 含 `main/src/main`；改码后 7 passed / EXIT=0；变异复现 `2 failed \| 5 passed` 且还原后残留计数 0                                                     |
| N3  | `scripts/__tests__/typecheck-emit-isolation.test.ts` + `.github/workflows/build.yml`（D2） | 新增「闸门覆盖面」用例 → workflow `lint-typecheck` job 插一步 `npm run typecheck:e2e`（含 8 行注释） | 加断言后未改 yml 前 1 failed / EXIT=1；改后 8 passed；`audit-config.test.ts` 19 passed；`tsc --noEmit -p e2e` EXIT=0；build.yml 裸 LF 行恒 0、numstat 第二列 0                            |
| N4  | `AGENTS.md`、`docs/CODING_CONVENTIONS.md`、`.qoder/rules/project-conventions.md`           | CI 覆盖面口径补 `typecheck:e2e` 与「不得折进 typecheck」；本地镜像同步                               | `prettier --check --end-of-line auto AGENTS.md CHANGELOG.md` EXIT=0；镜像与真相源「校验与提交」节逐字一致（脚本比对 6 条 vs 6 条 identical）                                              |
| N5  | 本文件                                                                                     | 台账、审查结论、红→绿读数入仓                                                                        | `git add` 后 `npm run docs:links` EXIT=0、dead=0                                                                                                                                          |
| N6  | 全量闸门                                                                                   | 只读回归                                                                                             | `npm test` / `lint` / `typecheck` / `typecheck:e2e` / `i18n:guard` / `preview:check` / `audit` 全 EXIT=0，无新增失败项                                                                    |
| N7  | 提交 1                                                                                     | 本批全部改动（排除 lock）→ `fix(e2e): …`                                                             | `[PRE-COMMIT]` 三步 PASSED；提交后 `dist/main` 仍 28422 字节 / 0 `.d.ts`；`git show --stat HEAD` 不含 `package-lock`                                                                      |
| N8  | `CHANGELOG.md` + 本文件 → 打包 → 提交 2                                                    | `[2.5.5-beta]` 节补录 → `dist:win` → `e2e:smoke` / `e2e:perf` → `chore(release): …`                  | `PACK_EXIT=0`、`verify:dist` 通过、exe mtime 刷新且字节数入档；`.cache/gates/smoke.txt` 含 `linkGate=run`；提交 2 只暂存 `.md`（钩子跳过 `tsc -b`）；提交后 `git status --porcelain` 为空 |

## 8. 验证与自测顺序

N1 → N2 红 → N2 绿 → N2 子集（46 passed）→ N3 红 → N3 绿 → N3 复验 → N4 → N6 → N5/N7（`docs:links` 须在 `git add` 之后）→ N8。所有含 `tsc -b` 的步骤一律排在 `dist:win` 之前；打包后不再跑任何 `tsc -b`（提交 2 只暂存 `.md`，钩子 Step 3 自然跳过）。

## 9. 交付说明要点

- 契约面：本轮不动 IPC 通道 / preload 方法签名 / `IpcResponse` / 错误码 / 主题变量 / i18n key，`docs/IPC_CONTRACT.md` 无需更新（`npm run i18n:guard` 复验）。
- 受保护路径：改动全部落在 `e2e/**`、`scripts/**`、`src/main/tsconfig.json`、`vitest.config.ts`、`.github/**`、`docs/**` 与根 md，均不在四清单内，无需 `@core-change` 授权注释。
- 提交拆分沿用本仓口径：`fix(e2e): …`（代码 + 审查修复 + 三份计划文档）→ `chore(release): 2.5.5-beta 补录…并据此重新打包`（CHANGELOG + 打包读数）。
- 版本号：**一处未改**，四处声明位实测已是 `2.5.5-beta`。

## 10. 未纳入本轮的既有事实（避免误读为已处理）

- **安装包运行内容不变**：本批改动全在开发期闸门 / 工具层，`src/**` 业务代码一行未动，`build.files` 仍只取 `dist/**` 与 `resources/**`，新落点 `.cache/tsmain` 不进 asar ⇒ 重打包产物与 12:54 那个在运行内容上等价，只有时间戳与哈希变化。经用户确认仍照旧重打包、旧包直接覆盖不备份。
- **CI 的 N 套件覆盖面仍为 0**：CI 不给 `@nikkisync` 建链，门控生效后是 skip 而非红；本轮只补了只读诊断与类型闸门。
- **`typecheck:e2e` 未进本地 verify / pre-commit**：只补 CI 面，本机仍需手动跑（本轮已跑，见 §11.2）。
- **S6 / S7 级联**：本机既有未定位失败，与产物无关，本轮只报告读数。

## 11. 执行记录（逐项回填实测读数）

### 11.1 N2｜D1 红→绿（`emitTargetFor` 基准错配）

- 基线：`npx --no-install vitest run scripts/__tests__/typecheck-emit-isolation.test.ts` → **6 passed**、EXIT=0。
- 红灯（加断言、未改实现）：**1 failed \| 6 passed (7)**、EXIT=1，`AssertionError: expected '.cache/tsmain/main/src/main/preload.d…' to be '.cache/tsmain/main/preload.d.ts'`。
- 绿灯（调用点 `'src/main/preload.ts'` → `'preload.ts'`）：**7 passed**、EXIT=0。
- 判别力变异：`absSource = path.resolve(repoRoot, sourceFile)`（标记 `MUT-D1-BASIS`）→ **2 failed \| 5 passed (7)**，读数 `expected '.cache/preload.d.ts' to be '.cache/tsmain/main/preload.d.ts'` 与 `expected 'dist/preload.d.ts' to be 'dist/main/main/preload.d.ts'`，其余 5 条不动 ⇒ 两条新断言都有判别力。逐字还原后 `grep -c MUT-D1-BASIS` = **0**。
- 相关子集：`vitest run` 四份（本文件 + `pre-dist-check.test.ts` + `e2e/__tests__/dist-guard.test.ts` + `e2e/__tests__/nikkisync-guard.test.ts`）→ **4 files / 46 passed**、SUBSET_EXIT=0。
- 格式与静态：`prettier --check --end-of-line auto` 首轮 warn（98 字符的调用被要求折成单行）→ `--write` 后 RECHECK_EXIT=0；`eslint` 该文件 EXIT=0；文件仍 no-bom、LF-only（145 行裸 LF、0 行 CRLF）。
- 产物未被污染：`dist/main/main/preload.js` 仍 **28422 字节**、`dist/main` 全树 `.d.ts` 计数 **0**。
- 附一条包装层假信号（记入口径）：`grep -rc "MUT-D1-BASIS"` 无匹配时退出码 1，把 `&&` 后面的 vitest 整条截断，首轮 `SUBSET_EXIT=1` 且输出文件不存在——那是 grep 的状态，不是测试失败。改 `;` 分隔后取到真实 EXIT=0。

### 11.2 N3｜D2 红→绿（CI 补 `e2e` 类型闸门）

- 基线：`npx --no-install tsc --noEmit -p e2e` → **EXIT=0、0 字节输出**（e2e 侧当前无类型错误，补步骤不会落地即红）。
- 红灯（加用例、未改 yml）：**1 failed \| 7 passed (8)**、EXIT=1，`AssertionError: expected 'name: Build & Release\r\n…' to contain 'npm run typecheck:e2e'` —— 失败本身即空档的现场证据。
- 绿灯（`lint-typecheck` job 插入一步 + 6 行中文注释）：`typecheck-emit-isolation.test.ts`(8) + `audit-config.test.ts`(19) → **2 files / 27 passed**、EXIT=0。
- 行尾双证：编辑前后 CRLF 行 **301 → 309**（净增 8 行），裸 LF 行 **0 → 0**；`git diff --numstat` = **`14 0`**（本批累计只增不删，另 6 行为上一节点已获批的 warn-only 诊断步骤）；`git ls-files --eol` 仍 `i/crlf w/crlf`。
- 不依赖 build / 建链的证据：`tsc --noEmit -p e2e --listFiles` → 307 个文件，`@nikkisync` 命中 **0**，`/dist/` 命中 21 但逐条核对全属 `node_modules/**/dist/*.d.ts`（fdir、tinyglobby、vite、vitest、expect-type 等），仓库内 `dist/` 与 `release/` 命中 **0**。
- `npm run typecheck` 覆盖面**未变**（`package.json` 未改，仍 `tsc -b && tsc -p tsconfig.scripts.json`），本地 verify / pre-commit 的 `tsc -b` 步骤口径不受影响。

### 11.3 N6｜全量闸门与提交前只读闸门（含一处格式红灯）

- 全量只读闸门七项，逐条取真实退出码，全部 **EXIT=0**：`npm test` → **422 个测试文件全绿、6501 passed \| 2 skipped**（上轮基线 6499，本轮 D1/D2 各加 1 条用例 ⇒ +2 吻合）；`npm run lint` → 0 errors、11 warnings（全是既有 DEBT-030 的 `src/renderer/components/common/*.test.tsx` BOM）；`npm run typecheck` / `npm run typecheck:e2e` / `npm run i18n:guard` / `npm run preview:check` / `npm run audit` 均 0。
- 落点隔离在全量 `typecheck` 之后仍然成立：`dist/main/main/preload.js` 仍 **28422 字节**、`dist/main` 全树 `.d.ts` 计数 **0**，而 `.cache/tsmain` 收了 **277** 个声明产物 —— 本批 outDir 迁移在真实闸门链上复验通过。
- **红灯（本轮审查抓出的第二项，属格式闸门）**：`npm run docs:links` EXIT=0（无死引用，另有 143 处既有类别提醒），但 `npm run verify:staged` 首轮 **`format` ✗ / VERIFY_STAGED_EXIT=1**，唯一未过项是 `e2e/__tests__/nikkisync-guard.test.ts` 不符合 prettier（68 行起被手工折行，与 prettier 的换行算法不一致）。
  - **为什么上一轮的「verify 5 项 0 失败」没抓到它**：`scripts/verify-changes.ts` 的默认目标取自 `git diff HEAD`，**未跟踪文件不在这个集合里**；该测试文件在上轮全程处于 `??` 状态，所以它的格式从未进入过闸门。本轮 `git add` 之后才暴露 —— 这条差异（verify 绿灯 ≠ 未跟踪文件已被检查）应记进口径。
  - 处置：`prettier --write` 该文件（WRITE_EXIT=0），复跑 `vitest run e2e/__tests__/nikkisync-guard.test.ts` → **18 passed / EXIT=0**；文件仍 no-bom、LF-only（153 行裸 LF、0 行 CRLF）。重新暂存后 `npm run verify:staged` → typecheck / lint / core-gate / format(13 文件) / test **5 项 0 失败**、EXIT=0。
  - 4 条 `[VERIFY] ⚠ 缺少匹配套件`（`e2e/helpers.ts`、`scripts/verify-changes.ts`、`vitest.config.ts`、`e2e/nikkisync-runtime.e2e.ts`）为既有非阻断提示，本批未新增。

### 11.4 N7｜提交 1

- 提交号 **`514e8ab`**，`20 files changed, 1143 insertions(+), 45 deletions(-)`，头一行 `fix(e2e): 产物与链接双守卫接入闸门，并补 CI 的 e2e 类型检查覆盖面`。
- `[PRE-COMMIT]` 三步全 PASSED：Step 1 lint-staged（`e2e/**/*.{ts,tsx}` 命中 6 files、`package.json` 20 files）、Step 2 core-gate `⊘ 本次变更不涉及核心路径受保护文件`、Step 3 `tsc -b`。
- **本批 outDir 隔离在真实提交链上的复验**：钩子跑完 `tsc -b` 之后 `dist/main/main/preload.js` 仍 **28422 字节**、`dist/main` 内 `.d.ts` 计数 **0** —— 这正是本批要消除的污染，如今不再发生。
- lockfile 未入仓：`git show --stat HEAD` 的文件清单里没有 `package-lock.json`；提交后 `git status --porcelain` 为空。
- 附带观察：`scripts/AGENTS.md` 被钩子的 `prettier --write` 重新对齐了表格列宽（11 行），属该文件既定的格式化行为，非语义改动。

### 11.5 N8｜打包读数（含一次本机环境阻塞与仓内既定解法）

- 补录前先跑收口闸门：`npx --no-install tsx scripts/check-changelog-release.ts` → 解析到 12 个版本节、`[2.5.5-beta]` 存在且唯一、`[Unreleased]` 已收口、**EXIT=0**；`prettier --check --end-of-line auto CHANGELOG.md` EXIT=0。
- **第一次 `npm run dist:win` 失败：PACK_EXIT=1**。后台包装层报的是「completed (exit code 0)」——那是包装命令的状态，真实码取自 `exits.txt`（既有口径）。`npm run build` 与 `pre-dist-check` 全过（**26 项 ✔**），失败在 electron-builder 的 `prepareApplicationStageDirectory`：
  `⨯ EPERM: operation not permitted, rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'`（栈经 `electronGet.ts:249 extractArchive` → `ElectronFramework.ts:254 unpack`）。
- 定位读数：`.tmp` 内 21 项 / 75 文件 / **361,039,014 字节**（Electron 已完整解出）；目录**内单个文件改名 OK**、子树删除 OK；等待 45s 复探目录改名仍 EPERM；无任何 builder / electron / 7za / node 残留进程占用该路径；`Get-CimInstance root/SecurityCenter2` 显示杀软为 Windows Defender。
- **与 2026-10-18 那次的区别（须如实记）**：该次留档（`docs/plans/2026-10-18-uncommitted-review-commit-2.5.5-beta-repack.md` §8.1）的结论是「本机拦截 Node 进程内的目录 rename，PowerShell 改名可行」；本轮 PowerShell `Rename-Item` **同样被拒**，原因是我为清理而执行的递归删除已把该目录推进 delete-pending 态 —— 这是我处置过程的次生效应，不是初始病因，也说明「移走/删掉再重跑」对本类拦截无效（与该文档的 How to apply 一致）。
- **复用仓内既定解法**（同文档 §8.1）：`npx electron-builder --win --publish never --config.electronDist=node_modules/electron/dist` ⇒ 日志走 `using custom unpacked Electron distribution` + `copying unpacked Electron`（复制本地已解包 dist，不再「下载 zip → 解压 → rename」），**PACK2_EXIT=0**。该覆盖只用于本次命令行，**未写入 `package.json`**，避免把本机环境规避固化进产物配置（同 §8.1 的最小改动口径）。
- 产物：`NikkiGallery-Setup-2.5.5-beta.exe` **183,415,300** 字节、mtime `2026-10-19T12:41:49.833Z`（旧为 183,332,146 / `04:54:06Z`，按既定口径直接覆盖不备份）；`latest.yml` 与 `.blockmap` 同步刷新；`release/win-unpacked` 为本次新建。
- 顺手清掉 `release/alt-stage`（2026-10-17 失败残留）。必要性：`findAsarUnpacked` 取**首个**命中且 `alt-stage` 字典序排在 `win-unpacked` 之前，留着它 `verify:dist` 会校验错树（该 hazard 已在 `docs/plans/2026-10-19-grid-flicker-review-commit-2.5.5-beta-repack.md` §4 登记）。清理前先模拟选取逻辑确认 `_backup-2.5.3-*` 内只有安装包、不含 `app.asar.unpacked`，不构成同类风险。
- `npm run verify:dist` → **EXIT=0、17 项全 ✔**，校验树确认为 `release\win-unpacked\resources\app.asar.unpacked`（@nikkisync 四包入口 + `0001_initial.sql` + `LocalSyncServer.js` / `GalleryRuntime.mjs` 深入口 + 四个 VC++ 运行库 + better_sqlite3 / sharp / libvips / koffi + `requestedExecutionLevel=asInvoker`）。
- 残留：`release/win-unpacked.tmp`（内容已被清、目录本体处于 delete-pending，在 `.gitignore` 的 `release/` 下不入仓，句柄释放或重启后可删）。
- 打包后 `dist/main/main/preload.js` 仍 **28422 字节**、无 `preload.d.ts`。

### 11.6 N8｜打包后闸门

- `npm run e2e:smoke` → **SMOKE_EXIT=0、15 passed (26.1s)**：`fullscreen-diagnose` 1 + N1/N2/N3/N3b/N3c/N4 六条 + S1–S7 与「userData 隔离」八条。**S6 本轮通过**（仍是本机既有间歇失败，只报告不处理）。
- 三条关键读数：`[e2e-nikkisync] linkGate=run — @nikkisync 链接就绪` ⇒ N 套件确实跑到了覆盖面而非 skip；`[e2e-nikkisync] gameRoot=H:\InfinityNikki Launcher\InfinityNikki`；`[e2e] executable: …/release/win-unpacked/无限暖暖相册管理工具.exe` ⇒ S 套件测的确实是**本次新产物**（不是 12:54 的旧包）。
- 口径区分：N 套件走 `launchBuiltApp()` 加载未打包的 `dist/main`，其读数**不等于**安装包复验；安装包本体由 `launchApp()` 的 S 套件覆盖。
- `npm run e2e:perf` → **PERF_EXIT=0、10 passed | 8 skipped (7.2s)**；8 条 skip 全为 `@perf-real` R1–R5，判据是 `e2e/perf-real.e2e.ts:320` 的 `test.skip(!SOURCE_USER_DATA, '需设置 PERF_REAL_USERDATA 指向本机 userData 目录')` —— 既有 opt-in 门控，非本轮引入，也未据此判红。

### 11.7 探针与临时件

- 本轮取证与验证临时写的输出件：`.cache/e2e-typecheck-probe.txt`、`.cache/base-*.txt`、`.cache/d1-*.txt`、`.cache/d2-*.txt`、`.cache/fmt*.txt`、`.cache/cc.txt`、`.cache/mc.txt`、`.cache/gates/*.txt`（七项闸门、docs:links、两轮 verify:staged 的原始输出），验证后已删除、不入仓（`.cache/` 由 `.gitignore:26` 排除）；打包与打包后的日志同样只落 `.cache/gates/`，读数已全部誊写进 §11.5 / §11.6，仓库根不留下任何 `.log`。
