# 修复 `npm run e2e:smoke` 报错：`tsc -b` 覆写 electron-vite 产物导致 NikkiSync N1 假失败

日期：2026-10-19 ｜ 分支：`feat/gallery-runtime-embed` ｜ 版本：2.5.5-beta
状态：已完成，全部节点红→绿读数见文末「执行记录」

## 1. 症状与定位入口

在本机项目根目录执行 `npm run e2e:smoke` 退出码 1。三条容易误判的前提，逐一证伪：

- **不是打包冒烟失败**：`e2e:smoke` = `playwright test --config e2e/playwright.config.ts --grep-invert @perf`，配合 `testMatch: '*.e2e.ts'`，实际选中 **三个** 文件——`smoke.e2e.ts`、`nikkisync-runtime.e2e.ts`、`fullscreen-diagnose.e2e.ts`（只排除 `@perf`）。失败的是 NikkiSync N1，S1–S7 与「userData 隔离」全绿。
- **不需要 dev server / 测试地址**：打包冒烟经 `launchApp()` 起 `release/win-unpacked/无限暖暖相册管理工具.exe`（`NODE_ENV=production`，走 `app://` 特权协议）；NikkiSync 经 `launchBuiltApp()` 用仓内 electron 直接加载 **未打包** 的 `dist/main/main/app/index.js`。两者都不监听端口。
- **不是依赖/Node/链接问题**：Node 26.3.0、`@playwright/test` 1.62.1、`playwright` 1.62.1、`tsx` 4.23.1 均与 `package.json` 声明一致；`--grep-invert` 是合法参数；`npm run verify:nikkisync` 11 项全 ✔（四条 `@nikkisync/*` junction 完好、四包 dist 齐全）；工作树 `git status --porcelain` 为空。

## 2. 取证（全部为实测读数，非推断）

| 项                   | 读数                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 失败断言             | `e2e/nikkisync-runtime.e2e.ts:294` `expect(bridgeType).toBe('function')` → `Expected: "function" / Received: "undefined"`                                                                                                                                                                                                                            |
| 级联范围             | 同文件 `:265` `test.describe.configure({ mode: 'serial' })` ⇒ N2/N3/N3b/N4 报 "did not run"，不是 4 个新缺陷                                                                                                                                                                                                                                         |
| 运行日志（主进程）   | `[NIKKISYNC] nikkisync runtime assembly failed: … require() cannot be used on an ESM graph with top-level await … From D:\…\dist\main\main\nikkisync\runtime-loader.js`；`[Fault:rendererError] [fetchMediaFromDatabase] electronAPI 不可用: media.list=false, category.list=false`                                                                  |
| 被执行的 loader 形态 | `dist/main/main/nikkisync/runtime-loader.js`（tsc per-file CJS，内含 `__importStar(require(s))`）；而 electron-vite 的 `dist/main/main/app/runtime-loader.js` 保留 `await import(`                                                                                                                                                                   |
| 产物形态             | 污染态 `dist/main/main/preload.js` = 9513 字节、首行 `"use strict"; Object.defineProperty(exports, "__esModule", { value: true });`、`require("./preload/api/*")` 跨文件、同目录多出 `preload.d.ts` / `preload.js.map`；干净态 = 28422 字节、首行 `"use strict"; const electron = require("electron");`、无相对 require、无 `__esModule`、无 `.d.ts` |
| mtime 分桶           | 15:09–15:12 写入 37 个文件（`npm run build`），15:13–15:16 写入 844 个文件（一次 `tsc -b` 全量覆写）                                                                                                                                                                                                                                                 |
| 消费点               | `src/main/app/window-manager.ts:67` 按 `__dirname/../preload.js` 取 preload；`:70` `sandbox: true`                                                                                                                                                                                                                                                   |

## 3. 根因

`src/main/tsconfig.json` 的 `outDir` 是 `../../dist/main`，而 electron-vite 的 main 产物在 `dist/main/main/app/*`、preload 在 `dist/main/main/preload.js`——**两套构建器写同一棵树**（`scripts/pre-dist-check.ts:23-31` 早已把这一点写进注释，并以「放宽检索作用域」的方式容忍它）。`tsc -b` 有三个调用点：`package.json:47` 的 `typecheck`、`scripts/verify-changes.ts:115`（`npm run verify`）、`.husky/pre-commit` Step 3。任何一次类型检查都会把 rollup bundle 覆写成 per-file CJS，后果有两处：

1. `sandbox: true` 的 preload 无法 `require` 兄弟模块 → `contextBridge` 完全不执行 → `window.electronAPI` 整体 undefined；
2. TS 把 `await import(specifier)`（刻意用变量以躲过 Rollup 折叠的护栏）编译成 `require(s)` → `@nikkisync/pc-companion` 的含 top-level await 的 ESM 图装载即失败。

CI 不红的原因：`build.yml` 在同一 job 里 `npm run build` → `dist:win` → `e2e:smoke`（:185/:188/:199），而 `npm run typecheck` 属另一个 job（:68），产物树从未被 tsc 覆写。本机则随时可能因一次提交（钩子跑 `tsc -b`）而回到污染态。

## 4. 方案（含一次被实测推翻的分支）

**原计划主方案是 `tsc -b --noEmit`（TS 5.6+ 能力，实测 5.9.3 的 `--dry` 接受该 flag）。落地后 `npm run typecheck` 立即以 exit 2 失败：`tsconfig.json(28,18): error TS6310: Referenced project '…/src/main/tsconfig.json' may not disable emit.`** —— 被 `references` 引用的 composite 项目不允许禁 emit，因为引用方要靠它的声明产物解析类型。故改用计划中预授权的回退方案 R1：**保持 `tsc -b` 不变，把 emit 落点迁出产物树**。

最终改动：

- `src/main/tsconfig.json`：`outDir` `../../dist/main` → `../../.cache/tsmain`（`.cache/` 已被 `.gitignore:26` 排除，且 `build.files` 只含 `dist/**` 与 `resources/**`，不会进 asar）；附中文注释说明 TS6310 与覆写后果。
- `e2e/dist-guard.ts`（新增）：导出纯函数 `detectTscOverwrittenDist(head, hasDeclarationSibling)`，两判据取真实产物形状——同目录存在 `preload.d.ts`（electron-vite 从不产出声明），或头部窗口内同时出现 `Object.defineProperty(exports, "__esModule"` 与跨文件相对 `require`。
- `e2e/helpers.ts`：`launchBuiltApp()` 在既有 `app/index.js` 存在性检查之后调用该守卫，污染态直接 `throw` 并提示先 `npm run build`（不再伪装成被测代码缺陷）。
- `vitest.config.ts`：node project 的 `include` 补 `./e2e/**/*.test.ts`。此前 `verify-changes.ts` 按路径派发测试时，`e2e/**` 下的测试会撞上 vitest "No test files found" 而退出码 1，与 `AGENTS.md` 声称的「verify 会跑 e2e 下的 `*.test.ts`」不符；补入后 `npm test` 与 `npm run verify` 都能真正命中。
- 测试：`scripts/__tests__/typecheck-emit-isolation.test.ts`（落点契约，6 例）、`e2e/__tests__/dist-guard.test.ts`（守卫纯函数，7 例）。
- 既有契约订正：`scripts/__tests__/pre-dist-check.test.ts` 的「结构契约」两条用例原以 `tsc` 的 main 落点 `=== dist/main/main` 为前提（那正是本轮要消除的覆写态），改为断言「tsc 落点必须在产物树之外」并保留「作用域不得收窄回 `app/`」；`scripts/pre-dist-check.ts` 顶部关于「两套构建器写同一棵树」的注释同步更新为现状（`MAIN_MARKER_SCOPE` 取值不变）。
- 文档：`AGENTS.md`（`typecheck` 行注 + 「必须记住的三点」→「四点」第 4 点）、`docs/CODING_CONVENTIONS.md`「校验与提交」新增落点隔离条、`scripts/AGENTS.md` 的 `verify-changes.ts` 行补注、本地 IDE 镜像 `.qoder/rules/project-conventions.md` 同步（不入仓）。
- **未改**：`package.json` 的 `typecheck` 命令、`.husky/pre-commit` 的命令本体（仍 `tsc -b`，仅注释与步骤说明更新）、`build.files`、`clean`、任何被测业务代码、`@nikkisync` 链接。

## 5. 依赖声明

零新增依赖；`package.json` / `package-lock.json` 依赖段未改动；无 `npm install`，故本轮不触发「`libc` 字段被剥 / `@nikkisync` 链接被清」两类既有后遗症。

## 6. 启动说明

```bash
# 前置：release/win-unpacked/*.exe 存在（npm run dist:win 或既有产物）；@nikkisync 已建链（npm run link:nikkisync）
npm run build                 # 产出干净的 dist/main（electron-vite）
npm run typecheck             # 现在只读产物树：emit 落 .cache/tsmain
npx playwright test --config e2e/playwright.config.ts --grep "N1"   # 单条复验
npm run e2e:smoke             # 全量冒烟（含 NikkiSync 与全屏诊断）
```

判别式一条：`npm run build && npm run typecheck` 之后 `dist/main/main/preload.js` 必须仍是 28422 字节、且 `dist/main` 内 `*.d.ts` 计数为 0。

## 7. 错误处理

- 守卫只在 `launchBuiltApp()` 入口抛 `Error`（Playwright 记为用例失败，`afterAll` 仍会 `collectDiagLogs` 保留现场），不 `process.exit`、不静默重建产物——绝不把环境态洗成「看起来成功」。
- 纯函数 fail-open：`head` 非字符串或空串且无兄弟 `.d.ts` 时返回 `null`（不猜测），把「产物根本不存在」留给 helpers 既有的两条存在性报错，避免双重信息。
- 落点契约测试对缺失输入显式断言（键缺失即失败），不依赖 `undefined` 静默通过。

## 8. 参数校验

| 入参                                 | 类型/必填       | 非法值处理                                                           |
| ------------------------------------ | --------------- | -------------------------------------------------------------------- |
| `head`                               | `string`，必填  | 非 string / 空串 → `null`；函数内部只消费前 512 字节（读取成本恒定） |
| `hasDeclarationSibling`              | `boolean`，必填 | 非 true 一律按 falsy；true 时直接判污染（先于 head 判定）            |
| `outDir` / `rootDir`（契约测试读取） | 缺失即 `''`     | 解析前剥行注释；`outDir` 为空串时断言失败，不静默放行                |

## 9. 基础测试用例

- 正常：vite bundle 头部 + 无 `.d.ts` → 放行；真实 `dist/main/main/preload.js`（已 build）→ 判为干净。
- 异常：tsc 转译体头部 + `.d.ts` → 返回含 `npm run build` 与 `tsc -b` 的中文原因；只有转译体特征（无 `.d.ts`）→ 同样判污染；只有 `preload.d.ts` → 同样判污染；`package.json` 任何脚本、pre-commit、verify-changes 出现 `tsc -b --noEmit` → 契约测试直接红（TS6310 防复发）。
- 边界：空/非法 `head` 不误报；特征出现在 512 字节之后不触发；`dist/main` 或 `preload.js` 不存在时跳过（干净克隆与只跑单测的 CI job 不被误判）；行尾断言先归一 CRLF→LF，与 `--end-of-line auto` 同口径。

## 10. 执行记录（红 → 绿）

- **基线红（改码前）**：`npx playwright test --config e2e/playwright.config.ts --grep "N1"` → EXIT=1，`Expected: "function" / Received: "undefined"`，定位 `:294`；`main.log` 同时给出 `ERR_REQUIRE_ASYNC_MODULE` 与 `electronAPI 不可用`。
- **机制红（改码前）**：`npm run build` → preload 28422 字节 / 0 `.d.ts`；随后 `npm run typecheck`（当时仍是裸 `tsc -b`）→ preload 回到 **9513 字节**、`dist/main` 出现 **277** 个 `.d.ts`。污染可确定复现，非偶发。
- **主方案被推翻**：三处加 `--noEmit` 后 `npm run typecheck` → EXIT=2、`TS6310 … may not disable emit`；三处 `--noEmit` 全部回退，改用 outDir 隔离。
- **落点契约测试**：新增后首跑 3 红 2 绿（其中一红是本人断言未考虑本机 `core.autocrlf=true` 的 CRLF，已先归一行尾）；outDir 隔离落地后 → **5 例全绿**。判别力另以临时变异验证：把 `verify-changes.ts` 的 `'--noEmit'` 摘掉，只有对应用例转红，随后逐字还原并 grep 确认无残留。
- **守卫测试**：`e2e/__tests__/dist-guard.test.ts` 首跑因 vitest include 不含 `e2e/**` 而 "No test files found"（EXIT=1）；补入 include 后实现落地 → **7 例全绿**。
- **守卫真实生效**：临时把 `outDir` 改回 `../../dist/main` 并 `npx tsc -b`（preload 回到 9513 字节、`preload.d.ts` 出现），`--grep "N1"` 的报错从 `Expected: "function"` 变为守卫文案（EXIT=1）；还原 `outDir` 后两份测试一度转红（残留在 `dist/main` 的 277 个 `.d.ts` 被真实产物锚定用例与边界用例抓住），`npm run build` 清干净后 **12 例全绿**。
- **二次踩坑（本轮自证）**：给 `src/main/tsconfig.json` 加 `//` 注释解释 outDir 缘由 → 全量 `npm test` 出现 **新增失败** `scripts/__tests__/pre-dist-check.test.ts`：`SyntaxError: Expected double-quoted property name in JSON at position 114 (line 6 column 5)`，因为该既有用例严格 `JSON.parse` 这个文件。处理：注释全部撤掉（缘由改由守卫测试与文档承载），并在 `typecheck-emit-isolation.test.ts` 补一条「必须保持严格 JSON 可解析」的边界断言；再用临时变异（重新加回一行注释）确认这条新断言与 `pre-dist-check.test.ts` 同时转红、报错签名与真实失败逐字一致，随后撤除变异并 grep 确认无残留。
- **既有契约随之订正**：撤掉注释后 `pre-dist-check.test.ts` 仍有 2 条红，位于「结构契约：标记作用域必须覆盖 tsc 的 main 落点」——它断言 `resolveTscMainRoot() === dist/main/main`，前提正是本轮消除的覆写态。按 §4 改写后 → 3 个守卫套件 **27 例全绿**。
- **打包闸门**：`npm run build` EXIT=0 → `npm run pre-dist-check`（含 `check-doc-versions` / `check-changelog-release`）EXIT=0，**26 项 ✔、0 项 ✖** —— 证明纯 rollup 布局下第 4/5 项标记检索与 11.5/11.6 都不受 outDir 迁移影响（风险 R1 的实测收口）。
- **全量回归**：`npm test` → **421 个测试文件全绿（0 失败）**；`npm run lint` EXIT=0；`npm run typecheck` EXIT=0 且 `dist/main/main/preload.js` 仍 28422 字节、`dist/main` 内 `.d.ts` 为 0；`npm run i18n:guard` EXIT=0；`npm run docs:links` EXIT=0（无死引用）；`npm run verify` → typecheck / lint / core-gate / format / test 五步全 ✓（EXIT=0，跑 3 个测试文件；`e2e/helpers.ts`、`scripts/verify-changes.ts`、`vitest.config.ts` 三条 ⚠ 为「无同名套件」的既有非阻断提示）。
- **终态 e2e**：`npm run e2e:smoke` → 10 passed / 1 failed / 4 did not run，唯一失败是 **N2「库落点」**（`expect(fs.stat(%LOCALAPPDATA%\NikkiSync\nikkisync.sqlite)).rejects.toThrow()` 收到 resolved）——本机该文件实测 11894784 字节、mtime 2026-10-18 15:55，早于本轮，属既有环境性失败（判定手段：直接 `ls` 目录取 birth/mtime 与本轮时刻比对）。按既有口径不改断言、不删用户数据，改用 `--grep-invert "@perf|N2 库落点"` 取回其余覆盖 → **14 passed、EXIT=0**（`fullscreen-diagnose`、N1、N3、N3b、N3c、N4、S1–S7、userData 隔离全绿；本轮 S6 亦通过）。
  - 附一条取证纪律：判定该文件是否存在时，`node -e` 拼 Windows 路径的一次读数为 `absent ENOENT`（转义被 shell 吃掉），而直接 `ls "$LOCALAPPDATA/NikkiSync"` 显示文件在。**以直接列目录为准**，不要被包装层的假信号带走。
- **终态**：`npm run build` EXIT=0（preload 28422 字节）→ `npm run typecheck` EXIT=0（11s，preload 仍 28422、`dist/main` 内 `.d.ts` 0 个、`.cache/tsmain` 收 277 个）→ `--grep "N1"` **1 passed (3.0s)**。

## 11. 遗留与如实报告

- **S6 与 N2 是本机既有失败，本轮不修**：`e2e/smoke.e2e.ts` 的 S6「静置 5s 进程仍存活」在本机会让 `proc.exitCode` 由 `null` 变 `0` 并级联 S7/userData 隔离（未定位，疑与 GPU 自愈或退出链相关）；`nikkisync-runtime.e2e.ts` 的 N2「库落点」断言 `%LOCALAPPDATA%\NikkiSync\nikkisync.sqlite` 不存在，而本机该文件长期存在。两者均不改断言、不删用户数据、不弱化。
- `e2e/helpers.ts` 在 `find-related-tests.ts` 的四条匹配规则下仍无同名套件（会打 `[VERIFY] ⚠ 缺少匹配套件`），守卫逻辑已拆到 `e2e/dist-guard.ts` 并配套测试，故该 ⚠ 为既有状态、非阻断。
- `.cache/tsmain` 是类型检查产物，由 `npm run reset`（清 `dist`/`cache`/`.vite`/`tsbuildinfo`）覆盖，不入仓、不进 asar。
- 契约面：本轮不动 IPC 通道 / preload 方法签名 / `IpcResponse` / 错误码 / 主题变量 / i18n key，`docs/IPC_CONTRACT.md` 无需更新，`npm run i18n:guard` 已验 EXIT=0。改动文件均不在「核心路径保护」四清单内（`src/main/tsconfig.json`、`scripts/**`、`e2e/**`、`vitest.config.ts`、根与 docs 的 md），无需 `@core-change` 授权注释，`npm run verify` 的 core-gate 步骤已实测通过。
- `--noEmit` 那条直觉（原计划主方案）已被实测否定并写进 `docs/CODING_CONVENTIONS.md`「校验与提交」与 `AGENTS.md`「必须记住的四点」第 4 点，配套 `typecheck-emit-isolation.test.ts` 会直接把 `tsc -b --noEmit` 这种写法判红，避免下一轮重走。
