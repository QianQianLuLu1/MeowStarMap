# NikkiSync 上游同步 · 05 结案报告（阶段 5：全量回归、打包态验证与结案交付）

> 生成日期：2026-10-26 · 执行依据：已批准的 [`02-实施计划`](../../2026-10-25-nikkisync-upstream-sync-02-实施计划.md) §9 全局验证矩阵 + 阶段 5 任务书
> 阶段 5 开工时本仓 HEAD：`9a8a1fb`（能力层收尾提交后）；本系列起点 `dc9f085`，区间 **16 次提交 / 63 文件 / +7470 −94**
> 上游锚定：`b4221933be9714fde0c260b1f19bdaa6d1337fd3`（阶段 3/4/5 全程 `git -C ../NikkiSync status --porcelain` = **0 行**，零上游源码修改）
> 环境：Node v26.3.0 / npm 11.16.0 / PowerShell / Windows x64 / electron 41.10.6；四条 junction 在位，`verify:nikkisync` 12 项全 ✓
> 本轮不做：新功能、重构、格式化 sweep、上游源码修改、`@nikkisync` 写回 package.json 依赖声明

---

## 1. 结论与验收对照

**总判定：可以结案交付。** 全量自动化校验零失败、零新增失败；链接态套件真实执行而非 skip，未链接默认态的 skip/warn 语义经双路取证仍然成立；完整 Windows 安装包出包且解包资源齐备；无法自动化的项已全部列入 §8 并显式标注「未自动化验证」，无一被谎报通过。

| #   | 验收标准（阶段 5 任务书）                                              | 结论 | 证据锚                                         |
| --- | ---------------------------------------------------------------------- | ---- | ---------------------------------------------- |
| 1   | 全量自动化校验零新增失败，链接态测试真实执行全绿、未链接 skip 语义保持 | ✓    | §5 全表 + §5.2 skip 归属表                     |
| 2   | 构建/打包态产物核查通过，迁移与深入口资源在 asar.unpacked 可用         | ✓    | §5.3 构建与打包证据 Ⓐ–Ⓔ                        |
| 3   | 结案报告与手动清单齐备，每个结论可追溯到命令证据                       | ✓    | 本文档 §5（每条含命令与读数）与 §8             |
| 4   | 红项或未验证项有明确处置，不得静默收尾                                 | ✓    | §6 已知缺口（含处置）与 §8（逐条标注未自动化） |

失败二分（对照阶段 4 F-2 基线，**同口径重跑**）：

| 类别           | 数量 | 明细                                                   |
| -------------- | ---- | ------------------------------------------------------ |
| 本仓既存失败   | 0    | 矩阵十步 + 双态取证 + 打包 + e2e 全部 exit 0           |
| 本阶段新增失败 | 0    | 无红灯，故未产生任何代码修复提交（无一文件因缺陷改动） |

---

## 2. 上游整合事实

### 2.1 上游侧（NikkiSync 检出 `../NikkiSync`）

| 项           | 事实                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 整合起点 SHA | `d4ca7d7a164d44ca91dcc3e7e7604b9839296ad3`（2026-10-13，`fix(android): save motion photos as rotated videos or LIVE`）                                                                                                    |
| 整合目标 SHA | **`b4221933be9714fde0c260b1f19bdaa6d1337fd3`**（origin/main，2026-10-24 推送）                                                                                                                                            |
| 提交区间明细 | `git -C ../NikkiSync log --oneline --no-decorate d4ca7d7..origin/main` = **12 提交**；`rev-list --left-right --count main...origin/main` = `0 12`（零分叉，fast-forward 前进）                                            |
| 总体体量     | `git -C ../NikkiSync diff --stat d4ca7d7..b422193                                                                                                                                                                         | tail -1` = **376 files, +16421, −682** |
| 消费面内     | 74 文件（`packages/` 10 + `apps/pc-companion/` 58 + 根构建 6）                                                                                                                                                            |
| migrations   | `git diff --stat d4ca7d7..b422193 -- packages/database/migrations packages/database/src/database-manager.ts packages/database/scripts` = **空输出**；目标态仍仅 `0001_initial.sql` ⇒ 本仓零适配、老库零迁移（详见 03 §3） |
| 上游干净度   | 阶段 5 全程 Working tree 0 行 porcelain（多次复查），**未修改上游任何源码**                                                                                                                                               |

### 2.2 本仓侧（`dc9f085` → `9a8a1fb`，16 提交）

| #   | SHA       | 节点     | 主题摘要                                                                                      |
| --- | --------- | -------- | --------------------------------------------------------------------------------------------- |
| 1   | `b8c78e9` | 步骤 0   | 01 影响评估 + 02 实施计划入库并记录批准裁示（§14 Q1–Q6 按提案通过）                           |
| 2   | `c48a037` | C2       | 探针必需导出表收紧 + 能力深入口产物核查清单（`NIKKISYNC_CAPABILITY_ARTIFACTS`）               |
| 3   | `f43faa9` | C3       | 迁移 SQL 收口（零适配落档）与老库重开零迁移证明                                               |
| 4   | `9bb771b` | C4       | vendored 协议/域类型真相源对齐上游（多 host 配对 URI、`connectionHosts`、`pose`/camera 字段） |
| 5   | `505718c` | C5       | 装载面结构跟随（`runtime-types` 十项声明 + facade 四注入缝）                                  |
| 6   | `6402cb5` | 阶段收口 | 03 兼容层执行记录落盘与 02 §16 回填                                                           |
| 7   | `332e0de` | K1       | 启动阶段观测 + 缓存解码元数据接线                                                             |
| 8   | `54e5e21` | K2       | 元数据在线解析许可/隐私开关（fail-closed 同意门，双重默认关）                                 |
| 9   | `3c7ab84` | K3       | 游戏版本推断展示（上游静态日历表，纯本地无出站）                                              |
| 10  | `6f4e44d` | K4       | 连接诊断面（纯聚合观测，零主动探测）                                                          |
| 11  | `476182b` | K5       | 多 host 配对（设置键默认关、`parsePairingUri` 双格式、QR 备选地址）                           |
| 12  | `fb17ee5` | K6       | 额外照片目录（上游 0600 JSON 单一真相源、五通道八短码映射）                                   |
| 13  | `887103d` | K7       | 扫描诊断观测面（纯计数快照，不发明修复动作）                                                  |
| 14  | `9cf6bfc` | K8       | 批量删除/离线整理（回收站 helper + 开关门三通道 + 整理队列区）                                |
| 15  | `5e308e9` | F-2      | 矩阵揪出的两处既有欠账修复（旧名台账核账 + helper 测试元组断言）                              |
| 16  | `9a8a1fb` | F 收尾   | 04 执行记录落盘、02 §16 回填、计划文档死引用修复                                              |

阶段 5 自身产出：`docs/plans/archive/2026-Q4/2026-10-25-nikkisync-upstream-sync-05-结案报告.md`（本文档）+ 三处最小文档事实订正（见 §6.3）。

---

## 3. 变更文件分类清单

基数：`git diff --stat dc9f085..HEAD | tail -1` = **63 files changed, 7470 insertions(+), 94 deletions(-)**；精确清单以 `git diff --name-status dc9f085..HEAD` 为准。下表为人工分类（每类均注明节点归属）。

| 分类             | 数量 | 文件（省略 `dc9f085..HEAD` 前缀）                                                                                                                                                                                                                                                                                                                         | 节点        |
| ---------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| ① 装载缝与运行时 | 12   | `src/main/nikkisync/runtime-loader.ts`、`runtime-facade.ts`、`runtime-manager.ts`、`runtime-types.ts`、`sync-server-view.ts`、`protocol-contract.ts` 及配套测试 `runtime-loader.test.ts`、`runtime-facade.test.ts`、`runtime-facade.linked.test.ts`、`sync-server-view.test.ts`、`sync-server.linked.test.ts`、`runtime-manager.test.ts`                  | C2/C5/K1–K8 |
| ② 元数据解析面   | 4    | `src/main/nikkisync/metadata-resolver.linked.test.ts`（阶段 6 已有实现，本轮回归参与）、`src/main/app/nikkisync-runtime-setup.ts`+`__tests__/nikkisync-runtime-setup.test.ts`（装配点与 K2/K5/K8 注入）、`protocol-contract.test.ts`                                                                                                                      | K2/K5/K8    |
| ③ IPC 与 preload | 6    | `src/main/ipc/handlers/nikkisync-handler.ts`（+ 同名 `.test.ts`）、`src/main/ipc/handlers/settings-handler.test.ts`、`src/main/preload/api/nikkisync.ts`、`src/main/preload/__tests__/preload.test.ts`（方法清单 17→28）、`src/shared/types/electron-api.ts`                                                                                              | K2/K3/K6/K8 |
| ④ 共享契约层     | 4    | `src/shared/sync/protocol.ts`（`buildPairingUri` 双分支、`ServerInfoResponse.connectionHosts`）、`src/shared/sync/domain-types.ts`、`src/shared/sync/protocol.test.ts`、`src/shared/settings-keys.ts`                                                                                                                                                     | C4/K5/K8    |
| ⑤ 渲染层         | 7    | `src/renderer/pages/sync-gallery/SyncServicePage.tsx`（+ 同名 `.test.tsx`）、`src/renderer/pages/sync-gallery/SyncAssetDrawer.tsx`（+ 同名 `.test.tsx`）、`src/renderer/components/sync/PairingQrDialog.tsx`（+ 同名 `.test.tsx`）、`src/renderer/vite-env.d.ts`                                                                                          | K1–K8       |
| ⑥ i18n           | 14   | `src/renderer/i18n/locales/{en,zh-CN,zh-TW,ja,ko,fr,de,es,pt,ru,th,vi}.json`（各 4056 keys）+ `sync-service-keys.test.ts`、`sync-gallery-keys.test.ts` 守卫扩展                                                                                                                                                                                           | 全能力层    |
| ⑦ 脚本闸门与打包 | 8    | `scripts/verify-nikkisync-link.ts`（第 12 项检查）、`scripts/pre-dist-check.ts`（`missingPackedCapabilityArtifacts` 等）、`scripts/build-recycle-helper.cjs`+`scripts/__tests__/build-recycle-helper.test.ts`、`scripts/__tests__/{pre-dist-check,verify-nikkisync-link}.test.ts`、`scripts/__tests__/old-name-ledger.json`、`package.json`、`.gitignore` | C2/C5/K8    |
| ⑧ 新增源码资源   | 1    | `resources/nikkisync/recycle-helper.cs`（C# 回收站 helper 源码，exe 由 `build:recycle-helper` 产出且已 gitignore）                                                                                                                                                                                                                                        | K8          |
| ⑨ 文档           | 7    | `docs/plans/*01–04*.md`（系列文档）、`docs/IPC_CONTRACT.md`（§8.1/§8.1.5/§8.2 落档）、`CHANGELOG.md`（2.5.5 节 2026-10-25 条目）                                                                                                                                                                                                                          | C1–F        |

核对：基类 ①–⑨ 计数合计 63，与 `--stat` 一致（测试文件按实际路径归并到其被测层）。

---

## 4. 依赖与设置项变更

### 4.1 依赖

- **零 npm 依赖新增/删除**：本系列 16 提交内 `package.json` 的 `dependencies` / `devDependencies` / `optionalDependencies` 全部无改动；
  `@nikkisync/*` **始终不是声明依赖**（自包含设计，见 `docs/sync-integration/09-legacy-debt-remediation-plan.md`），由 `npm run link:nikkisync` 在开发机显式建 junction。
- 实证：`verify:nikkisync` 第 1 项「dependency graph is self-contained (no out-of-repo file: specs)」✓；`scripts/__tests__/self-contained-deps.test.ts` 随全量测试绿。
- `package.json` 的真实改动仅三处，均属**脚本与打包编排**，非依赖：

| 改动位置                       | 内容                                                                 | 节点 |
| ------------------------------ | -------------------------------------------------------------------- | ---- |
| `scripts.build:recycle-helper` | 新增，`node scripts/build-recycle-helper.cjs`                        | K8   |
| `scripts.dist:win`             | 链首追加 `npm run build:recycle-helper`                              | K8   |
| `build.files`                  | 追加 `!resources/nikkisync/*.exe`（防 helper 双入 asar）             | K8   |
| `build.extraResources`         | 新增 `{from: resources/nikkisync, to: nikkisync, filter: ["*.exe"]}` | K8   |

### 4.2 设置项

新增两个布尔键（均在 `src/shared/settings-keys.ts` 白名单内，**默认 false**）：

| 键                           | 默认  | 消费点                                                    | 语义                                                                       |
| ---------------------------- | ----- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `nikkisync.multiHostPairing` | false | `src/main/app/nikkisync-runtime-setup.ts`                 | 关闭 ⇒ 配对串仍是 `NS1                                                     | `七段逐字节不变；开启 ⇒`nikki-sync://pair?`+`hosts`（≤8） |
| `nikkisync.organizerEnabled` | false | `src/main/ipc/handlers/nikkisync-handler.ts` 三通道开关门 | 关闭 ⇒ 三条 organizer 通道一律 `PRECONDITION_FAILED`；破坏性能力双保险之一 |

既有四键（`nikkisync.syncServerEnabled`、`nikkisync.runtimeEnabled`、`nikkisync.metadataResolverEnabled` 及同步服务端口相关）**语义与默认值均未变**。

---

## 5. 验证证据索引

> 口径：每条记录「命令 → 关键读数 → 结论」。命令均已在 `package.json` 中核实存在；读数取自本机实跑输出。
> 时点：除注明外均为 2026-10-26 00:00–00:10（UTC+8）执行于 HEAD `9a8a1fb`。

### 5.1 静态与测试矩阵（对应 02 §9 第 1–7 步）

| #   | 命令                       | 关键读数                                                                                                                                                                             | 结论                           |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| 1   | `npm run verify`           | `[VERIFY] 总计: 2 项, 0 失败`（core-gate 695ms / format 371ms）；TS 变更 ⊘ 跳过                                                                                                      | ✓                              |
| 2   | `npm run typecheck`        | `tsc -b && tsc -p tsconfig.scripts.json` 无错误输出，exit 0（**含 scripts 工程**，覆盖 `verify` 收不到的面）                                                                         | ✓                              |
| 3   | `npm run typecheck:e2e`    | `tsc --noEmit -p e2e` exit 0                                                                                                                                                         | ✓                              |
| 4   | `npm run lint`             | `eslint .` exit 0，零 error                                                                                                                                                          | ✓                              |
| 5   | `npm run format:check`     | `All matched files use Prettier code style!` exit 0（`--end-of-line auto`，闸门作用域）                                                                                              | ✓                              |
| 6   | `npm test`                 | **Test Files 444 passed (444)；Tests 6942 passed │ 12 skipped (6954)；Duration 71.46s**；exit 0                                                                                      | ✓（与阶段 4 F-2 基线逐位一致） |
| 7   | `npm run i18n:check`       | 12 locale 各 4056 keys 对齐，`✅ 所有 locale 文件 key 对齐校验通过`                                                                                                                  | ✓                              |
| 8   | `npm run i18n:guard`       | `✅ 白名单只减不增、清零必移除、key 已同步，守卫通过。`                                                                                                                              | ✓                              |
| 9   | `npm run docs:links`       | HEAD 基线：`✅ 无死引用（另有 160 处提醒）`，exit 0；本文档落盘后复跑：`✅ 无死引用（另有 161 处提醒）`，exit 0（新文档未引入死链，提醒均为历史定义的「本机留存区/已交代去向」两类） | ✓                              |
| 10  | `npm run verify:nikkisync` | **12 项全 ✓，`OK (blocking failures: 0)`**（第 7 项：zero `require("@nikkisync` hits across `dist/main/main/app/*.js`）                                                              | ✓                              |

### 5.2 skip 归属与双态取证

**全量测试 12 条 skip 的精确归属**（静态核算 + 报告计数互证，两者同为 12）：

| 来源文件                                    | 条数  | 门控形态                                                     | 性质      |
| ------------------------------------------- | ----- | ------------------------------------------------------------ | --------- |
| `src/main/utils/ci-linux-emulation.test.ts` | 10    | `it.skipIf(!ACTIVE)`（CI 宿主模拟装置未激活）                | 预期 skip |
| `src/main/sync/identity-service.test.ts`    | 2     | `it.skipIf(process.platform === 'win32')`（POSIX 0600 权限） | 预期 skip |
| 链接态六套件                                | **0** | `hasNikkiSyncLink(projectRoot)` 为真 ⇒ 全量真实执行          | 无 skip   |

**链接态真执行 vs 未链接 skip/warn（同一命令对照）**：

| 状态     | 命令                                | 读数                                                                                                                                                                   | 结论                                              |
| -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 已链接   | `npx vitest run src/main/nikkisync` | **Test Files 16 passed (16)；Tests 276 passed (276)，0 skipped；24.17s**                                                                                               | ✓ 真执行                                          |
| 未链接   | 同上（`@nikkisync` 临时移出期间）   | **Test Files 13 passed │ 3 skipped (16)；Tests 232 passed │ 44 skipped；1.31s**；exit 0                                                                                | ✓ skip 语义成立（环境缺失未被记成失败）           |
| 未链接   | `npm run verify:nikkisync`          | 12 项全 ✓，其中 5 项为 `skipped (no links present)`；第 2 项给出「embedding lane inactive … supported default state」提示文本；**`OK (blocking failures: 0)`，exit 0** | ✓ warn/skipped 语义成立，环境缺失未伪装成逻辑失败 |
| 还原复核 | `npm run link:nikkisync:check`      | `check OK (all four links in place)`；随后重跑域测试 276/276 全绿                                                                                                      | ✓ 无残留改动                                      |

> 沙箱方法：`Move-Item node_modules\@nikkisync → @nikkisync.stage5.bak`（**只移不删**，绕本机 Safe-Delete 网关且 100% 可逆）→ 取证 → 反向 Move 还原 → `link:nikkisync:check` + 域测试复跑。实验期间未执行任何 `npm install`（会剪 junction）。
> 交叉印证：移出前后总用例数同为 276 ⇒ 恰好 44 条用例为链接门控、232 条为无链接亦必跑。

### 5.3 构建与打包态（对应 02 §9 第 8–9 步）

| 锚  | 命令 / 核查                          | 关键读数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 结论                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Ⓐ   | `npm run build`                      | `✓ built in 5.21s`，exit 0（`dist/main`、`dist/renderer` 重建，`dist/main/package.json` = `{"type":"commonjs"}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ✓                    |
| Ⓑ   | `npm run verify:nikkisync`（构建后） | 第 7 项 `zero require("@nikkisync hits across dist/main/main/app/*.js`；`OK (blocking failures: 0)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | ✓ 无折叠 `require()` |
| Ⓒ   | `npm run dist:win`（四段链）         | ① `build:recycle-helper`：`built …\resources\nikkisync\nikkisync-recycle-helper.exe`；② build ✓；③ `pre-dist-check`：`✔ 原生模块 ABI 闸门通过 electron=41.10.6 npmRebuild=true` + `check-doc-versions ✅` + `check-changelog-release ✅`（附 ⚠：工作区有未提交改动=既有 `package-lock.json`，非阻断）；④ `electron-builder --win`：`packaging platform=win32 arch=x64 electron=41.10.6`、`building target=nsis file=release\MeowStarMap-Setup-2.5.5.exe` 并签名 uninstaller + installer；⑤ `verify:dist` `✅ 解包产物校验通过`。**整链 exit 0**                                                        | ✓ 完整安装包出包     |
| Ⓓ   | `verify:dist`（`--verify-asar`）逐项 | ✔ better-sqlite3 `.node` / ✔ sharp `sharp-win32-x64-0.35.5.node` / ✔ libvips `libvips-42.dll` / ✔ koffi `koffi.node` / ✔ **@nikkisync migrations `0001_initial.sql` 已解包** / ✔ 四包入口已解包（core、database、protocol、pc-companion）/ ✔ `row-mappers.js` / ✔ `LocalSyncServer.js` / ✔ `GalleryRuntime.mjs` / ✔ **能力深入口产物 7 项全部解包** / ✔ `requestedExecutionLevel=asInvoker` / ✔ 32 条禁串零命中（`app.asar` 71,746,207 字节）                                                                                                                                                          | ✓ 解包资源齐备       |
| Ⓔ   | 人工逐项核查（PowerShell）           | 解包树文件数：core **38** / database **53** / pc-companion **438** / protocol **11**；迁移 SQL **6615 B**；helper exe **5120 B**（落 `resources\nikkisync\`）；12 个深入口全部在位：`LocalSyncServer.js`(32454B)、`row-mappers.js`(6680B)、`GameVersionCalendar.js`(3323B)、`LanAddress.js`(2369B)、`Nuan5CompatibleResolver.js`(3737B)、`MetadataResolutionDiagnostics.js`(3615B)、`CachedDecodedMetadataService.js`(1943B)、`MetadataOnlineConsent.js`(3610B)、`DeletionQueue.js`(22088B)、`ExtraScanDirectories.js`(12246B)、`ScanDiagnostics.js`(963B)、`core\dist\src\decoded-metadata.js`(7631B) | ✓ 逐项点名无缺       |

**打包态迁移路径解析亲读**（第二条独立证据，判据不同于文件存在性；一次性命令、未落任何新脚本）：

- 构造：`buildPackagingContext({isPackaged:true, resourcesPath:'release\win-unpacked\resources', projectRoot:'<repo>'})`
- `resolveModuleRoot()` 四包全部命中 `…\app.asar.unpacked\node_modules\@nikkisync\<pkg>`，**`fellBackToAsar=false`**（未回落 asar）
- `resolveMigrationsSqlPath()` → `…\app.asar.unpacked\node_modules\@nikkisync\database\migrations\0001_initial.sql`
- `readMigrationsSql()` → **6615 bytes**，首 70 字符 `"PRAGMA foreign_keys = ON;\r\nPRAGMA journal_mode = WAL;\r\nPRAGMA synchron"` ⇒ **打包态 SQL 可解析且可读**
- `resolveDeepEntryUrl()` → `file:///…/@nikkisync/pc-companion/dist/src/server/LocalSyncServer.js`、`…/metadata/Nuan5CompatibleResolver.js`（深入口 URL 形态正确）

> 产物时点声明：Ⓒ 的 `dist:win` 执行于阶段 5 文档订正之前，因此安装包对应源码 HEAD `9a8a1fb`；阶段 5 的后续改动全部是 `.md` 文档（不参与 `build.files`），对 app.asar 内容无影响。

### 5.4 e2e 与冒烟（对应 02 §9 第 10 步）

| #   | 命令                                                                                 | 关键读数                                                                                                                                                                         | 结论                                            |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | `npm run e2e:smoke`（`--grep-invert @perf`，配置 `e2e/playwright.config.ts`）        | **16 passed (25.5s)**，exit 0；含 S1 启动/主窗口、S2 非白屏、S3 preload 四对象、S4 版本探针、S5 DB/原生模块探针、S6 静置稳定性、S7 首装自动扫描、S8 GPU 探针 + userData 隔离校验 | ✓                                               |
| 2   | 同上批次内的 NikkiSync N 套件                                                        | `[e2e-nikkisync] linkGate=run — @nikkisync 链接就绪：N 套件按原断言执行`；N1(6.3s)/N2/N3/N3b/N3c(1.9s)/N4 全 ok                                                                  | ✓ 真执行（`decideNikkiSyncGate` 未降级为 skip） |
| 3   | `npx playwright test --config e2e/playwright.config.ts e2e/nikkisync-runtime.e2e.ts` | **6 passed (7.6s)**，exit 0                                                                                                                                                      | ✓ 专项证据                                      |

---

## 6. 已知缺口与遗留

### 6.1 未自动化项（全部移入 §8 手动清单，无一谎报）

自动化边界说明（避免误读「绿=真机可用」）：

- **N3b** 已在真实主进程内起上游 `LocalSyncServer` 并用外部进程做证书真校验，但**只覆盖 PC 侧服务可用性**；第三方 Android 客户端的扫码、拉流、删除回传均未自动覆盖。
- **K8** 全套单测/链接态集成**刻意不构造真实文件**（不触发 `executing` 态），因此「批准 → 真实回收 → 回收站恢复」全链**没有自动化证据**。
- **K2** 同意 UI 有单测覆盖，但「实际外发字段」只能靠真机抓包核对。

### 6.2 继承自前序节点的遗留（03 §7.2 / 04 §3 共 17 项，处置均已落档）

要点摘录（完整表见 03 §7.2 与 04 §3）：

| #   | 遗留                                                          | 状态                                            |
| --- | ------------------------------------------------------------- | ----------------------------------------------- |
| 1   | C4 红灯用例系会话外工作区预置（逐行审查后采纳）               | 已登记，已随 C4 提交                            |
| 2   | C6 零改动故无独立提交                                         | 证据型节点，结论已入 03 §6                      |
| 3   | K2 `initiallyDisabled` 严于上游（fail-closed）                | 按计划的 Q3 裁示实现                            |
| 4   | K8 zod 不去重（由上游 `invalid_ids` 拒绝，避免双真相源）      | 已采纳为口径                                    |
| 5   | preload 方法清单历史缺口 17→28                                | 随 K8 补全                                      |
| 6   | K1 页面用例在全量负载下曾有一次超时抖动（隔离复跑 3×38 全绿） | 本阶段全量与域测试均未复现，**留观**            |
| 7   | `package-lock.json` 48 行 `"libc"` 字段剥离（npm 版本差异）   | 工作区既有改动，本轮不入任何提交（沿用 02 §10） |

### 6.3 本阶段文档订正（三处最小事实更新）

| 文件                             | 订正内容                                                                     | 判据                                              |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/main/nikkisync/AGENTS.md`   | 职责表补 `runtime-facade.test.ts` 一行                                       | 该文件由本系列 C5/K 节点多次改动，原表未登记      |
| `src/main/sync/AGENTS.md`        | `initSyncServer()` 调用位置 `lifecycle.ts:340` → `:338`                      | 实读 `src/main/app/lifecycle.ts` 当前行号         |
| `docs/plans/*02-实施计划.md` §16 | 删除「能力层未开工」与「预留侦察落档位」两处过期陈述，改为指向本文档的索引行 | K1–K8 与 F 已由阶段 4 完成，原文为阶段 3 时点事实 |

**登记但不处理（超出本阶段最小化边界）**：`src/main/nikkisync/AGENTS.md` 职责表仍缺 6 个测试文件（`embedding-paths.test.ts`、`metadata-resolver-driver.test.ts`、`metadata-isolation-guards.test.ts`、`resource-allowlist.ts`、`resource-allowlist.test.ts`、`runtime-cli-report.test.ts`）——这些文件本系列未触碰，属既有欠账，本轮只登记不批量补写（避免 jumble 顺手改动）。

### 6.4 已核对「无需变更」的项

- **IPC 契约完整性**：`src/main/ipc/handlers/nikkisync-handler.ts` 实际注册 **27 条** `nikkisync:*` 通道，在 `docs/IPC_CONTRACT.md` 中逐通道有对应行——查询面 10 条（`runtime-status` … `profile-stats`）、服务面 6 条（`server-status` … `revoke-device`）、K2 同意 2 条、K3 推断 1 条、K6 额外目录 5 条、K8 整理队列 3 条，另有 `nikkisync:library-changed` 推事件单独落档；**无「代码有文档无」或「文档有代码无」的差异** ⇒ 不触发 IPC 契约补写。
- **preload 暴露面**：`src/main/preload/api/nikkisync.ts` 暴露的方法与 `preload.test.ts` 的 28 方法清单一致，已在全量测试中随绿。
- **根 `AGENTS.md` 导航表**：所列嵌套 AGENTS.md 路径全部可解析、无新增/删除嵌套指引 ⇒ 不动。

---

## 7. 回滚方法

沿用 02 §12 五条口径，并按本系列提交倒序给出区段：

1. **热关优先（推荐首选）**：异常先关闭 `nikkisync.organizerEnabled` / `nikkisync.multiHostPairing` / 在线解析同意（K2），以及 `nikkisync.syncServerEnabled`；所有能力默认 false，多数线上症状无需回滚代码。C4 vendored 回滚时**必须同时关闭多 host 开关**，否则本仓产出的多 host URI 与 vendored 类型面会不一致。
2. **节点级 revert（倒序，含依赖顺序）**：`9a8a1fb`（F）→ `5e308e9`（F-2 欠账）→ `9cf6bfc`（K8）→ `887103d`（K7）→ `fb17ee5`（K6）→ `476182b`（K5）→ `6f4e44d`（K4）→ `3c7ab84`（K3）→ `54e5e21`（K2）→ `332e0de`（K1）→ `6402cb5`（阶段收口）→ `505718c`（C5）→ `9bb771b`（C4）→ `f43faa9`（C3）→ `c48a037`（C2）→ `b8c78e9`（批准入库）。
   注意：回滚 K8 会连带还原 `build:recycle-helper` 脚本、`extraResources` 与 `resources/nikkisync/recycle-helper.cs`；残留 env 设置无害（helper 路径不存在时上游返回 `recycle_unavailable`，任务标 failed 且**不删文件**，fail-safe）。
3. **整系列 reset**：`git reset --hard dc9f085`（本系列起点），随后需重跑 `npm run link:nikkisync` 与必要的 `npm install`（此处才会剪 junction，务必补链）。
4. **上游不降级**：四包导出只增不删，`b422193` 检出保持不动；能力层回滚不需要回退上游检出。
5. **零迁移**：migrations 无变化，任何回滚都不产生数据库 schema 变化，既有 `{userData}/nikkisync/nikkisync.db` 无兼容负担。

---

## 8. 未自动化验证清单

> **声明：以下每一条在本环境下均未自动化执行，也未由本次任何自动化测试间接覆盖；标注「未自动化验证」者不得计入通过结论。**
> 每条含前置、操作步骤、预期结果。执行人需在 exe 安装态或 `npm run dev` 态完成；失败即按 §7 处置。

### M1 · 第三方 Android 真机 · 单 host 配对回归（**未自动化验证**）

- 前置：手机与 PC 同一局域网；`nikkisync.multiHostPairing` **关闭**（默认）；开启同步服务。
- 步骤：① 设置页「同步服务」起始服务；② 取配对二维码；③ 用 NikkiSync App 扫码；④ 完成配对后拉一次列表。
- 预期：二维码内容为 `NS1|` 七段串（旧版 App 可直接识别）；配对成功，设备列表出现该设备，拉列表有数据。
- 自动化边界：N3b 只验证 PC 侧服务可用，未覆盖 App 扫码。

### M2 · 多 host 配对（**未自动化验证**）

- 前置：同上，且 `nikkisync.multiHostPairing` **开启**；PC 处于多网段/多网卡环境；App 支持 `nikki-sync://pair?` 格式。
- 步骤：① 开关开启后取码；② 扫码配对；③ 断开主地址所在网段后再次连接。
- 预期：二维码内容为 `nikki-sync://pair?serverId=…&hosts=…`（hosts ≤ 8）；主地址不可达时 App 能尝试备选地址。
- 自动化边界：vendored hosts 分支有单元/漂移测试，但 App 端解析行为未验。

### M3 · K8 批量删除全流程（含回收站恢复）（**未自动化验证**）

- 前置：`nikkisync.organizerEnabled` 开启且 `resources/nikkisync/nikkisync-recycle-helper.exe` 在打包产物内；App ≥ 1.0.21；准备若干测试照片（先备份）。
- 步骤：① 手机端发起删除；② PC 整理队列出现 `pending`；③ PC 批准；④ 手机核对；⑤ 在 Windows 回收站恢复；⑥ 重扫。
- 预期：审批确认弹窗列明将移入系统回收站的文件总数；执行后文件进系统回收站（**不入本仓应用回收站**）；可从回收站恢复；重扫后资产状态一致。
- 自动化边界：测试红线——全套用例不触发 `executing` 态，此链表 no automation evidence。

### M4 · K8 拒绝 / 取消路径（**未自动化验证**）

- 前置：同 M3。步骤：① PC 拒绝某条；② 手机端查看；③ 手机端取消某条；④ PC 查看队列。
- 预期：PC 拒绝 ⇒ 手机显示已取消；手机取消 ⇒ PC 队列同步为 `cancelled`；文件始终未被删除。

### M5 · helper 异常注入（**未自动化验证**）

- 前置：K8 开关开启，临时将 `nikkisync-recycle-helper.exe` 改名。
- 步骤：触发一次批准执行。
- 预期：任务标 failed、错误可见（不静默失败）、**文件保留**（fail-safe），属 §7.2 所述 env 缺失形态。
- 自动化边界：`build-recycle-helper.test.ts` 只覆盖构建脚本与 usage 分支，未覆盖运行期 exe 缺失。

### M6 · mDNS 发现（**未自动化验证**）

- 前置：默认 `mdns=false`（`SYNC_SERVER_DEFAULT_MDNS=false`，且注意上游 `MdnsAdvertiser` 回环自激已知问题）；显式开启后测试。
- 步骤：开关开启 mdns → 起服务 → 手机端发现设备。
- 预期：默认关时不组播；显式开启后可被发现（异常时关闭 mdns 即可回落到手填地址配对）。

### M7 · 端口占用 / 防火墙（**未自动化验证**）

- 前置：占用 28080 端口；首次监听时 Windows 防火墙弹窗。
- 步骤：① 端口被占时起服务；② 防火墙放行后手机访问。
- 预期：端口占用归一为 `PORT_IN_USE` 提示（不外抛崩溃）；放行后手机可达。

### M8 · K2 在线解析的实际外发行为（真机抓包）（**未自动化验证**）

- 前置：开启在线解析与同意；抓包工具就绪（HTTPS 解密）。
- 步骤：触发一次元数据解析，抓包核对请求。
- 预期：端点 `https://nuan5.pro/api/decode-photo2`；仅含「photo UID」与「NUAN5 JPEG-prefix 参数 MD5 摘要」两类字段（外发字段清单已在 UI 披露）；未同意时零出站。

### M9 · K6 额外照片目录（真机目录形态）（**未自动化验证**）

- 前置：准备网络盘/权限受限目录/深层目录各一个。
- 步骤：逐一「添加 → 预检 → 确认 → 重扫」。
- 预期：上限 16、模式 `native|images`、重叠折叠全部由上游承担；不可读目录给出可读错误短码而非静默。

### M10 · 安装包实机安装 → 首启 → 同步服务页全区块渲染（**未自动化验证**）

- 前置：`release\MeowStarMap-Setup-2.5.5.exe`（本轮已出包并签名，`app.asar` 71,746,207 字节）。
- 步骤：① 干净机器安装；② 首启；③ 进入设置页「同步服务」二级页；④ 逐区块确认（启动阶段 / 同意折叠块 / 连接诊断 / 上次扫描 / 目录管理 / 整理队列 / 配对二维码 / 设备列表）。
- 预期：无需管理员（`requestedExecutionLevel=asInvoker`）；首启无空白页；同步服务页八个区块全部渲染且默认值符合「全部开关默认关」的安全姿态。
- 自动化边界：e2e 的 S1–S8 跑的是 `win-unpacked` 目录态，未跑 NSIS 安装态。

### M11 · 托盘行为与开机自启动（说明 + 人工确认）（**未自动化验证**）

- 说明：上游 `apps/windows-shell` 的原生服务恢复与自启动修复（01 评估 #11）按 02 §11 裁决为**不适用**，本仓未接入；本条只针对本仓 Electron 既有的托盘与自启动行为做回归确认而非新功能验证。
- 步骤：① 打包态运行下检查托盘图标与菜单；② 在系统设置里切换开机自启动后重启一次观察。
- 预期：托盘与自启动行为与本次整合前一致（本系列未触碰该功能面）；若有变化，先怀疑系统策略而非本次整合。

---

## 9. 附：本轮命令清单（便于复核重跑）

```
git -C ../NikkiSync rev-parse HEAD && git -C ../NikkiSync status --porcelain
npm run link:nikkisync:check
npm run typecheck && npm run typecheck:e2e
npm run lint
npm run format:check
npm test
npm run i18n:check && npm run i18n:guard
npm run docs:links
npm run verify:nikkisync
npm run verify
npx vitest run src/main/nikkisync                     # 链接态 / 未链接态对照
npm run build && npm run verify:nikkisync
npm run dist:win                                      # 含 build:recycle-helper / pre-dist-check / verify:dist
npm run e2e:smoke
npx playwright test --config e2e/playwright.config.ts e2e/nikkisync-runtime.e2e.ts
```

> 本机 Safe-Delete 网关提醒（阈值 500 项）：`release/win-unpacked` 达 866 项，electron-builder doPack 阶段会被拦
> （`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。本轮处置为**先 `Move-Item release\win-unpacked` 到临时目录**再执行 builder，
> 未使用 `Remove-Item`、未删除任何历史产物。
