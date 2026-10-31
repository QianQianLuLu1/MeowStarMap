# 账号作用域收尾审查 · 缺陷修复 · 2.5.6-beta 重打包 · 实施计划

- 日期：2026-10-31
- 审查基线：`main` @ `133a2bd`（工作树干净，无未提交代码）
- 出包基线：`release/` 产物时间 2026-10-31 21:44（对应 `200691f`）⇒ 审查范围 = `200691f..HEAD` 的 7 笔提交
  （`56c6998` 计划文档、`97555c5` 契约字段、`8ecac26` 撤裁剪 + 账号作用域内核、`4570c6e` IPC 面、
  `476fcc7` 同步服务页 UI + 12 语言、`9b7a9c2` / `133a2bd` 文档回写）
- 版本目标：`2.5.6-beta`（现已是该值，见「版本步骤」）
- 落盘状态：2026-10-31 经用户批准入仓；执行读数回写于 §11

---

## 0. 审查结论（先核账）

逐文件核过本轮 diff 与上游 `NikkiSync@b397e0e`（`AccountSyncSettings.ts` / `SyncReadRepository.ts` /
`ExtraScanDirectories.ts` / `LocalSyncServer.ts`）后，**确认 3 个缺陷**，其余抽检通过。

### 0.1 已核验无问题的关键面（不修改）

| 面           | 判据                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 上游语义对齐 | `selection()===undefined` / `null` = 全部、`[]` = 零；`setSelection` 去重排序、同值不 bump；`listChanges` 判据 `after < revision \|\| after < minimum-1` 与上游 `LocalSyncServer.ts:457` 逐字一致                              |
| 作用域接线   | `createQuerySurface` 向 `SyncReadRepository` 注入 `selection` / `sourceGroups` 两闭包，与上游 `LocalSyncServer.ts:162` 同形；`sourceGroups()` 读路径写库属上游行为，本仓未加锁未缓存                                           |
| 晚绑定 thunk | `accountSourceDirectories` 在 `RuntimeCtor` 之前声明、运行期求值，构造期调用回落 `[]`；`ExtraScanDirectories` 第四参 `onSourcesChanged` 与上游 `windows-app.ts:212` 一致                                                       |
| IPC 面       | 4 条新通道均在 `wrapHandler*` 内、zod 界与上游语义一致、`label` 剔除、preview 三键投影、错误短码映射（`invalid_accounts`→VALIDATION、`invalid_source`→VALIDATION、`directory_not_found`→PRECONDITION）；preload 只装配不写业务 |
| 契约/文档    | `stripAssetPathFields` 在 `src/**`、`IPC_CONTRACT.md`、`AGENTS.md` 零残留；§8.2.3 / §8.2.5 与实现一致                                                                                                                          |
| i18n         | 12 包新增键等集、非空串、`{{uid}}` / `{{count}}` 占位逐语言一致（脚本实测无差异）                                                                                                                                              |
| 渲染层       | 保存不乐观更新、失败回滚、缩略图失败留空、`all` 开关提交 `null`、来源切换后刷新账号；`GalleryPage` 对 `fullResyncRequired` 走整页重取，作用域收窄能真正移除条目                                                                |
| 新解析器     | `extractInterfaceMembers` 对注释/字符串/嵌套/可选标记的处理与上游 `index.d.ts` 实形匹配；`protocol.ts` 无正则字面量（不会被误掩码）                                                                                            |

### 0.2 缺陷 D1（功能 · 严重）账号样例缩略图在真机上一律 403

- 根因：`media://` 第 4 条规则只放行 `resource-allowlist` 里**被 `get-resource-records(mode:'path')` 交出过**的确切路径
  （`src/main/app/media-protocol.ts:296-300`）。`accounts.preview()` 走的是 `AccountSyncSettings` 自己的无作用域读仓储，
  其 `source_path` **从未登记**；组件用例 mock 掉 `previewSyncAccount`，故 3 条 UI 用例全绿也测不到。
- 额外事实：被取消勾选的账号其样例本来就不在作用域内，**不能用** `get-resource-records` 补登记（会被作用域过滤成空），
  因此修复必须走主进程直接登记。

### 0.3 缺陷 D2（功能 · 轻）移除额外目录后「同步账号」区块陈旧

- 根因：`handleRemoveDirectory` 只刷新目录清单（`SyncServicePage.tsx:626-634`）。删除一个 `spinning_momo` 目录会让来源分组消失，
  但账号节不重取，仍显示幽灵分组与旧计数，直到切页重进。
- 同类路径已处理：`handleConfirmAdd`（`:617-618`）与 `handleSetDirectorySource`（`:474-476`）都会刷新账号。

### 0.4 缺陷 D3（一致性 · 轻）目录来源变更后不推 `nikkisync:library-changed`

- 根因：`setSource` 改变来源分组 ⇒ 在已有账号选择时资产进出作用域（上游同步 bump journal revision），
  但 handler 未推送库变更（N4 只对 `set-sync-account-selection` 做了）。本地同步图库停留在旧视图，直到下一次扫描。
- 判据：`set-selection` 已有同款推送与其用例（`nikkisync-handler.test.ts:1211-1224`），来源变更是同一类「作用域变更」。

### 0.5 观察项（本轮不修，如实登记）

- 文案 «选择要同步到手机的账号» 与实际行为（本地「同步图库」同样受作用域过滤）存在措辞差；属产品表述，
  且改动需同批改 12 语言，按最小化原则**不修**，仅记录在此。若用户要求可单列一轮。

---

## 1. 依赖声明

**零新增、零变更 npm 依赖。** 但执行链有两个既有事实必须遵守：

| 项                            | 动作 / 判据                                                                                                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`（用户要求必跑） | 会剪掉 4 条 `@nikkisync/*` junction（`node_modules/@nikkisync` 变空壳）⇒ 装完立刻 `npm run link:nikkisync` + `npm run link:nikkisync:check`（期望 `check OK`），再 `npm run verify:nikkisync`                                 |
| 本机工具链                    | Node v26.3.0 / npm 11.16.0（`.node-version` 为 22）⇒ `npm install` 可能改写 `package-lock.json` 的 `libc` 字段；先 `git diff package-lock.json` 取证，若是纯工具链抖动则 `git checkout -- package-lock.json` **还原、不提交** |
| 上游仓                        | `../NikkiSync` HEAD = `b397e0e…`、`git status --porcelain` = 0；**绝不修改上游任何文件**                                                                                                                                      |

## 2. 启动与验证说明

- 环境：Windows x64；开发启动 `npm run dev`（本任务不依赖 GUI，UI 交互由组件用例覆盖）。
- 全部命令均已在 `package.json` 中确认存在：`install / build / test / typecheck / typecheck:e2e / lint /
format:check / i18n:guard / docs:links / verify:nikkisync / audit / test:coverage / test:ci-linux /
e2e:smoke / dist:win / verify:dist / link:nikkisync(:check) / pre-dist-check`。

## 3. 错误处理与参数校验（本轮不新增入参）

| 面                                          | 处理                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `preview` 资源行缺 `source_path` / 非字符串 | 不登记、不抛额外错误，返回既有投影（`sourcePath` 缺省 ⇒ 渲染层不渲染该图）                         |
| `preview` 资产不存在                        | 维持 `NOT_FOUND`（manager 抛 `NikkiSync asset not found`，不改）                                   |
| 登记表条目上限                              | 沿用 `MAX_ENTRIES` 插入序淘汰，不新增路径                                                          |
| 移除目录失败                                | 维持现有 `showError`，且失败时不刷新账号（`await` 在 try 内、异常先抛）                            |
| `library-changed` 推送失败                  | 复用 `notifyLibraryChanged` 的 try/catch（通知尽力而为，不改变成功结果）                           |
| zod 边界                                    | 无新增通道/入参；现存 4 条通道的界（assetId 1..128、id 1..128、uids ≤200×64、source 枚举）保持不变 |

## 4. 修复设计（最小化、优先复用）

### D1 — 主进程在 preview 时登记确切路径

- `src/main/nikkisync/resource-allowlist.ts`：把 `registerNikkiSyncResourcePaths` 的「归一 + 先删后插 + 上限淘汰」
  抽成私有 `appendKey()`，新增导出 `registerNikkiSyncResourcePath(filePath)`：**只追加、不改写/比对表所属 revision**
  （preview 没有 `libraryRevision` 上下文）。语义：表已带 revision N 时保持 N；表未初始化时保持未初始化，
  后续首次按 revision 登记不会清掉该条；下一次 revision 滚动时随整表一起失效（样例会随状态刷新重新登记）。
- `src/main/nikkisync/runtime-manager.ts`：`previewSyncAccount` 取到行后，用
  `registerNikkiSyncResourcePath(row.source_path)` 登记该确切文件，再返回（不改返回值、不改投影）。
- `docs/IPC_CONTRACT.md` §8.2.5：在 preview 条目后补一句「主进程登记该 `source_path` 到 `media://` 授权表」。

### D2 — 移除目录后刷新账号节

- `src/renderer/pages/sync-gallery/SyncServicePage.tsx`：`handleRemoveDirectory` 成功后，若 `syncAccounts` 可见则
  `await refreshAccounts()`（与 `handleConfirmAdd` 同款，不新增 toast）。

### D3 — 来源变更后推送库变更

- `src/main/ipc/handlers/nikkisync-handler.ts`：`nikkisync:set-extra-directory-source` 改成
  `wrapHandlerRaw(ctx, async (args, _ctx, event) => …)`，成功返回后 `notifyLibraryChanged(event)`；
  文件头 `// @core-change:` **替换**为新原因（本批改动，不复用旧原因）。
- `docs/IPC_CONTRACT.md` §8.2.3：补「成功后推送 `nikkisync:library-changed`」。

## 5. 基础测试用例矩阵（先红后绿，同一提交内）

| 修复       | 正常                                                            | 异常                                     | 边界                                                                                                                   |
| ---------- | --------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1 授权表  | preview 后 `isNikkiSyncResourcePath('D:/photos/a1.jpg')` = true | preview 不存在 ⇒ 仍 `not found` 且不登记 | 行无/空 `source_path` 不登记不抛；已有 revision 时追加不改 revision；未初始化时后续整表登记不清该条；空串/非字符串忽略 |
| D2 页面    | 移除目录后 `getSyncAccounts` 再次调用                           | 移除失败 ⇒ `showError` 且不刷新账号      | 账号节不可见（老链接）⇒ 不额外调用                                                                                     |
| D3 handler | 来源变更成功 ⇒ `event.sender.send('nikkisync:library-changed')` | 上游抛 `invalid_source` ⇒ 不推送         | 发送函数抛错 ⇒ 仍返回成功（`notifyLibraryChanged` 静默）                                                               |

**红测证明方式**：先落测试并跑 `npx vitest run <file>` 收集失败原文（D1：`expected false to be true`；
D2：`getSyncAccounts` 调用数定格在 1 导致 `waitFor` 超时；D3：`send` 未被调用），再实现转绿；
提交后复跑同一文件，读数入 commit message 与本文件 §11。

## 6. 分步执行

### 阶段 A（唯一动作 + 停点）

1. 本文件落仓为 `docs/plans/2026-10-31-review-nikkisync-scope-fixes-repack.md`。
2. `git add` 并单独提交 `docs(plans): 落盘账号作用域收尾审查与 2.5.6-beta 重打包计划`。
3. 停下，等用户回「继续 / 按计划执行」后再动代码。

### 阶段 B（逐节点真跑，自己读报错自己修）

| 节点                  | 涉及文件                                                                             | 输入 → 输出                    | 验收（客观判据）                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0 取证               | 无                                                                                   | —                              | `git status --porcelain` 空；`node -v` / `npm -v` 记录；上游 porcelain = 0                                                                                                                                        |
| B1 `npm install`      | `package-lock.json`（只读核对）                                                      | 依赖树 → 退出码                | exit 0；`git diff --stat package-lock.json` 如有输出则判定性质（工具链抖动 ⇒ 还原）                                                                                                                               |
| B2 恢复链接           | `node_modules/@nikkisync/*`                                                          | install 后剪链 → 4 条 junction | `npm run link:nikkisync` 成功、`link:nikkisync:check` = `check OK`、`verify:nikkisync` = 13 项 OK / blocking 0                                                                                                    |
| B3 D1 红→绿           | `resource-allowlist.ts(.test.ts)`、`runtime-manager.ts(.test.ts)`、`IPC_CONTRACT.md` | preview 行 → 授权表含确切路径  | 新增用例修复前红、修复后绿；`npx vitest run src/main/nikkisync` 全绿 0 skipped                                                                                                                                    |
| B4 D2 红→绿           | `SyncServicePage.tsx(.test.tsx)`                                                     | 移除目录 → 账号节重取          | 新用例修复前红、修复后绿；`npx vitest run src/renderer/pages/sync-gallery` 全绿                                                                                                                                   |
| B5 D3 红→绿           | `nikkisync-handler.ts(.test.ts)`、`IPC_CONTRACT.md`                                  | setSource 成功 → 推送库变更    | 新用例修复前红、修复后绿；`npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts` 全绿                                                                                                                   |
| B6 变更闭环           | 全部改动                                                                             | —                              | `npm run verify`：typecheck / lint / core-gate / format / test 全 ✓                                                                                                                                               |
| B7 全量门（用户清单） | —                                                                                    | —                              | 见 §7，六项必须全绿                                                                                                                                                                                               |
| B8 附加门             | —                                                                                    | —                              | `lint` / `typecheck:e2e` / `i18n:guard` / `docs:links` / `verify:nikkisync` / `format:check` / `test:coverage` 退出 0；`audit` 若网络不可用记 not-run 并附原因                                                    |
| B9 提交               | CHANGELOG + 上述文件                                                                 | —                              | 2 笔 `fix(...)` 提交（主进程 D1+D3 一笔、渲染层 D2 一笔，各含红测读数入 message）；CHANGELOG 在既有 `[2.5.6-beta]` 的 `### Fixed` 首位追加一条，`[Unreleased]` 保持空；提交后 `git status --porcelain` 无钩子残留 |
| B10 版本              | 版本声明位                                                                           | 核对 → 零编辑                  | `node -e` 读 `package.json` / lock 均为 `2.5.6-beta`；preview mock / README / ARCHITECTURE / DEVELOPMENT / AGENTS 逐处一致；`npx tsx scripts/check-changelog-release.ts` 三 ✔                                     |
| B11 重打包            | `release/`                                                                           | HEAD 源码 → Setup 安装包       | 见 §8                                                                                                                                                                                                             |
| B12 包内取证          | `release/`                                                                           | 包 → 读数                      | 见 §8；并复跑 `npm run e2e:smoke` 指向新树                                                                                                                                                                        |

## 7. 用户清单验证（阶段 B7，逐项记录退出码与读数）

| 命令                    | 判据                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `npm install`           | exit 0；锁文件无人工改动                                                                 |
| `npm run build`         | exit 0；`dist/main/main/app/index.js`、`dist/renderer/index.html` 存在                   |
| `npm run test`          | 0 failed；文件数/通过数 ≥ 基线（`459 passed / 7238 passed \| 20 skipped`）+ 本轮新增例数 |
| `npm run typecheck`     | exit 0                                                                                   |
| `npm run e2e:smoke`     | 全过；日志 `[e2e] executable: release/win-unpacked/喵星图.exe`                           |
| `npm run test:ci-linux` | 0 failed（基线 `459 files / 7216 passed \| 3 skipped`）                                  |

## 8. 重打包（阶段 B11–B12）

1. **先备份不可再生产物**：把 `release/MeowStarMap-Setup-2.5.6-beta.exe`、`.blockmap`、`latest.yml`
   复制到 `_safe_backup_release-2.5.6-<时间戳>/`（`release/` 与 `_safe_backup_*` 均被 gitignore）。
2. 首选标准配方 `npm run dist:win`（含 `build:recycle-helper` → `build` → `pre-dist-check` →
   electron-builder → `verify:dist`）。
3. 若复现既有 EPERM/EBUSY（安全软件锁 `win-unpacked.tmp` / 新 asar）⇒ 用已验证旁路（不改任何配置）：
   缓存解出的干净 electronDist（排除 `resources/default_app.asar` 与 `version`）+ `--config.electronDist=<dir>`
   - `--config.directories.output=release/build-<标签>`，产物出来后
     `cp -rf release/build-<标签>/win-unpacked release/win-unpacked`（读取/覆盖允许，rename/unlink 才被锁），
     再**裸跑** `npm run verify:dist` 使其自己变绿；旧 `release/build-*` 残壳当前只剩被锁的 `app.asar`、
     无 `app.asar.unpacked`（已实测），不会抢走 `findAsarUnpacked` 首命中。
4. 包内取证（强判据）：新旧 `latest.yml` 的 `size` 与 `sha512` 两轴都不同；用 `@electron/asar` 的
   `extractFile` 取包内主入口与盘上 `dist/main/main/app/index.js` 逐字节相等；`verify:dist` 回显的 asar
   路径指向 `release/win-unpacked`。
5. 出包后复跑 `npm run e2e:smoke`（打包态入口 `launchApp()`），确认验的是新树。

## 9. 风险与红线

- 不做无关重构/格式化；不改上游 NikkiSync；不改 12 语言文案（观察项见 §0.5）。
- 禁止 `--no-verify`、`it.skip`、删改测试、弱化断言；红测必须真红。
- 提交前 `npm run verify`，提交后 `git status --porcelain` 复核钩子残留，并对提交后内容复跑受影响用例。
- `release/` 覆盖是破坏性动作：不可再生的旧 Setup 先备份、先说清；旁路只作绕锁，不修改 `package.json` 打包配置。
- 环境阻塞（安全软件持续锁新 asar）时如实报「前提不成立」，并把唯一剩余动作写清，不伪造绿灯。

## 10. 不做项

- 不接入上游移动端 / Windows Shell / Desktop Control Server 面。
- 不修 DEBT-041（上游自身用例红，属供应链记账）。
- 不改「未提交代码」：工作树本就干净，不虚构提交。

## 11. 实测读数回写位（执行时填写）

| 项                        | 读数 |
| ------------------------- | ---- |
| B0 取证                   | 待填 |
| B1 `npm install`          | 待填 |
| B2 链接恢复               | 待填 |
| B3 D1 红 → 绿             | 待填 |
| B4 D2 红 → 绿             | 待填 |
| B5 D3 红 → 绿             | 待填 |
| B6 `npm run verify`       | 待填 |
| B7 六项清单               | 待填 |
| B8 附加门                 | 待填 |
| B9 提交                   | 待填 |
| B10 版本核对              | 待填 |
| B11 重打包                | 待填 |
| B12 包内取证 + 复跑 smoke | 待填 |
| not-run 清单              | 待填 |
