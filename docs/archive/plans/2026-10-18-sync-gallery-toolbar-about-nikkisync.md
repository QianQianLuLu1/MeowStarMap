# 同步图库工具栏新增「关于 NikkiSync」外链按钮（2026-10-18）

## Context

需求：在「同步图库」板块顶部按钮区域增加一个「关于 NikkiSync」按钮，点击后用系统浏览器打开 `https://github.com/ToStardust/NikkiSync`。

定位与现状：

- 该板块唯一真实存在的「上方按钮区域」是 `src/renderer/pages/sync-gallery/SyncGalleryToolbar.tsx:63-115`（状态徽标 + 详情 / 刷新 / 扫描 / 同步服务）。板块内层级 2 的 `SyncServicePage` 页头没有按钮区，本次不动它。
- 该工具栏在 `SyncGalleryPage.tsx:159`（空态）与 `:185`（列表态）各渲染一次，两处都要出现新按钮。
- 打开外链的链路仓库已具备，**不新增依赖、IPC 通道或 preload 方法**：渲染层 `window.electronAPI?.shell?.openExternal?.(url)` → 通道 `shell:openExternal`（`src/shared/types/ipc.ts:554`）→ handler `src/main/ipc/handlers/shell-handler.ts:78-92` → `shell.openExternal`。同类先例：`src/renderer/pages/settings/about-sections.tsx:17,147`。

关键区分：设置页的 `GITHUB_URL` 指向**本应用仓库** `QianQianLuLu1/NikkiGallery`；本次要打开的是**上游同步引擎仓库** `ToStardust/NikkiSync`。两者是不同 repo，新常量必须命名 `NIKKISYNC_REPO_URL`，避免未来被误「统一」。

硬约束：最小改动、不顺手重构或格式化无关文件；先写失败测试（红灯）再实现转绿；每节点跑相关回归，最后跑全量 + 类型 + lint。

## 1. 依赖声明

无新增、无变更依赖，不触碰 `package.json` / `electron.vite.config.ts` / lockfile。复用仓库既有能力：

| 复用项                                      | 位置                                        | 用途                                                             |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `Button`（`variant="secondary" size="sm"`） | `src/renderer/components/common/Button.tsx` | 与其它 4 个按钮逐字一致；`Button` 内部已对 `icon` 加 aria-hidden |
| `IconGithub`                                | `src/renderer/icons/index.tsx:615`          | `fill="currentColor"`，随主题继承，无字面色值                    |
| `electronAPI.shell.openExternal`            | `src/main/preload/api/shell.ts:6`           | 用系统浏览器打开 URL                                             |
| `schemas.httpUrl`                           | `src/main/ipc/validator.ts:125-133`         | 主进程侧 http/https 协议白名单（已存在，本次不改）               |
| `useTranslation`                            | `react-i18next`                             | 文案 i18n，禁止硬编码用户可见文本                                |

安装方式：无需安装，仓库既有 `node_modules` 即可。

## 2. 启动说明

```bash
npm run dev            # 人工验证按钮外观与浏览器跳转
npm run verify         # 只读验证闸门
npx vitest run src/renderer/pages/sync-gallery
npx vitest run src/renderer/i18n/locales/sync-gallery-keys.test.ts
npm run i18n:check && npm run i18n:guard
npm test && npm run typecheck && npm run lint && npm run format:check
```

脚本存在性已核实（`package.json` 第 43/46/47/48/57/64/84/85 行）。**不存在** `npm run test:i18n`、`npm run typecheck:renderer`。

Windows + Git Bash 注意：

1. 工作目录含空格与中文，vitest filter 只用相对路径 + 正斜杠。
2. 不跑 `npm run format`（全量会改写未改文件）；只用 `format:check`，必要时 `npx prettier --write <指定文件>`。
3. 只改 JSON locale 时 `npm run verify` 一个测试都不会跑（`scripts/find-related-tests.ts:38` 只匹配 `.ts/.tsx`），i18n 节点必须手动指名跑守卫。
4. `tsc -b` 是增量的，异常快时不要把「没报错」当成通过证据。
5. 新行必须 LF、UTF-8 无 BOM（12 个 locale 现均无 BOM）。
6. 工作区有大量未跟踪日志，严禁 `git add -A`，只按名字 add。

人工验证：`npm run dev` → 侧边栏进「同步图库」→ 工具栏最右出现「关于 NikkiSync」→ 点击后系统默认浏览器打开目标仓库；再把资产列表清空（或桥不可用时）确认空态分支同样有该按钮。

## 3. 错误处理

| 异常分支                                                        | 处置                                                         | 理由                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| preload 桥缺失（非授信 origin 被 `exposeIfTrusted` 静默跳过等） | 可选链短路，点击无反应、不抛错                               | 与 `about-sections.tsx:147`、`UpdateDialog.tsx:93`、`DetailPage.tsx:681` 一致；裸写法会 `TypeError`                          |
| 主进程 `shell.openExternal` 失败                                | handler 抛 `AppError.internal` → `IpcError` → Promise reject | 由 `wrapHandler` 统一转译，渲染层不手写 `try/catch + return {success:false}`                                                 |
| 渲染层是否加 `.catch`                                           | 不加                                                         | 同步箭头函数抓不到 Promise rejection；加 `.catch + extractUserMessage` 会给纯展示组件新增 `shared/errors` import，扩大改动面 |
| 返回值消费                                                      | 不消费                                                       | 既有类型漂移：`vite-env.d.ts:785` 标 `{success}`、preload 实返 `{opened}`；不读返回值天然免疫                                |
| 日志                                                            | 不新增                                                       | 无新逻辑分支需要留痕，失败路径主进程已记                                                                                     |

兜底：静默降级 + 无副作用。按钮不 disabled、不 loading、不弹窗，失败不影响工具栏其余功能与页面取数。

## 4. 参数校验

- 渲染层：`onClick` 处理函数零入参；URL 为 module 级 `const` 字面量，不可被外部覆盖、无非法值可能。i18n key `syncGallery.toolbar.about` 由 locale 完整性守卫保证 12 包均为非空字符串。
- 主进程（已存在，本次不改）：`z.tuple([schemas.httpUrl])` → `.url()` + `.refine(http/https)`，非法协议返回 `VALIDATION_ERROR`；本次 https 天然通过。
- 边界：`window.open` / `<a target="_blank">` 不可用——`src/main/app/window-manager.ts:88` 的 `setWindowOpenHandler` 一律 `deny`，`navigation-guard` 会拦外站导航，必须走 IPC 通道。
- 无新增通道 / 设置键，`docs/IPC_CONTRACT.md` 同步义务不触发（触发条件是改通道名、签名或 `IpcResponse` 结构，本次只新增调用点）。

## 实施步骤

### 节点 0 计划入库

`docs/plans/2026-10-18-sync-gallery-toolbar-about-nikkisync.md`（本文件）。验收：`git add` 后 `git ls-files --error-unmatch` 返回 0。

### 节点 1 基线预检

不改文件。`npm run i18n:check` + `npx vitest run src/renderer/i18n/locales/sync-gallery-keys.test.ts src/renderer/pages/sync-gallery` 必须全绿；基线不绿先修基线，否则后续红灯失真。

### 节点 2 i18n：守卫先红 → 补 12 包转绿

1. `src/renderer/i18n/locales/sync-gallery-keys.test.ts` 的 `REQUIRED_KEYS`（`:63` 之后）加 2 行（1 行注释 + `'syncGallery.toolbar.about',`）。红灯判据：报 `zh-CN.json 缺失 syncGallery.toolbar.about`。
2. 12 个 locale（`src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,fr,de,es,pt,ru,th,vi}.json`）：锚点统一在 `syncGallery.toolbar` 块的 `"detail"`（各文件 L4287）之后追加 `"about"`，各 `+1 行`，不动既有行、不改键序。

   译文与各自 `settings.groups.about`（L1470）用词对齐，`NikkiSync` 作为产品名不译：
   zh-CN `关于 NikkiSync` / zh-TW `關於 NikkiSync` / en `About NikkiSync` / ja `NikkiSync について` / ko `NikkiSync 정보` / fr `À propos de NikkiSync` / de `Über NikkiSync` / es `Acerca de NikkiSync` / pt `Sobre o NikkiSync` / ru `О NikkiSync` / th `เกี่ยวกับ NikkiSync` / vi `Giới thiệu về NikkiSync`

   `th.json` 的 `syncGallery.toolbar` 除 `service` 外是英文残留，不跟着抄英文，取该包 `groups.about` 的真泰文。12 包必须同批改完，否则 `:117-125` 子树同构断言持续红。

   绿灯判据：守卫 5 个用例全过，`npm run i18n:check` 与 `npm run i18n:guard` 退出码 0。

### 节点 3 组件行为红灯

`SyncGalleryToolbar.test.tsx`：+2 个 helper（`setShellBridge` / `clearBridge`，复用 `SyncGalleryPage.test.tsx:104-112` 形态，覆写为 `{ shell: { openExternal } }`）+ `afterEach`，加 3 条用例：

- C1 渲染出 `getByTitle('关于 NikkiSync')`
- C2 点击后 `toHaveBeenCalledWith('https://github.com/ToStardust/NikkiSync')`（URL 字面量钉在测试里，改源码常量必红）
- C3 桥缺失时 `expect(() => fireEvent.click(...)).not.toThrow()`（该契约的全仓唯一守卫）——**执行中证实这条是假绿，已改写为 `window` 的 `error` 监听器通道，见文末「审查发现并修复：C3 是一条假绿断言」**

不能用 `tests/setup.ts` 的全局桩：它是单层 Proxy（`get: () => vi.fn(...)`），`electronAPI.shell` 返回新 mock fn、其 `.openExternal` 为 `undefined`，可选链静默短路 → 断言永远 0 次调用。`tests/mocks/electron.ts` 全仓无人 import，属死桩，同样不采用。

红灯判据：C1/C2/C3 报 `Unable to find an element with the title: 关于 NikkiSync`，既有 6 条仍绿。

### 节点 4 源实现转绿

只改 `SyncGalleryToolbar.tsx`，约 `+14 行 / 改 1 行 / 删 0 行`：

1. L4 import 行尾追加 `, IconGithub`（保持既有追加序，不重排字母序）。
2. imports 后新增 module 级 `NIKKISYNC_REPO_URL` + 具名函数 `openNikkiSyncRepo()`，附 1 行中文注释点明「上游引擎仓库，非本应用仓库」。
3. L114（`onOpenService` 三元块）之后、L115 `</div>` 之前，新增无条件渲染的 `<Button>`。

放最右的理由：`onOpenDetail` 是条件渲染，按钮组左端会随选中态漂移；信息类入口优先级最低。`SyncGalleryPage.tsx` 零改动——props 化的价值在于「信息在父级」，而打开一个恒定第三方 URL 零输入零状态，父级什么都没有，自持还可避免两个渲染分支静默分叉。

不需要 `// @core-change:`：`scripts/core-path-gate.ts` 的 `PROTECTED_GLOBS` 不含 `src/renderer/**`；也不要为「保险」塞注释（`core-path-gate.test.ts` 禁止占位文案）。

绿灯判据：`npx vitest run src/renderer/pages/sync-gallery` 全绿，`npm run verify` 输出 `[VERIFY] ✓`。

### 节点 5 页面接线加固

`SyncGalleryPage.test.tsx:212` 附近，在「运行态 off 空态」用例尾部并 1 行 `expect(screen.getByTitle('关于 NikkiSync')).toBeInTheDocument()`。锁「新按钮不受可选 prop 门控、空态分支同样出现」。该 suite 的 `setBridge` 不带 `shell`，新 handler 全程可选链 → 纯 no-op，无需额外覆写。

### 节点 6 全局回归

`npm run verify` → `npm test` → `npm run typecheck` → `npm run lint` → `npm run format:check`，五条退出码均 0 且与节点 1 基线相比无新增失败项。`npm test` 若出现子进程 `spawn EFTYPE`，先按 `docs/troubleshooting-spawn-eftype.md` 分辨是否环境问题。`test:coverage`（既有阈值门槛）与 `e2e:smoke`（依赖打包产物）与本任务无关，不跑。

## 基础测试用例

| #   | 用例                                      | 类型 | 所在文件                      | 断言                                                 |
| --- | ----------------------------------------- | ---- | ----------------------------- | ---------------------------------------------------- |
| C1  | 工具栏渲染出「关于 NikkiSync」入口        | 正常 | `SyncGalleryToolbar.test.tsx` | `getByTitle('关于 NikkiSync')` 存在                  |
| C2  | 点击后用系统浏览器打开上游仓库            | 正常 | `SyncGalleryToolbar.test.tsx` | `openExternal` 调用 1 次，参数逐字等于目标 URL       |
| C3  | preload 桥缺失时点击不抛错                | 异常 | `SyncGalleryToolbar.test.tsx` | `window` 的 `error` 监听器收到 0 条（见「C3 假绿」） |
| C4  | 空态分支同样出现该按钮                    | 边界 | `SyncGalleryPage.test.tsx`    | `files: []` + `runtimeState: 'idle'` 时按钮存在      |
| C5  | 12 包都有非空 `syncGallery.toolbar.about` | 正常 | `sync-gallery-keys.test.ts`   | 逐包 `toBeDefined` + `toBeTypeOf('string')` + 非空   |
| C6  | 12 包 `syncGallery` 子树叶子键集同构      | 边界 | `sync-gallery-keys.test.ts`   | 漏任一包即 `toEqual` 红                              |

已核实「不会红」的回归面：`src/renderer/pages/sync-gallery/` 全目录无按钮计数/`getAllByRole` 数量断言，全仓无 `__snapshots__`/`*.snap`；`e2e/nikkisync-runtime.e2e.ts:475` 用 `getByTitle('同步服务').first()`，不受影响；测试文件被 `eslint.config.js` 豁免中文硬编码规则。

## 已知可接受风险

- 横向溢出：工具栏行容器 `flex items-center gap-3` 无 `flex-wrap`，本按钮是第 5~6 个；法语 `Service de synchronisation` + `À propos de NikkiSync` 在窄窗会挤压。本次不加 `flex-wrap`/`shrink-0`（属顺手重构）；若实测溢出另起 UI 议题。
- 既有类型债（仅登记不修）：`src/renderer/vite-env.d.ts:785` 的 `openExternal` 返回类型与 preload 实返漂移；修它会牵动所有调用点，违反「禁止顺手重构」。

## 执行记录与红-绿读数（本轮实测）

### 基线（改动前后均为绿）

| 项          | 命令                                                                                                                                          | 读数                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 死引用闸门  | `npm run docs:links`                                                                                                                          | ✅ 无死引用，扫描 64 篇被跟踪 markdown，133 处提醒，退出码 0                          |
| i18n        | `npm run i18n:check` / `npm run i18n:guard`                                                                                                   | 12 包各 3939 keys 对齐 ✅ / 守卫 ✅                                                   |
| 相关套件    | `npx vitest run src/renderer/pages/sync-gallery src/renderer/i18n/locales/sync-gallery-keys.test.ts scripts/__tests__/check-md-links.test.ts` | **6 files / 75 passed / 0 failed**                                                    |
| 类型        | `npx tsc -b --force`                                                                                                                          | 退出码 0，**10 秒全量重检**，零输出（不用增量秒退当证据）                             |
| lint / 格式 | `npm run lint` / `npm run format:check`                                                                                                       | 0 error（11 条 DEBT-030 存量 BOM warning）/ All matched files use Prettier code style |

### 范围外改动处置

`package-lock.json` 的 `0 / 48`（npm 剥离 `"libc"` 字段）按决定丢弃：`git restore -- package-lock.json` 后工作树 blob 回到索引值 `d2cf697`（`git hash-object` 与 `git ls-files -s` 一致），16 处 `"libc"` 复位，`git status --porcelain package-lock.json` 为空。被丢弃的 diff 另存到仓库外临时文件留档。

### 红-绿取证（临时变异，全部逐字还原）

代码先落工作区，加固断言天然直接绿，故按下表反向施加变异复现红灯。每个变异还原后 `git diff -- <文件> | sha256sum` 与变异前记录逐字相等：组件 `05c0c295…`、`vi.json` `893b61ff…`、文档 `66f84269…`；变异特征串全仓 0 命中。

| 变异                                                         | 判红        | 实测                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 `NIKKISYNC_REPO_URL` 改成本应用仓库                       | 仅 C2       | **1 failed / 50 passed**，红点为 `expect(openExternal).toHaveBeenCalledWith(…)`                                                                                       |
| M2 去掉 `window.electronAPI?.shell?.openExternal?.` 的可选链 | 应仅 C3     | 见下方「C3 假绿」                                                                                                                                                     |
| M3 删除整个新 `<Button>` 块                                  | C1+C2+C3+C4 | **4 failed / 47 passed**，四条各报 `Unable to find an element with the title: 关于 NikkiSync`                                                                         |
| M4 按钮改为 `{onOpenService ? null : …}`                     | 仅 C4       | **1 failed / 50 passed**，红点是页面「运行态 off 空态」那条——组件级三条全绿，证明「不受可选 prop 门控」只有页面接线用例能锁                                           |
| M5 `vi.json` 删掉 `"about"`                                  | C5+C6       | **2 failed / 5 passed**（必需键非空 + 子树同构），且 `npm run i18n:check` 同步退出码 1                                                                                |
| M5′ M5 之上再删 `REQUIRED_KEYS` 那一行                       | —           | **1 failed / 6 passed**，只剩子树同构红 ⇒ 漏键由同构守卫独立兜住；`REQUIRED_KEYS` 那一行负责的是「键存在但值为空串/非字符串」与「键被整族删除」这一类同构查不到的缺陷 |
| M6 文档退回 HEAD 写法（去向不与路径同行）                    | 死引用契约  | `docs:links` 退出码 1 指名 355 行；`npx vitest run scripts/__tests__/check-md-links.test.ts` **1 failed / 23 passed**，仅 `runCheck() 的死引用数为 0` 红              |

### 审查发现并修复：C3 是一条假绿断言

M2 暴露出计划原写的 `expect(() => fireEvent.click(…)).not.toThrow()` **抓不到任何东西**：React 19 把事件处理器里的同步异常交回 jsdom 的监听器机制异步上报，`fireEvent.click` 同步返回，于是异常以 `Unhandled Errors / Uncaught Exception` 让整轮退出码变 1，而该条用例本身照样通过——即「修复前就绿」的失效测试。

用一次性探针实测三条通道（探针验证后删除、不入仓），读数 `syncThrow=false windowError=1 reportError=0 consoleError=1`；`globalThis.reportError` 在 jsdom 里根本不存在（`vi.spyOn` 报 `The property "reportError" is not defined`），因此唯一可靠的观测点是 `window` 的 `error` 监听器。C3 已改写成「注册监听 → 点击 → 等一个宏任务 → `expect(errors).toHaveLength(0)`」，M2 下 **1 failed / 43 passed** 且红点精确落在 `toHaveLength(0)`，还原后转绿。`SyncGalleryToolbar.test.tsx` 的 numstat 因此从 `40 / 1` 增至 `54 / 1`。

同类写法在 5 个既有测试文件里另有存在（`components/common/IconButton.test.tsx`、`components/common/MediaThumbnail.test.tsx`、`components/common/SliderControl.test.tsx`、`components/gallery/FullscreenViewer.mouseNav.test.tsx`、`pages/settings/shared.test.tsx`），属既有测试质量问题：改它们可能暴露真实缺陷，已超出本任务范围，本轮只登记不修。

### 入库与重新打包读数

提交 1 = `d59e629 feat(sync-gallery): 工具栏新增「关于 NikkiSync」上游外链入口`，19 files / +402 / −16，pre-commit 三步全过（lint-staged、核心路径闸门判 `⊘ 不涉及受保护文件`、`tsc -b`）。

**第一次 `npm run dist:win` 失败（真实退出码 1，非管道尾命令状态）**：NSIS 包、签名、blockmap 全部产出，倒在 `verify:dist`——`✖ @nikkisync 已建链但未随包`。取证：`node_modules/@nikkisync/` 已退化成**空目录**（`LinkType` 为空，四个 junction 全丢），于是 `build.files` 的对象式 `from/to` 拷不到任何东西；`pre-dist-check.ts` 的 `nikkiSyncPackedVerdict()` 三分支在这种情况下正是设计成 `fail`（产物没带上整个内嵌运行时不能静默出货）。根因与 §范围外改动处置 里的 `package-lock.json` libc churn 同源——本机约 20:14 有一次 `npm install` 清掉了链接并改写了 lock。上一轮 18:26 的包是好的，故属**环境状态漂移、非本轮代码缺陷**。

修复用仓库自带工具，不手工造链接：`npm run link:nikkisync`（幂等，root 解析到 sibling `NikkiSync`）重建 4 条链接，`link:nikkisync:check` 回到 `ok ×4`，`verify:nikkisync` 除「已打包的旧产物缺 migrations」这一条（正是那次失败的结果）外全 ✓。

**第二次 `npm run dist:win` 退出码 0**：`pre-dist-check` 打包前 43 项 ✔；`verify:dist` 18 项全 ✔，含 `@nikkisync` 迁移 SQL、四个入口、深入口 `row-mappers.js`、`LocalSyncServer.js` 与 `GalleryRuntime.mjs`。产物读数：

| 项                                       | 旧包（18:26）              | 新包（21:37）                                                                                                            |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NikkiGallery-Setup-2.5.5-beta.exe` 字节 | 183,331,198                | 183,330,183（−1,015）                                                                                                    |
| exe 的 sha512(base64)                    | `mA3fM3Yw…`                | `anXBhX1rYNDtjERcLw1Q9jcOIHBmaNK3cGHF5XAbcYfSsCAFr7acRCxrtwRSKLh/SXvSS6QWp0BG9XlPob7Ziw==`，与 `latest.yml` **逐字一致** |
| `latest.yml` releaseDate                 | `2026-10-18T10:26:10.528Z` | `2026-10-18T13:37:25.042Z`                                                                                               |
| asar 内 `ToStardust/NikkiSync`           | **0**                      | **1**（`关于 NikkiSync` 2、`About NikkiSync` 2；对照本应用仓库名恒为 7，未受影响）                                       |

旧包按决定直接覆盖、未备份。打包全程未回写 `package-lock.json`（`git status --porcelain package-lock.json` 始终为空），四条 `@nikkisync` 链接也未被 `@electron/rebuild` 破坏。

**打包态探针复验通过**（临时 `e2e/sync-gallery-about-probe.e2e.ts`，验证后已删除、不入仓；`playwright test --list` 复跑为 0 命中）：复用仓内 `e2e/helpers.ts` 的 `launchBuiltApp()` 起 `dist/` 未打包产物（`NODE_ENV=production`，`app://` 协议，CSP 生效，`app.isPackaged=false`——**这不等于已复验安装包本体**），语言固定 `zh-CN` 后重载 → 点侧栏「同步图库」→ `getByTitle('关于 NikkiSync')` 等到出现 → 点击。渲染层打桩无效（`window.electronAPI` 经 `contextBridge` 暴露后是冻结的），故在主进程侧 `app.evaluate(({ shell }) => …)` 把 `shell.openExternal` 换成只记录不委托的桩：既不会真拉起系统浏览器，又让「zod `schemas.httpUrl` 放行 → `wrapHandler` → handler 执行」这段只能在打包态验证的部分被覆盖（拒绝会以 `IpcError` 返回，捕获数组将恒空）。读数 `urls=https://github.com/ToStardust/NikkiSync bridge=function linkErrors=0`，1 passed / 2.9s。

探针首版另有一处自伤：断言写成「全窗口 0 console error」，而本探针不带 `NIKKI_NIKKISYNC_RUNTIME=1` 启动，`Sidebar.tsx:129` 的 `fetchMediaFromDatabase()` 会经 `src/main/nikkisync/runtime-manager.ts` 抛既有的 `NikkiSync runtime is not ready (runtime state is idle)` 告警——与新按钮无关，属把环境配置差异误报成缺陷。已把断言收窄为「外链链路相关错误为 0」并单独打印无关噪声条数（实测 1 条，即上述既有告警）。
