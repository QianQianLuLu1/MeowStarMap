# 阶段 6 执行记录：全量回归、残留终扫与收尾

日期：2026-10-23 ｜ 范围：计划 §七 余量节点（N3 / N5 / N8）+ §十一 全局回归 + 终扫台账 + 常驻守卫
取值真相源：`2026-10-23-project-rename-meow-star-map.md` §1.1 / §1.2，并遵循文末「阶段 5 / 阶段 4 订正」两节。
工作基线：阶段 5 收尾提交 `cac6c0e`（工作树干净）。

---

## 一、开工前的真实读数

| 项                                                                                                         | 读数                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 全仓 tracked 旧名命中（29 条模式，`git grep -n -F -f`）                                                    | **624 行**                                                               |
| 其中记录类文档（`docs/plans/**`、`CHANGELOG*`、`docs/2.5.0/**`、`docs/sync-integration/**`、两份事故报告） | 425 行（逐字记录当时事实，本阶段不动）                                   |
| 非记录面（代码 + 生效文档 + 守卫）                                                                         | **199 行 / 66 文件**                                                     |
| 其中「非白名单的真实待办」                                                                                 | N3 前缀链 72 处、N5 导出名 2 处、N8 文档余量 1 处 + 搬迁清单**完全缺失** |

开工前另核实两处会骗人的前提（都影响红灯的可信度）：

1. **真 zod 备份名正则全仓零覆盖**：`src/main/ipc/handlers/backup.test.ts:60` 用
   `tests/mocks/mock-validator` 顶掉真实 validator，`_test-helpers.ts:28` 的桩是宽松 `/.+/`，
   `src/main/ipc/validator.test.ts` 原 19 条用例无一条碰 `backupFilename`
   ⇒ §N3 设想的「改源码即红」里，那 6 条 handler 断言**不会红**。C1 先补真判据再动源码。
2. **§十一 的「doctor DB 检查指向新根」为错**：`scripts/doctor.ts:126` 查的是仓内
   `data/album_index.db`，与 userData 无关 ⇒ 搬迁清单的验证步改用「设置 → 备份只列 `meow_star_map_*`」。

## 二、提交清单（一节点一提交）

| #   | SHA       | 内容                                                                                                                                    | 站点数           |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| C1  | `c243bd5` | `refactor(db)`：落库与备份名前缀链 `wxnn_photo_manager` → `meow_star_map`（锁 B 原子批）+ validator 边界用例 3 条 + 两处 `@core-change` | 18 文件 / 65 处  |
| C2  | `f9651b6` | `refactor(e2e)`：`perf-real.e2e.ts` 库名跟随 + `pack-identity-name` 守卫同批改锁（三轴式）                                              | 2 文件 / 6 处    |
| C3  | `3cf5e0c` | `refactor(resonance)`：导出文件名 `nikkigallery-resonance-*` → `meow-star-map-resonance-*`                                              | 2 文件 / 2 处    |
| C4  | `0daddd5` | `docs(development)`：§九 / §9 用户数据人工搬迁清单（中英双份）+ PLUGIN_API 示例水印改新名                                               | 3 文件 / +169 −1 |
| C5  | `5a9166d` | `test(guard)`：常驻终扫守卫 `old-name-ledger.test.ts` + 白名单台账 JSON（40 文件逐条 reason）                                           | 2 文件（新增）   |
| C6  | 本提交    | `docs(plans)`：入库本执行记录并订正阶段 1 的 §十一 判据                                                                                 | —                |

C1 的六处同值站点必须整体翻转（生成端 `backup-service.ts:158`、过滤端 `:214`、恢复读库 `:533`、
zod `validator.ts:150`、迁移模式 `dir-manager.ts:146`、worker `lifecycle.ts:324/328`、渲染层
`data-sections.tsx:25`），拆半即「恢复被 zod 拒 + 备份静默消失」。`-wal/-shm/.clean-exit/.corrupt-*`
由 `connection.ts` 从 `dbPath` 派生，自动跟随，未单独改。

## 三、逐节点红→绿

| 节点 | 红灯（真实跑出）                                                                                                                                                          | 绿灯                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1a  | 仅新增 `validator.test.ts` 三条边界用例 ⇒ **2 failed / 20 passed**（新前缀被拒、旧前缀仍放行）                                                                            | 源码翻转后 22/22                                                                                                                                                              |
| C1b  | 源码 13 处翻完、断言未翻 ⇒ **12 failed / 704 passed**（backup-service 6、connection 4、lifecycle 1、dir-manager 1）；`core-path-gate` 无授权行时 `[CORE-GATE] ✗ 2 处违规` | 同命令 39 files / 741 tests 全过；补授权行后 `[CORE-GATE] ✓`；`npm run verify` ✓                                                                                              |
| C1c  | `handlers/backup.test.ts` 6 处、`custom-dirs:67`、`media-update:75`、`recovery:79` **改前不红**（mock 所致）                                                              | 如实记为「断言跟随」，不冒充红灯                                                                                                                                              |
| C2   | 只翻 `perf-real` ⇒ 守卫 `expected +0 to be 4` 1 failed / 36 passed                                                                                                        | 三种 profile 各 37 passed；`typecheck:e2e` ✓                                                                                                                                  |
| C3   | 只翻源码 ⇒ `exportPayload.test.ts:225` 1 failed / 10 passed                                                                                                               | 4 files / 83 passed（含 `resonance.test.ts:188`、`resonance-handler.test.ts:378` 线格式与 `UpdateDialog.test.tsx` URL 锁三条「必须保持绿」对照）                              |
| C4   | — （文档新增，无红灯）                                                                                                                                                    | `docs:links` ✅ dead 0 / 提醒 153（与基线同值）、`check-md-links` + `verify-format-scope` 60 passed、prettier `--check` ✓、`git diff --numstat` 证明 zh +78/en +91 全为纯新增 |
| C5   | 空台账首跑 ⇒ 40 文件全部「未登记」红                                                                                                                                      | 台账写定后 5/5；反向自证见下                                                                                                                                                  |

**C5 的两向敏感性自证**（防「守卫空转常绿」）：

- 往 `AGENTS.md` 追加一行 `NikkiGallery` ⇒ 报 `未登记 AGENTS.md → {"NikkiGallery":1}`；
- 把台账里 `README.md` 的 `NikkiGallery` 计数由 2 改成 1 ⇒ 报 `实际 2 ≠ 台账 1`；
- 两次都随即还原，且 `git status --porcelain` 确认工作树干净。

## 四、全量回归与静态闸门（本机真跑）

| 命令                                                      | 结果                                                                     | 对照                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`                                            | `eslint .` 无输出 = 0 error                                              | —                                                                                                                                                                                 |
| `npm run typecheck`（`tsc -b` + `tsconfig.scripts.json`） | ✓                                                                        | C5 曾报 `TS6133 toPosix 未使用`，删除后转绿                                                                                                                                       |
| `npm run typecheck:e2e`                                   | ✓                                                                        | —                                                                                                                                                                                 |
| `npm run i18n:guard`                                      | ✅ 白名单只减不增、key 已同步                                            | 与阶段 1 基线同判                                                                                                                                                                 |
| `npm run i18n:check`                                      | ✅ 12 语包 × 3939 键全对齐                                               | 同阶段 2                                                                                                                                                                          |
| `npm run audit`（audit-ci）                               | `Passed npm security audit`（11 条既有 allowlist）                       | 未新增依赖                                                                                                                                                                        |
| `npm test`                                                | **437 files / 6704 passed + 12 skipped**，exit 0                         | 阶段 5 为 436 / 6696；+1 文件 = C5 守卫，+8 = C1 三条 + C5 五条，逐条可归因                                                                                                       |
| `npm run test:coverage`                                   | 69.32 / 60.57 / 61.81 / 70.93，exit 0                                    | 阶段 5 为 69.32 / 60.57 / 61.81 / 70.92（+0.01%），过阈                                                                                                                           |
| `npm run test:ci-linux`                                   | 29 failed files / 46 failed tests                                        | **红文件集合与阶段 5 台账逐字相同**（`comm` 双向为空），passed files 407 → 408（+1 = C5 守卫在装置下也绿）                                                                        |
| `npm run test:posix-host`                                 | 62 failed files / 167 failed tests（诊断 profile，非闸门）               | `backup-service.test.ts` 在本阶段与 `cac6c0e` worktree 上**同为 11 failed / 25 passed** ⇒ 本阶段零新增红；`ui-brand-name.test.ts` 的 `path.resolve` 装载缺陷为阶段 5 已记既有问题 |
| `npm run docs:links`                                      | ✅ 无死引用，153 处提醒                                                  | 与阶段 1/2 基线同值                                                                                                                                                               |
| `npx tsx scripts/core-path-gate.ts`                       | ✓（C1 前 ✗ 2 处缺授权）                                                  | —                                                                                                                                                                                 |
| `npm run preview:check`                                   | 10 项：PASS 5 / WARN 5 / **FAIL 0**，✅ 无致命漂移                       | 需先 `npm run build:preview`（本阶段真生成，非记未验证）                                                                                                                          |
| `npm run verify`                                          | 每节点均 ✓                                                               | 钩子后 `git status --porcelain` 均干净                                                                                                                                            |
| `npm run doctor`                                          | 5 项全 OK；横幅 `║        Meow Star Map 环境诊断报告        ║` 42 列对齐 | 「数据库文件」检查读仓内 `data/album_index.db`，判据已按 §一.2 订正                                                                                                               |

## 五、运行时取证（真跑，非推断）

1. `npm run build`（electron-vite）✓，`npm run dist` ✓ exit 0：产物
   `release/MeowStarMap-Setup-2.5.5-beta.exe` 与 `release/win-unpacked/喵星图.exe`；
   `npm run verify:dist` 全 ✔（含 `@nikkisync` 解包与管理员清单闸门）。
2. 构建产物内 **零** `wxnn_photo_manager`，`meow_star_map` 出现在 `dist/main/main/app/application.js`
   等 bundle 中（`grep -rl` 实测）。
3. `npm run e2e:smoke`（先 `unset ELECTRON_RUN_AS_NODE`）：**15 passed / 26.1s**。
   说明：冒烟跑的是打包后的 `win-unpacked`，用例结束会清理 `.cache/e2e-smoke-*`，
   所以落盘名证据另取——
4. 直接以固定 userData 启动新 exe（`--user-data-dir=.cache/stage6-manual-ud`）实测：
   `database/` 下为 `meow_star_map.db`、`.db-wal`、`.db-shm`、`.db.clean-exit`；
   全树 `find -iname "*wxnn*"` 为空；`logs/main.log` 出现 `unable to open database file` **0 次**；
   `%USERPROFILE%\喵星图\Diagnostics\`（`diag.log`、`startup-errors.log`）仍在位，
   复核阶段 5 的落盘名未被本阶段打破。探针进程已停止（`Get-Process 喵星图` 计数 0）。

## 六、终扫台账（白名单）

判据：**终扫非记录面命中文件集合 == 守卫台账文件集合 ∪ {台账 JSON 自身}，双向差集为空**
（`git -c core.quotePath=false grep -n -F -f .cache/rename-scan/old-names-stage3.txt` ×
`scripts/__tests__/old-name-ledger.json`，比对脚本 `.cache/rename-scan/set-equal.mjs`）。

- 全仓 tracked：624 → **707 行**（记录面 425 行不变；非记录面 199 → 282）。
- 非记录面 Δ +83 的构成：清零 −62 行（25 个文件的代码站点），新增 +156 行——
  台账 JSON 116（逐条 `reason` 里必然写着旧名）、守卫测试 8、`DEVELOPMENT.md` 15 + `.en.md` 16
  （人工搬迁清单必须逐字写出旧目录/旧库名，否则用户无从对照磁盘实物）、
  `validator.test.ts` 1（旧前缀必须被 zod 拒的反向锁）。
- 逐文件核账（节选，完整表见 `.cache/rename-scan/` 的 reconcile 输出）：

| 改前 → 改后                                    | 归属桶                                                                                | 文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 32 → 0 / 6 → 0 / 5 → 0 / 3 → 0 / 2 → 0 / 1 → 0 | 已清零                                                                                | N3 的 `backup-service.test.ts`、`backup.test.ts`、`connection.test.ts`、`lifecycle*.test`、`dir-manager*`、`data-sections.tsx`、`custom-dirs/media-update/recovery/_test-helpers`、`connection.ts`、`backup-service.ts`、`validator.ts`、`editor-service.ts`、`metadata-isolation-guards.ts`、`perf-real.e2e.ts`(5→1)                                                                                                                                                                                               |
| 13 → 12                                        | 磁盘键 + 已发布事实                                                                   | `docs/PLUGIN_API.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3 → 2                                          | 线格式                                                                                | `src/renderer/utils/resonance/exportPayload.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 23 → 22 / 24 → 24 / 5 → 5 / 8 → 8              | 守卫反向锁                                                                            | `pack-identity-name` / `ui-brand-name` / `runtime-disk-name` / `old-name-ledger.test`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 0 → 15 / 0 → 16                                | 磁盘实物指令                                                                          | `DEVELOPMENT.md` / `DEVELOPMENT.en.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 0 → 1                                          | 反向锁                                                                                | `src/main/ipc/validator.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 10 / 7 / 3 / 3 / 3 / 2×n / 1×n（不变）         | 类型名与磁盘键、URL、本机目录名、自投 fixture、修复前实况注释、本机磁盘事实、历史产物 | `plugin-host.ts`、`plugin.ts`、`plugin-sections.tsx`、`plugins-samples/.../package.json`、`about-sections.tsx`、`UpdateDialog.*`、`SyncGalleryToolbar.test.tsx`、`README.md`、`ARCHITECTURE*.md`、`nikkisync/{embedding-paths,runtime-loader,runtime-manager}`、`sync/**.test.ts` + `sync-{read,handler}.test.ts`、`resonance*.ts(x)`、`startup-diagnostic.ts`、`early-crash-guard.ts`、`eslint.config.js`、`e2e/perf-real.e2e.ts`、`docs/技术债清单.md`、`docs/debt-registry.json`、`tools/scripts/extract_js.ps1` |

八条归属桶与计划 §1.2 的对应关系逐条写在 `old-name-ledger.json` 的 `reason` 字段里（40 条，
每条 ≥8 字且不允许批量复制同一句——守卫对此判红）。

## 七、已知偏差（本阶段不修，逐项交代去向）

1. **老用户首启新建空库**：`%APPDATA%\wxnn-photo-manager` 不会被自动迁移；旧前缀备份在
   设置 → 备份里**静默**不可见/不可恢复/不可清理。防线只有 §六 交付的 `DEVELOPMENT` 双语人工
   搬迁清单，且发布带更名的 tag 前必须先出搬迁公告（计划 §十 首行风险仍在）。
2. **`package.json` 的 repository/homepage 已指 `MeowStarMap`，而代码内 5 处 `GITHUB_URL` 仍是
   `github.com/QianQianLuLu1/NikkiGallery`**：用户规定「任何 URL 不动」的直接后果，靠 GitHub
   改名重定向可达；若旧名被他人抢注需另起改动。
3. **既有库存的 `WXNN XiangCe` 服务名不跟随**：`DEFAULT_SERVER_NAME` 只作用于新建库（阶段 5 已知偏差 3 沿用）。
4. **本机工作副本目录名仍是 `WXNN XiangCe`**，`eslint.config.js:510` 的 `wxnn-photo-manager/**`
   ignore 与 `tools/scripts/extract_js.ps1` 的真实路径因此保留。
5. **本机预览教程件（9 月生成、被 `.gitignore` 排除、未被跟踪）仍写着旧名**：它不属于仓库内容，
   也不进守卫域；按现源码重新生成即跟随语包新名。
6. **`test:posix-host` 大面积红是诊断 profile 的既有形态**（62 文件），不是 CI 闸门；本阶段以
   worktree 对照证明 `backup-service.test.ts` 两侧同为 11 failed，零新增红。

## 八、未验证项（如实记录）

1. **真实 ubuntu-latest 的 `Test (shard x/10)` 与 `Coverage Gate` job**：本机 `test:ci-linux` 只是复现装置。
2. **`npm ci` 与改名后 lock 的一致性**：本机跑会扰动 `better-sqlite3`/`sharp`/`koffi` 的 ABI。
3. **NSIS 就地升级与 electron-updater 行为**（appId + productName 双变）：需两个已安装版本共存。
   本阶段只重跑了 `npm run dist`（打包链本身 ✓），未安装。
4. **`@perf-real`**：需 `PERF_REAL_USERDATA` 指向真实用户数据；本机 `%APPDATA%\meow-star-map`
   尚未由安装版产生（冒烟与探针都用独立 userData）。
5. **真机 Android 上看到的服务名**（阶段 5 同样未取）、Storybook job、Linux/Android 打包：与更名无关。

## 九、需要用户手动完成的仓库设置（代码内无法完成）

远端已是 `https://github.com/QianQianLuLu1/MeowStarMap`（`git remote -v` 实测）。GitHub Settings 建议改为：

1. **Description**：`喵星图 / Meow Star Map —— 《无限暖暖》玩家的本地相册管理器：扫描、浏览、编辑、整理、分享游戏照片（Electron + React + TypeScript，Windows x64）`
2. **Topics**（只收字母数字与连字符，中文不可用）：`meow-star-map`、`electron`、`react`、`typescript`、
   `desktop-app`、`photo-manager`、`photo-gallery`、`infinity-nikki`、`sqlite`、`windows`
3. **Website / Homepage**：留空或填 `https://github.com/QianQianLuLu1/MeowStarMap`（与 `package.json` 一致）
4. **Releases**：历史 release 的标题/正文与已上传的 `NikkiGallery-Setup-*.exe` 属已发布产物事实，**不改名**
   （改名即失效链接）；只在最新 release 补一句「自 v2.5.5-beta 起产品更名为喵星图 / Meow Star Map，
   用户数据需按 `DEVELOPMENT.md` 第九节手工搬迁」。
5. **自查项**：branch protection 规则、Actions 里的仓库名引用、Pages 站点名、Deploy keys 与 secrets
   是否按旧仓库名配置过；旧名 → 新名的重定向是代码内 5 处 URL 仍可达的前提。
