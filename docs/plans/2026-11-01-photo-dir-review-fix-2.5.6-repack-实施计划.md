# 照片目录功能审查修复 → 全绿 → 提交 → 2.5.6 收口重打包（实施计划）

> 生成日期：2026-11-01 · 本仓 `main` @ `7598c29`（`meow-star-map 2.5.6`），工作区含一整个未提交功能
> 真相源：`docs/CODING_CONVENTIONS.md`（§1 IPC / §2 AppError / §3 CSS 变量 / §6 路径语义三分法）· `src/main/ipc/handlers/AGENTS.md` · `src/main/nikkisync/AGENTS.md` · `docs/IPC_CONTRACT.md` · `scripts/check-changelog-release.ts`
> 审查范围：最后一次出包（`a3cfaf6` 15:42 定版 → `release/win-unpacked` 15:43）之后的全部改动 = 工作区 26 文件 / +1296 −25，已逐文件读完；`7598c29` 为纯文档提交。

---

## 0. 审查结论

功能主体质量合格，不构成返工。已逐条核对通过的事实：

- 设置键两侧同源：`src/main/app/nikkisync-runtime-setup.ts:41` 的 `SETTING_GAME_ROOT = 'nikkisync.gameRoot'` 与 `src/main/ipc/handlers/nikkisync-handler.ts:391` 的 `SETTING_GAME_ROOT_KEY` 同值 ⇒ 「替代默认路径」真的会生效。
- `dbManager.setSetting/getSetting` 确为同步 API（`database/connection.test.ts:804` 起）；`getSetting` 会按默认值类型折叠脏值，handler 里 `typeof value === 'string'` 的兜底**不是**死代码（存 `null` 时返回 `null`）。
- `AppError.forbidden/validation`（`shared/errors/app-error.ts:82/87`）、`isSensitivePath`（`utils/ipc-validate.ts:53`，win32 钉）、`pathGuard.registerUserPickedDir`（`ipc/validator.ts:275`）均真实存在，无幻觉 API。
- 可写探测 fail-open 的实现与注释一致；四通道不 `requireRuntime`，同步服务未启用也能先配置。
- 重启询问 `confirmed === 0 → app.relaunch()` 与既有先例 `src/renderer/pages/settings/data-sections.tsx:173-182` 逐字一致；`showMessageBox` 桥确为 `call<number>`。
- 分区 ③b 落在 `{extraDirs && …}` 之外 ⇒ 「不经运行时装配也常驻」的注释成立。
- 12 语包 19 键齐备、无空值，且 ja/ko/de/th/ru/vi 抽检为真翻译（不是英文回填）。
- 新增主进程 11 例 + 渲染层 9 例断言的是可观察契约，无 `it.skip`、无弱化断言、无 `--no-verify`；`preload.test.ts` 32→36、`settings-handler.test.ts`、`sync-service-keys.test.ts` 三处「锁测试」更新属合法契约同步。

发现三处需要动代码/文档的缺陷：

| #   | 级别             | 缺陷                                                                                                                                                                                              | 证据                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **安全（必修）** | `nikkisync:admit-directory` 把**渲染层任意传入**的目录写进全局 `userPicked`/`userPickedDirs`，且 `addUserPicked` 内部还调 `this.register(p)` 写进全局读白名单 `roots`——这三者都是**前缀**短路判据 | `nikkisync-handler.ts:895` → `validator.ts:243-246`（`register()`）与 `matchesPicked`（`validator.ts:289-300`，`startsWith(root + sep)`）⇒ admit 一个 `D:\` 整盘免检，且**无需任何用户手势**；而 `validator.ts:237`、`scanner-handler.ts:74`、`media-protocol.ts:314` 三处注释都断言「渲染进程无任何 IPC 可写入该集合」——修复前该断言为假 |
| F2  | **阻断（必修）** | `CHANGELOG.md` 把新条目写在 `[Unreleased]` 下，而目标版本 2.5.6 已是当前值 ⇒ `check-changelog-release` 判 error ⇒ `npm run dist:win` 在 `pre-dist-check` 步就 abort                               | `scripts/check-changelog-release.ts` 铁律 2「[Unreleased] 节无待发布条目」                                                                                                                                                                                                                                                                |
| F3  | 潜在（守卫）     | 设置键字面量在 handler 与 app 读取端各写一遍，既有测试断言的是**手抄的字面量** ⇒ 任一侧改名，功能静默失效而测试仍绿                                                                               | `nikkisync-handler.test.ts:1184/1208/1243`                                                                                                                                                                                                                                                                                                |

两处已核实的**非缺陷**（不修，避免顺手改）：

- `handleInspectTypedDirectory` 不置 `busy`，与既有 `handleAddDirectory`（`SyncServicePage.tsx:714-724`）同形态，且按钮已 `disabled={busy || extraDirs.busy}` ⇒ 不是新引入的双提交缺口。
- 渲染层重复一遍绝对路径正则只做 UX 预检，服务端校验仍是唯一真相源（符合约定）。

**本轮已裁决的两项（作为约束使用）**：F1 走「收窄为同步域专用登记」；F2 走「条目并入 `## [2.5.6]`、版本保持 2.5.6、重出同名安装包」。

## 1. 依赖声明

**零新增/零变更依赖。** 全部复用仓内既有能力：`PathGuard` 私有 `markPicked/matchesPicked`、`isSensitivePath`、`AppError` 工厂、zod、`dialog.selectDirectory/showMessageBox`、`app.relaunch`、`SectionShell/SettingsCard/SettingsRow`、`useGlobalToast`/`useErrorToast`、`_test-helpers` 的 `makeCtx/getHandler`。

> 环境事实（仓库里读不出来）：`npm install` **会静默删掉** `node_modules/@nikkisync` 下 4 条 junction（`core/database/protocol/pc-companion`），后果不是报错而是静默降级——`build.files` 拷不到东西 ⇒ 安装包缺整个内嵌同步运行时，拦它的是 `verify:dist` 的 `nikkiSyncPackedVerdict`。因此 §N6 里 install 之后**必须**紧跟 `npm run link:nikkisync` + `link:nikkisync:check`。

## 2. 启动与运行说明

- 环境：Node（本机 v24.18.0；CI 钉 `.node-version=22`）+ npm + Git Bash，无需凭据。
- 单测走 vitest（electron 别名指惰性替身），逐节点验证**不需要**先 `npm run build`。
- 逐节点：`npx vitest run <文件>`；分层 `npm run test:main` / `npm run test:renderer`。
- 只读预检：`npm run verify`（typecheck + eslint 无 `--fix` + core-gate + prettier `--check` + 相关单测，绝不改写文件）。
- 人工实机项见 §7。

## 3. 节点设计（每步真跑，红→绿）

### N0 计划落仓（本文件）

- 文件：`docs/plans/2026-11-01-photo-dir-review-fix-2.5.6-repack-实施计划.md`。
- 输入/输出：批准的计划 → tracked 计划文档（含空的 §8 读数节）。
- 验收：`git ls-files` 能列出该文件（`check-md-links` 按 tracked 集判存在，未 `add` 会被 CHANGELOG 引用打回）；单独提交 `docs(plans): …`。**停点：等用户读过再进 N1。**

### N1 F1 红灯

- 文件：`src/main/ipc/handlers/nikkisync-handler.test.ts`（既有 admit 用例之后追加）。
- 用例（判据不依赖宿主 fs 形态，Windows 机与 ubuntu CI 同结论）：
  1. `vi.spyOn(pathGuard, 'registerUserPickedDir')` + admit 一个真实 tmpdir ⇒ 断言**未被调用**，同时 `res.success === true`；
  2. 同一次 admit 后 `pathGuard.isUserPickedDir(dir)` 为 `false`（未获得全局短路）；
  3. 既有「admit → inspect 放行」用例保持绿 ⇒ 证明收窄没有削掉功能。
- 验收：`npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts` 新增 2 例红、其余全绿；红读数原样进 commit message。

### N2 F1 绿灯（最小改动）

- 文件：
  - `src/main/ipc/validator.ts`：新增私有 `syncPhotoDirs` 集合 + `registerSyncPhotoDir(p)`（**只** `markPicked(this.syncPhotoDirs, p)`，不调 `register()`、不写 `userPicked/userPickedDirs`）+ `isSyncPhotoDir(p)`；注释写明「本集合只被 `nikkisync:inspect-extra-directory` 消费，不构成主相册扫描与 `media://` 的免检」。
  - `src/main/ipc/handlers/nikkisync-handler.ts`（受保护路径，`@core-change` 注释替换为本次真实原因）：admit 改调 `registerSyncPhotoDir`；inspect 门禁 `if (!isUserPickedDir) assertFileReadPath` → `if (!isUserPickedDir && !isSyncPhotoDir) assertFileReadPath`。
  - 三处失效注释订正：`validator.ts:237`、`scanner-handler.ts:74`、`media-protocol.ts:314`——修复后「渲染进程无 IPC 可写入 userPicked」重新为真，补一句指名新通道与收窄后的集合，防止后人照旧注释理解 admit。
- 关键前置取证（已完成）：`media://` 对同步库照片走的是规则 4 精确授权表 `isNikkiSyncResourcePath`（`media-protocol.ts:296-301`），**与 `userPicked` 无关** ⇒ 收窄登记不会让手输目录的缩略图 403。
- 验收：`npx vitest run src/main/ipc/handlers` 全绿 + `npx vitest run src/main/app` 全绿 + `npm run typecheck` 绿。

### N3 F3 守卫（不造假红灯）

- 文件：`src/main/ipc/handlers/nikkisync-handler.test.ts`——断言改用 `import { SETTING_GAME_ROOT } from '../../app/nikkisync-runtime-setup'` 替代手抄字面量。
- 两侧现同值 ⇒ 新断言直接为绿。本轮**不编造红灯**（无缺陷即无红-绿，如实记账），有效性由变异抽查 M1 承担：临时改 `SETTING_GAME_ROOT_KEY` 字面量 ⇒ 断言必须红 ⇒ 还原并用 `sha256sum` 证明逐字节还原。
- 验收：M1「改后红 / 还原绿」两条读数进 §8。

### N4 F2 CHANGELOG 收口

- 文件：`CHANGELOG.md`——把 `[Unreleased]` 下的 `### Added` 条目整体移入既有 `## [2.5.6] - 2026-11-01` 节，保持「唯一同名版本节 + `[Unreleased]` 无列表项」。
- 验收：`npx tsx scripts/check-changelog-release.ts` 退出码 0、无 error。

### N5 契约与 i18n 文档同步

- 文件：`docs/IPC_CONTRACT.md` §8.2.6——把「与 `dialog:selectDirectory` 同信任级别」订正为「登记只进同步域专用集合 `syncPhotoDirs`，`scanner:start` / `settings:set` / `media://` 判据不受影响」。
- 验收：`npx vitest run src/renderer/i18n/locales` 绿 + `npm run i18n:guard` 绿 + 契约通道名/入参/返回体与实现逐字段一致。

### N6 全局回归（按序真跑）

1. `npm install` → `npm run link:nikkisync` → `npm run link:nikkisync:check`（4 条 junction 必须在位）
2. `npm run build`
3. `npm run typecheck`（`tsc -b` emit 落 `.cache/tsmain`，不得污染 `dist/main`）
4. `npm run typecheck:e2e`
5. `npm run lint`
6. `npm run i18n:guard`
7. `npm test`（全量；用「总数差 == 本轮新增例数」核对无既有用例被吞）
8. `npm run test:ci-linux`（装置把 `path/os/fs` 换成 CI 宿主语义；本轮新增用例做 `mkdtemp` 真 IO，属约定 §6 第 2 档保宿主绑定——若出红，修判据形态，**禁止** `it.skipIf` / 放宽断言）
9. `npm run e2e:smoke`（打包态，前提 `release/win-unpacked/喵星图.exe` 在场；基线跑一次、重打包后再跑一次）
10. `npm run verify`

验收：逐项 `[VERIFY] ✓` / 退出码 0；任何一项红先修，**一票否决**不得进 N7。

### N7 提交

- 前跑 `npm run verify`，后跑 `git status --porcelain` 复核钩子残余（lint-staged 会 `prettier --write` 改写并重新暂存）。
- 切分（本仓 `src/**` 刻意留红会被自家 pre-commit 拒 ⇒ 红测与修复合并一笔，红读数进 message，**不用 `--no-verify`**）：
  1. `feat(nikkisync): 同步服务页照片目录自定义，手输预检登记收窄为同步域专用集合`
  2. `chore(release): CHANGELOG 照片目录条目并入 2.5.6 节`
- 工具链抖动不进提交：`package-lock.json` 若被本机 npm 重写 ⇒ 还原、不造 `chore(deps)`。

### N8 版本核对与重打包

1. 版本声明核对：`package.json` = `2.5.6` ⇒ **零编辑**（目标值即当前值，如实报），并核对 README 徽章 / `AGENTS.md` / `DEVELOPMENT(.en).md` / `ARCHITECTURE(.en).md` / `src/renderer/preview/mock/database-mock.ts` 同值。
2. 先留底：`release/` 现役 2.5.6 四件（`MeowStarMap-Setup-2.5.6.exe` 184,648,735B + blockmap + `latest.yml`）与 `win-unpacked` 树移到 `_safe_backup_20261101-pre-photo-dir/`（`release/` 全目录被 gitignore，包在 git 里没有第二份）。
3. `npm run dist:win`。
4. 若死在 `EPERM rename('release\win-unpacked.tmp' -> 'win-unpacked')`（本机实时防护的既有锁）⇒ 走已验证旁路：`electronDist` 指干净解包目录 + `--config.directories.output=release/build-<标签>`，再 `cp -rf`（被锁文件只挡 rename/unlink，不挡读与就地覆盖）建标准名树，并当场比两侧 `app.asar` sha256 全等；裸跑 `npm run verify:dist` 须自己变绿。
5. 新树再跑 `npm run e2e:smoke`（`[e2e] executable:` 必须打 `release/win-unpacked/喵星图.exe`）。
6. 新鲜度三条轴：`latest.yml` 的 `size` 与 `sha512` 均不同于留底旧包；`@electron/asar` `extractFile` 逐文件 sha256 比 `dist/main/*`（条目名反斜杠带前导 `\`，只去前导分隔符、绝不换成 `/`）；包内字节直接回答「修复在不在包里」——`nikkisync:set-game-root` 与 `registerSyncPhotoDir` 命中数 > 0，且 admit 分支不再出现 `registerUserPickedDir`。
7. 改 12 语包必须重打包（本轮已含）；`scripts/**` 改动不需要。
8. 回写 §8 读数并 `docs(plans): 回写…` 提交。

## 4. 错误处理

- 主进程：zod 失败/相对/不存在/非目录 → `AppError.validation`；系统敏感目录、`R_OK` 不可读 → `AppError.forbidden`；`setSetting` 抛错由 `wrapHandler` 统一收敛。错误消息为英文（`src/**` 中文硬编码护栏），本地化由渲染层承担。
- 可写探测 fail-open：任何异常（EACCES/EROFS/其他）归 `writable:false`，绝不阻断、绝不上抛。
- 四通道不 `requireRuntime`；运行时未启用/未建链不影响配置落库。
- 渲染层：失败 `showError` 并保留输入；成功 `success` Toast；`writable:false` 追加 Toast；`showMessageBox` 缺桥时静默跳过 relaunch。
- 残余风险（如实记账）：`syncPhotoDirs` 集合仍由渲染层增长、无条目上限——与对话框路径同源，但面比修复前的全局 `roots` 小得多。加上限属独立技术债，登记 `docs/技术债清单.md`，本轮不顺手做。

## 5. 参数校验

- `path`：`trim()` 后 1..512（gameRoot，与 `scanSchema.gameRoot` 同界）/ 1..4096（admit，与 `inspectDirectorySchema` 同界）；绝对路径正则 `^([A-Za-z]:[\\/]|\\\\|\/)`；`isSensitivePath` 黑名单；`stat` 存在 + `isDirectory` + `R_OK` 必过；`W_OK` 只回布尔不参与判定。
- 返回体字段固定：`{gameRoot}` / `{gameRoot, needRestart, writable}` / `{needRestart}` / `{path}`。
- F1 修复后新增硬边界：admit 的产物**只**能被 `nikkisync:inspect-extra-directory` 读到。

## 6. 基础测试用例（正常 / 异常 / 边界）

| 类                | 用例                                                                                                                                                                                                    | 来源                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 正常              | set 真实目录 → 持久化 + `{gameRoot,needRestart:true,writable}`；get 回读；reset → `''`；**admit → inspect 放行（收窄后仍成立）**                                                                        | 既有 5 例 + N1 第 3 判据 |
| 异常              | 相对/不存在/文件非目录 → VALIDATION；`C:\Windows\System32` / `C:\Program Files\X` / `D:\ProgramData` → PATH_FORBIDDEN；`R_OK` 拒 → PATH_FORBIDDEN；`settings:set nikkisync.gameRoot` 被拒并指向专用通道 | 既有 4 组                |
| 边界              | 512 过 / 513 拒；trim 后入库；重复 set 幂等；`getSetting` 脏值（非串/`null`）→ 回退 `''`；可写探测失败仅 `writable:false`                                                                               | 既有 4 例                |
| **N1 新增（F1）** | admit 成功但 `registerUserPickedDir` 未被调用、`isUserPickedDir(dir)` 为 `false`                                                                                                                        | 红 → N2 绿               |
| **N3 新增（F3）** | 写入键 === `SETTING_GAME_ROOT`（M1 变异自证有牙）                                                                                                                                                       | 绿 + 变异                |

## 7. 人工验证清单（自动化覆盖不到）

`npm run dev`：设自定义路径 → 重启询问 → 重启后同步图库出该目录照片；Program Files 被拒并提示；只读目录保存成功 + 不可写警告；K6 手输 → 预检提案 → 确认添加 → **缩略图与全屏预览能出图（这条专门验 F1 收窄没打断 `media://`）**；未设置时回退自动发现；保存动作不动运行中的局域网同步服务。

## 8. 执行读数回写（运行时填写）

- N1 红：`___ failed / ___ passed` · N2 绿：`___` · M1 变异：`改后红 ___ / 还原 sha256 ___`
- 六项点名门：install+relink `___` · build `___` · typecheck `___` · e2e:smoke（基线/新树）`___` · test:ci-linux `___` · dist:win `___`
- 全量：`npm test` `___ passed / ___ skipped / 0 failed` · lint `___` · typecheck:e2e `___` · i18n:guard `___`
- 包新鲜度：`latest.yml` size/sha512 与旧包差异 `___` · asar 逐文件哈希 `___` · 包内新通道命中 `___`
- 预期与实测不符时保留原预期并另写订正行，不悄悄改计划。
