# 同步图库与上游 NikkiSync 最新提交对齐 · 实施计划

- 日期：2026-10-31
- 本仓基线：`main` @ `9b7a9c2`（`meow-star-map 2.5.6-beta`）
- 上游锚点：`ToStardust/NikkiSync` `main` @ `b397e0eb6ca1b4748f13a72f13bb1702a549410e` = tag `v1.0.27-public-beta.1`
- 本地链接检出：`D:\Workbuddy 项目\WXNN YD - 副本\NikkiSync`（HEAD 同锚点，`git status --porcelain` = 0，`dist` 重建于 2026-10-29 21:11，晚于全部源文件）
- 落盘状态：2026-10-31 经用户批准入仓；执行读数回写于 §7

---

## 0. 差异结论（先核账，再动手）

### 0.1 已确认对齐的部分

| 项           | 事实                                                                                                                                                              | 取证                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 上游最新提交 | `git ls-remote origin main` = `b397e0e…`，与本机检出 HEAD 逐字一致                                                                                                | 2026-10-31 实测                                                                        |
| 上游工作区   | 0 行改动；tag `v1.0.27-public-beta.1` 指向 HEAD                                                                                                                   | `git -C ../NikkiSync status --porcelain`、`git tag --points-at HEAD`                   |
| 上游产物     | `packages/{protocol,core,database}` 与 `apps/pc-companion` 的 `dist/src/**` 均晚于源文件                                                                          | `find … -newer dist/src/index.js` 无输出                                               |
| 本仓运行路径 | “同步图库”实际运行的是内嵌上游 `PcCompanionRuntime` + `LocalSyncServer`（`src/main/nikkisync/`），不是已停自启的移植面（`PORTED_SYNC_AUTOSTART_ENABLED = false`） | `src/main/app/sync-server-setup.ts:63`、`src/main/nikkisync/runtime-facade.ts:599-723` |

结论：**不存在“漏拉的上游提交”**。上游 `b422193..b397e0e` 的移动端、Windows Shell、Desktop Control Server 改动同样不在本仓应用表面内。

### 0.2 真正未对齐的四项

| #   | 差异                                                   | 现状                                                                                 | 目标（本轮裁决）                                                                                                                                              |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | vendored `AssetSummary` 缺 8 个可选字段                | `src/shared/sync/protocol.ts:65-82` 仅到 b422193                                     | 逐字补 `thumbnailSha256` / `previewSha256` / `fullPreviewResourceId` / `fullPreviewSha256` / `mediaFingerprint` / `sourcePath` / `sourceFolder` / `sizeBytes` |
| D2  | 三类查询通道被委托层裁掉 `sourcePath` / `sourceFolder` | `runtime-manager.ts` 的 `stripAssetPathFields`（3 处调用）                           | **完全对齐：撤裁剪**，载荷与上游 `mapAssetSummary` 同形                                                                                                       |
| D3  | 1.0.27 账号同步作用域（AccountSyncSettings）不可配置   | 未传 `accountSourceDirectories`、无选择 UI、`listChanges` 未接 `accounts.revision()` | **完整接入（含 UI）**：账号勾选、样例缩略图、目录来源标注、变更强制全量重同步                                                                                 |
| D4  | 契约溯源锚点陈旧                                       | `src/shared/sync/README.md` 仍写 `284d4a6`，头注释写 b422193                         | 统一改为 `b397e0e`（tag `v1.0.27-public-beta.1`），并列明本轮追加字段来源                                                                                     |

### 0.3 上游语义事实（实现必须逐字遵守）

- `undefined`（从未保存）= 全部；`null`（显式全部）= 全部；`[]` = 一个都不同步。
- `validKey`：`''`、1–32 位纯数字、`'source:spinning_momo'`；其余非法 → 上游抛 `invalid_accounts`。
- `setSelection` 先把数组去重排序；与当前选择相同则**不写 journal、不 bump revision**。
- `sourceGroups()` 是**读路径上的写操作**（来源指纹变化时写 `app_settings` / `change_journal`）；`selection === undefined` 时只写指纹、不 bump revision。
- `fullResyncRequired = after < accounts.revision() || (minimum !== undefined && after < minimum - 1)`。
- `inspect(path, source?)` 只接受 `source === 'spinning_momo'`；`setSource(id, source)` 接受 `'spinning_momo' | 'other'`。
- 上游 `state().accounts[].label` 是中文（`UID x` / `未识别 UID 的照片` / `旋转吧大喵`）⇒ handler 必须剔除，渲染层按 `uid` + i18n 出文案（`src/**` 禁中文硬编码）。
- 上游 `preview(assetId)` 返回资源行（`resource_id` / `mime_type` / `source_path`），不存在时返回 `undefined`。

---

## 1. 依赖声明

**零新增、零变更 npm 依赖。**

| 项              | 事实 / 动作                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `@nikkisync/*`  | 不在 `package.json` 声明；沿用 `npm run link:nikkisync` 建四条 junction（`NIKKISYNC_ROOT` → `../NikkiSync` → `vendor/NikkiSync`） |
| 安装方式        | 不执行 `npm install` / `npm update`（会剪断 junction，链接态用例集体降级为 skip）                                                 |
| 上游产物        | 已构建且新于源码；若被清理，执行 `cd ../NikkiSync && npm run build`（**不修改上游任何文件**）                                     |
| Node / Electron | 不变（`engines.node >= 22.12.0`；本机 Node v26.3.0、Electron 41）                                                                 |
| 新增运行时模块  | 无。账号作用域直接复用 `runtime.server.accounts`，**不新增深入口**（`LOAD_CHAIN_ROOTS` 保持 13 项）                               |

---

## 2. 启动说明与验证方式

### 2.1 环境准备（顺序即前置）

```bash
git -C ../NikkiSync rev-parse HEAD              # 期望 b397e0eb6ca1b4748f13a72f13bb1702a549410e
git -C ../NikkiSync tag --points-at HEAD        # 期望 v1.0.27-public-beta.1
git -C ../NikkiSync status --porcelain | wc -l  # 期望 0
npm run link:nikkisync                          # 幂等重建四条 junction
npm run link:nikkisync:check                    # 期望 check OK
npm run verify:nikkisync                        # 期望 blocking failures: 0
```

### 2.2 开发启动

```bash
npm run dev        # electron-vite dev
```

界面路径：图库数据源切到“同步图库” → 设置页“同步服务” → 额外照片目录下方的“同步账号”新区块。

### 2.3 验证命令（全部取自 package.json，均已确认存在）

| 目的         | 命令                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 域内单测     | `npx vitest run src/shared/sync src/main/nikkisync src/main/preload src/main/ipc/handlers/nikkisync-handler.test.ts src/renderer/pages/sync-gallery src/renderer/stores/nikkisyncContractTypes.test.ts src/renderer/i18n/locales/sync-service-keys.test.ts` |
| 变更只读闭环 | `npm run verify`                                                                                                                                                                                                                                            |
| 类型三面     | `npm run typecheck` / `npm run typecheck:e2e`                                                                                                                                                                                                               |
| 静态与格式   | `npm run lint` / `npm run format:check`                                                                                                                                                                                                                     |
| i18n         | `npm run i18n:guard`                                                                                                                                                                                                                                        |
| 文档引用     | `npm run docs:links`                                                                                                                                                                                                                                        |
| 装载链体检   | `npm run verify:nikkisync`                                                                                                                                                                                                                                  |
| 全量测试     | `npm test`                                                                                                                                                                                                                                                  |
| 依赖安全     | `npm run audit`（需网络；失败如实记 not-run 并给原因）                                                                                                                                                                                                      |
| 覆盖率门     | `npm run test:coverage`（CI 同款阈值）                                                                                                                                                                                                                      |

已知既有现象（不属本轮引入，验收时单独记账）：`npm run test:ci-linux` 在开发机为红（sharp 平台包 + 装置置根不可写），本轮不以其为判据。

---

## 3. 错误处理与参数校验

### 3.1 错误处理矩阵

| 场景                                | 处理                                                          | 用户可见结果                |
| ----------------------------------- | ------------------------------------------------------------- | --------------------------- |
| runtime 句柄未装配                  | `AppError.preconditionFailed`                                 | 区块隐藏 / toast 提示不可用 |
| 会话未建 `accounts`（老链接）       | manager 抛 `… is unavailable` → `PRECONDITION_FAILED`         | 区块隐藏，不崩页            |
| `setSelection` 收到非法 UID         | 上游 `invalid_accounts` → `VALIDATION_ERROR`                  | toast“保存失败，请重试”     |
| `setSource` 目录 id 不存在          | `directory_not_found` → `PRECONDITION_FAILED`（沿用 K6 映射） | toast + 刷新目录列表        |
| `setSource` / `inspect` 非法 source | `invalid_source` → `VALIDATION_ERROR`（新增映射）             | zod 先拒，页面不发出        |
| `preview` 资产不存在                | `AppError.notFound`（对齐上游 404）                           | 样例缩略图留空，不打断整卡  |
| DB 读写失败                         | 原错上抛 → `INTERNAL_ERROR`（`wrapHandler` 记录）             | toast 通用错误              |
| 账号列表读取失败（渲染层）          | catch → 隐藏整节（沿用 K6 降级）                              | 不阻塞其他同步设置          |
| 保存失败（渲染层）                  | 不做乐观更新，保留旧选择                                      | toast + 状态回滚            |

日志：不新增用户数据日志；`wrapHandler` 已有错误日志。**不得**把 UID 列表、绝对路径写入日志。

### 3.2 参数校验（zod，主进程单一入口）

| 通道                                   | schema                       | 边界                                                                                        |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `nikkisync:get-sync-accounts`          | 无参                         | —                                                                                           |
| `nikkisync:preview-sync-account`       | `{ assetId }`                | trim 1..128（复用 `assetIdSchema`）                                                         |
| `nikkisync:set-sync-account-selection` | `{ uids: string[] \| null }` | 数组 ≤200、元素 ≤64 字符；**语义正则交上游**（避免双真相源），非法值映射 `VALIDATION_ERROR` |
| `nikkisync:set-extra-directory-source` | `{ id, source }`             | id trim 1..128；source ∈ `spinning_momo \| other`                                           |
| `nikkisync:inspect-extra-directory`    | 追加 `source?`               | 仅允许 `spinning_momo`（上游 inspect 的取值域）                                             |

---

## 4. 节点设计（每节点：文件 / 输入输出 / 红测 / 验收）

依赖图：`N0 → (N1 ∥ N2) → N3 → N4 → N5 → N6`。N1、N2 文件不重叠；N3 后 N4 才可编译；N5 依赖 N4 的桥方法。

### N0 · 落盘计划 + 基线取证

- 文件：`docs/plans/2026-10-31-nikkisync-upstream-align-01-实施计划.md`（本文件入仓）
- 输入 → 输出：已批准计划 + 上游双锚点 → 仓内可追溯文档
- 取证：`npm test` 基线读数（Test Files / Tests / skipped）、`npm run verify:nikkisync` 读数、`git status --porcelain`
- 验收：文档被跟踪；`npm run docs:links` 退出 0；基线读数写入文档 §7
- 提交：`docs(plans): 落盘同步图库与上游 b397e0e 对齐计划`

### N1 · vendored 契约补 8 字段 + DTO 字段集防漂移

- 文件：
  - `src/shared/sync/protocol.ts`
  - `src/shared/sync/README.md`
  - `src/main/nikkisync/protocol-contract.ts`
  - `src/main/nikkisync/protocol-contract.test.ts`
  - `src/main/nikkisync/protocol-drift.test.ts`
  - `src/shared/sync/protocol.test.ts`（T6 增补新字段构造）
- 输入 → 输出：上游 `packages/protocol/src/index.ts` 的 `AssetSummary` → vendored 同形接口（仅保留既有两处已注释差异：`./domain-types` 指向、空接口改类型别名）
- 实现要点：
  1. 8 个字段**逐字、按上游顺序**插入 `previewResourceId` 之后。
  2. `protocol-contract.ts` 新增纯函数 `extractInterfaceMembers(source, name)` 与 `diffInterfaceMembers(vendored, upstream)`（零依赖、只做文本/AST 无关的成员名提取）。
  3. `protocol-contract.test.ts` 覆盖正常/异常/边界（嵌套对象、注释、可选标记、缺失接口）。
  4. `protocol-drift.test.ts` 新增链接态用例：读取链接包 `dist/src/index.d.ts`（经 `fs.realpathSync('node_modules/@nikkisync/protocol')` 定位），与本仓 `protocol.ts` 比对 `AssetSummary` 成员集合。
- 红测（先写后改）：`npx vitest run src/main/nikkisync/protocol-drift.test.ts` → 新用例失败，差异清单含 8 个缺失字段
- 验收：同一命令转绿且 `0 skipped`；`npx vitest run src/shared/sync src/main/nikkisync/protocol-contract.test.ts` 全绿
- 提交：`fix(sync): vendored AssetSummary 对齐上游 b397e0e 并新增 DTO 字段集漂移守卫`

### N2 · 撤掉委托层路径裁剪（行为与上游同形）

- 文件：
  - `src/main/nikkisync/runtime-manager.ts`（删 `ASSET_PATH_FIELDS` / `isPlainObject` / `stripAssetPathFields` 与 3 处调用）
  - `src/main/nikkisync/runtime-manager.test.ts`（3 条“不透出”用例翻转为“原样透出”；删除 9 条裁剪实现边界用例；保留 path 模式用例）
  - `src/main/nikkisync/runtime-facade.linked.test.ts`（N4 套件翻转：manager 响应必须含两键）
  - `docs/IPC_CONTRACT.md` §8.1（删除“一处刻意例外”整段，改写为零转换含路径）
  - `src/main/nikkisync/AGENTS.md`（删除裁剪职责描述）
  - `src/renderer/utils/assetViewModel.ts`（注释：载荷可含路径，视图模型仍不映射）
  - `src/main/ipc/handlers/nikkisync-handler.ts`（如头注释含“刻意不跟随”，同步改写）
- 输入 → 输出：上游 DTO → IPC 原样（不再剔键）
- 红测：先改用例为断言 `sourcePath` / `sourceFolder` 存在（含 `search-suits` 嵌套 `items[].photos[].asset`），修复前红
- 验收：`npx vitest run src/main/nikkisync/runtime-manager.test.ts src/main/nikkisync/runtime-facade.linked.test.ts` 全绿；`grep -rn "stripAssetPathFields" src docs/IPC_CONTRACT.md src/main/nikkisync/AGENTS.md` 零命中
- 提交：`fix(nikkisync): 撤销委托层路径裁剪，资产摘要与上游载荷同形`

### N3 · 账号作用域内核（真上游实例，不重写）

- 文件：
  - `src/main/nikkisync/runtime-types.ts`
  - `src/main/nikkisync/runtime-facade.ts`
  - `src/main/nikkisync/runtime-manager.ts`
  - `src/main/nikkisync/sync-server-view.ts`
  - `src/main/nikkisync/runtime-facade.test.ts`
  - `src/main/nikkisync/runtime-manager.test.ts`
  - `src/main/nikkisync/sync-server-view.test.ts`
  - `src/main/nikkisync/runtime-facade.linked.test.ts`
- 类型面：
  - 新增 `AccountSyncSettingsLike`（`state/selection/setSelection/revision/preview/sourceGroups/sourceDirectoriesChanged`）
  - `LocalSyncServerLike.accounts?: AccountSyncSettingsLike`
  - `ExtraScanDirectoriesLike.inspect(selected, source?)` + `setSource(id, source)`
  - `NikkiSyncSyncServerConfig.accountSourceDirectories?: () => readonly unknown[]`
  - `NikkiSyncRuntimeSession.accounts?: AccountSyncSettingsLike`
  - `NikkiSyncRuntimeHandle`：`listSyncAccounts` / `previewSyncAccount` / `setSyncAccountSelection` / `setExtraDirectorySource`
- facade 装配：
  1. 在 `new RuntimeCtor` 之前声明 `let extraDirectories`；构造 `accountSourceDirectories = () => extraDirectories?.state().directories ?? []`，以函数引用写入 `embeddedServerConfig({ ...options.syncServer, accountSourceDirectories })`（构造期冻结函数、运行期读最新目录）。
  2. `createRuntimeSession` 中 `new ExtraScanDirectoriesCtor(file, runtime.scanner, async () => {}, () => runtime.server.accounts?.sourceDirectoriesChanged())`（第四参对齐上游 `windows-app.ts:212`）。
  3. `createQuerySurface`：`const accounts = runtime.server.accounts`；`new ReadRepoCtor(db, accounts ? () => accounts.selection() : undefined, accounts ? () => accounts.sourceGroups() : undefined)`。
  4. `listChanges` 判据改为 `after < (accounts?.revision() ?? 0) || (minimum !== undefined && after < minimum - 1)`。
  5. 会话返回 `accounts: runtime.server.accounts`。
- manager：
  - `requireAccounts()` 缺席抛 `sync account scope is unavailable`
  - `listSyncAccounts()` → `accounts.state()`；`previewSyncAccount(assetId)` → 行或 `NikkiSync asset not found`；`setSyncAccountSelection(uids)` → `setSelection` 后返回 `state()`
  - `setExtraDirectorySource(id, source)` → `requireExtraDirectories().setSource(...)`
- 链接态 K9（同节点红→绿）：
  1. 夹具追加第二个 UID 目录（`GamePlayPhotos/20002/NikkiPhotos_HighQuality/Photo_3.jpg`），既有 `>=` 断言不受影响。
  2. `session.accounts.state()`：默认 `all === true`，两个 UID 分组、`selected === true`。
  3. `setSelection(['10001'])` → `queries.listAssets` 只返回该 UID；越界资产 `listResourceRecords` 为空；`listChanges(0).fullResyncRequired === true`。
  4. `setSelection([])` → 0 条；`setSelection(null)` → 恢复全部。
  5. 独立临时会话（自建 `extraDirectoriesFile` + 临时 images 目录）：`inspect(dir,'spinning_momo')` + `add(id)` → `accounts.state()` 出现 `source:spinning_momo` 分组；`setSource(id,'other')` → 分组消失且目录行 `source` 更新。
- 红测：上述单测与 K9 在实现前失败（`session.accounts` 不存在 / 仓储仍单参 / 判据仍单支）
- 验收：`npx vitest run src/main/nikkisync` 全绿、`0 skipped`；`sync-server-view.test.ts` 默认键集不变、新增两例通过
- 提交：`feat(nikkisync): 接入上游账号同步作用域与目录来源标注`

### N4 · IPC / preload / 共享类型

- 文件：
  - `src/main/ipc/handlers/nikkisync-handler.ts`（文件头**替换**为新的 `// @core-change:` 授权注释）
  - `src/main/ipc/handlers/nikkisync-handler.test.ts`
  - `src/main/preload/api/nikkisync.ts`（文件头**替换** `@core-change`）
  - `src/main/preload/__tests__/preload.test.ts`
  - `src/shared/types/electron-api.ts`
  - `src/renderer/vite-env.d.ts`
  - `src/renderer/stores/nikkisyncContractTypes.test.ts`
  - `docs/IPC_CONTRACT.md`
  - 成功后复用 `emitLibraryChanged`（`nikkisync-handler.ts:328`）推送 `nikkisync:library-changed`，让图库在作用域变更后按 `fullResyncRequired` 刷新
- 通道（4 条新增）：`nikkisync:get-sync-accounts`、`nikkisync:preview-sync-account`、`nikkisync:set-sync-account-selection`、`nikkisync:set-extra-directory-source`
- 形态：
  - `NikkiSyncSyncAccountsInfo = { all: boolean; accounts: Array<{ uid; count; selected; samples: string[] }> }`（`label` 在 handler 剔除以避免中文透传）
  - `NikkiSyncSyncAccountPreviewInfo = { resourceId; mimeType; sourcePath? }`（唯一显式投影：上游返回 DB 资源行，这里只取 UI 需要的三键，文档写明）
  - `NikkiSyncExtraDirectoriesInfo.directories[]` 追加 `source?: 'spinning_momo' | 'other'`
- 红测：handler 通道清单 27→31、zod 拒绝、错误映射、未装配、label 剔除、预览 404；preload 方法清单 28→32、通道转发
- 验收：`npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts src/main/preload` 全绿；`npm run typecheck` 通过
- 提交：`feat(nikkisync): 账号作用域与目录来源 IPC 面（preload + handler + 契约）`

### N5 · 渲染层 UI + 12 语言文案

- 文件：
  - `src/renderer/pages/sync-gallery/SyncServicePage.tsx`
  - `src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`
  - `src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,fr,de,es,pt,ru,th,vi}.json`
  - `src/renderer/i18n/locales/sync-service-keys.test.ts`
- 插位：额外照片目录区块与整理队列之间，新 `<SectionShell title={t('syncService.syncAccounts.title')}>`
- 交互（对齐上游 `AccountSyncPanel`）：
  - “同步全部账号”开关；开启时单项 checkbox 全选且禁用；保存时 `uids: null`
  - 关闭后按 `selected` 渲染可编辑 checkbox；保存发送勾选数组（可为 `[]`，文案提示“全部不勾选将暂不同步照片”）
  - 每账号显示 i18n 文案 + 数量 + 最多 3 张样例缩略图（`previewSyncAccount` → `toFileUrl(sourcePath)`；失败留空）
  - 账号标签：`uid === ''` → 未识别；`'source:spinning_momo'` → 旋转吧大喵；其余 → `UID {{uid}}`
  - 额外目录行（`mode === 'images'`）加来源切换按钮（`spinning_momo` ↔ `other`），成功后刷新目录与账号两处；新增“添加旋转吧大喵目录”按钮，`inspect` 带 `source: 'spinning_momo'`
  - 读取失败 → 隐藏整节；保存失败 → toast + 不乐观更新
- i18n 新 key（12 包全部真译文，禁空串）：
  `syncService.syncAccounts.{title,scopeNote,all,empty,emptyHint,unknownUid,spinningMomo,uidLabel,count,samples,save,saving,saved,saveFailed,loadFailed,previewEmpty}`
  `syncService.extraDirectories.{addSpinning,markSpinning,unmarkSpinning,sourceSpinning,sourceOther,sourceUpdated}`
- 红测：页面用例（渲染/全选/保存 null 与数组/全不选/保存失败/未挂面隐藏/样例缩略图/来源切换/添加旋转吧大喵目录）；`sync-service-keys.test.ts` 等集断言先红
- 验收：`npx vitest run src/renderer/pages/sync-gallery src/renderer/i18n/locales/sync-service-keys.test.ts` 全绿；`npm run i18n:guard` 退出 0
- 提交：`feat(sync-ui): 同步服务页新增账号作用域与目录来源设置（12 语言）`

### N6 · 文档回写 + 全量回归

- 文件：
  - `src/main/nikkisync/AGENTS.md`（类型清单、facade/manager 职责、硬性约定新增“LAN 内容受账号作用域过滤”）
  - `docs/IPC_CONTRACT.md`（通道表、判据、路径字段、账号选择三态）
  - `docs/sync-integration/README.md`（一条状态说明：账号作用域已接入）
  - `docs/plans/2026-10-31-nikkisync-upstream-align-01-实施计划.md`（§7 回写实测读数）
- 全量：
  1. `npm run typecheck`、`npm run typecheck:e2e`
  2. `npm run lint`、`npm run format:check`
  3. `npm run i18n:guard`、`npm run docs:links`、`npm run verify:nikkisync`
  4. `npm test`（与 N0 基线对比，**零新增失败**）
  5. `npm run test:coverage`（阈值门）
  6. `npm run audit`（网络失败记 not-run 并附原因）
- 验收：以上可跑项全部退出 0；`git -C ../NikkiSync status --porcelain` 仍为 0；提交后 `git status --porcelain` 无钩子遗留
- 提交：`docs(nikkisync): 回写账号作用域对齐读数与契约`

---

## 5. 基础测试用例矩阵（每节点至少覆盖三类）

| 模块     | 正常                                 | 异常                          | 边界                                                      |
| -------- | ------------------------------------ | ----------------------------- | --------------------------------------------------------- |
| 契约字段 | DTO 成员集与上游一致                 | 上游缺接口时给出可读差异      | 注释/可选标记/嵌套不误判                                  |
| 路径透出 | `listAssets` 含两键；嵌套搜索含两键  | —                             | path 模式仍返回绝对路径；不写回上游对象                   |
| 账号状态 | `all=true` + 两个 UID 分组           | 会话无 accounts → unavailable | `samples` ≤3；`count` 只算未删除                          |
| 选择写入 | `['10001']` 过滤生效                 | 非法 UID → VALIDATION_ERROR   | `null`=全部、`[]`=零、≤200、重复去重幂等（revision 不变） |
| 变更判据 | `after < revision` → fullResync      | 仓储最小值分支保持原语义      | `after == revision` 不触发；无 accounts 时退回 0          |
| 目录来源 | `setSource` 触发分组出现/消失        | 非法 source / 目录不存在      | `inspect` 只收 `spinning_momo`；`native` 目录拒绝         |
| IPC      | 四通道零转换（label 剔除、预览投影） | 未装配 → PRECONDITION_FAILED  | id 1..128、assetId 1..128、uids >200 拒绝                 |
| 渲染     | 区块渲染、全选、保存 null/数组       | 读取失败隐藏、保存失败 toast  | 无账号空态、全不选、样例预览失败留空                      |
| i18n     | 12 包 key 等集                       | 缺键即红                      | 全部非空串                                                |

---

## 6. 风险、回滚与不做项

| 风险                           | 处置                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| 撤裁剪让渲染层拿到绝对路径     | 属本轮用户裁决；路径本就经 `mode:'path'` 与 `media://` 可达；契约与视图注释同步改写      |
| `sourceGroups()` 在读路径写库  | 上游行为；文档注明，不在本仓加锁或缓存                                                   |
| 作用域变更后本地图库缓存旧数据 | `set-selection` 成功后推送 `nikkisync:library-changed`，图库按 `fullResyncRequired` 重取 |
| 老链接无 `accounts`            | 类型与代码全程可选；缺席即 PRECONDITION_FAILED，不崩页                                   |
| 中文 label 透传                | handler 剔除 `label`，渲染层按 uid + i18n 出文案                                         |
| 测试污染（链接态会话）         | 新 linked 用例照 K3 模板：独立临时库 + `try/finally` dispose + `rmSync`                  |
| 全量测试过长/网络审计失败      | 如实记录读数与 not-run 原因，不伪造绿灯                                                  |

**不做项**（避免越界）：

- 不接入上游移动端 / Windows Shell / Desktop Control Server 的专属页面与接口。
- 不新增设置键：选择存上游 `app_settings['sync_account_selection']`。
- 不修改上游任何文件（`porcelain` 必须持续为 0）。
- 不新增深入口（`LOAD_CHAIN_ROOTS` 保持 13 项；`AccountSyncSettings.js` 已在产物清单）。
- 不修 DEBT-041（上游自身 1 条红，属 supply-chain 记账）。
- 不重打包（`dist:win`），除非另行授权。

---

## 7. 实测读数回写位（执行时填写）

| 项                            | 读数                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 上游锚点复核                  | `b397e0eb6ca1b4748f13a72f13bb1702a549410e` = tag `v1.0.27-public-beta.1`，检出 `porcelain` = 0，四条链接 `check OK`         |
| N0 `npm test` 基线            | `459 passed` / `7199 passed \| 20 skipped (7219)`，71.15s；`verify:nikkisync` = 13 项 OK、blocking 0；`docs:links` 无死引用 |
| N1 红 → 绿读数                | 待填                                                                                                                        |
| N2 红 → 绿读数                | 待填                                                                                                                        |
| N3 链接态读数（含 0 skipped） | 待填                                                                                                                        |
| N4 handler/preload/typecheck  | 待填                                                                                                                        |
| N5 renderer/i18n              | 待填                                                                                                                        |
| N6 全量回归 + coverage        | 待填                                                                                                                        |
| not-run 清单                  | 待填（含原因与复现命令）                                                                                                    |

---

## 8. 提交边界

- 每节点一个 Conventional Commit；**红测与修复同一提交**（仓库 lint-staged 会拒绝带失败用例的提交，禁止 `--no-verify`）。
- 受保护路径 `src/main/preload/api/**`、`src/main/ipc/handlers/**` 的实质改动必须同批附带**一条**真实原因的 `// @core-change:` 注释（替换旧原因，不追加第二条）。
- 不夹带无关格式化/重构；`npm run format` 仅对改动文件执行。
