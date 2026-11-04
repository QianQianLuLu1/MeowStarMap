# CI 红灯修复实施计划：e2e 字面量 import('@nikkisync/*') 导致 typecheck:e2e 在 CI 独占失败（2026-11-04）

> 症状：GitHub Actions run #30（head `77b0309`，即现役 main HEAD）的 `Lint, Typecheck & Security` job 步骤 11
> `Typecheck e2e sources (tsc --noEmit -p e2e)` 以退出码 2 失败，下游 test / coverage / build 全部连带 skipped。
> 本机 `npm run typecheck:e2e` 退出码 0 —— 红只在 CI 现形。
> 决策：只改一处越界装载 + 把仓内既有 NikkiSync 装载护栏的作用域扩到 e2e；零新增依赖、不动 CI 配置、不放宽任何闸门。

## 〇、CI 实况（全部历史失败运行，经 GitHub Actions API 免鉴权读取）

| Run | 时间（UTC）      | head_sha  | 失败 job / 步骤                                                                 | 根因                                                                                  | 现状                                                                                                                           |
| --- | ---------------- | --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| #21 | 2026-10-27 13:58 | `59b40a4` | Lint, Typecheck & Security / `Security audit (audit-ci, fail on high/critical)` | 依赖高危通告                                                                          | 已修：`d2ae917 fix(deps)` 把 zod 与 undici 重解析到已修复版本；`9451efd chore(audit)` 豁免 GHSA-jr5w-w6x2-84p9 并登记 DEBT-038 |
| #22 | 2026-10-27 15:55 | `df2ab84` | 同上 / 同一步                                                                   | 同一轮依赖通告未清（`df2ab84` 那次「移除 package-lock 的 libc 可选依赖字段」未击中）  | 同上                                                                                                                           |
| #23 | 2026-10-28 12:18 | `d28564f` | Test (shard 5/10) / `npm test -- --shard=5/10` 退出码 1                         | CI（ubuntu-latest）上 connection 套件的 logger 落盘写与拆解竞态                       | 已修：`489ffbf fix(test): 静默 connection 套件的 logger 落盘写，修 CI shard 5 的拆解竞态`                                      |
| #30 | 2026-11-04 05:50 | `77b0309` | Lint, Typecheck & Security / 步骤 11 `Typecheck e2e sources`                    | **本文件主题一**                                                                      | 已修：`229d6bb fix(e2e)`（run #31 该 job 实测转绿）                                                                            |
| #31 | 2026-11-04 07:12 | `bb9f6df` | Test (shard 10/10) 与 Coverage Gate（同一条用例）                               | **本文件主题二**：`collectSystemInfo` 的裸 `require('electron')` 在无 path.txt 时抛错 | 已修：`df8ab01 fix(log)`；#30 早逝于 lint-typecheck ⇒ 下游全 skip，这两条一直埋在 main 上，直到 #31 才现形                     |

判据：#23 之后 #24…#29 连续六次 `conclusion=success`，说明前三次失败已在树内清偿；本轮不重复处理，只把读数留在本表。
一条非阻断 notice 每轮都在：`ubuntu-latest` 自 2026-10-19 起迁移到 Ubuntu 26（观察项，本轮不动 workflow）。

## 〇-b、主题二：`log-service.test.ts:523` 的 CI 独占红（#31 现形）

报错（shard 10/10 与 Coverage Gate 两个 job 的 annotation 逐字同文）：

```
AssertionError: expected [ 'startup-errors.log', …(3) ] to include 'manifest.json'
 ❯ src/main/services/log-service.test.ts:523:22
```

机理（本机复刻，非推测）：

1. `collectSystemInfo()` 头部两行 `const os = require('os')` / `const { app } = require('electron')`
   **不在任何 try 内**（其余六处 `require('electron')` 全在 try 内，唯此一处裸奔）。
2. CI 用 `npm ci --ignore-scripts` 装依赖 ⇒ electron 的 postinstall 不跑 ⇒ `node_modules/electron/path.txt` 不存在
   ⇒ 该包 `index.js` 被 require 时直接 `throw new Error('Electron failed to install correctly, …')`。
3. 抛出点落在 `exportLogsAsZip` 第 4 步之前 ⇒ 外层 catch（`logger.error(buildDiagnosticFailed)`）接管
   ⇒ 第 4/5 步的 `system-info.json` 与 `manifest.json` 整段缺席 ⇒ staged 恰余 4 项，与 `…(3)` 读数吻合。
4. 本机取证：把 `node_modules/electron/path.txt` 临时移开（模拟 CI 状态）后跑该文件，得
   **逐字同一条红**（`1 failed | 43 passed`，同 `…(3)` 数组）；改后同条件 `44 passed`；
   `path.txt` 已复原并验过 `require('electron')` 可达（本机两条路径都跑过，不留单向证据）。

修法（取仓内既有形态、净删两行、不新增抽象）：`os` 改模块顶部静态 import；electron 复用文件顶部
**已在 import 的 `app`**——函数内再 require 一份既是第二真相源、又绕过测试的 `vi.mock('electron')`、
还在未装二进制的宿主上必抛。`log-service.ts` 属受保护路径，故同批替换了顶部 `@core-change` 原因行。

为什么本机与装置都拦不住（如实记账，不在本轮动）：基座 `vitest.config.ts` 把 `electron` 别名到
`tests/mocks/electron-inert.ts`，而装置第 5 轴（曾把 electron 指向必抛错的壳）已于早前回退
（见 `vitest.ci-linux.config.ts:28-29` 与 `tests/ci-linux.setup.ts:22-23` 的在案说明）⇒
`npm test` 与 `npm run test:ci-linux` 都不会加载真 electron，这类「装了包但没二进制」的失真只有 CI 能现形。
是否把第 5 轴补回装置属另一项裁决，本轮不擅自推翻既有决策。

## 一、根因（check-run annotations + 本机 program 文件清单双重实锤）

`e2e/nikkisync-game-root.e2e.ts` 第 184 行的注解原文：

```
Cannot find module '@nikkisync/pc-companion/dist/src/game-directory-discovery.js'
or its corresponding type declarations.
```

机制：

1. 该文件在「合成安装根环境自检」分支（`test.beforeAll` 里，仅当机器上没有真机游戏根时才执行）写了**字面量**
   `await import('@nikkisync/pc-companion/dist/src/game-directory-discovery.js')`。
2. `@nikkisync/*` 不是 `package.json` 声明依赖，由 `npm run link:nikkisync` 在开发机建 junction 指向同级 NikkiSync
   仓库的 `dist/` 产物。CI 走 `npm ci --ignore-scripts`，四条 junction 不存在 ⇒ 类型解析无源，`tsc --noEmit -p e2e` 报 TS2307。
3. 本机判据（修复前实测）：`npx tsc --noEmit -p e2e --listFiles` 的输出里，落在仓库根**之外**的文件恰两行——
   `../NikkiSync/apps/pc-companion/dist/src/game-directory-discovery.d.ts` 与
   `../NikkiSync/apps/pc-companion/dist/src/WindowsInstallationHints.d.ts`（后者是前者的兄弟模块依赖）。
   整个 e2e program 无第二处仓库外解析 ⇒ 与 CI 只报一条 TS 错、只给一条 annotation 的事实自洽。
4. 为什么 `npm run lint` 放过：仓内既有 NikkiSync 装载护栏（`eslint.config.js` 的 `files: ['src/main/**/*.ts']` 块）
   正是为拦「字面量 `import('@nikkisync/*')`」而设（依据 `src/main/nikkisync/AGENTS.md` 硬性约定 1），
   但作用域只钉了 `src/main`，`e2e/**` 不在覆盖面内 ⇒ 护栏本身没写错，是漏了一档目录。
5. 附带的运行时潜伏雷（同一条写法）：Playwright 的 babel `transform-modules-commonjs` 会把**可静态解析**的
   `import()` 改写成 `require()`，而上游 ESM 图含 top-level await ⇒ 链接态机器上一旦真走到合成根分支，
   就是 `ERR_REQUIRE_ASYNC_MODULE`。今天没暴露的唯一原因是本机有真机游戏根，该分支从未执行。
6. 另一条非阻断注解（登记为观察项，本轮不动 workflow）：`The ubuntu-latest label will migrate to Ubuntu 26
beginning October 19, 2026`。

## 二、修复方案（最小改动：1 处装载改写 + 1 个护栏窄块）

### 依赖声明

- 新增/变更依赖：**无**。不动 `package.json`、`package-lock.json`、`audit-ci.jsonc`、`.node-version`。
- `@nikkisync/*` 继续不是声明依赖（由 `scripts/__tests__/self-contained-deps.test.ts` 钉「无仓库外 `file:` / `workspace:` 依赖」），
  CI 保持无链接态；不得为了「让 CI 也能解析类型」把它加进依赖或加 `paths` 映射 / ambient `declare module`——
  那等于把「只有链接态才存在」写成契约，并把上游产物漂移藏进假绿。
- 复用的既有实现（均为已跟踪文件，不另造轮子）：`src/main/nikkisync/embedding-paths.ts` 的
  `buildPackagingContext()` / `resolveModuleRoot()` / `resolveDeepEntryUrl()`，`src/main/nikkisync/runtime-loader.ts` 的
  `NIKKISYNC_PACKAGES` 与 `hasNikkiSyncLink()`；组装口径逐字参照既有先例 `src/main/nikkisync/runtime-facade.ts` 的深入口装载段。

### 启动说明

- 环境：Windows x64 开发机、Node 24（`.node-version`）、同级 NikkiSync 已 `npm run build`、四条 junction 在位
  （`npm install` 会剪掉 junction，装完必须 `npm run link:nikkisync` 重建）。未链接是受支持的默认态：该 e2e 套件整件 skip。
- 红灯判据（修复前必须失败、修复后必须为空）：
  ```bash
  REPO="$(pwd -W)"; npx tsc --noEmit -p e2e --listFiles | grep -vF "$REPO"
  ```
- 绿灯判据：`npm run typecheck:e2e`、`npm run lint`、`npx eslint e2e` 均退出码 0。
- 远端判据：push 到新 run 后，经 API 读 jobs / steps / annotations，读到 `conclusion=success` 才判「CI 通过」。

### 节点 1：护栏扩面到 e2e（本 bug 的复现测试，必须先红）

- 需修改的文件：`eslint.config.js`（紧跟既有 NikkiSync 护栏块之后新增一块）
- 输入 / 输出：字面量写法仍在 e2e ⇒ 输出「恰一条 lint 错误」的红灯证据
- 改动形状：`files: ['e2e/**/*.ts']`，只带两条规则
  - `no-restricted-imports`：`group: ['@nikkisync/*']` + `allowTypeImports: true`，message 指路装载缝
  - `no-restricted-syntax`：**只有** `ImportExpression[source.value=/^@nikkisync\//]` 这一条 selector
  - 刻意**不**展开 `i18nGuardSelectors`：e2e 用例合法包含中文 UI 断言（同文件里的 `getByText('照片目录已保存并立即生效')` 等），
    展开会把本节点变成误报风暴；此判断须写成块上方中文注释。
  - 刻意**不**加 `Literal[value=/^@nikkisync\//]`：会误伤 `e2e/nikkisync-guard.ts` 的 skip 原因串与
    `scripts/__tests__/verify-nikkisync-link.test.ts` 的 fixture 串。
  - 该块**不得**设置 `local/core-path-guard`：`scripts/__tests__/core-path-gate.test.ts` 会 diff「该规则为 error 的块的
    `files` 并集」与闸门 `PROTECTED_GLOBS`，误加即红。
- 验收标准：`npx eslint e2e/nikkisync-game-root.e2e.ts` 退出码 1 且恰一条错误落在第 184 行；`npm run lint` 的错误清单只有这一条
- 回归：`npx vitest run scripts/__tests__/core-path-gate.test.ts scripts/__tests__/source-encoding.test.ts scripts/__tests__/verify-format-scope.test.ts scripts/__tests__/pack-identity-name.test.ts`
  （四个套件都读 `eslint.config.js`：须保住全局 `unicode-bom` error、`'no-restricted-syntax': 'off'` 字样仍在、
  文件内含字面串 `docs/CODING_CONVENTIONS.md`、ignores 保留 `wxnn-photo-manager/**`）
- 格式化：`npx prettier --write eslint.config.js` 后 `npm run format:check` 绿（根 `*.{ts,js,json,md}` 键覆盖本文件）

### 节点 2：改掉越界装载（转绿）

- 需修改的文件：`e2e/nikkisync-game-root.e2e.ts`（仅此一处，`test.beforeAll` 的合成根分支）
- 输入 / 输出：字面量 bare specifier ⇒ 经装载缝组出的变量式 `file://` URL
- 改动形状（保持 `envSkipReason` 分流与结构类型断言不变）：
  - 顶部从 `../src/main/nikkisync/embedding-paths` 追加三个纯函数 import，并让既有 `hasNikkiSyncLink` 那行同时取 `NIKKISYNC_PACKAGES`
  - 模块级新增深入口常量 `['game-directory-discovery.js'] as const` 与本地 `GameDirectoryDiscoveryModule` 接口
    （沿用原 cast 签名，不用 `any`——`@typescript-eslint/no-explicit-any` 为 error）
  - 分支内求址三步：`buildPackagingContext({ isPackaged: false, projectRoot: REPO_ROOT })` →
    `resolveModuleRoot(NIKKISYNC_PACKAGES.pcCompanion, ctx).root` → `resolveDeepEntryUrl(root, 深入口常量)` → 变量式 `await import(url)`
  - 不加 `/* @vite-ignore */`：e2e 不经 vite 打包，该注释只在 `src/main` 有承重意义
  - 不用 `isPackaged: true`：自检跑在 Playwright 测试进程（plain Node），拿不到也不该猜 `resourcesPath`；
    此口径写成注释，免得后人误以为打包态复验（`NIKKI_E2E_PACKAGED=1`）也覆盖这一步
- 验收标准：`npx eslint e2e` 退出码 0；红灯判据命令输出为空；`npm run typecheck:e2e` 退出码 0；`npm run lint` 退出码 0
- 回归：`npx vitest run e2e/__tests__ src/main/nikkisync/embedding-paths.test.ts src/main/nikkisync/runtime-loader.test.ts`

### 节点 3：一次性装置验真装载（不入库，用后即删）

- 需新建的文件：`.cache` 下一个一次性探针脚本（`.cache/**` 已被 `.gitignore` 与 eslint ignores 双排除，不入库）
- 输入 / 输出：复刻节点 2 的三步求址 ⇒ 三段读数
  1. URL 落在 `node_modules/@nikkisync/pc-companion/dist/src/game-directory-discovery.js`
  2. `await import(url)` 后 `typeof discoverInfinityNikkiInstallation === 'function'`
  3. 合成安装根正例返回非空 `{ installRoot }`；「只有目录没有 exe」的裸目录负例返回 `undefined`
- 验收标准：`npx tsx` 跑该探针退出码 0、三段读数全部符合预期；删除后 `git status --porcelain` 不含它
- 失败处置：第 2 段缺失说明上游产物改名或未 build ⇒ 停在节点，如实报告并指路 `npm run verify:nikkisync`，
  不得把判据改成恒真

### 节点 4：全局回归与静态/类型/安全闸门

依次执行并逐条记退出码（全部为 `package.json` 真实存在的脚本）：`npm run typecheck`、`npm run typecheck:e2e`、
`npm run lint`、`npm run i18n:guard`、`npm run format:check`、`npx vitest run e2e src/main/nikkisync scripts/__tests__`、
`npm test`（全量；CI 侧是同一批用例的 10 分片）、`npm run test:ci-linux`（本仓约定：装置全绿 + 真宿主全绿才算 Linux 全绿）、
`npm run verify`。验收：全 0，且失败数不增于 `77b0309` 基线。

### 节点 5：提交、推送与远端复验

一笔 `fix(e2e)` 提交（Conventional Commits，经 commit-msg + commitlint；不带 `--no-verify`，
pre-commit 会 `eslint --fix` / `prettier --write` 改写并重新暂存，提交后须 `git status --porcelain` 复核），
`git push origin main` 触发新 run，再读 jobs / steps / annotations 直到 `conclusion=success`。

## 三、错误处理（异常分支 / 兜底 / 日志）

- **节点 1 出现连带误报**：把 `files` 收窄为 `['e2e/*.ts']`（排除 `__tests__`），而不是删护栏——护栏是本轮唯一防复发机制。
- **节点 2 后红灯判据仍有越界行**：说明 program 里还有第二处仓库外解析 ⇒ 逐行定位并按同一缝改写，
  不得用 `exclude` / 调低 `strict` / 关步骤来遮蔽。
- **节点 3 装载失败**：区分两类并如实打印 —— `ERR_MODULE_NOT_FOUND`（链接缺失，指路 `npm run link:nikkisync`）与
  `ERR_PACKAGE_PATH_NOT_EXPORTED` 或段清单漂移（指路 `npm run verify:nikkisync`）。
- **用例运行期语义不变**：`resolveModuleRoot` / `resolveDeepEntryUrl` 抛错落在 `beforeAll` 内 ⇒ 该套件报装配失败，
  **不**降级为静默 skip（把抛错咽成 skip 会把「上游产物漂移」藏成假绿）；自检判据照旧只写 `envSkipReason`，
  环境失败与逻辑失败继续分开。
- **远端新 run 仍红**：不重跑旧 run、不 `--no-verify`、不动 workflow；取新 annotation 定位后回到节点 1/2 循环。
- **本机句柄 / EBUSY 类问题**：与本轮无关（不构建产物、不碰 `release/`、不碰 `dist/`）。

## 四、参数校验（入参类型 / 必填 / 边界 / 非法值）

本轮新增调用全部落在既有纯函数上，校验由它们自带且都不触磁盘（开发态分支不做 `exists` 判定）：

- `buildPackagingContext({ isPackaged, resourcesPath?, projectRoot })`：`isPackaged: false` ⇒ 不要求 `resourcesPath`；
  `projectRoot` 必填，空串或全空格 ⇒ `NikkiSyncAssetError('Expected non-empty projectRoot, ...')`。
  本轮传 `isPackaged=false` 与由 `import.meta.url` 推导的 `REPO_ROOT`（恒非空）。
- `resolveModuleRoot(specifier, ctx)`：`specifier` 必须匹配 `^@nikkisync/[a-z][a-z-]*$` ⇒ 拒绝含路径分隔符、`..`、
  大写形态（如 `@nikkisync/CORE`）与非 `@nikkisync` 作用域，非法即在触磁盘前抛 `NikkiSyncAssetError`。
  本轮传 `NIKKISYNC_PACKAGES.pcCompanion`（值 `@nikkisync/pc-companion`）。
- `resolveDeepEntryUrl(root, segments)`：`root` 非空；`segments` 必须非空数组，逐段匹配 `^[A-Za-z0-9._-]+$` 且不得为
  `''` / `'.'` / `'..'`；末段必须以 `.js` / `.mjs` 结尾（否则可能把 migrations SQL 包成可装载 URL）。
  本轮传 `['game-directory-discovery.js']`，锚定在 `dist/src` 之下，与旧字面量所指同一文件（盘上实测存在，11,267 B）。
- 无新增 IPC 通道、无 preload 暴露签名变化、无 `IpcResponse` / `IpcError` 结构改动 ⇒ `docs/IPC_CONTRACT.md` 不动；
  无新增 i18n key ⇒ 12 个 locale 包不动（`npm run i18n:guard` 仅作回归复验）。

## 五、基础测试用例（正常 / 异常 / 边界）

- **正常**：链接态开发机上，`resolveDeepEntryUrl` 组出的 URL 指向真实 `.js` 产物，装载后 `discoverInfinityNikkiInstallation`
  为函数，对合法合成安装根返回非空 `{ installRoot }`。
- **异常**：对「只有目录没有 exe」的裸目录调用同一函数返回 `undefined` ⇒ 用例继续写 `envSkipReason` 而非假失败；
  未链接（CI 默认态）时套件经 `decideNikkiSyncGate` 整件 skip，且 `tsc` 与 `eslint` 都不再引用 `@nikkisync/*`。
- **边界**：`segments` 空数组、含 `'..'`、末段 `.sql` 三种非法入参，以及 `specifier` 形态非法（`@nikkisync/../etc`、
  `@nikkisync/CORE`、带子路径）⇒ 由 `src/main/nikkisync/embedding-paths.test.ts` 既有用例钉住，本轮零改动只复用。
- **防复发用例（护栏自身）**：`npx eslint e2e/nikkisync-game-root.e2e.ts` 在还原旧写法时必须报 1 条、在新写法下必须 0 条
  ——两个方向各验一次，证明护栏有牙而非恒绿。

## 六、明确不做（守最小改动边界）

- 不动 `.github/workflows/build.yml`（含 Ubuntu 26 迁移观察项）、不动依赖清单与 lock。
- 不给 `tsc --noEmit -p e2e` 加任何放宽；不给 e2e 套件加 `test.skipIf`；不把 `typecheck:e2e` 折进 `npm run typecheck`
  （被 references 引用的 composite 项目禁 emit 会报 TS6310，且三面覆盖面由
  `scripts/__tests__/typecheck-emit-isolation.test.ts` 钉住）。
- 不动 `src/main/nikkisync/**`（缝已够用，无需新增 API）、不动受保护路径 ⇒ 无需 `@core-change` 授权注释。
- 不改 CHANGELOG 与技术债清单：本轮是当场清偿、无遗留债务；且 `scripts/check-changelog-release.ts` 要求
  `[Unreleased]` 无待发布条目，塞条目会撞打包闸门。

## 七、执行记录（边做边回写）

### 修复前红灯读数（本机实测）

- `npm run typecheck:e2e` 退出码 **0**（本机四条 junction 在位 ⇒ 解析得到，正是「本地全绿、CI 独占红」的成因）。
- `npx tsc --noEmit -p e2e --listFiles | grep -vF "$(pwd -W)"` 越界行数 **2**：
  `../NikkiSync/apps/pc-companion/dist/src/game-directory-discovery.d.ts` 与
  `../NikkiSync/apps/pc-companion/dist/src/WindowsInstallationHints.d.ts`（后者是前者的兄弟模块依赖）。
- 远端 run #30：步骤 11 退出码 2，唯一一条 TS 错误 annotation ⇒ 与「program 只此一处越界」自洽。

### 节点 1（护栏扩面）红灯读数

- 插入 `files: ['e2e/**/*.ts']` 窄块后、改代码前：`npx eslint e2e/nikkisync-game-root.e2e.ts`
  → `184:16 error 禁止字面量 import("@nikkisync/*")… no-restricted-syntax`，`✖ 1 problem (1 error, 0 warnings)`，退出码 1。
- 无连带损伤：`npm run lint` 退出码 1 且**全仓只有那一条**。
- 四个读 `eslint.config.js` 的套件 105 例全绿（core-path-gate 27 / verify-format-scope 36 / pack-identity-name 37 / source-encoding 5）。

### 节点 2（改装载）绿灯读数

- `npx eslint e2e` 退出码 0；`npm run lint` 退出码 0；`npm run typecheck:e2e` 退出码 0。
- 越界行数 **2 → 0**（同一判据命令，输出为空）⇒ e2e program 已完全自包含，这才是「CI 上 typecheck:e2e 会绿」的充分本地证据
  （本机永远有链接，直接跑命令看不出差别）。
- 相关子集：`npx vitest run e2e/__tests__ src/main/nikkisync/embedding-paths.test.ts src/main/nikkisync/runtime-loader.test.ts`
  → 7 文件 87 passed。

### 节点 3（一次性装置）读数与一条附带发现

装置（`.cache` 下两个一次性脚本，跑完即删、不入库）复刻改后的三步求址并取三段判据：

- ① URL 落点 ✓：`file:///D:/…/WXNN%20XiangCe/node_modules/@nikkisync/pc-companion/dist/src/game-directory-discovery.js`
  （空格与中文段被 `pathToFileURL` 百分号编码，Node 侧正常解回；仓库根含空格与中文不构成障碍）。
- ② 导出形态 ✓：`typeof discoverInfinityNikkiInstallation === 'function'`。
- ③ 首轮 **1 FAILED**：正例（合成安装根）返回 `undefined`。装置随即按上游 `InstallationSearch.valid()`
  的三个候选落点各造一棵树复测，得矩阵：

  | exe 落点                                  | 上游判定                                                                      |
  | ----------------------------------------- | ----------------------------------------------------------------------------- |
  | `<root>/InfinityNikki.exe`                | ACCEPT（`installRoot` 命中，`photoRoots` 收到 `X6Game/Saved/GamePlayPhotos`） |
  | `<root>/X6Game/InfinityNikki.exe`         | **REJECT**（返回 `undefined`）                                                |
  | `<root>/X6Game/Binaries/Win64/X6Game.exe` | ACCEPT                                                                        |

  ⇒ 附带缺陷定位：`createInstallRootShape` 把标记 exe 写在 `X6Game` 里，正是被拒的那一形态
  （文件头原注释「`X6Game/` 为目录 + `InfinityNikki.exe` 为文件」描述的是兄弟形态，实现与之分叉）。
  后果不是红而是**恒 skip**：合成根永远过不了自己的自检 ⇒ `envSkipReason` 恒被置上 ⇒ 无真机游戏根的机器上
  G1/G2/G3 三条真窗判据全部静默跳过。本轮把落点订正为判据第一位的 `<root>/InfinityNikki.exe`，
  装置随即 **ALL PASS**（③ 正例返回所传根、负例返回 `undefined`）。

- 同日顺带读数：37 字节非 PE 文本本轮存留未被隔离（注释里的「43 字节」是更早一份 marker 的读数，已按实测定语订正）。
- 残留覆盖面缺口（如实记账）：该分支的覆盖只到装置，**没有**匹配套件——`npm run verify` 亦打印
  `⚠ e2e/nikkisync-game-root.e2e.ts 缺少匹配套件`。补永久用例的前提不成立：跑真链路要 `@nikkisync` 链接（CI 无），
  不跑真链路就得在本仓另立一份上游落点清单当判据（假真相源）。故按「装置取证 + 本表落档」收口。

### 节点 4（全局回归）退出码读数

`npm run typecheck` 0 / `npm run typecheck:e2e` 0 / `npm run lint` 0 / `npm run i18n:guard` 0 /
`npm run format:check` 0 / 相关子集 52 文件 **948 passed** / `npm test` 470 文件
**7516 passed | 20 skipped** / `npm run test:ci-linux` 470 文件 **7533 passed | 3 skipped** /
`npm run verify` 「总计 4 项, 0 失败」。两组全量读数与 `77b0309` 基线（11-04 复查轮记的 7516 | 20 与 7533 | 3）
**逐项相等** ⇒ 本轮零新增失败、零丢失用例。

### 节点 5（推送与远端复验）读数

- push `77b0309..bb9f6df`（三笔：`38abb48` 计划、`229d6bb` 装载与护栏、`bb9f6df` 回写读数）⇒ 触发 run **#31**。
- **#31 的 `Lint, Typecheck & Security` = success** ⇒ 主题一（本文件原定的动作项）在远端实测关闭，
  `npm run typecheck:e2e` 在无 `@nikkisync` 链接的宿主上不再报 TS2307。
- **#31 另有两条红**：`Test (shard 10/10)` 与 `Coverage Gate`，同一条用例 `log-service.test.ts:523`
  ⇒ 即主题二（机理与取证见 〇-b）。这两个 job 在 #30 里是 `skipped`（needs 的 lint-typecheck 先红），
  所以它们是**既存缺陷**而非本轮引入的回归——本轮把 main 推到全绿的过程，正是逐层掀开被 skip 掩盖的下游。
- 主题二修复（`df8ab01`）后的本机读数：`lint` / `typecheck` / `i18n:guard` / `format:check` / `verify`（5 项 0 失败）全 0；
  `npx vitest run src/main/services scripts/__tests__/path-semantics-guard.test.ts` 18 文件 505 passed；
  `npm test` 470 文件 7516 passed | 20 skipped、`npm run test:ci-linux` 470 文件 7533 passed | 3 skipped
  ——两轴与主题一收口时（即 `77b0309` 基线）**逐项相等**，零新增失败、零丢失用例。
- 待回写：`df8ab01` + 本笔文档推送后的 run #32 结论。判据是整条 workflow `conclusion=success`
  （含 10 个 test 分片、Coverage Gate 与 Windows build job），不只看单个 job。
