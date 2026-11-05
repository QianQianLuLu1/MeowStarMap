# 2026-11-05 预提交审查 → 修复 → 六项验证 → 单笔提交 → 2.5.7-beta 重打包 实施计划

> 状态：已确认，执行中（Plan 模式产出并经确认；按 T0→T8 逐步执行，每步实测通过才进入下一步）
> 工作区：`D:/Workbuddy 项目/WXNN YD - 副本/WXNN XiangCe`（路径含空格，命令中一律双引号包裹）
> 项目：meow-star-map，Electron 41.10.6 + React 19 + TS strict，Windows x64，Node ≥22.12，`package.json` 当前 `version = 2.5.6`
> 路径作用域：本文引用的构建产物、本机留存区与上游仓路径不在本仓，均为自动产出或被忽略项，不作为入仓资产。

## 0. 已核实事实（禁止幻觉，全部经只读调研确认）

- **审查基线（用户确认）**：最近一次实际打包 = `release/latest.yml` 的 `releaseDate: '2026-11-05T00:38:28.206Z'`，产物 `MeowStarMap-Setup-2.5.6.exe`（184,896,162 B / sha512 `VonbOeWxWKln+5u6UKZEmiEpdlXL3mHDlL6iwLiPEq1AuieGt7LV/A0reNk3NzWBwrCCozvNg5Yz5b5lG3fvVg==`）。其后仅 1 个提交 `a2fb348`（纯 `docs(plans)` 读数回写，无代码）；2.5.6 定版 `a3cfaf6` 以来的 112 个提交已在历轮 `docs/plans` 逐轮审查并随该包发布，本轮只做**最终态抽查 + 全量测试/静态检查兜底**，不重复逐提交复审。
- **未提交改动仅 3 项**（暂存区空）：`M src/main/app/window-manager.ts`（+import、+`registerCdnUserAgent()`）、`M src/main/app/__tests__/window-manager.test.ts`（+约 153 行 UA-1..UA-6）、`?? src/main/app/cdn-user-agent.ts`（92 行新文件）。`node_modules/ dist/ release/ logs/ coverage/ .zcode/` 均被 `.gitignore` 忽略。
- **审查结论**：`a2fb348` 无代码问题；未提交生产代码发现 **1 个真实边界 Bug** + **1 处规范缺口**，其余 6 项为低危/需人工确认，按最小化改动「记录不修」（§10）。
  - Bug：`src/main/app/cdn-user-agent.ts:56-87`，成功路径 `:81` 的 `callback(...)` 若抛错，会被同一 `try` 的 `:82 catch` 接住并在 `:85` **再次** `callback({})`，违反 Electron `webRequest`「callback 恰好一次」与代码自陈注释。共 5 个 callback 出口（63/69/77/81/85），修复须全覆盖。
  - 规范缺口：新模块无同名套件（`AGENTS.md:175` 要求同目录 `*.test.ts`；`scripts/find-related-tests.ts` 对 `cdn-user-agent.ts` 命中 0，`npm run verify` 会提示缺匹配套件）。
  - 已核查无问题：宿主精确比较、大小写不敏感去 UA、不 mutate 入参、fail-open、注册早于 `loadURL`、CSP 双写位一致、`onBeforeSendHeaders` 全仓仅此一处、受保护路径未被触及（`df8ab01` 的 `@core-change` 注释合规）。
- **脚本真实性**：`npm install`（npm 内建）、`build`、`test`、`typecheck`、`test:ci-linux` 均真实存在；**`npm run e2eismoke` 不存在**（`package.json` scripts 全 60 键无此键，仓内 `docs/plans/2026-11-01-review-fix-2.5.6-repack-round2-实施计划.md:15` 已判定为笔误），真实名为 **`npm run e2e:smoke`**。按用户确认：不改 `package.json`，直接改跑真实脚本，最终报告显式列出「原名→实跑命令→结果」。
- **`npm install` 副作用**：会剪断 `node_modules/@nikkisync` 四条 junction，导致 44 个链接门控用例**静默 skip** 而 `npm test` 仍 exit 0（属测试作弊风险）→ 安装后、任何测试前必须 `npm run link:nikkisync` + `npm run link:nikkisync:check`（four links in place）；`git diff --stat package-lock.json` 若仅行尾规范化则 `git checkout -- package-lock.json` 还原。
- **提交约束**：`core.hooksPath=.husky/_`；pre-commit 三步 = `lint-staged`（`*.{ts,js,json,md}` 含根 `package.json`/`package-lock.json`/`CHANGELOG.md` 走 `prettier --write`；`src/**/*.ts` 另跑 `eslint --fix` + `npm run test:precommit`）→ `tsx scripts/core-path-gate.ts --staged` → 暂存含 TS/TSX 时 `tsc -b`；commit-msg = commitlint（14 类 type 含 `release`/`i18n`，subject ≤72、body ≤120、中文允许、禁句号结尾）。**本轮改动不触及 4 个受保护目录，无需 `@core-change` 注释**。
- **版本双硬闸门**：`scripts/check-changelog-release.ts:100` 要求 CHANGELOG 有且仅有 1 个逐字 `## [2.5.7-beta] - YYYY-MM-DD` 节且 `[Unreleased]` 无 `-`/`*` 条目（否则 `dist:win` 的 `pre-dist-check` exit 1）；`scripts/__tests__/check-changelog-release.test.ts:303-320` 要求 `package.json` version 在 CHANGELOG 有唯一节、`[Unreleased]:` 链接以 `/compare/v2.5.7-beta...HEAD` 结尾；`scripts/__tests__/pack-identity-name.test.ts:112-115` 要求 lock 根与 `packages[""]` 两处 version 都等于 `pkg.version`。
- **`e2e:smoke` 前置**：`e2e/helpers.ts:36-41` 用 `glob('release/win-unpacked/*.exe')` 定位打包产物，找不到即抛错；`:47-50` 的 `readExpectedVersion()` 运行时读 `package.json`；`e2e/smoke.e2e.ts:97-100` S4 断言 `app.getVersion() === readExpectedVersion()`。→ **版本 bump 后、重打包完成前禁止跑 `e2e:smoke`**（包内仍是 2.5.6，会假红）。
- **基线读数**（上轮 `docs/plans/2026-11-05-precommit-audit-fix-repack-2.5.6-实施计划.md` §9.2/§9.4）：`npm test` 471 文件 / 7544 passed / 20 skipped / 0 failed；`typecheck` exit 0；`e2e:smoke` 19 passed；`test:ci-linux` 471 文件 / 7561 passed / 3 skipped；`dist:win` exit 0。

### 顺序说明（因用户选择「版本改动合并为一笔提交」而调整，必须照此执行以防假绿）

用户原顺序为「验证全绿 → 提交 → 改版本 → 重打包」，但已确认版本改动要并入同一笔提交，故版本 bump 必须前移到提交之前。为保证「六项全绿」与最终态都成立，采用双阶段验证：

1. **T3**：在 `2.5.6` 状态下完整跑满用户指定的六项（含 `e2e:smoke`，S4=2.5.6）→ 全绿。
2. **T4**：改版本为 `2.5.7-beta`（提交前）。
3. **T5**：在最终版本态重跑所有会读版本配置的全量套件与静态检查（`npm test` / `typecheck` / `lint` / `test:ci-linux` / `verify` / `audit` / 配置契约子集）；**此阶段不跑 `e2e:smoke`**（原因见上），留到 T8 重打包后补跑（S4=2.5.7-beta）。
4. **T6**：一笔提交同时包含「审查修复 + 版本改动 + 计划文档」，**仅本地提交、不 push**。
5. **T7/T8**：重打包 + 打包后 `e2e:smoke` 复验。

## 1. 依赖声明

- **新增依赖：无；变更依赖：无；版本号变更：无**（`dependencies` / `devDependencies` / `overrides` / `optionalDependencies` 一字不动）；不新增任何包、不改 `audit-ci.jsonc`。
- **安装引入方式**：`npm install` 仅作为 T3 第 1 项（用户指定清单）执行；**不执行** `npm ci`、`npm audit fix`、`npm run audit:fix`；**T4 之后禁止再跑 `npm install`**（会重写 lock 的两处手工版本、再剪 junction、引入行尾扰动）。
- 复用仓内既有工具链：`vitest` / `tsc` / `eslint` / `prettier` / `tsx` / `playwright` / `electron-builder` / `audit-ci` / `link-nikkisync.ts` / `core-path-gate.ts`；不自行实现等价脚本。

## 2. 启动与运行说明

**环境准备（T0 一次性，只读）**：`git status --short` 确认 3 项未提交改动、暂存区空、HEAD=`a2fb348`；`npm run link:nikkisync:check` 确认 four links in place；`node -e "require('better-sqlite3')"` 探针 OK；确认 `release/win-unpacked/*.exe` 与 `release/latest.yml`（2.5.6）在位。不需启动 dev server，不需手动启动应用；`e2e:smoke` 由 Playwright 自行 launch 打包 exe（`workers:1`、本地 `retries:0`）。

**六项验证（T3，按用户指定顺序，逐项通过才进下一项）**

| #   | 原名                              | 实跑命令                       | 真实形态                                                                                                          |
| --- | --------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | `npm install`                     | `npm install` + 三条善后（§0） | 依赖安装                                                                                                          |
| 2   | `npm run build`                   | `npm run build`                | `clean` + `electron-vite build` + 写 `dist/main/package.json`                                                     |
| 3   | `npm run test`                    | `npm run test`                 | `vitest run`                                                                                                      |
| 4   | `npm run typecheck`               | `npm run typecheck`            | `tsc -b && tsc -p tsconfig.scripts.json`                                                                          |
| 5   | **`npm run e2eismoke`（不存在）** | **`npm run e2e:smoke`**        | `playwright test --config e2e/playwright.config.ts --grep-invert @perf`                                           |
| 6   | `npm run test:ci-linux`           | `npm run test:ci-linux`        | `vitest run --config vitest.ci-linux.config.ts`（纯 Node 模拟 Linux 宿主，Windows 可跑，无 xvfb/chmod/bash 依赖） |

**全局回归附加项**：`npm run lint`（`eslint .`）、`npm run typecheck:e2e`（`tsc --noEmit -p e2e`）、`npm run verify`（`tsx scripts/verify-changes.ts`：只读 typecheck + eslint 只读 + `prettier --check` + 相关单测）、`npm run audit`（`audit-ci --config ./audit-ci.jsonc`，**失败即一票否决**）。
**局部回归**：`npx vitest run <精确文件路径...>`（§7 与 T5）。
**重打包**：`npm run dist:win` = `build:recycle-helper` → `build` → `pre-dist-check`（含 `check-doc-versions.ts` + `check-changelog-release.ts`）→ `electron-builder --win --publish never` → `verify:dist`。

## 3. 错误处理

**被测模块既有 fail-open 契约（修复不得改变任何一条）**

| 分支                           | 行为                                                               | 日志                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `new URL(details.url)` 抛错    | `callback({})` 零干预放行                                          | `logger.warn('[cdn-user-agent] URL parse failed (url=…); request continues with original headers', err)` |
| `hostname !== 'cdn.gongeo.us'` | `callback({})`，其它主机零干预、不 mutate 入参                     | 无                                                                                                       |
| `requestHeaders` 缺失/非对象   | `callback({})`（不构造只含 UA 的新对象，避免丢 Accept/Referer）    | `logger.warn('[cdn-user-agent] requestHeaders missing …')`                                               |
| 成功                           | `callback({ requestHeaders: withCdnUserAgent(headers) })`          | 无                                                                                                       |
| listener 内未预期异常          | `callback({})` 兜底，不外抛、不挂起请求、不打断 `createMainWindow` | `logger.warn('[cdn-user-agent] unexpected error …')`                                                     |
| 注册本身抛错                   | 记日志后返回，绝不向 `createMainWindow` 冒泡                       | `logger.warn('[cdn-user-agent] failed to register …')`                                                   |

**本轮修复的错误处理契约**：在 listener 开头引入一次性守卫 `done`，5 个出口全部改走 `done`；`settled` 置位后任何重复调用直接 `return`，既不二次调用 callback，也不吞掉首次 callback 抛错产生的诊断日志（catch 仍 `warnFailOpen`）。**不改日志文案、不改 CSP、不改注册时机、不改 `withCdnUserAgent`**。

**执行期（原子化）**：任一命令非 0 → **立即停止、不进下一步**，原样记录输出；禁止跳过、重跑掩盖、注释/删除/弱化测试、改阈值、加豁免、用 `|| true` 兜底。`npm install` 后 junction 未复原、`npm test` 的 skipped 数由 20 上涨、`test:ci-linux` 由 3 上涨，均视为失败。`dist:win` 若 `pre-dist-check` 红，按 §9 双闸门逐条核对，不得绕过。`npm run audit` exit≠0（含官方源不可达）→ 按用户确认**一票否决，停止后续提交与打包**，如实报告，不加 allowlist、不改 `"high"` 阈值、不跑 `audit:fix`。

## 4. 参数校验

- **listener 入参**：`details.url: string` 必填，非法 URL → fail-open；`details.requestHeaders: Record<string,string>` 目标主机必填，缺失或 `typeof !== 'object'` → fail-open；`callback` 必填且**恰好调用一次**（本轮核心不变量），callback 自身抛错必须被容纳且不触发第二次调用。
- **主机判据**：`URL.hostname` 精确等于 `cdn.gongeo.us`；`cdn.gongeo.us.evil.com` / `evilcdn.gongeo.us` / 路径含主机串一律不匹配。
- **`withCdnUserAgent`**：入参 `Record<string,string>`；大小写不敏感剔除全部 UA 变体；输出必含且仅含一个 `'User-Agent': 'MeowStarMap'`；其它键原值保留；返回新对象不 mutate 入参。
- **非法值/边界（测试覆盖，不新增源码分支）**：`'not a valid url'`、`requestHeaders: undefined`、`requestHeaders: {}`、多 UA 变体大小写混合、伪冒主机串、callback 首次调用抛错。
- **版本参数**：`package.json` / lock 根 / lock `packages[""]` / `database-mock.ts:664` / CHANGELOG 节名五处逐字一致 = `2.5.7-beta`（`check-changelog-release.ts:100` 为精确字符串相等，`VERSION_RE` 只做 `x.y.z` 前缀合法性）；`[Unreleased]` 列表条目数 = 0；`[2.5.7-beta]` 节数 = 1 且须插在 `[2.5.6]` **之前**；`[Unreleased]:` 链接以 `/compare/v2.5.7-beta...HEAD` 结尾；lock `lockfileVersion` 保持 3、`name` 保持 `meow-star-map`。
- **测试环境**：`vitest.config.ts:24` `clearMocks:false`（共享 `vi.fn` 调用历史跨用例累积）→ 新套件 `beforeEach` 必须对 `onBeforeSendHeaders` / logger mock 显式 `mockClear()`，每用例重新注册后取 `mock.calls[0][0]`；`resolve.alias.electron` 指向 inert mock，`vi.mock('electron', …)` 优先级更高；`tests/setup.ts` 无全局 `vi.mock('electron')`，不冲突。

## 5. 基础测试用例（新建 `src/main/app/cdn-user-agent.test.ts`）

文件形状（直接 import 被测模块，不复用 `window-manager.test.ts` 的间接驱动）：`vi.hoisted` 造 `onBeforeSendHeaders: vi.fn()` 与 `loggerWarn: vi.fn()`；`vi.mock('electron', () => ({ session: { defaultSession: { webRequest: { onBeforeSendHeaders } } } }))`；`vi.mock('../utils/logger', () => ({ logger: { warn: loggerWarn } }))`（测试文件在 `src/main/app/`，此路径才与源码的 `'../utils/logger'` 同 ID）；`beforeEach` 双 `mockClear()`；`listener()` 辅助函数每用例重新 `registerCdnUserAgent()` 并返回 `mock.calls[0][0]`。

| 类                       | 用例                        | 精确断言                                                                                                                                                       |
| ------------------------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 1                   | 导出常量                    | `expect(CDN_USER_AGENT).toBe('MeowStarMap')`                                                                                                                   |
| 正常 2                   | 目标主机改写                | `out.requestHeaders!['User-Agent'] === 'MeowStarMap'`；`Accept` 保留；UA 键唯一且为 `'User-Agent'`                                                             |
| 正常 3                   | 非目标主机零干预            | `expect(out).toEqual({})`；`expect(before).toEqual(snapshot)`（不 mutate）                                                                                     |
| 异常 1                   | URL 解析失败                | `out` 为 `{}`；日志含 `URL parse failed`                                                                                                                       |
| 异常 2                   | headers 缺失                | `out` 为 `{}`；日志含 `requestHeaders`                                                                                                                         |
| **异常 3（红灯主用例）** | **callback 抛错只调用一次** | `cb = vi.fn().mockImplementationOnce(() => { throw new Error('callback boom') })`；驱动目标主机请求；`expect(cb).toHaveBeenCalledTimes(1)` 为**唯一红/绿判据** |
| 边界 1                   | 空 headers                  | `out.requestHeaders` 恰为 `{ 'User-Agent': 'MeowStarMap' }`                                                                                                    |
| 边界 2                   | 多 UA 变体大小写混合        | 输出仅一个 `'User-Agent':'MeowStarMap'`，不含任何旧 UA 值                                                                                                      |
| 边界 3                   | 伪冒主机                    | 三条伪冒 URL 逐条 `expect(out).toEqual({})`                                                                                                                    |

> `expect(() => listener(...)).not.toThrow()` 仅作辅助守卫：当前实现 catch 已吞异常，修复前后**都成立**，**不得**用它判红/绿（§7）。

## 6. 子任务（每个含 涉及文件 / 输入输出 / 验收标准）

### T0 计划落盘 + 最终态抽查

- **涉及文件**：新增 `docs/plans/2026-11-05-audit-verify-2.5.7-beta-repack-实施计划.md`（受跟踪，`git add` 之，使 `check-md-links` 的 `git ls-files` 能扫到）；新增 `.zcode/plans/2026-11-05-audit-verify-2.5.7-beta-repack-实施计划.md`（被 `.gitignore:158` 忽略，**不入库**）。只读抽查：`src/main/app/cdn-user-agent.ts`、`window-manager.ts`、`__tests__/window-manager.test.ts`、`release/latest.yml`、`git diff --stat a3cfaf6..HEAD`。
- **输入/输出**：输入＝本计划正文；输出＝两份计划文档 + 抽查结论（1 个纯文档提交、3 个未提交改动、Bug 定位 81/85 行、112 提交最终态不重复复审、受保护路径无违规）。计划文档内不得出现不可解析的相对路径引用（避免 `check-md-links` 死链）。
- **验收标准**：`git status --short` 为原 3 项 + 1 个已暂存的 `docs/plans/…`；`git check-ignore -v .zcode/plans/…` 命中 `.gitignore:158`；`git ls-files docs/plans | wc -l` = 82。

### T1 TDD 红灯

- **涉及文件**：新增 `src/main/app/cdn-user-agent.test.ts`（§5 全部用例，含异常 3）。
- **输入/输出**：输入＝当前未修复的 `cdn-user-agent.ts`；输出＝红灯读数。
- **验收标准**：`npx vitest run src/main/app/cdn-user-agent.test.ts` **必须失败**，且失败点恰为异常 3 的 `expected "vi.fn()" to be called 1 times, but got 2 times`，其余用例绿。**若未出现该红灯，停止并重写用例，不得直接改源码。**

### T2 最小修复 + 绿灯

- **涉及文件**：修改 `src/main/app/cdn-user-agent.ts`、修改 `src/main/app/__tests__/window-manager.test.ts`；`src/main/app/window-manager.ts` **保持既有未提交改动、本轮不再修改**。
- **输入/输出**：
  - `cdn-user-agent.ts` 在 listener 回调体首行加一次性守卫，**把 63/69/77/81/85 五处 `callback(...)` 全部换成 `done(...)`**，其余一字不动：
    ```
    let settled = false
    const done: typeof callback = (r) => {
      if (settled) return
      settled = true
      callback(r)
    }
    ```
  - `window-manager.test.ts` 在 UA-4 用例（约 776-810 行）`await createMainWindow(makeAppCtx())` 之前插入一行 `process.env.NODE_ENV = 'production'`（`beforeEach`/`afterEach` 自动复原）；**不动** `invocationCallOrder[0]` 断言强度。
- **验收标准**：`npx vitest run src/main/app/cdn-user-agent.test.ts -t "callback 抛错"` 由红转绿（`1 passed`）；`npx vitest run src/main/app/cdn-user-agent.test.ts src/main/app/__tests__/window-manager.test.ts` 全绿；`git diff --stat src/main/app/cdn-user-agent.ts` 仅守卫相关约 6 行。

### T3 六项验证全绿 + 全局回归（版本态 2.5.6）

- **涉及文件**：不改源码；`node_modules/`（install 副作用）、`package-lock.json`（可能行尾扰动，须还原）。
- **输入/输出**：按 §2 顺序执行 6 项并逐项记录原样读数，再跑附加静态/类型/安全检查。
- **验收标准（原子化）**：
  1. `npm install` exit 0 → `npm run link:nikkisync` → `npm run link:nikkisync:check`（four links in place）→ `git diff --stat package-lock.json` 若仅行尾扰动则 `git checkout -- package-lock.json` 还原。
  2. `npm run build` exit 0 且 `dist/main/main/app/index.js` 在位。
  3. `npm run test`：**472 文件**（471 + 新套件）/ passed ≥7544 + 新用例数 / **20 skipped（不得增长）** / 0 failed。
  4. `npm run typecheck` exit 0。
  5. `npm run e2e:smoke`：**19 passed**（S4 = 2.5.6，用现役 2.5.6 包）。
  6. `npm run test:ci-linux`：**472 文件** / passed ≥7561 + 新用例数 / **3 skipped** / 0 failed。
  - 附加全绿：`npm run lint`、`npm run typecheck:e2e`、`npm run verify`（不再提示 `cdn-user-agent.ts` 缺匹配套件）、`npm run audit`（**exit 0；失败即一票否决停止**）。`npm run verify` 若因新文件格式判红，仅对本次新增/修改文件运行 `npx prettier --write` 后复跑，不做无关格式化。

### T4 版本改为 2.5.7-beta（提交前，按「合并为一笔提交」决策前移）

- **涉及文件与确切改动**：
  | 文件                                         | 位置                                     | 改前 → 改后                                                        |
  | -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
  | `package.json`                               | 第 3 行                                  | `"2.5.6"` → `"2.5.7-beta"`（scripts 一字不动，不新增 `e2eismoke`） |
  | `package-lock.json`                          | 第 3 行（根）、第 9 行（`packages[""]`） | 两处 `"2.5.6"` → `"2.5.7-beta"`                                    |
  | `src/renderer/preview/mock/database-mock.ts` | 第 664 行                                | `'2.5.6'` → `'2.5.7-beta'`                                         |
  | `CHANGELOG.md`                               | 见下                                     | 三处                                                               |
  - CHANGELOG ① 在 `## [Unreleased] | 未发布`（18-22 行）之后、`## [2.5.6] - 2026-11-01`（24 行）**之前**插入唯一 `## [2.5.7-beta] - 2026-11-05` 节（含 `### Fixed`/`### Changed` 各条目与 `---`），`[Unreleased]` 保持空壳（无任何 `-`/`*` 条目）；② 第 531 行 `[Unreleased]:` 链接改 `.../compare/v2.5.7-beta...HEAD`；③ 链接定义区补 `[2.5.7-beta]: https://github.com/QianQianLuLu1/MeowStarMap/releases`。
- **输入/输出**：输入＝T3 全绿的工作区；输出＝4 个文件（含 lock 两行）+ CHANGELOG 的版本态改动；`release/latest.yml` **禁止手改**（由 `dist:win` 自动重写，且被忽略）。
- **验收标准**：`git diff --stat` 中版本相关恰为上述 5 处文件、lock 恰好 2 行改动、`lockfileVersion` 仍 3；`npx tsx scripts/check-changelog-release.ts` exit 0（节唯一、Unreleased 已收口）；`npx tsx scripts/check-doc-versions.ts` exit 0（只校验 README 的 Electron 41.10，与 app 版本无关）。**不动** README/AGENTS/ARCHITECTURE/DEVELOPMENT/PLUGIN_API 的叙述性版本句；**不动** `gpu-status.test.ts:212` 的 `fallbackVersion: '2.5.6'` fixture。

### T5 最终版本态局部 + 全局回归（防假绿）

- **涉及文件**：无新增改动，仅复验 T2/T4 的产出。
- **输入/输出**：T4 改变了 `package.json` / lock / CHANGELOG 的真实内容，而 `npm test` 与 `test:ci-linux` 内含读真实文件的配置契约用例（§0）→ **T3 的绿在 bump 后已失效，必须重跑**。
- **必须重跑**：`npx vitest run scripts/__tests__/check-changelog-release.test.ts scripts/__tests__/pack-identity-name.test.ts`、`npm run test`、`npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`、`npm run test:ci-linux`、`npm run verify`、`npm run audit`。
- **明确不重跑**：`npm install`（会抹掉手工版本、再剪 junction）；`npm run build`（`dist:win` 内含）；**`npm run e2e:smoke`**（包内仍 2.5.6、package.json 已 2.5.7-beta，S4 必假红，留到 T8 重打包后）。
- **验收标准**：以上全部 exit 0；4 个配置契约用例（version 唯一节 / 节标识无重复 / `[Unreleased]` 链接 / lock 双处 version）全绿；`npm test` / `test:ci-linux` 的 skipped 仍为 20 / 3；`npm run audit` exit 0（否则一票否决）。任一红即停止，回查 T4 逐字一致性，**不得改测试或加豁免**。

### T6 单笔提交（用户确认：修复 + 版本改动合并）

- **涉及文件（`git add` 范围）**：`docs/plans/2026-11-05-audit-verify-2.5.7-beta-repack-实施计划.md`、`src/main/app/cdn-user-agent.ts`、`src/main/app/cdn-user-agent.test.ts`、`src/main/app/window-manager.ts`、`src/main/app/__tests__/window-manager.test.ts`、`package.json`、`package-lock.json`、`src/renderer/preview/mock/database-mock.ts`、`CHANGELOG.md`。**不 add** `.zcode/plans/…`、`release/`、`dist/`、logs。
- **输入/输出**：输出＝**一笔本地提交**（仅本地，**不 push**）；pre-commit 三步与 commit-msg 自动触发；lint-staged 可能对根 json/md 做 `prettier --write` 并自动重新暂存。
- **验收标准**：提交成功、`git status --porcelain` 干净（`.zcode/` 被忽略不显示）；提交后复核 `package.json` version 仍为 `2.5.7-beta`、CHANGELOG 节名逐字未变（防 prettier 改写破坏闸门）；commitlint 通过。提交信息（subject ≤72、中文、无句号）：
  ```
  fix(app): CDN UA 回调改为单次调用并补同名契约测试
  ```
  body（前空一行，每行 ≤120）：
  ```
  - onBeforeSendHeaders 五个出口统一走一次性 done 守卫，消除成功路径 callback 抛错后的二次调用
  - 新增 cdn-user-agent.test.ts 同名套件，覆盖正常/异常/边界并含红→绿回归用例
  - window-manager.test.ts UA-4 显式绑定 NODE_ENV
  - 版本声明位同步为 2.5.7-beta：package.json、lock 两处、preview mock、CHANGELOG
  - 落盘本轮实施计划；六项验证与 lint/typecheck/audit/verify 全绿，打包后另做 e2e 复验
  ```

### T7 备份 + 清树 + 重新打包

- **涉及文件**：`release/build-20261105-257beta-pre/`（新建备份，被忽略）；`release/win-unpacked*`（删除后由打包重建）；`release/latest.yml` / `release/MeowStarMap-Setup-2.5.7-beta.exe` / `.blockmap`（自动生成，**禁止手改**）。
- **输入/输出**（顺序不可颠倒，**备份必须先于清树**）：
  ```
  mkdir -p "release/build-20261105-257beta-pre"
  cp "release/MeowStarMap-Setup-2.5.6.exe" "release/MeowStarMap-Setup-2.5.6.exe.blockmap" "release/latest.yml" "release/build-20261105-257beta-pre/"
  cp "release/win-unpacked/resources/app.asar" "release/build-20261105-257beta-pre/"
  rm -rf release/win-unpacked*
  npm run link:nikkisync:check
  npm run dist:win
  ```
  若 `win-unpacked*` 被安全软件句柄锁死：从备份可回退，按仓内预案等待/重试，不强删备份目录、不走上旁路打包树凑成功。
- **验收标准**：`dist:win` exit 0（`pre-dist-check` 双闸、`electron-builder` NSIS x64、`verify:dist` 全通过）；产出 `release/MeowStarMap-Setup-2.5.7-beta.exe`，`latest.yml` 自动为 `version: 2.5.7-beta`；记录新包 **size + sha512 双轴**并与旧包 `184,896,162 B` / `VonbOeWxWKln+…` 比对，**双轴均变**才算非空重跑（相同须查明原因，不得当作通过）。

### T8 打包后复验 + 最终报告

- **涉及文件**：无源码改动；输出＝最终报告（读数可回写计划文档 §读数回写）。
- **输入/输出**：`npm run e2e:smoke`（此时包内 `app.getVersion()` = 2.5.7-beta，与 `readExpectedVersion()` 一致）；可选 `npm run verify:dist`、`npm run docs:links`。
- **验收标准**：`e2e:smoke` **19 passed** 且 S4 = 2.5.7-beta；`git status --short` 无 tracked 改动；最终报告按 §13 逐项给出读数，任何失败/不可达必须原样报告，不得写成通过。

## 7. TDD 红→绿闭环（确切命令与读数）

| 阶段             | 命令                                                                                               | 预期读数                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 红（T1，修复前） | `npx vitest run src/main/app/cdn-user-agent.test.ts`                                               | `Tests 1 failed                             | N passed`；失败断言 `expected "vi.fn()" to be called 1 times, but got 2 times`。机理：`:81`首次 callback 抛错 →`:82 catch`→`:85`第二次`callback({})`（`mockImplementationOnce` 已消费，不抛）→ 恰好 2 次。已逻辑复核**必然失败**。 |
| 绿（T2，修复后） | `npx vitest run src/main/app/cdn-user-agent.test.ts -t "callback 抛错"`                            | `1 passed`；`cb` 恰好 1 次、listener 不外抛 |
| 全绿（T2）       | `npx vitest run src/main/app/cdn-user-agent.test.ts src/main/app/__tests__/window-manager.test.ts` | 0 failed，UA-1..UA-6 保持绿                 |

绿灯机理：`done` 首次调用前置 `settled=true`；`:81` → callback 抛错 → catch → `:85` 的 `done({})` 见 `settled` 已真即 `return`，异常仍被 catch 容纳并 `warnFailOpen`，listener 不外抛。

## 8. 六项验证读数表（最终报告模板，逐项「原名→实跑命令→结果」）

| #   | 原名                            | 实跑命令                                      | 结果（填原样读数）                                 | 判定 |
| --- | ------------------------------- | --------------------------------------------- | -------------------------------------------------- | ---- |
| 1   | `npm install`                   | `npm install` + 三条善后                      | exit 0 / four links in place / lock 零扰动或已还原 | ☐    |
| 2   | `npm run build`                 | `npm run build`                               | exit 0，`dist/main/main/app/index.js` 在位         | ☐    |
| 3   | `npm run test`                  | `npm run test`                                | 472 文件 / X passed / 20 skipped / 0 failed        | ☐    |
| 4   | `npm run typecheck`             | `npm run typecheck`                           | exit 0                                             | ☐    |
| 5   | **`npm run e2eismoke`（笔误）** | **`npm run e2e:smoke`**                       | **19 passed**（S4 = 2.5.6）                        | ☐    |
| 6   | `npm run test:ci-linux`         | `npm run test:ci-linux`                       | 472 文件 / X passed / 3 skipped / 0 failed         | ☐    |
| 附  | 静态/类型/安全                  | `lint` / `typecheck:e2e` / `verify` / `audit` | 全部 exit 0（audit 失败即一票否决）                | ☐    |
| T5  | 最终版本态回归                  | §6/T5 八条命令                                | 全 exit 0，skipped 20/3                            | ☐    |
| T7  | 重打包                          | `npm run dist:win`                            | exit 0，新包双轴记录                               | ☐    |
| T8  | 打包后复验                      | `npm run e2e:smoke`                           | 19 passed，S4 = 2.5.7-beta                         | ☐    |

## 9. 版本闸门与重打包要点（防踩坑）

- 节名必须**逐字** `2.5.7-beta`（不得写 `[2.5.7]` / `[2.5.7-beta.1]`）；`VERSION_RE` 只校验 `x.y.z` 前缀，`s.version === packageVersion` 是精确相等。
- `[Unreleased]` 节内 `-`/`*` 条目数必须为 0；新节须插在 `[2.5.6]` **之前**（`latest` = 第一个非 Unreleased 节，决定 `compare/v…` 断言）。
- `[2.5.7-beta]: https://github.com/QianQianLuLu1/MeowStarMap/releases` 为 external 链接，`check-md-links` 不阻断。
- `release/latest.yml` 由 electron-builder 自动重写；`release/` 被 `.gitignore:7` 忽略，`git ls-files release` = 0，产物不入仓。
- T4 之后**禁止** `npm install`；T5 阶段**禁止** `e2e:smoke`（假红）；T7 清树后到 `dist:win` 产出前 `findUnpackedExe()` 会直接抛错。

## 10. 低危发现「记录不修」（避免顺手重构）

| 项                                                                 | 理由                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 协议/端口口径（只按 hostname 精确比较，不区分 scheme/port）        | 上游契约只约定主机白名单，改动会扩大行为面，超出「修 1 个 Bug + 补同名测试」 |
| 英文 `logger.warn` 诊断文案                                        | 仅日志可见、非 UI 文案，不违反 i18n 约定                                     |
| UA-4 的 `invocationCallOrder[0]` 断言强度                          | 本轮只显式绑定 NODE_ENV，不加强既有断言                                      |
| 注册失败外层 catch、`requestHeaders` 非对象（字符串/数字）分支补测 | 属补测非修复；`undefined` 缺失已由 UA-6 与新套件异常 2 覆盖                  |
| `src/main/app/AGENTS.md:131` 的「27 源文件 / 23 同名套件」计数     | 叙述性统计、非闸门，新增后应为 28/24，本轮不动                               |
| `gpu-status.test.ts:212` 的 `fallbackVersion: '2.5.6'`             | 任意 fixture，不读 package.json，bump 后不动                                 |

## 11. 完整文件清单（相对路径）

| 文件                                                                                              | 操作               | 内容                                                      |
| ------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------- |
| `docs/plans/2026-11-05-audit-verify-2.5.7-beta-repack-实施计划.md`                                | 新建·入库          | 本计划正文 + 读数回写                                     |
| `.zcode/plans/2026-11-05-audit-verify-2.5.7-beta-repack-实施计划.md`                              | 新建·忽略          | 同上副本，字面满足用户要求，不入库                        |
| `src/main/app/cdn-user-agent.ts`                                                                  | 修改（原 `??`）    | 一次性 `done` 守卫，5 处出口替换                          |
| `src/main/app/cdn-user-agent.test.ts`                                                             | 新建               | §5 同名套件 + §7 红灯主用例                               |
| `src/main/app/window-manager.ts`                                                                  | 保持既有未提交改动 | 第 18 行 import + 第 60 行注册调用，随 T6 提交            |
| `src/main/app/__tests__/window-manager.test.ts`                                                   | 修改               | UA-4 加 `process.env.NODE_ENV = 'production'`             |
| `package.json`                                                                                    | 修改               | 第 3 行 version → `2.5.7-beta`                            |
| `package-lock.json`                                                                               | 修改               | 第 3、9 行两处 version → `2.5.7-beta`                     |
| `src/renderer/preview/mock/database-mock.ts`                                                      | 修改               | 第 664 行 → `'2.5.7-beta'`                                |
| `CHANGELOG.md`                                                                                    | 修改               | 新增唯一 `[2.5.7-beta]` 节、`[Unreleased]` 链接、链接定义 |
| `release/latest.yml` / `release/MeowStarMap-Setup-2.5.7-beta.exe` / `.blockmap` / `win-unpacked/` | 自动生成·禁止手改  | `dist:win` 产出，被忽略                                   |
| `release/build-20261105-257beta-pre/`                                                             | 新建备份           | T7 先于清树备份 exe / .blockmap / latest.yml / app.asar   |

**明确不动**：README / AGENTS / ARCHITECTURE(.en) / DEVELOPMENT(.en) / PLUGIN_API 的叙述性版本句、`audit-ci.jsonc`、`docs/plans` 历史文档原文、`gpu-status.test.ts:212`。

## 12. 风险与一票否决

1. **`npm run audit` 严格闸门**（用户确认）：`audit-ci.jsonc:10` 固定官方 `https://registry.npmjs.org`（本机默认镜像无审计端点），有网络依赖、30 项存量豁免。exit≠0 或不可达 → **停止后续提交与打包、任务不标记完成**，如实报告；不得跳过、伪造、加 allowlist、改阈值。仓内最近确证通过读数在 `docs/plans/2026-10-28-fix-ci-audit-vulnerable-floors.md:277-279`，**不得引用历史读数冒充本轮结论**。
2. **重打包清树句柄**：上轮 `rm -rf release/win-unpacked*` 直接成功，但本机防护软件可能锁 `app.asar`/exe；备份已在清树之前完成可回退。
3. **pre-commit 改写风险**：lint-staged 会对根 `package.json`/`package-lock.json`/`CHANGELOG.md` 跑 `prettier --write`；提交后必须复核版本字面量与 CHANGELOG 节名未被改写破坏双闸门。
4. **T3 与 T5 双阶段验证不可合并**：T3 的 `e2e:smoke` 读数是 2.5.6 态；T8 的 19 passed 才是最终 2.5.7-beta 态，报告须分别写明，不得混写为一次「全绿」。
5. 若任一红灯用例在修复前就通过、或任何 skipped 数上涨，视为测试失效/作弊信号，立即停止并重写用例或补回 junction。

## 13. 最终报告格式

① 审查基线（releaseDate / 旧包双轴 / `a2fb348` / 3 个未提交改动 / 112 提交最终态抽查结论）；② T1→T2 红绿闭环的确切命令与失败、通过读数原文；③ §8 六项验证逐项「原名→实跑命令→结果→判定」（**显式写出 `e2eismoke` → `e2e:smoke` 替代**）；④ lint / typecheck:e2e / verify / audit 读数；⑤ T5 最终版本态八条回归读数；⑥ T6 单笔提交 SHA + commitlint 通过 + 不 push；⑦ T7 备份路径、清树结果、`dist:win` exit 0、新包 size/sha512 双轴对比、`latest.yml` 自动重写为 2.5.7-beta；⑧ T8 `e2e:smoke` 19 passed + S4 = 2.5.7-beta；⑨ §10 记录不修清单；⑩ §12 风险与未解决项。**任何失败/不可达必须原样报告，不得写成通过。**
