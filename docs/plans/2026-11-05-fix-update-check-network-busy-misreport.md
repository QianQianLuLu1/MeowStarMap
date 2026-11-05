# 修复「检查更新」永远误报「当前网络繁忙」（2026-11-05）

## Context（为什么改）

设置页点「检查更新」，**无论网络通不通**都弹出「当前网络繁忙，点击确定跳转官网」。实测已排除网络因素：

```
HTTP 200  https://github.com/QianQianLuLu1/MeowStarMap/releases.atom          ← GitHub 完全可达
HTTP 404  .../releases/download/MeowStarMap-Setup-2.5.6/latest.yml            ← 更新元数据不存在
HTTP 200  .../releases/download/MeowStarMap-Setup-2.5.6/MeowStarMap-Setup-2.5.6.exe
```

现存 10 个 Release **全部只带 `.exe`、没有一个带 `latest.yml`**（`MeowStarMap-Setup-2.5.6` / `MeowStarMap2.5.5` / `NikkiGallery2.5.3` / `2.5.0` …）。electron-updater 拿不到 channel 文件必然抛错，而 UI 把所有错误一刀切显示成「网络繁忙」。所以这不是网络问题，是**发布产物缺元数据 + 错误分类缺失 + 文案一刀切**叠加，用户被告知的原因为假。

目标：「当前网络繁忙」只在真的连不上 GitHub 时出现；能连上时完成版本检查并按结果走 `available`（下载弹窗）/ `not-available`（已是最新）/ `source`（源未就绪，新文案）；原有「确定 → 跳官网」行为逐字保持不变。

## 一、根因（4 条，互相独立，已实测）

| #   | 根因                                                                                                                                                                                                                                                                                                                                                     | 证据                                                                          | 本次代码可修                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| R1  | **更新源从未就绪**：`dist:win` 用 `electron-builder --publish never`，`release/latest.yml` 只留在本地，从未随 Release 上传                                                                                                                                                                                                                               | `latest.yml` 实测 404；本地 `release/latest.yml` 存在且 `version: 2.5.7-beta` | 代码侧只能加闸门校验，真正修复是发布          |
| R2  | **beta 版本号把检查带进 prerelease 分支**：`package.json` version=`2.5.7-beta`，`AppUpdater.js:218` 构造时 `this.allowPrerelease = hasPrereleaseComponents(currentVersion)` ⇒ true；`GitHubProvider.getLatestVersion()` 因此逐条 `semver.valid(hrefTag)` 过滤 feed，现存 tag 全部非法 semver 被跳过，最终命中远古 `2.5.0`，再取 `2.5.0/latest.yml` → 404 | `node_modules/electron-updater/out/providers/GitHubProvider.js` 源码          | ✅ 显式钉 `allowPrerelease = false`           |
| R3  | **错误分类缺失 + 文案一刀切**：`auto-update.ts:85-89` 的 `on('error')` 把任何错误推成 `stage:'error'`；`UpdateDialog.tsx:260` error 分支写死 `updateNetworkBusy`，`payload.errorMessage` 全文件只出现在类型定义、**从未渲染**。全仓 `isOnline / navigator.onLine / connectivity` **0 命中**——项目从来没有连通性判断                                      | 实测 grep 0 处                                                                | ✅ 新增分类器 + 分支文案                      |
| R4  | **开发版点了没反应**：`initAutoUpdater` 在 `!app.isPackaged` 直接 return，`checkForUpdates()` 第 105 行 `if (!initialized) return` 不推任何事件；而 handler 仍返回 `{checking:true}` 永不抛错 ⇒ `about-sections.tsx:41-44` 注释写了「接口不可用时兜底打开仓库」的 `catch` **永远走不到**                                                                 | `auto-update.ts:46-50,104-113`                                                | ✅ 未初始化时抛 `AppError.preconditionFailed` |

次要缺陷（同批顺手修，成本 1 行）：`ctxRef = ctx` 赋在 `!app.isPackaged` 早退**之后**，dev 下 `pushUpdate` 连 ctx 都没有。

**R1 与 R2 必须同批修**：只补 `latest.yml` 仍 404（拉的是 `2.5.0`）；只钉 `allowPrerelease` 也仍 404（源里根本没有 yml）。

## 二、触发条件与预期行为（判据表）

| 真实状态                                            | 判据                     | 应弹什么                                                 | 「确定」按钮                     |
| --------------------------------------------------- | ------------------------ | -------------------------------------------------------- | -------------------------------- |
| 连不上 GitHub（DNS/拒连/超时/TLS/5xx/429）          | `errorKind:'network'`    | **不变**：「当前网络繁忙，点击确定跳转官网」             | 跳 `GITHUB_URL`（不变）          |
| 连得上，但元数据缺失/无已发布版本/feed 解析失败/4xx | `errorKind:'source'`     | **新文案**：「未获取到可用的更新信息，点击确定跳转官网」 | 跳 `GITHUB_URL`                  |
| 连得上且有更高版本                                  | `update-available`       | **不变**：「发现新版本 v… + 更新说明」下载弹窗           | 「下载更新」→ 应用内下载（不变） |
| 连得上且无更高版本（含更低版本 ⇒ 不允许降级）       | `update-not-available`   | **不变**：「当前已是最新版本」                           | 跳官网（不变）                   |
| 开发版/未打包                                       | 抛 `PRECONDITION_FAILED` | 无模态，`about-sections.tsx` 现有 catch 跳官网           | —                                |

分类顺序（兜底方向是关键，兜底 network 就是今天的误报形状）：

1. `err.code` 以 `ERR_UPDATER_` 开头（`CHANNEL_FILE_NOT_FOUND` / `NO_PUBLISHED_VERSIONS` / `LATEST_VERSION_NOT_FOUND` / `INVALID_RELEASE_FEED`）⇒ `source`
2. 有 `statusCode`：≥500 / 408 / 429 ⇒ `network`；其余 4xx ⇒ `source`
3. Node `code` ∈ `ENOTFOUND / EAI_AGAIN / ECONNREFUSED / ECONNRESET / EPIPE / ETIMEDOUT / EHOSTUNREACH / ENETUNREACH`，或 TLS 证书类 ⇒ `network`
4. message 含 `net::ERR_`（Electron net 栈）⇒ `network`
5. **兜底 ⇒ `source`**

不做主动连通性探测：判据已能分开「传输失败」与「连上了但元数据不对」；探测多一次往返、多一套失败模式，且与主请求结论不一致时仍需分类（captive portal 返 200 垃圾 XML 会正确落 `INVALID_RELEASE_FEED = source`）。

## 三、范围边界（不动的东西）

- **不改** `src/main/ipc/handlers/app-handler.ts`、`src/main/preload/api/app.ts`、`preload.test.ts`：避开受保护核心路径的 `@core-change` 授权注释与 CI「IPC contract sync check」阻断，契约面零变化。
- **不改** `electron-builder --publish never`、`package.json` version、`.github/workflows/build.yml`（CI build job 在 push `v*` tag 时已用 `softprops/action-gh-release@v3` 上传 `release/latest*.yml`，机制本来就通，只是这批 Release 是手工发的、没走 CI）。
- **不重写** `UpdateDialog` 的视觉结构（glass-card 模态 / 双按钮 / CSS 变量），只在 error 分支内加 kind 判定。
- 遵守既有否定断言：新代码不得出现「更新出错」「重试」「handleRetry」，不得出现 `app?.checkUpdate()`（渲染层重试），不得出现 `p.stage === 'not-available'`。
- UI 不渲染原始 `errorMessage` 英文技术串（约定：UI 走 `userMessage`、技术细节留日志）。

## 四、需调整逻辑（文件级清单）

### N1 错误分类器（R3 地基）

| 文件                                                       | 输入                                     | 输出                    | 验收                                                          |
| ---------------------------------------------------------- | ---------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `src/main/app/update-error-class.ts`（新增，纯函数零依赖） | `unknown`（electron-updater 抛出的错误） | `'network' \| 'source'` | `npx vitest run src/main/app/update-error-class.test.ts` 全绿 |
| `src/main/app/update-error-class.test.ts`（新增）          | 真实错误形态 fixture                     | 判定结论                | 修改前该文件不存在 ⇒ 天然红灯                                 |

不放 `auto-update.ts` 内联：后者顶层 import `electron` / `electron-updater` / `logger` / `i18n`，分类器写在里面无法脱 mock 单测。已核 `src/main/utils/`、`src/shared/utils/` 无现成错误分类可复用；shared 层禁引 Node/Electron，更新器错误码属主进程专属。

### N2 主进程接线（R2 + R3 + R4）

`src/main/app/auto-update.ts`：① `autoUpdater.allowPrerelease = false` ② `ctxRef = ctx` 前移到早退之前 ③ `on('error')` 按分类器决定 `errorKind` ④ `checkForUpdates()` 未初始化时抛 `AppError.preconditionFailed(t('main.error.updaterNotInitialized'))` ⑤ `downloadUpdate()` 的 catch 同过分类器 ⑥ dev 假源开关（N5）。

新建 `src/main/app/auto-update.test.ts`（该模块当前**零同名测试**）：`vi.mock('electron')`（`app.isPackaged`）+ `vi.mock('electron-updater')`（fake `autoUpdater`，用 `on` 捕获 handler）+ stub `../utils/logger`、`../i18n`、`./renderer-bridge`（断言 `sendToRenderer` 入参即观测面）。

**不设 `autoUpdater.channel`**：`AppUpdater.js:33-45` 的 setter 有副作用 `this.allowDowngrade = true`；且 `_channel` 非空让 prerelease 分支 `currentChannel='latest'` ⇒ `shouldFetchVersion=false`、`isNextPreRelease=false` ⇒ tag 恒 null ⇒ 必抛 `NO_PUBLISHED_VERSIONS`。不设时 `this.channel` 回落 `getDefaultChannelName()` = `latest` + 空前缀 ⇒ `latest.yml`（`getChannelFilename` = `` `${channel}.yml` ``）。`allowDowngrade` 保持默认 false：beta 客户端遇更低版本 yml 得 `not-available`，不降级下载。

### N3 契约扩字段（向后兼容）

- `src/shared/types/electron-api.ts`：新增 `export type UpdateErrorKind = 'network' | 'source'`；`UpdatePayload` 加**可选** `errorKind?`（旧字段语义不变，符合约定 §1「新增字段可选」）。
- `docs/IPC_CONTRACT.md`：补 `app:update` / `app:update:check` / `app:update:download` / `app:update:install` 与 `errorKind` 语义（该组通道今天完全没写进契约文档）。

### N4 渲染层分支（R3 表现层）

- `src/renderer/components/common/UpdateDialog.tsx`：error 分支正文改为 `payload.errorKind === 'network' ? t('settings.about.updateNetworkBusy') : t('settings.about.updateSourceUnavailable')`；同步该文件内 `UpdatePayload` 本地副本的 `errorKind`，注释单一来源在 shared。
- `src/renderer/components/common/UpdateDialog.test.tsx`：现有 9 条源码字符串断言全部保留；新增含 `updateSourceUnavailable` / `errorKind` 的断言 + **render 型**用例覆盖 4 类 payload 的文案与「确定 → `openExternal(GITHUB_URL)`」。
- `src/renderer/i18n/locales/*.json` × 12：新增 `settings.about.updateSourceUnavailable` 各语言真实译文。

### N5 发布闸门 + 本地假源夹具（R1 可判定化）

- `scripts/pre-dist-check.ts`：在 `--verify-asar` 分支尾部（即 `npm run verify:dist` = `dist:win` 终点；主分支跑在 electron-builder **之前**，位置不对）新增纯函数 `verifyUpdateFeedArtifacts({ files, appVersion })`：`latest.yml` 存在、其 `version` == `package.json` version、`path:` 指向的 exe 在同目录存在。照 `treeContainsMarker(scope, files, pattern)` 的注入口径做纯函数。失败信息直接打印待执行动作（Release 编辑页补传 `release/latest.yml`，或推 `v<semver>` tag 走 CI）。
- `scripts/__tests__/pre-dist-check.test.ts`：fixture 覆盖缺 yml / version 不一致 / exe 缺失三类失败。**本地 `release/latest.yml` 已自洽，真目录不红，红灯只能来自 fixture。**
- `dev-app-update.yml`（仓库根，dev-only）：`provider: generic` + `url: http://127.0.0.1:8123/` + **`updaterCacheDirName: meow-star-map-updater-dev`**（与生产包 `meow-star-map-updater` 物理隔离）。
- `scripts/serve-dev-update-feed.ts`（新增，仅 stdlib `node:http` + `node:crypto`，不引新依赖）：生成假 exe + 现算 sha512 + 写 `latest.yml` + 起静态服务；`--no-yml` 复现「可达但源未就绪」；**产物目录若落在 `release/` 之下直接拒绝启动**。

### 依赖声明

**零新增依赖。** `electron-updater` 已是 `^6.8.9` 生产依赖；分类器与夹具服务均为 stdlib + 现有 dev 工具链（`tsx`、`vitest`）。不引入 `gh` CLI（本机实测 `gh: command not found`）、不引入 `http-server`/`axios`。安装方式不变：`npm ci`。

### 启动说明

```bash
npm ci                       # 依赖安装
npm run dev                  # 开发启动（默认 dev 点检查更新 = 抛错跳官网）

# 本地假更新源四场景验证（需两个终端）
npx tsx scripts/serve-dev-update-feed.ts --version 9.9.9 --port 8123
MEOW_DEV_UPDATE_FEED=1 npm run dev

# 单节点验证
npx vitest run src/main/app/update-error-class.test.ts
npx vitest run src/main/app/auto-update.test.ts
npx vitest run src/renderer/components/common/UpdateDialog.test.tsx
npx vitest run scripts/__tests__/pre-dist-check.test.ts
npx tsx scripts/pre-dist-check.ts --verify-asar

# 全局回归
npm run verify && npm test && npm run test:coverage
npm run typecheck && npm run typecheck:e2e && npm run lint && npm run i18n:guard
npm run test:ci-linux
```

### 错误处理（异常分支 / 兜底 / 日志）

- 分类器**永不抛错**：入参 `unknown`，非 Error / 无 code / 无 statusCode ⇒ message 正则 ⇒ 兜底 `source`。
- `on('error')` 保持单次推送；`checkForUpdates()` 的 try/catch 依旧只记日志不重复推（避免同一失败弹两次模态）。
- `downloadUpdate()` 失败同过分类器（否则下载期 `ECONNRESET` 被兜底判成 source，方向反了）。
- 日志沿用既有 `main.autoUpdate.log.updateError` / `downloadFailed` / `checkFailed`，消息后附 `errorKind` 与真实 `err.message`。真实原因（如 `Cannot find latest.yml in the latest release artifacts`）只在日志可见，UI 只显示归类文案。
- `AppError.preconditionFailed` 经 `wrapHandler` 转 `IpcError`，渲染层 `catch` 生效跳官网；`details` 不放路径等敏感数据。
- 夹具服务端口占用 ⇒ 明确错误 + 退出码 1；假 exe 的 sha512 由脚本现算，避免 yml 与文件不一致导致下载校验失败。

### 参数校验

- `classifyUpdateError(err: unknown)`：`null` / `undefined` / 原始值 ⇒ 兜底 `source`，不抛。
- `verifyUpdateFeedArtifacts({ files, appVersion })`：`files: string[]` 必填（空数组 ⇒ 判「缺 latest.yml」）；`appVersion` 必填非空且匹配 `^\d+\.\d+\.\d+(-[\w.]+)?$`（非法 ⇒ 直接失败）；`latest.yml` 解析失败（非法 YAML / 缺 `version` / 缺 `path`）⇒ 判失败并打印文件路径。
- `serve-dev-update-feed.ts`：`--port` 必须 1024-65535 整数；`--version` 必须合法 semver；`--dir` 解析后若落在 `release/` 之下即拒绝。
- `dev-app-update.yml`：仅 dev 且 `MEOW_DEV_UPDATE_FEED=1` 时被读取；生产环境 `forceDevUpdateConfig` 恒 false。`updaterCacheDirName` 必须与生产包不同名。

### 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                                                                   | 期望                                               |
| ---- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 正常 | `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`（今天真实错误原文）                               | `source`                                           |
| 正常 | `ENOTFOUND github.com` / `ECONNREFUSED` / `ETIMEDOUT`                                  | `network`                                          |
| 正常 | `HttpError 500` / `429`                                                                | `network`；`HttpError 404` ⇒ `source`              |
| 正常 | error 事件 ⇒ `pushUpdate({stage:'error', errorKind:'source'})`                         | `sendToRenderer` 收到该入参                        |
| 正常 | 假源 `latest.yml version=9.9.9` > 当前                                                 | `available` ⇒ 下载弹窗（版本 + releaseNotes）      |
| 异常 | `isPackaged=false` 且未开 dev 开关 ⇒ `checkForUpdates()` rejects `PRECONDITION_FAILED` | 不推 `checking`（不得先弹「正在检查更新…」再静默） |
| 异常 | 假源在但无 `latest.yml`（`--no-yml`）                                                  | `source` ⇒ 新文案，**不得**出现「网络繁忙」        |
| 异常 | 假源服务未启动                                                                         | `network` ⇒ 「当前网络繁忙」+ 确定跳官网（原行为） |
| 边界 | `allowPrerelease=false` 钉定后 feed 最新 tag 是非 semver                               | 走 `/releases/latest` 分支，不再命中远古 `2.5.0`   |
| 边界 | yml 版本低于当前 + `allowDowngrade` 默认 false                                         | `not-available`（不是 error、不是降级下载）        |
| 边界 | 非 Error 抛物（字符串 / null）                                                         | 兜底 `source`，不崩                                |
| 边界 | `pre-dist-check` fixture：缺 yml / version 不符 / exe 缺失                             | 三种各自独立失败信息                               |

## 五、分步验证与闭环（每节点：红灯 → 改 → 绿灯 → 局部回归）

推进 N1 → N2 → N3 → N4 → N5 → 全局回归。每节点先写红灯测试并确认失败，再改代码，再转绿；每个回归测试修复前必须处于失败状态，若修复前就通过说明未覆盖该 bug，须重写测试。

| 节点 | 红灯判据（修复前必须失败的具体现象）                                                                                                                                                  | 绿灯命令                                                                                                                                                                                                     | 局部回归                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| N1   | `update-error-class.test.ts` 不存在（模块找不到）；写完即红                                                                                                                           | `npx vitest run src/main/app/update-error-class.test.ts`                                                                                                                                                     | —                                             |
| N2   | 「CHANNEL_FILE_NOT_FOUND ⇒ `errorKind:'source'`」失败（当前不产出 `errorKind`）；「dev 未初始化 ⇒ rejects」失败（当前静默 return）；「`allowPrerelease` 被钉 false」失败（当前 true） | `npx vitest run src/main/app/auto-update.test.ts`                                                                                                                                                            | `npm run test:main`                           |
| N3   | `typecheck` 对 N4 里 `payload.errorKind` 报错（字段尚未定义）                                                                                                                         | `npm run typecheck`                                                                                                                                                                                          | `npx vitest run src/main/preload`             |
| N4   | render 用例「`errorKind:'source'` 渲染 `updateSourceUnavailable`」失败（error 分支恒渲染 `updateNetworkBusy`）；同时保留「`errorKind:'network'` 仍渲染 `updateNetworkBusy`」回归锁    | `npx vitest run src/renderer/components/common/UpdateDialog.test.tsx`                                                                                                                                        | `npm run test:renderer`、`npm run i18n:guard` |
| N5   | 三条 fixture 失败用例当前无实现 ⇒ 红；`serve-dev-update-feed.ts` 不存在 ⇒ 红                                                                                                          | `npx vitest run scripts/__tests__/pre-dist-check.test.ts`、`npx tsx scripts/pre-dist-check.ts --verify-asar`                                                                                                 | `npx vitest run scripts`                      |
| 全局 | —                                                                                                                                                                                     | `npm run verify` → `npm test` → `npm run test:coverage`（阈值 statements 66 / branches 58 / functions 59 / lines 68）→ `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `npm run i18n:guard` | `npm run e2e:smoke`                           |

`npm run verify` 只读；pre-commit 钩子会 `eslint --fix` + `prettier --write` 改写并重新暂存，提交后用 `git status --porcelain` 复核。源码必须 UTF-8 无 BOM + LF。

## 六、验证结论（四场景口径）

| 场景                                   | 制造方式                                                           | 修复前                     | 修复后期望                                                                           |
| -------------------------------------- | ------------------------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------ |
| 不可联网                               | 假源服务**不启动**（`ECONNREFUSED`），或打包版断网/封 `github.com` | 弹「当前网络繁忙」         | 仍弹「当前网络繁忙，点击确定跳转官网」，确定开浏览器到仓库页（**原行为逐字不变**）   |
| 可联网 + 无更新                        | 假源 `latest.yml version` == 当前版本                              | 弹「当前网络繁忙」（误报） | 弹「当前已是最新版本」                                                               |
| 可联网 + 有更新                        | 假源 `latest.yml version=9.9.9`                                    | 弹「当前网络繁忙」（误报） | 弹「发现新版本 v9.9.9」+ 更新说明 +「下载更新」                                      |
| 可联网但源未就绪（**今天的真实状态**） | 假服务起但 `--no-yml`                                              | 弹「当前网络繁忙」（误报） | 弹「未获取到可用的更新信息，点击确定跳转官网」；日志带 `errorKind=source` 与真实原因 |
| 开发版（未打包）                       | `npm run dev` 点按钮                                               | 毫无反应                   | 直接跳官网（复用现有 catch）                                                         |

**必须如实告知**：真实环境要出现「发现新版本」弹窗，还差发布动作，且**不由 Agent 代做**（本机无 `gh` CLI、无 GitHub 凭据）：

1. 每次发 Release，除 `.exe` 外**必须同时上传 `release/latest.yml`**（electron-builder 每次构建都已生成）；或
2. 推 `v<semver>` tag 走 CI（现存 10 个 Release 的 tag 不匹配 `v*`，从未触发过该 job）；
3. 且 feed 上必须存在**严格高于装机版本**的 release，否则客户端正确结果就是「当前已是最新版本」（这不是 bug）。

完成 1 或 2 后，用已装的旧包（`release/MeowStarMap-Setup-2.5.6.exe`）点检查更新即可实机看到下载弹窗，作为最终交付确认。

## 七、方案 1 的无残留保证（针对「测完会不会一直误显示最新版本为 9.9.9」）

结论：**不会**。四条可判定边界：

1. **假版本号不持久化**。electron-updater 每次检查都现取源、现做 semver 比较，不把「最新版本号」写入状态文件；UI 上的 `v9.9.9` 只活在 `UpdateDialog` 的 React state，重启即散。
2. **双条件开关，打包版永不进该分支**。生效要求 `!app.isPackaged && process.env.MEOW_DEV_UPDATE_FEED === '1'` 同时成立才设 `forceDevUpdateConfig = true`。日常 `npm run dev` 不带该变量 ⇒ 走 N2 抛错跳官网。
3. **缓存目录物理隔离**。`dev-app-update.yml` 的 `updaterCacheDirName` = `meow-star-map-updater-dev`，与生产包 `meow-star-map-updater` 不同名 ⇒ 即便点了下载，假 exe 只落 `%LOCALAPPDATA%\meow-star-map-updater-dev`，清理即删这一个目录。
4. **假产物禁止落进 `release/`**（最危险的残留面：CI 发布 glob 是 `release/latest*.yml`）。⇒ `serve-dev-update-feed.ts` 的 `--dir` 校验，默认 `.cache/dev-update-feed/`。验收：`npx tsx scripts/serve-dev-update-feed.ts --dir release` 非 0 退出并打印拒绝原因。

`dev-app-update.yml` 虽入仓但不进包：`build.files` 白名单只收 `dist/**`、`resources/**`、`@nikkisync` 映射。

**验证纪律**：四场景默认只看弹窗与版本号，**不点「下载更新」**；若额外验下载链路，测后删 `%LOCALAPPDATA%\meow-star-map-updater-dev` 即彻底复原。上述任一条做不到即退回方案 3（不搭假源，等真实发版后实机确认），并显式记账。

## 八、风险与回滚

- 钉 `allowPrerelease = false` 会让 beta 客户端不再追 prerelease 通道新版。当前产品只有 NSIS 单一 `latest.yml`（实测产物即 `latest.yml`，非 `beta.yml`），无实际损失；若将来发 beta 通道，需让 CI `files` 覆盖 `beta*.yml` 并显式设 `channel`（届时必须同批显式设 `allowDowngrade`，因为 setter 会把它打开）。
- 新增 i18n 键若某语言漏填，`npm run i18n:guard` 的 key 对齐项直接阻断 CI。
- 回滚：本轮无 DB schema、无迁移、无产物布局变化；`git revert` 相应提交即可，`dev-app-update.yml` / 夹具脚本为 dev-only。

## 九、实施结果（2026-11-05 实测回写）

### 红绿分账（每节点修复前必红）

| 节点          | 修复前                                                                                                                                   | 修复后                    | 测试文件                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| N1 分类器     | 模块不存在 ⇒ 0 例执行、Test Files 1 failed                                                                                               | 23/23 绿                  | `src/main/app/update-error-class.test.ts`                                                     |
| N2 主进程     | 17 例中 **7 红**（source 归类 / network 归类 / download 归类 / allowPrerelease / dev 抛错 ×2 / 假源开关），10 绿为刻意保留的回归锁与守卫 | 17/17 绿                  | `src/main/app/auto-update.test.ts`（该模块此前零同名测试）                                    |
| N4 渲染层     | 17 例中 **4 红**（errorKind 分流源码断言、新键声明、source 渲染用例；另有 1 红是我自己把 `h2` 精确串断言写错，改正则后消除）             | 17/17 绿                  | `src/renderer/components/common/UpdateDialog.test.tsx`（新增 render 型用例）                  |
| N5 闸门与夹具 | 新增 **13 红**（`verifyUpdateFeedArtifacts` 未实现），既有 60 例不受影响                                                                 | 74/74 绿；另夹具 17/17 绿 | `scripts/__tests__/pre-dist-check.test.ts`、`scripts/__tests__/serve-dev-update-feed.test.ts` |

`auto-update.ts` 覆盖率由「无同名测试」升至 **92.15% 语句 / 97.77% 行**。

### 全局校验读数

`npm run verify` 5 项全过（typecheck / lint / core-gate / format / test）· `npm test` 475 文件 7638 例 0 失败 ·
`npm run test:coverage` 退出码 0（阈值 66/58/59/68）· `npm run typecheck` / `typecheck:e2e` / `lint` /
`i18n:guard` 全绿 · `npm run e2e:smoke` 19/19（含真实打包版 `喵星图.exe`，证明 `app.isPackaged=true`
的生产分支不受 `allowPrerelease`/`forceDevUpdateConfig` 改动影响）· `npm run test:ci-linux`
475 文件 7655 例通过（新测试在 ubuntu 宿主语义下同样成立）。

一处实现期偏离计划的修正：`checkForUpdates()` 的抛错消息原计划用英文字面量（避免连带 12 份翻译），
但 `eslint` 的 `no-restricted-syntax` 禁止主进程中文字面量，且 `main.error` 下无可用键，
故按既有命名模式新增 `main.error.updaterNotInit`（12 语言包齐补，i18n:guard 通过）。

### 四场景真实应用实测

用 `launchBuiltApp`（未打包但已 `npm run build` 的真实应用会话：`app://` + 真实 preload + 完整 IPC）
带 `MEOW_DEV_UPDATE_FEED=1` 启动，在渲染进程调 `electronAPI.app.checkUpdate()`，读回主进程推送与
`document.body.innerText`：

| 场景                               | 终态事件                                                                         | 界面实测                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 有更新（假源 9.9.9）               | `{stage:'available',version:'9.9.9'}`                                            | 「发现新版本」=真、下载按钮=真、版本 9.9.9 露出；网络繁忙=假                                      |
| 无更新（假源=装机版本）            | `{stage:'not-available',version:'2.5.7-beta'}`                                   | 「当前已是最新版本」=真；其余文案全假                                                             |
| 源未就绪（服务在、latest.yml 404） | `{stage:'error',errorKind:'source'}`                                             | 「未获取到可用的更新信息」=真、**网络繁忙=假**（修复前此处即误报）                                |
| 连不上（端口无服务）               | `{stage:'error',errorKind:'network',errorMessage:'net::ERR_CONNECTION_REFUSED'}` | 「当前网络繁忙」=真（原提示与跳转行为未被破坏）                                                   |
| 开发版（不带开关）                 | 无事件推送（`seen:[]`）、无模态                                                  | `checkUpdate()` 抛「自动更新器未初始化（开发版默认跳过）」⇒ `about-sections` 的跳官网兜底首次可达 |

真实 electron-updater 抛出的两类错误（404 与 `net::ERR_CONNECTION_REFUSED`）在实测中被正确分到
source / network，证明分类器不只对我手工构造的 fixture 成立。

### 无残留实测

- `%LOCALAPPDATA%\meow-star-map-updater-dev` **不存在**（四场景未点下载，缓存目录连建都没建）；
  生产缓存 `meow-star-map-updater` 内仅有一枚 `installer.exe`，时间戳 11:43 = 本轮工作开始前的
  2.5.7-beta 打包时刻，与本轮无关。
- 假产物只落 `.cache/dev-update-feed/`，实测 `git status --porcelain release/` 为空；
  `--dir release` 被参数校验拒绝（有单测）。
- 一次性验证脚本与夹具产物已删除；`dev-app-update.yml` 由白名单契约用例钉住不进生产包。

### 交付后仍需发布人执行的一步（代码无法代做）

真实环境当前仍看不到下载弹窗：GitHub 上 10 个 Release 无一携带 `latest.yml`。修复后该情形会如实显示
「未获取到可用的更新信息」而不再谎报网络繁忙；要进入「发现新版本 → 应用内下载」，须任选
①编辑 Release 补传 `release/latest.yml`（与 `.exe` 同批），或 ②推 `v<semver>` tag 让 CI 的
`Publish GitHub Release` 步骤按 `release/*.exe + release/latest*.yml` 上传。且 feed 上需存在
**严格高于装机版本**的 release，否则「当前已是最新版本」就是正确结论。
