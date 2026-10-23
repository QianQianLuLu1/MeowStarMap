# 项目整体更名为「喵星图 / Meow Star Map」实施计划（阶段 1 交付物）

> **状态**：盘点与计划已交付，**尚未改动任何代码**。等用户按节点放行后才进入实施。
> **创建日期**：2026-10-23
> **范围**：阶段 1 = 全面盘点 + 本实施计划。N1–N8 属阶段 2+，未获授权。

## Context

GitHub 仓库已更名为 `QianQianLuLu1/MeowStarMap`，`package.json` 的三条 URL（`:8/:10/:12`）也已随之订正（commit `7c6926f`），但仓库内的**产品名、界面文案、多语言、打包配置、运行时落盘名称**仍全部使用旧名。当前是「外部标识新、内部标识旧」的分裂态：应用内「关于 / 检查更新」仍展示 `NikkiGallery`，安装包名、快捷方式名、诊断目录名各自沿用三套不同旧标识。

目标统一更名为：

- 中文名 **喵星图**
- 英文名 **Meow Star Map**（三词、单词间各一个空格）
- 无空格技术标识 **`meow-star-map`**（kebab），派生形式 **`MeowStarMap`**（Pascal，用于文件名/目录名/CI 产物名/mDNS 实例名）与 **`meow_star_map`**（下划线，用于数据库与备份文件名）

### 已由用户确认的 6 项决策

| #   | 决策点                                                                                                  | 结论                                                      |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | 技术标识拼写                                                                                            | `meow-star-map`（kebab-case）                             |
| 2   | `package.json` `name` / `appId`                                                                         | **一并改**，接受 `%APPDATA%` 数据目录迁移成本             |
| 3   | 数据库与备份文件名 `wxnn_photo_manager*`                                                                | **改**为 `meow_star_map*`                                 |
| 4   | 历史文档（`docs/plans/**`、`CHANGELOG*.md`、`docs/sync-integration/**`、`docs/2.5.0/**`、两份事故报告） | **保留原文不改**，它们是当时事实记录                      |
| 5   | `productName`（决定 exe 名 + 快捷方式名）                                                               | `喵星图`（现状已是 CJK，已验证可用）                      |
| 6   | zh-TW 包                                                                                                | `喵星圖`；其余 9 个非中文语包统一用拉丁形 `Meow Star Map` |

---

## 〇、盘点清单（按五类归置，全部为 file:line 实测证据）

盘点命中量级：`NikkiGallery` 系 259 处 / 72 文件；`无限暖暖相册管理工具` 系 44 处 / 26 文件；`wxnn` 系 649 处 / 156 文件（**绝大多数是游戏标识，禁改**）。下表只列**更名生效范围内**的站点。

### A. 文档

| 文件                                                                                                                   | 站点                                                                                                                                                                                 | 处置                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `README.md`                                                                                                            | `:1` H1、`:4`、`:6`、`:25`、`:71` `cd NikkiGallery`、`:138`、`:184`                                                                                                                  | 改                                                                                                       |
| `README.md`                                                                                                            | `:60`、`:173` releases URL                                                                                                                                                           | **禁改**（URL）                                                                                          |
| `README.md`                                                                                                            | `:10-14` Electron 版本徽章                                                                                                                                                           | 保留原形，否则 `check-doc-versions.ts:58-61` 会 `exit 1`                                                 |
| `AGENTS.md`                                                                                                            | `:7`（一行内含 `wxnn-photo-manager` + `无限暖暖相册管理工具`）                                                                                                                       | 改                                                                                                       |
| `ARCHITECTURE.md`                                                                                                      | `:1`、`:3`、`:4`、`:33`、`:327`、`:585`、`:822`、`:824`、`:1199`、`:1630`、`:1631`、`:1643`、`:1684`、`:1831`                                                                        | 改（`:1199` 是 `NikkiGalleryManifest` 类型名，正文提及保留）                                             |
| `ARCHITECTURE.en.md`                                                                                                   | `:1`、`:3`、`:4`、`:33`、`:327`、`:585`、`:823`、`:825`、`:1194`、`:1488`、`:1602`、`:1603`、`:1615`、`:1656`、`:1803`                                                               | 改，与 zh 逐行配对                                                                                       |
| `DEVELOPMENT.md`                                                                                                       | `:3`、`:5`、`:66`、`:317`、`:323`、`:330`、`:337`、`:647`、`:654`、`:660`、`:672`、`:693`、`:704`、`:705`、`:785`、`:793`、`:794`、`:829`、`:839`                                    | 改                                                                                                       |
| `DEVELOPMENT.en.md`                                                                                                    | `:3`（现为第三种英文名 `Infinity Nikki Photo Manager`）、`:5`、`:66`、`:317`、`:323`、`:330`、`:337`、`:651`、`:660`、`:666`、`:678`、`:699`、`:788`、`:796`、`:797`、`:832`、`:842` | 改；与 zh 同步（zh `:704/:705` 无 en 对应行，属既有不对称）                                              |
| `docs/PLUGIN_API.md`                                                                                                   | 正文 `:1`、`:3`、`:5`、`:79`、`:82`、`:120`、`:121`、`:284`、`:305`、`:509`、`:526`、`:578`、`:692`、`:695`、`:706`、`:710-712`、`:727`、`:736`                                      | 正文改；小写 `nikkiGallery` 磁盘键（`:45,102,104,108,126,510,564,703,718-720`）**禁改**                  |
| `docs/tutorial/用户使用教程.md`                                                                                        | `:1`、`:33`、`:54`、`:56`                                                                                                                                                            | 改                                                                                                       |
| `docs/技术债清单.md`                                                                                                   | `:1` H1                                                                                                                                                                              | 改；`:240`、`:308`、`:309` 记录磁盘实况，**保留**                                                        |
| `docs/debt-registry.json`                                                                                              | `:397`                                                                                                                                                                               | **保留**（含用户真实存在的 `D:\NikkiGallery缓存` 目录）                                                  |
| `docs/perf-regression.md`                                                                                              | `:97`（DB 名）、`:122`（`PERF_REAL_USERDATA`）                                                                                                                                       | 改                                                                                                       |
| `docs/sync-integration/verify-audit.mjs`                                                                               | `:39` `assert.equal(pkg.name,'wxnn-photo-manager')`                                                                                                                                  | **改**：可执行脚本，属代码而非叙述                                                                       |
| `docs/sync-integration/0*-*.md`、`docs/sync-integration/README.md`                                                     | 叙述性记录                                                                                                                                                                           | **保留**                                                                                                 |
| `docs/plans/2026-10-*.md`（33 篇）                                                                                     | 各处                                                                                                                                                                                 | **保留**（工程执行记录）                                                                                 |
| `CHANGELOG.md`                                                                                                         | 正文 `:23,25,41,45,47,89,223,346,376`；引用定义 `:426-437`                                                                                                                           | **保留**（`:426-437` 同时是 URL，双重禁改）                                                              |
| `CHANGELOG-2.5.3.md`                                                                                                   | `:1`                                                                                                                                                                                 | **保留**                                                                                                 |
| `docs/2.5.0/RELEASE_NOTES_v2.5.0_illustrated.md`                                                                       | `:1`、`:5`、14 条图片引用                                                                                                                                                            | **保留**；配图目录 `assets/nikki-gallery-v250-illustrations/` **不改名**                                 |
| `docs/packaged-scan-crash-report.md`、`docs/troubleshooting-spawn-eftype.md`                                           | `:22-29,82-85` / `:3,4,28-31`                                                                                                                                                        | **保留**（事故报告，引用当时真实弹窗与路径）                                                             |
| `docs/CODING_CONTRACTS`／`docs/IPC_CONTRACT.md`、`docs/manual-smoke-checklist.md`、`docs/i18n/whitelist-baseline.json` | 实测 0 处产品名                                                                                                                                                                      | 不动                                                                                                     |
| `.github/workflows/build.yml`                                                                                          | `:248` `name: NikkiGallery-win-x64-nsis`                                                                                                                                             | 改；`:250,276` 用 `release/*.exe` glob，与产物名无关                                                     |
| `plugins-samples/custom-watermark-template/`                                                                           | `README.md:3,7,25`、`package.json:4,5`、`templates/festival.svg:12`                                                                                                                  | 改正文与示例元数据；`package.json:12` 的 `nikkiGallery` 键**禁改**                                       |
| 模块级 AGENTS/README                                                                                                   | `src/main/database/AGENTS.md:91`、`src/main/nikkisync/AGENTS.md:3`、`src/renderer/utils/share-card/README.md:3`                                                                      | 改（share-card README 同文件含 `NikkiSync` 上游引用，**禁止整文件批量替换**）                            |
| `.qoder/rules/project-conventions.md`                                                                                  | `:2` frontmatter                                                                                                                                                                     | 手工改；不入库，且在 `# 项目编码约定` 锚点之前，`verify-format-scope.test.ts:350` 的字节一致守卫覆盖不到 |
| `scripts/archive/*.ps1`                                                                                                | 含三个旧名                                                                                                                                                                           | 不动（`.gitignore:185` 不入库）                                                                          |

### B. 界面与多语言

| 站点                                                                                                                      | 现值                                                                                                  | 处置                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/renderer/index.html:13`                                                                                              | `<title>无限暖暖相册管理工具</title>`                                                                 | 改（HTML 字面量，未走 i18n）                                                                       |
| `src/renderer/preview/index.html:7`                                                                                       | `<title>无限暖暖相册管理工具 - 预览版</title>`                                                        | 改；生成的 `preview.html` 不入库                                                                   |
| `src/renderer/components/layout/TitleBar.tsx:15`                                                                          | `t('titleBar.appTitle')`                                                                              | 不动（正确走 i18n）                                                                                |
| `src/renderer/pages/settings/about-sections.tsx:75`、`:395`                                                               | 可见标签 `NikkiGallery`                                                                               | 改 → `Meow Star Map`                                                                               |
| `src/renderer/pages/settings/about-sections.tsx:17`、`:395`、`:399`、`UpdateDialog.tsx:18`                                | `github.com/QianQianLuLu1/NikkiGallery`                                                               | **禁改**（URL）。注意 `UpdateDialog.test.tsx:66-68` 逐字嗅探该源码字符串，不动 URL 才能保持它绿    |
| `src/main/services/share-wifi-service.ts:420`、`:438`                                                                     | `<title>/<h1>无限暖暖相册分享</h1>`                                                                   | 改（手机浏览器可见）                                                                               |
| `src/main/utils/early-crash-guard.ts:126`、`:127`                                                                         | 硬编码双语弹窗「NikkiGallery 启动失败…」                                                              | 改（i18n 未就绪前的原生弹窗，不引入 `t()`）                                                        |
| `src/main/app/desktop-shortcut.ts:54`                                                                                     | `description: t('main.app.name')`                                                                     | 不动，随 locale 值跟随                                                                             |
| 12 个 locale 的 `settings.about.appValue`、`titleBar.appTitle`                                                            | zh-CN `:1678`/`:2238`；其余 11 个 `:1269`/`:1829`                                                     | 改（zh-CN→喵星图、zh-TW→喵星圖、其余→Meow Star Map；`ko:1269` 是谚文音译，正则易漏，需按行号定位） |
| zh-CN 额外 3 键                                                                                                           | `main.app.name:3537`、`main.dialog.cleanupFailed.detail:2768`、`main.dialog.startupFailed.title:2772` | 改（后两键在 11 个非 zh-CN 包中本就是 `""`，无需动）                                               |
| 各 locale 的 `resonance.brand`、`resonance.subtitle`、`syncGallery.empty.gameRootMissing`、`shareCard.card.fallbackTitle` | `无限暖暖` / `無限暖暖`                                                                               | **禁改**，全部是游戏名                                                                             |

### C. 打包与构建配置

| 站点                                                                                                              | 现值                                                                   | 决定什么                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `package.json:2`                                                                                                  | `"name": "wxnn-photo-manager"`                                         | **`%APPDATA%` userData 根目录**、`updaterCacheDirName`                  |
| `package.json:4`                                                                                                  | `"description": "无限暖暖相册管理工具"`                                | 纯元数据                                                                |
| `package.json:211`                                                                                                | `"appId": "com.qianlu.wxnn-photo-manager"`                             | NSIS / Windows 注册表产品标识、就地升级判定                             |
| `package.json:212`                                                                                                | `"productName": "无限暖暖相册管理工具"`                                | **exe 文件名** `无限暖暖相册管理工具.exe`、任务管理器进程名、卸载显示名 |
| `package.json:277`                                                                                                | `"artifactName": "NikkiGallery-Setup-${version}.${ext}"`               | 安装包文件名 + `latest.yml` 的 `path:` 字段                             |
| `package.json:297`                                                                                                | `"shortcutName": "无限暖暖相册管理工具"`                               | 开始菜单快捷方式名                                                      |
| `package-lock.json:2`、`:8`                                                                                       | `"name": "wxnn-photo-manager"`                                         | CI `npm ci` 一致性                                                      |
| `.github/workflows/build.yml:248`                                                                                 | artifact 名                                                            | 仅影响 `gh run download` 与文档指引                                     |
| `package.json:19` `"infinity-nikki"`、`:225/:226/:261` `@nikkisync`                                               | —                                                                      | **禁改**                                                                |
| `electron.vite.config.ts:93,95,97,133`、`eslint.config.js:506`                                                    | `nikkisync-*`、`__NIKKI_PRELOAD_DEV__`、`wxnn-photo-manager/**` ignore | **禁改**（上游包；`:506` 指向磁盘真实存在的本地遗留目录）               |
| `tsconfig*.json`、`.prettierrc`、`.npmrc`、`vitest*.config.ts`、`tailwind.config.ts`、`audit-ci.jsonc`、`LICENSE` | 实测 0 处产品名                                                        | 不动                                                                    |

**关键结论（实测）**：全仓 **没有 `app.setName()` 也没有 `app.setAppUserModelId()`**。asar 内 `package.json` 不含 `productName`（被 electron-builder 剥离），`%APPDATA%` 下只存在 `wxnn-photo-manager` 一个目录 ⇒ **userData 根跟随 `name` 而非 `productName`**。`name`/`appId` 与 `productName`/`shortcutName`/`artifactName` 是**两组互不影响的旋钮**，改一组不会带动另一组。

### D. 运行时落盘名称

| 站点                                                                                                                                                                                                                                                                               | 现值                                                                      | 落盘位置                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/main/utils/user-diag-path.ts:12`                                                                                                                                                                                                                                              | `PRODUCT_DIAG_DIRNAME = 'NikkiGallery'`                                   | `%USERPROFILE%\Documents\NikkiGallery\Diagnostics` —— **单一权威常量**，被 `:63,70,76,85` 消费，改一处即全域跟随 |
| `src/main/utils/startup-diagnostic.ts:38`                                                                                                                                                                                                                                          | `'NikkiGallery-startup-errors.log'`                                       | `%TEMP%`                                                                                                         |
| `src/main/utils/startup-diagnostic.ts:57`                                                                                                                                                                                                                                          | `'NikkiGallery-diag.log'`                                                 | `%TEMP%`                                                                                                         |
| `src/main/utils/early-crash-guard.ts:64`                                                                                                                                                                                                                                           | `'NikkiGallery-startup-errors.log'`                                       | `%TEMP%`（最后兜底）                                                                                             |
| `src/main/utils/logger.ts:182`                                                                                                                                                                                                                                                     | `path.join(appData,'wxnn-photo-manager','logs','main.log')`               | `whenReady` 前手工拼的 `%APPDATA%` 回退                                                                          |
| `src/main/utils/logger.ts:183`                                                                                                                                                                                                                                                     | `path.join(os.tmpdir(),'wxnn-photo-manager-logs',…)`                      | 同上                                                                                                             |
| `src/main/database/connection.ts:156`                                                                                                                                                                                                                                              | `'wxnn_photo_manager.db'`                                                 | `userData\database\`                                                                                             |
| `src/main/services/backup-service.ts:158`                                                                                                                                                                                                                                          | `` `wxnn_photo_manager_${ts}${uid}.db` ``                                 | `userData\backups\` 生成侧                                                                                       |
| `src/main/services/backup-service.ts:214`                                                                                                                                                                                                                                          | `startsWith('wxnn_photo_manager_')`                                       | **列表过滤**（不同值 ⇒ 老备份静默消失）                                                                          |
| `src/main/services/backup-service.ts:533`                                                                                                                                                                                                                                          | `'wxnn_photo_manager.db'`                                                 | 恢复源路径                                                                                                       |
| `src/main/ipc/validator.ts:150`                                                                                                                                                                                                                                                    | `/^wxnn_photo_manager_\d{8}_\d{6}(_[a-zA-Z0-9]+)?\.db$/`                  | **zod 闸门**（不同值 ⇒ 恢复/删除直接被拒）                                                                       |
| `src/main/utils/dir-manager.ts:146`                                                                                                                                                                                                                                                | `backupDir: /^wxnn_photo_manager_.*\.db$/`                                | `MIGRATE_PATTERNS`                                                                                               |
| `src/renderer/pages/settings/data-sections.tsx:23`、`:25`                                                                                                                                                                                                                          | 文件名规范文案 + 同款正则                                                 | 渲染层 UID 解析                                                                                                  |
| `src/main/app/lifecycle.ts:322,324,328`                                                                                                                                                                                                                                            | `setDbPath(...)`                                                          | scanner / media-worker 传参                                                                                      |
| `src/main/app/desktop-shortcut.ts:27`、`:69`                                                                                                                                                                                                                                       | `'无限暖暖相册管理工具.lnk'`                                              | 桌面 / `homedir` 快捷方式文件名                                                                                  |
| `src/main/nikkisync/sync-server-view.ts:34`                                                                                                                                                                                                                                        | `SYNC_SERVER_DEFAULT_NAME = 'NikkiGallery'`                               | mDNS 实例名 + 手机端 `PairResponse.serverName`                                                                   |
| `src/main/database/sync-metadata-repository.ts:84`                                                                                                                                                                                                                                 | `DEFAULT_SERVER_NAME = 'WXNN XiangCe'`                                    | 落库 `server_name`（仅新建库生效，`:327` 保留既有值）                                                            |
| `src/renderer/utils/resonance/exportPayload.ts:142`                                                                                                                                                                                                                                | `` `nikkigallery-resonance-${iso}.json` ``                                | 默认导出文件名（读侧不匹配该名字，安全）                                                                         |
| `src/main/app/renderer-protocol.ts:10,11`                                                                                                                                                                                                                                          | `process.env.WXNN_RENDERER_DIR`                                           | **禁改**（私有配置键）                                                                                           |
| `src/main/database/sync-metadata-repository.ts:330`                                                                                                                                                                                                                                | `` `wxnn-${16hex}` ``                                                     | **禁改**（已落库配对身份）                                                                                       |
| `src/main/services/xmp-metadata-service.ts:43,44`                                                                                                                                                                                                                                  | `http://wxnn.qianlu.com/xmp/1.0/`、`wxnn` 前缀                            | **禁改**（URL + 已写入用户照片）                                                                                 |
| `scripts/simulate-gpu-crash.cjs:16,58,59`                                                                                                                                                                                                                                          | `%APPDATA%\NikkiGallery`、`.config/NikkiGallery`                          | **既有缺陷**：真实目录是 `wxnn-photo-manager`，本次顺带落正                                                      |
| `e2e/helpers.ts:81,111`、`e2e/perf-real.e2e.ts:15,36,335,342,356,430`                                                                                                                                                                                                              | `%APPDATA%/wxnn-photo-manager/diag.log`、`database/wxnn_photo_manager.db` | 真装 e2e 与 perf 工装                                                                                            |
| 注释类：`dir-manager.ts:37`、`crash-service.ts:38`、`log-service.ts:189`、`editor-service.ts:64`、`metadata-isolation-guards.ts:18`、`user-diag-path.ts:5,26,49-51`、`startup-diagnostic.ts:24,25,34,49`、`early-crash-guard.ts:45,46`、`index.ts:53,251`、`desktop-shortcut` 顶部 | 描述落盘位置                                                              | 跟随改动，其中 3 处在受保护目录需授权注释                                                                        |

### E. 测试断言（改了源码不改这些就红灯）

| 套件                                                                                                                          | 站点                                                                                                                                                                                                                                                              | 锁定内容                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/utils/startup-diagnostic.test.ts`                                                                                   | `:86,103,112,123,260`（+ 用例名 `:85,96,108`）                                                                                                                                                                                                                    | `/NikkiGallery[\\/]Diagnostics[\\/]…/` 5 条                                                                                       |
| `src/main/utils/early-crash-guard.test.ts`                                                                                    | `:86,99,114,129,229`（+ `:82`）                                                                                                                                                                                                                                   | `toBe()` 精确匹配兜底目录链                                                                                                       |
| `src/main/services/crash-service.test.ts`                                                                                     | `:87`                                                                                                                                                                                                                                                             | 崩溃目录 `toMatch`                                                                                                                |
| `src/main/utils/dir-manager.test.ts`                                                                                          | `:78,79`（备份迁移）、`:149`（诊断目录）                                                                                                                                                                                                                          | `MIGRATE_PATTERNS` 逐字                                                                                                           |
| `src/main/app/__tests__/lifecycle.test.ts`                                                                                    | `:47,967`（诊断）、`:628,642,643`（DB 名）                                                                                                                                                                                                                        | 含一处 `toBe('/mock/NikkiGallery/Diagnostics')`                                                                                   |
| `src/main/app/__tests__/error-handlers.test.ts`                                                                               | `:61`（mock 路径）、`:132,191`（`toContain('NikkiGallery')`）                                                                                                                                                                                                     | 致命弹窗文案                                                                                                                      |
| `src/main/app/__tests__/desktop-shortcut.test.ts`                                                                             | `:91` 定义，`:205,226,264` 断言                                                                                                                                                                                                                                   | `.lnk` 文件名                                                                                                                     |
| `src/main/services/backup-service.test.ts`                                                                                    | 32 处 `wxnn_photo_manager_*`                                                                                                                                                                                                                                      | **爆炸半径最大**                                                                                                                  |
| `src/main/ipc/handlers/backup.test.ts`                                                                                        | `:184,185,193,206,207,215`                                                                                                                                                                                                                                        | 穿过 zod 正则执行                                                                                                                 |
| `src/main/database/connection.test.ts`                                                                                        | `:728,733,1582,1691,1711`                                                                                                                                                                                                                                         | DB/-wal/.clean-exit 名                                                                                                            |
| `src/main/app/__tests__/{custom-dirs:67,media-update:75,recovery:79}.test.ts`                                                 | —                                                                                                                                                                                                                                                                 | 迁移模式 / DB 路径 / 备份 `.bak`                                                                                                  |
| `src/main/ipc/handlers/_test-helpers.ts`                                                                                      | `:268`                                                                                                                                                                                                                                                            | 共享 `getDbPath` mock                                                                                                             |
| `src/main/nikkisync/sync-server-view.test.ts`                                                                                 | `:80`                                                                                                                                                                                                                                                             | `name: 'NikkiGallery'`                                                                                                            |
| `src/renderer/utils/resonance/exportPayload.test.ts`                                                                          | `:225`                                                                                                                                                                                                                                                            | 导出文件名                                                                                                                        |
| `src/main/app/startup-environment.test.ts`                                                                                    | `:42,55,67,78`                                                                                                                                                                                                                                                    | fixture 安装路径，属自投数据（可留可改，本次为一致性一并改）                                                                      |
| `tests/ci-linux.setup.ts:51,126`、`tests/mocks/ci-linux-fs.ts:23,292`、`src/main/utils/ci-linux-emulation.test.ts:53,128,132` | `/home/runner/work/NikkiGallery/NikkiGallery`                                                                                                                                                                                                                     | **四站点必须同 commit**：`CI_ROOT` 是功能键，与装置注入的 cwd 不等值会让 rooted 读路径落进「根不可写/不存在」mock，伪装成产品缺陷 |
| `tests/mocks/electron.ts:156`                                                                                                 | `'nikki-gallery-test'`                                                                                                                                                                                                                                            | `app.getName()` mock，无断言锁定                                                                                                  |
| `src/main/video-editor/watermark-builder.test.ts:28,93`                                                                       | `content:'NikkiGallery'`                                                                                                                                                                                                                                          | 任意 fixture 串，两侧同改或不改均可通过                                                                                           |
| **不会红**                                                                                                                    | `e2e/helpers.ts:19-25` 用 `glob('release/win-unpacked/*.exe')`、`sync-metadata-repository.test.ts:881,884` 引用常量、`vitest.config.ts:68` 不收 `docs/**`、`.storybook/` 0 命中                                                                                   | 自动跟随 / 无需改动                                                                                                               |
| **必须保持绿（证明禁改项未被动）**                                                                                            | `src/shared/types/resonance.test.ts:188`（`app:'nikkigallery'`）、`UpdateDialog.test.tsx:66-68`（URL 源码嗅探）、`SyncGalleryToolbar.test.tsx:148`（锁的是上游 `ToStardust/NikkiSync`）、`ipc-validate.test.ts:691`（`validateTagName('无限暖暖相册')` 是游戏词） | 任一红 = 越界                                                                                                                     |

---

## 一、名称映射表（唯一真相源，所有节点按此表取值）

### 1.1 需替换

| 旧形式                                                                                                                                                                                                                                                                                                                                                                                                                                      | 新形式                                                                           | 出现场合                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `无限暖暖相册管理工具`                                                                                                                                                                                                                                                                                                                                                                                                                      | `喵星图`                                                                         | `productName`、`shortcutName`、`.lnk` 文件名、`<title>`、zh-CN i18n 值、进程名提示文案、文档 |
| `無限暖暖相簿管理工具`                                                                                                                                                                                                                                                                                                                                                                                                                      | `喵星圖`                                                                         | zh-TW i18n 值                                                                                |
| `WXNN Photo Album Manager` / `WXNN フォトアルバム管理ツール` / `無限暖暖アルバム管理ツール` / `무한난난 앨범 관리 도구` / `WXNN 사진 앨범 관리 도구` / `WXNN Fotoalbum-Manager` / `WXNN Fotoverwaltungs-Tool` / `Gestor de álbumes de fotos WXNN` / `Gestionnaire d'album photo WXNN` / `Gerenciador de álbum de fotos WXNN` / `Менеджер альбома фотографий WXNN` / `เครื่องมือจัดการอัลบั้มรูปภาพ WXNN` / `Công cụ quản lý album ảnh WXNN` | `Meow Star Map`                                                                  | 9 个非中文 locale 的 `appValue` / `appTitle`                                                 |
| `NikkiGallery`（品牌叙述）                                                                                                                                                                                                                                                                                                                                                                                                                  | `Meow Star Map`                                                                  | 文档正文、README H1、About 页标签、插件示例、`doctor.ts` 横幅                                |
| `NikkiGallery`（文件名/目录名/实例名）                                                                                                                                                                                                                                                                                                                                                                                                      | `MeowStarMap`                                                                    | `PRODUCT_DIAG_DIRNAME`、`%TEMP%` 日志名、mDNS 实例名、CI 产物名、安装包前缀                  |
| `NikkiGallery-Setup-${version}.${ext}`                                                                                                                                                                                                                                                                                                                                                                                                      | `MeowStarMap-Setup-${version}.${ext}`                                            | `artifactName`                                                                               |
| `NikkiGallery 启动失败，程序已退出。` / `NikkiGallery failed to start and has exited.`                                                                                                                                                                                                                                                                                                                                                      | `喵星图启动失败，程序已退出。` / `Meow Star Map failed to start and has exited.` | `early-crash-guard.ts:126,127`                                                               |
| `无限暖暖相册分享`                                                                                                                                                                                                                                                                                                                                                                                                                          | `喵星图分享`                                                                     | `share-wifi-service.ts:420,438`                                                              |
| `wxnn-photo-manager`                                                                                                                                                                                                                                                                                                                                                                                                                        | `meow-star-map`                                                                  | npm `name`、`package-lock.json:2,8`、`appId` 尾段、`%APPDATA%` 字面量                        |
| `com.qianlu.wxnn-photo-manager`                                                                                                                                                                                                                                                                                                                                                                                                             | `com.qianlu.meow-star-map`                                                       | `package.json:211`                                                                           |
| `wxnn_photo_manager.db`（及 `-wal/-shm/.clean-exit/.corrupt-*`）                                                                                                                                                                                                                                                                                                                                                                            | `meow_star_map.db`                                                               | `connection.ts:156`、`backup-service.ts:533`                                                 |
| `wxnn_photo_manager_<ts>[_uid].db`                                                                                                                                                                                                                                                                                                                                                                                                          | `meow_star_map_<ts>[_uid].db`                                                    | 生成 `:158`、过滤 `:214`、zod `:150`、迁移 `:146`、渲染层 `:23,25`                           |
| `WXNN XiangCe`（`DEFAULT_SERVER_NAME`）                                                                                                                                                                                                                                                                                                                                                                                                     | `MeowStarMap`                                                                    | `sync-metadata-repository.ts:84`                                                             |
| `nikkigallery-resonance-${iso}.json`                                                                                                                                                                                                                                                                                                                                                                                                        | `meow-star-map-resonance-${iso}.json`                                            | `exportPayload.ts:142`                                                                       |
| `/home/runner/work/NikkiGallery/NikkiGallery`                                                                                                                                                                                                                                                                                                                                                                                               | `/home/runner/work/MeowStarMap/MeowStarMap`                                      | CI 宿主装置四处（真实 runner cwd 已随远端更名）                                              |
| `nikki-gallery-test`                                                                                                                                                                                                                                                                                                                                                                                                                        | `meow-star-map-test`                                                             | `tests/mocks/electron.ts:156`                                                                |
| `NikkiGallery-win-x64-nsis`                                                                                                                                                                                                                                                                                                                                                                                                                 | `MeowStarMap-win-x64-nsis`                                                       | `build.yml:248`                                                                              |
| `无限暖暖相册管理工具.lnk`                                                                                                                                                                                                                                                                                                                                                                                                                  | `喵星图.lnk`                                                                     | `desktop-shortcut.ts:27,69`                                                                  |
| `cd NikkiGallery`                                                                                                                                                                                                                                                                                                                                                                                                                           | `cd MeowStarMap`                                                                 | README / DEVELOPMENT 快速上手（远端已更名，此处当前是**错的**）                              |

### 1.2 保持原名（禁改清单，供逐条复核）

| 保持项                                                                                                                        | 位置                                                                                                                                              | 理由                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `NikkiGalleryManifest`、`nikkiGallery` 字段                                                                                   | `plugin.ts:18,184`、`plugin-host.ts:25,376,377,391`、`permission-guard.ts:100`、`plugin-sections.tsx:249,473,474`、示例 `package.json:12`         | 类名 / 第三方插件必须写的**磁盘键**，改了全部插件失效 |
| `app: 'nikkigallery'` zod + 类型 literal                                                                                      | `resonance.ts:384,416`、`exportPayload.ts:19,129`                                                                                                 | 导入信封**线格式**，改了历史导出被拒                  |
| XMP 命名空间 URI 与 `wxnn:` 前缀                                                                                              | `xmp-metadata-service.ts:43,44`                                                                                                                   | URL + 已写入用户照片                                  |
| `WXNN_RENDERER_DIR`                                                                                                           | `renderer-protocol.ts:10,11`                                                                                                                      | 私有配置键                                            |
| `wxnn-${16hex}` serverId 前缀                                                                                                 | `sync-metadata-repository.ts:330`                                                                                                                 | 已落库配对身份                                        |
| 一切 URL                                                                                                                      | `about-sections.tsx:17,395,399`、`UpdateDialog.tsx:18`、`CHANGELOG.md:426-437`、`README.md:60,173`、`docs/**` 外链、`nikkigallery.vip` 等第三方域 | 用户规定「任何 URL 不动」                             |
| 游戏标识 `wxnn`/`WXNN`/`Infinity Nikki`/`无限暖暖`/`NikkiPhotos_*`/注册表 `…\Uninstall\InfinityNikki`                         | `scanner/**`、`validator.ts:237,254`、`media-read-guard.ts:92` 等                                                                                 | 与项目名无关                                          |
| `@nikkisync` / `NikkiSync` / `nikkisync-*` / `__NIKKI_PRELOAD_DEV__` / 上游文件名 `NikkiGalleryMetadataDictionaryProvider.ts` | `package.json:225,226,261`、`electron.vite.config.ts:93,95,97,133`、`scripts/*nikkisync*`、`src/main/nikkisync/**`、`docs/sync-integration/**`    | 独立依赖，非本项目旧名                                |
| `eslint.config.js:506` 的 `wxnn-photo-manager/**` ignore                                                                      | 同                                                                                                                                                | 指向磁盘真实存在的本地遗留目录，不是产品引用          |
| `__wxnnCiLinuxEmulation` 全局标识                                                                                             | `tests/ci-linux.setup.ts:124`                                                                                                                     | 标识符不改                                            |
| `main.app.name` 在 11 个非 zh-CN 包为空                                                                                       | locales                                                                                                                                           | 既有缺口，填补属新增功能                              |
| 目录结构、依赖清单、任何逻辑、Android 内容                                                                                    | 全仓                                                                                                                                              | 用户规定；本任务只改「名称字符串的值」                |

---

## 二、依赖声明

**无新增依赖，无版本变更，无删除依赖。**

- 不运行 `npm install` / `npm update`（会扰动依赖清单，超出范围）。`package-lock.json:2` 与 `:8` 的 `"name"` **手工编辑**，与 `package.json:2` 同批提交 —— CI 各 job 用 `npm ci`（`build.yml:51,133,157`），二者不一致直接报错。
- lock 的 `"version"` 与全部依赖树不动。
- 复用既有工具：`scripts/verify-changes.ts`（`npm run verify`）、`scripts/core-path-gate.ts`、`npm run i18n:guard`、`npm run docs:links`、`npm run test:ci-linux`、`tsx`。

---

## 三、启动说明

```bash
# 环境：Node >=22.12.0（engines），本机 v24.18.0，Windows x64
npm run verify          # 只读：tsc -b + eslint(无 --fix) + core-gate + prettier --check + 相关单测
npm test                # vitest run 全量
npm run typecheck       # src + scripts
npm run typecheck:e2e   # 唯一能收到 e2e/** 的类型闸门
npm run i18n:guard      # locale 键对齐
npm run docs:links      # 死引用闸门，必须 dead = 0
npm run test:ci-linux   # ubuntu-latest 宿主语义复现装置（只读诊断）
```

单节点最小验证：`npx vitest run <该节点涉及的测试文件>`。

**基线（实施前必须先跑一次并存档，作为红/绿灯对照）**

| 命令                                                                   | 基线（本次盘点实测）        |
| ---------------------------------------------------------------------- | --------------------------- |
| `npm run i18n:guard`                                                   | `✅` 通过                   |
| `npm run docs:links`                                                   | `✅ 无死引用（153 处提醒）` |
| `git grep -c NikkiGallery -- ':!docs/plans' ':!docs/sync-integration'` | 需现场取值并存档            |

---

## 四、错误处理

### 4.1 异常分支

| 异常                        | 检测                                                                                                                                                                                          | 处置                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **漏改**                    | 节点收尾 `git grep -n "wxnn-photo-manager\|wxnn_photo_manager\|NikkiGallery\|无限暖暖相册管理工具\|WXNN XiangCe" -- ':!docs/plans' ':!docs/archive' ':!docs/sync-integration' ':!CHANGELOG*'` | 命中项必须能归入 1.2；归不入即漏改，当场补                                                      |
| **误改禁改项**              | 每节点 `git diff` 复核 + `resonance.test.ts` / `UpdateDialog.test.tsx` / `SyncGalleryToolbar.test.tsx` / `src/main/plugins`                                                                   | `git checkout -- <file>` 整文件回退，不留半态                                                   |
| **锁被拆半**                | 该节点单测集红灯                                                                                                                                                                              | 禁止「先提源码、下轮再改测试」，同节点内改完再提                                                |
| **受保护路径漏授权注释**    | `npx tsx scripts/core-path-gate.ts` → `[CORE-GATE] ✗ missing-auth`；pre-commit 拦截                                                                                                           | 第 1 行补 `// @core-change: <真实中文原因>`，同批提交                                           |
| **授权注释重复**            | ESLint `local/core-path-guard`（前 5 行 >1 条报错）                                                                                                                                           | 替换旧注释，不追加                                                                              |
| **BOM / CRLF 注入**         | `npm run lint` 的 `unicode-bom: error`、`prettier --check --end-of-line auto`                                                                                                                 | `npx eslint --fix` 剥 BOM；批量改写必须无 BOM 写回                                              |
| **README 改写误伤版本闸门** | `check-doc-versions.ts:58-61`（找不到 `Electron \d+\.\d+` 即 `exit 1`）                                                                                                                       | 保留 `:10-14` 徽章原文                                                                          |
| **文档新增死引用**          | `check-md-links.test.ts:232` 断言 `totals.dead === 0`                                                                                                                                         | 新写的 `` `docs/x.md` ``/`` `src/x.ts` `` token 必须真实存在，否则同行加 `已移除/不存在/不入仓` |
| **误加 CHANGELOG bullet**   | `check-changelog-release.ts:119-133` 阻断 `dist:win`                                                                                                                                          | 本次不写 CHANGELOG bullet                                                                       |
| **CI 装置四站点漂移**       | 只改 `ci-linux.setup.ts` 不改 `ci-linux-fs.ts` → `npm run test:ci-linux` 大面积红                                                                                                             | 四站点同 commit；有效性由 `ci-linux-emulation.test.ts` 逐轴自检                                 |
| **改名后首启「相册空了」**  | 第八节人工搬迁未执行                                                                                                                                                                          | 属预期而非缺陷：禁止新增自动迁移逻辑，清单随 `DEVELOPMENT.md` 交付                              |

### 4.2 兜底策略

1. **一节点一提交**；提交前 `npm run verify:staged`，提交后 `git status --porcelain` 复核钩子是否改写文件。
2. **回滚单位 = 节点**：每节点独立 commit，`git revert <sha>` 整节点回退。
3. **N1 前备份**：复制 `%APPDATA%\wxnn-photo-manager` → `%APPDATA%\wxnn-photo-manager.bak-<日期>`（只复制不删）。回滚 = 删新目录 + 跑旧安装包。
4. 任一红灯 30 分钟内无法定位 ⇒ **停在当前节点**，失败输出如实写入本文末「执行记录」；不放宽断言、不 `it.skip`、不调低覆盖率阈值。

### 4.3 日志输出

- 每节点开始/结束在本文末「执行记录」追加一行：`节点 | 命令 | 结果标记 | 关键计数`。
- 复用脚本既有前缀定位，不新增日志代码：`[VERIFY] ▶/✓/✗/⊘/⚠`、`[PRE-COMMIT]`、`[CORE-GATE]`、`[i18n:guard]`。
- 运行时侧不新增任何 logger 调用，只改既有路径字面量。

---

## 五、参数校验（本任务的「入参」= 名称映射表的取值约束）

| 项                      | 校验规则                                                                                                                              | 非法值处置                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 中文产品名              | 恰为 `喵星图`（3 字，无空格、无「相册管理工具」尾缀）                                                                                 | 不得自创 `喵星图相册管理` 等变体                                                      |
| 英文品牌名              | 恰为 `Meow Star Map`（三词各一空格），仅用于 UI 文案与文档正文                                                                        | 正文出现 `MeowStarMap` 即误用，回改为带空格形                                         |
| kebab 标识              | 恰为 `meow-star-map`（全小写、两个连字符），仅用于 npm `name`、`appId` 尾段、`%APPDATA%` 目录、导出文件名前缀                         | npm name 不容大写/空格，出现 Pascal 形视为非法                                        |
| Pascal 形               | `MeowStarMap`，仅用于文件名/目录名/CI 产物名/mDNS 实例名                                                                              | 空格会破坏 NSIS `artifactName` 与命令行引用                                           |
| 下划线形                | `meow_star_map`，仅用于 DB 与备份文件名                                                                                               | DB 名沿用既有下划线形态，出现 `-` 即非法                                              |
| **必填项**              | `productName`、`shortcutName`、`artifactName`、`appId`、`name` 五项必须同 commit（N1）落值                                            | 缺一即 NSIS 身份不完整，补全后重跑 N1                                                 |
| **边界：备份 zod 正则** | 保持 `/^meow_star_map_\d{8}_\d{6}(_[a-zA-Z0-9]+)?\.db$/`：日期 8 位、时间 6 位、`_uid` 段可选且字符集 `[a-zA-Z0-9]`、扩展名小写 `.db` | 少 `(_[a-zA-Z0-9]+)?` ⇒ 多 UID 备份被 `ValidationError` 拒；写宽 ⇒ 非法名进入恢复链路 |
| **边界：备份前缀同值**  | `backup-service.ts:158/:214`、`validator.ts:150`、`dir-manager.ts:146`、`data-sections.tsx:25`、`connection.ts:156` **五处同值**      | 任一处不同 ⇒ 备份可见性/恢复/清理三链路各自静默断裂                                   |
| **边界：locale JSON**   | 只改 value；键名/键序/嵌套零变动；12 文件每文件只动 2 键（zh-CN 另加 3 处）                                                           | 键名变动立刻触发 `i18n:guard` / `i18n:check` 红灯                                     |
| **边界：诊断目录常量**  | 只改 `user-diag-path.ts:12` 一处；`DIAG_SUBDIR`、候选链顺序、`getDocumentsPath` 注入逻辑不动                                          | 改候选链即改逻辑，属禁止事项                                                          |

---

## 六、基础测试用例（正常 / 异常 / 边界）

> 本任务不新增业务功能，「测试用例」= 证明更名正确性与完整性的可判定断言。前两类复用既有套件，第三类为节点收尾现跑校验（`git grep` / `node -e`，不落新测试文件）。

### 6.1 正常路径（须从红转绿）

| 用例                                  | 命令                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 备份生成/列表/恢复/清理全链路用新前缀 | `npx vitest run src/main/services/backup-service.test.ts src/main/ipc/handlers/backup.test.ts`                                                                                 |
| DB 路径与 WAL/干净退出标记跟随新前缀  | `npx vitest run src/main/database/connection.test.ts`                                                                                                                          |
| 诊断目录四候选跟随新常量              | `npx vitest run src/main/utils/startup-diagnostic.test.ts src/main/utils/early-crash-guard.test.ts src/main/utils/dir-manager.test.ts src/main/services/crash-service.test.ts` |
| 桌面快捷方式写新 `.lnk`               | `npx vitest run src/main/app/__tests__/desktop-shortcut.test.ts`                                                                                                               |
| 自定义目录迁移模式为新前缀            | `npx vitest run src/main/app/__tests__/custom-dirs.test.ts`                                                                                                                    |
| 同步实例名/默认服务器名               | `npx vitest run src/main/nikkisync/sync-server-view.test.ts src/main/database/sync-metadata-repository.test.ts src/main/app/__tests__/nikkisync-runtime-setup.test.ts`         |
| 导出文件名前缀变、信封 literal 不变   | `npx vitest run src/renderer/utils/resonance/exportPayload.test.ts src/shared/types/resonance.test.ts`                                                                         |
| CI 宿主装置四轴一致                   | `npm run test:ci-linux`                                                                                                                                                        |
| locale 值改动不影响键对齐             | `npm run i18n:guard && npm run i18n:check`                                                                                                                                     |
| 全量                                  | `npm test`                                                                                                                                                                     |

### 6.2 异常路径（必须**保持绿**，证明禁改项未动）

| 用例                                       | 命令                                                                                                                                       | 证明                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 共鸣导入信封 literal 拒收非 `nikkigallery` | `npx vitest run src/shared/types/resonance.test.ts`                                                                                        | 线格式未变，历史导出仍可导入         |
| 更新弹窗逐字锁定仓库 URL                   | `npx vitest run src/renderer/components/common/UpdateDialog.test.tsx`                                                                      | URL 一字未动                         |
| NikkiSync 装载缝与链接器                   | `npx vitest run src/main/nikkisync scripts/__tests__/verify-nikkisync-link.test.ts scripts/__tests__/link-nikkisync.test.ts`               | `@nikkisync` 面未波及                |
| IPC 路径白/黑名单与游戏路径                | `npx vitest run src/main/ipc/media-read-guard.test.ts src/main/ipc/validator.test.ts src/main/utils/ipc-validate.test.ts src/main/scanner` | 游戏侧 `wxnn`/`InfinityNikki` 未误改 |
| 插件清单键与权限读取                       | `npx vitest run src/main/plugins`                                                                                                          | `nikkiGallery` 磁盘键未改名          |
| 缺授权注释时闸门必须红                     | 只改 `backup-service.ts` 不写注释 → `npx tsx scripts/core-path-gate.ts` 期望 `✗ missing-auth`；补注释后期望 `✓`                            | 闸门真实生效，未被绕过               |
| 静态与类型                                 | `npm run lint && npm run typecheck && npm run typecheck:e2e`                                                                               | 0 error；BOM/行尾/授权注释合规       |

### 6.3 边界校验（节点收尾现跑）

| 用例             | 方法                                                                                                                                                | 期望                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 五处备份名同值   | `node -e` 读 5 个文件断言均含 `meow_star_map`                                                                                                       | 5/5，0 处残留 `wxnn_photo_manager`                                                        |
| zod 正则边界样本 | 现跑：合法 `meow_star_map_20260101_120000.db`、`…_abc123.db`；非法 `wxnn_photo_manager_20260101_120000.db`、`meow_star_map_20260101.db`、大写 `.DB` | 前二真、后三假                                                                            |
| 三种形式互斥     | `git grep -n` 分别查 `Meow Star Map` / `meow-star-map` / `MeowStarMap`                                                                              | 各只命中自己的场合，无交叉误用                                                            |
| 禁改项零命中     | `git diff` 对 `nikkiGallery`、`NikkiGalleryManifest`、`'nikkigallery'`、XMP URI、`WXNN_RENDERER_DIR`                                                | 0 命中                                                                                    |
| 生效文档无旧名   | `git grep -c` 限定 README/AGENTS/ARCHITECTURE*/DEVELOPMENT*/PLUGIN_API/tutorial                                                                     | 0（PLUGIN_API 仅允许小写键命中）                                                          |
| 死引用           | `npm run docs:links`                                                                                                                                | `dead = 0`，与基线同值                                                                    |
| 覆盖率           | `npm run test:coverage`                                                                                                                             | 达 `vitest.config.ts:102-107` 的 `66/58/59/68`（不删测试不删可执行行，无需重定基线）      |
| 真机冒烟         | `npm run dist:win && npm run e2e:smoke`                                                                                                             | 产物 `MeowStarMap-Setup-<ver>.exe`、`release/win-unpacked/喵星图.exe`；e2e 用 glob 取 exe |

---

## 七、节点拆分（N1–N8，一节点一 commit）

排序依据：**三个必须整体翻转的锁**决定最小提交边界。

- **锁 A｜userData 根**：`name` 变更牵动 5 处手工拼 `%APPDATA%` 的代码 + `package-lock.json`（`npm ci` 一致性）。
- **锁 B｜DB/备份文件名**：13 处源码 + 约 56 处断言，拆半即「恢复被 zod 拒 + 45 条断言红」。
- **锁 C｜诊断目录常量**：1 处定义 + 11 处断言。

### N1 — 包身份与手工拼装的 userData 路径（锁 A）

- **文件**：`package.json:2,4,211,212,277,297`、`package-lock.json:2,8`、`.github/workflows/build.yml:248`、`src/main/utils/logger.ts:182,183`、`src/main/app/desktop-shortcut.ts:27,69`、`src/main/app/__tests__/desktop-shortcut.test.ts:91`、`e2e/helpers.ts:16,111`、`scripts/simulate-gpu-crash.cjs:16,58,59`
- **输入**：映射表 1.1 → **输出**：安装包/快捷方式/exe/`%APPDATA%` 根全部取新值
- **顺带修正**：`simulate-gpu-crash.cjs:58,59` 写死 `%APPDATA%\NikkiGallery`（真实是 `wxnn-photo-manager`），本次落到正确新值，commit body 说明
- **红灯**：先只改 `desktop-shortcut.ts:27,69` → `npx vitest run src/main/app/__tests__/desktop-shortcut.test.ts` 在 `:205,:264` 红
- **绿灯**：同命令全绿；`npx prettier --check --end-of-line auto package.json package-lock.json`；`git grep -c wxnn-photo-manager -- package.json package-lock.json` = 0
- **受保护路径**：无 → **验收**：`npm run verify` ✓、`npm run typecheck:e2e` ✓

### N2 — 诊断目录与启动/崩溃日志（锁 C；同时是授权注释机制试点）

- **文件**：`user-diag-path.ts:12`（+注释 `:5,26,49-51`）、`startup-diagnostic.ts:38,57`（+`:24,25,34,49`）、`early-crash-guard.ts:64,126,127`（+`:45,46`）、`src/main/services/crash-service.ts:38`、`src/main/services/log-service.ts:189`；测试 `startup-diagnostic.test.ts:85,86,96,103,108,112,123,260`、`early-crash-guard.test.ts:82,86,99,114,129,229`、`crash-service.test.ts:87`、`dir-manager.test.ts:149`、`app/__tests__/{lifecycle:47,967,error-handlers:61,132,191}`、`startup-environment.test.ts:42,55,67,78`
- **红灯**：先只改 `user-diag-path.ts:12` → 11 条断言红
- **绿灯**：上述文件 `npx vitest run` 全绿；`core-path-gate.ts` 先「无注释 ✗」再「补注释 ✓」
- **授权注释**：`crash-service.ts`、`log-service.ts` → **验收**：`npm run verify` ✓

### N3 — 数据库与备份文件名（锁 B，爆炸半径最大）

- **源码 13 处**：`connection.ts:156`、`backup-service.ts:158,214,533`、`validator.ts:150`、`dir-manager.ts:146`、`lifecycle.ts:322,324,328`、`data-sections.tsx:23,25`、注释 `editor-service.ts:64`、`metadata-isolation-guards.ts:18`、`src/main/database/AGENTS.md:91`
- **测试约 56 处**：`backup-service.test.ts`(×32)、`backup.test.ts`(×6)、`connection.test.ts`(×5)、`dir-manager.test.ts:78,79`、`_test-helpers.ts:268`、`app/__tests__/{custom-dirs:67,lifecycle:628,642,643,media-update:75,recovery:79}`、`e2e/perf-real.e2e.ts:15,36,335,342,356,430`
- **红灯**：先只改 `connection.ts` + `backup-service.ts` → 上述套件红
- **绿灯**：`npx vitest run src/main/services/backup-service.test.ts src/main/database/connection.test.ts src/main/ipc/handlers/backup.test.ts src/main/utils/dir-manager.test.ts src/main/app/__tests__` 全绿 + `npm run typecheck:e2e`
- **授权注释**：`backup-service.ts`、`editor-service.ts` → **验收**：6.3「五处同值」「zod 边界样本」通过

### N4 — 同步面可见名称

- **文件**：`sync-server-view.ts:34` + `sync-server-view.test.ts:80`；`sync-metadata-repository.ts:84`
- **取值**：两处均 `MeowStarMap`（mDNS 实例名保持 ASCII，避开非 ASCII 清洗分支）
- **不改**：`sync-metadata-repository.ts:330` `wxnn-` 前缀、`src/main/sync/**`、`sync/server/*.test.ts` 自投的 `serverName:'WXNN XiangCe'` fixture
- **红/绿灯**：`npx vitest run src/main/nikkisync/sync-server-view.test.ts src/main/database/sync-metadata-repository.test.ts src/main/app/__tests__/nikkisync-runtime-setup.test.ts`
- **验收**：全绿；`DEFAULT_SERVER_NAME` 引用处（`:327,336`）自动跟随，无逻辑改动

### N5 — 导出文件名、窗口标题、分享页、关于页标签

- **文件**：`exportPayload.ts:142` + `exportPayload.test.ts:225`；`src/renderer/index.html:13`；`src/renderer/preview/index.html:7`；`share-wifi-service.ts:420,438`；`about-sections.tsx:75`、`:395` 的可见标签（**不动** `:17,395,399` URL）
- **红灯**：`npx vitest run src/renderer/utils/resonance/exportPayload.test.ts` 在 `:225` 红
- **绿灯**：同上 + `UpdateDialog.test.tsx` **必须仍绿**（证明 URL 未动）
- **授权注释**：`share-wifi-service.ts`
- **注意**：两处标题在模板字符串内，不被 i18n ESLint 选择器（只匹配 `Literal`）命中，不引入违规；**不应**顺手改 `t()`（属逻辑变更）
- **验收**：`npm run preview:check` 与 N5 前同档；`npx vitest run src/renderer` 全绿

### N6 — 多语言文案值（12 个 locale）

- **文件**：`src/renderer/i18n/locales/{zh-CN,zh-TW,en,ja,ko,de,es,fr,pt,ru,th,vi}.json`
- **精确位置**：`appValue`（zh-CN `:1678`，余 11 个 `:1269`）、`appTitle`（zh-CN `:2238`，余 11 个 `:1829`）；zh-CN 另加 `main.app.name:3537`、`cleanupFailed.detail:2768`、`startupFailed.title:2772`
- **取值**：zh-CN `喵星图`、zh-TW `喵星圖`、其余 9 个 `Meow Star Map`；`main.app.name` 取 `喵星图`（被 `desktop-shortcut.ts:54` 用作 `.lnk` 描述）
- **禁改**：`resonance.brand`、`resonance.subtitle`、`syncGallery.empty.gameRootMissing`、`shareCard.card.fallbackTitle`（均为游戏名）
- **红灯**：`git grep -c "无限暖暖相册管理工具" -- src/renderer/i18n/locales` 改前 >0 → 改后 =0
- **绿灯**：`npm run i18n:guard` + `npm run i18n:check` + `npx prettier --check --end-of-line auto "src/**/*.json"`
- **验收**：`npx vitest run src/renderer/i18n` 全绿；`git diff --stat` 每文件改动行数 = 命中键数（证明键名键序零变动）

### N7 — 工具链与 CI 宿主装置

- **文件**：`scripts/doctor.ts:161`（框线宽 42 列；`║        Meow Star Map 环境诊断报告        ║` 按 CJK 双宽配平，须目测）、`tests/ci-linux.setup.ts:51,126`、`tests/mocks/ci-linux-fs.ts:23,292`、`src/main/utils/ci-linux-emulation.test.ts:53,128,132`（**四处同 commit**）、`tests/mocks/electron.ts:156`、`docs/sync-integration/verify-audit.mjs:39`
- **`verify-audit.mjs:39` 判定：改** —— 可执行脚本断言仓库客观事实，属代码非叙述，不改则更名后任何人跑必抛；`00-code-audit-plan.md:43` 的旧名叙述按历史保留，此分歧写入 commit body
- **不改**：`tests/ci-linux.setup.ts:124` 的 `__wxnnCiLinuxEmulation` 标识符
- **红灯**：先只改 `ci-linux.setup.ts` 留旧 `CI_ROOT` → `npm run test:ci-linux` 红 → 补齐转绿
- **绿灯**：`npm run test:ci-linux`、`npx vitest run scripts/__tests__/path-semantics-guard.test.ts`、`npm run test:posix-host`
- **验收**：`git grep -c "/home/runner/work/MeowStarMap/MeowStarMap"` = 4

### N8 — 生效文档（最后做，内容须与已交付产物一致）

- **文件**：见 A 类表「改」列全部条目
- **中英对同步**：`ARCHITECTURE.md ↔ .en.md`、`DEVELOPMENT.md ↔ .en.md`（1:1 行偏移镜像）；`README.md` 内 zh §1–132 / en §136–246 成对（`:25↔:138`、`:71↔:184`）；`DEVELOPMENT.en.md:3` 现用第三种英文名 `Infinity Nikki Photo Manager`，本次统一为 `Meow Star Map`
- **不改**：`docs/CODING_CONVENTIONS.md`（0 处产品名；`.qoder` 镜像正文区须保持字节一致，`verify-format-scope.test.ts:350` 守护，而镜像命中在锚点之前的 frontmatter，闸门覆盖不到 ⇒ 手工改）、`docs/debt-registry.json:397`、`docs/技术债清单.md:240,308,309`、`docs/2.5.0/**` 与其配图目录
- **红灯**：`git grep -c "NikkiGallery\|无限暖暖相册管理工具\|wxnn-photo-manager" -- README.md AGENTS.md ARCHITECTURE.md ARCHITECTURE.en.md DEVELOPMENT.md DEVELOPMENT.en.md docs/PLUGIN_API.md docs/tutorial` > 0
- **绿灯**：同上 = 0（PLUGIN_API 仅允许小写 `nikkiGallery` 键命中）；`npm run docs:links` = `dead 0`
- **验收**：`npm run verify` ✓ + 6.3「三种形式互斥」通过

---

## 八、用户数据人工搬迁清单（随 `DEVELOPMENT.md` 交付，不写自动迁移代码）

源 `%APPDATA%\wxnn-photo-manager` → 目标 `%APPDATA%\meow-star-map`（先手建目录；搬迁前关应用并结束残留进程）。**不得同时运行新旧两个版本**（单实例锁键在 userData，两版会共写同一 DB）。

**必须搬迁并重命名**

1. `database\wxnn_photo_manager.db` → `meow_star_map.db`，连同 `*-wal`、`*-shm`、`*.clean-exit`、`*.corrupt-*`、`db-backup-*.db`、`pre-migration-*.db`
2. `backups\wxnn_photo_manager_<ts>[_uid].db` → 逐个改名 `meow_star_map_<ts>[_uid].db`（不改名则老备份在设置页不可见、不可恢复、不可清理，且属**静默**失效）

**原样搬迁** 3. `thumbnails\`（否则全量重建）4. `search-index\`（否则全文索引重建）5. `plugins\plugins.json`（否则插件安装态重置）6. `sync\server.crt`/`server.key`、`nikkisync\nikkisync.db`（否则**每台已配对手机都要重新配对**）7. `logs\`（可选历史）

**故意不搬，让新装重建** 8. `boot-ok.marker`、`last-exit.json`、`gpu-fallback.json`、`gpu-pref.json`、`heartbeat.json`、`diag.log`、`startup-errors.log`、`scan-log.jsonl`、`diagnostic-tmp-*`（搬前两项会让首启把正常退出误判为崩溃）；Electron 自管的 `Cache/`、`Code Cache/`、`GPUCache/`、`Network/`、`Local Storage/`、`Session Storage/`、`blob_storage/`、`Preferences`、`Local State`、`DIPS`、`Dawn*`、`Dictionaries`、`SharedStorage`、`.updaterId` 一律不搬

**收尾** 9. 孤儿 `%USERPROFILE%\Documents\NikkiGallery\Diagnostics\` 可选搬入新 `Documents\MeowStarMap\Diagnostics\` 后删除 10. 验证：相册计数一致 / 设置→备份只列 `meow_star_map_*` 且一次恢复往返成功 / 缩略图不重生 / 搜索有结果 / `logs\main.log` 无 `unable to open database file` / `npm run doctor` DB 检查 OK / 手机免重连 11. 回滚：删 `meow-star-map` + 跑旧安装包（全程无覆盖）

---

## 九、授权注释（受保护路径同批提交）

`PROTECTED_DIRS`（`core-path-gate.ts:29-34`）为 `src/main/preload/api`、`src/main/ipc/handlers`、`src/main/services`、`src/shared/errors`；`isProtectedPath`（`:91-105`）排除 `__tests__/`、`*.test.ts`、handlers 下 `_` 前缀。需注释的恰好 5 个文件全在 `src/main/services/**`：

| 文件                    | 注释（第 1 行，前 5 行内至多一条）                                             |
| ----------------------- | ------------------------------------------------------------------------------ |
| `crash-service.ts`      | `// @core-change: 项目更名后诊断目录名改为 MeowStarMap，同步崩溃转储目录注释`  |
| `log-service.ts`        | `// @core-change: 项目更名后诊断目录名改为 MeowStarMap，同步日志路径注释`      |
| `backup-service.ts`     | `// @core-change: 项目更名为喵星图，数据库与备份文件名前缀改为 meow_star_map`  |
| `editor-service.ts`     | `// @core-change: 项目更名后 pruneOldBackups 文件名正则前缀变更，同步注释表述` |
| `share-wifi-service.ts` | `// @core-change: 项目更名为喵星图，局域网分享页标题同步改名`                  |

⚠ **`AGENTS.md:60`「纯注释增删不触发」与实现不符**：`core-path-gate.ts:162-176` 把任何非空且非授权注释的增删行判为实质改动，因此 `crash-service.ts:38`、`log-service.ts:189`、`editor-service.ts:64` 三处**注释级**改动同样需要授权行。执行口径按实现走；文档偏差另立一行技术债，本次不顺手改文档。

---

## 十、残留风险登记

| 风险                                                 | 机理                                                                                                                                        | 判定                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 自动更新让老用户「相册清空」                         | 旧装 `app-update.yml`（`updaterCacheDirName: wxnn-photo-manager-updater`）取到 `MeowStarMap-Setup-*.exe`，装进新 appId + 新 userData ⇒ 空库 | **必须入计划**：本轮只做仓内更名，**不发布带更名的 tag**；发布前先出搬迁公告 |
| NSIS 不再就地升级，出现两个应用条目                  | `appId` + `productName` 同时变更（`package.json:211,212`）                                                                                  | beta 可接受 —— 写入 README/教程                                              |
| 老备份不可见/不可恢复/不可清理                       | `backup-service.ts:214` + `validator.ts:150`                                                                                                | **必须入计划** —— 第八节步骤 2                                               |
| 新旧两版共写 DB                                      | `requestSingleInstanceLock` 键在 userData（`lifecycle.ts:57,66`）                                                                           | **必须入计划** —— 清单首行                                                   |
| 同步服务器名沿用旧值                                 | `DEFAULT_SERVER_NAME` 仅作用于新建库；搬迁来的库存 `WXNN XiangCe`（`:327`）                                                                 | beta 可接受 —— 文档写明可在设置自改                                          |
| `%APPDATA%\wxnn-photo-manager` 与 `…-updater` 成孤儿 | 禁止新增清理逻辑                                                                                                                            | 可接受 —— 手工删除说明                                                       |
| 桌面并存两个 `.lnk`                                  | 旧 `无限暖暖相册管理工具.lnk` 与新 `喵星图.lnk`                                                                                             | 可接受 —— 手工删除说明                                                       |
| `npm ci` 与 lock 名不一致                            | `package-lock.json:2,8`                                                                                                                     | **必须入计划** —— N1 同 commit 手工改，不跑 `npm install`                    |

---

## 十一、全局回归与最终验证（N8 后按序执行）

```bash
npx vitest run src/main/services/backup-service.test.ts src/main/database/connection.test.ts src/main/utils/dir-manager.test.ts src/main/app/__tests__
npm run verify
npm run lint              # 期望 0 error
npm run typecheck
npm run typecheck:e2e
npm run i18n:guard && npm run i18n:check
npm test                  # 全量，不得跳过任何用例
npm run test:coverage     # 阈值 66/58/59/68
npm run test:ci-linux && npm run test:posix-host
npm run docs:links        # dead = 0
npx tsx scripts/core-path-gate.ts
npm run preview:check
npm run doctor            # 横幅 42 列对齐、DB 检查指向新根
```

6.2 全部「必须保持绿」套件最后再跑一次，并跑 6.3 八条边界校验与 1.2 禁改项零命中复核。

### 未验证项（本机无法执行，如实记录，不得伪造结果）

1. **真实 ubuntu-latest** 的 `Test (shard x/10)` 与 `Coverage Gate` job —— 本机 `test:ci-linux` 只是复现装置；CI runner 真实 cwd 按定义无法本地验证。
2. **`npm ci` 与改名后 lock 的一致性** —— 本机跑会改动 `node_modules` 与 `better-sqlite3`/`sharp`/`koffi` 的 ABI，超出范围。确定性证据只能来自 CI `lint-typecheck` job。
3. **`npm run dist:win`**（NSIS 打包，产物约 183 MB）—— 耗时且被 `pre-dist-check` 的版本/changelog 闸门牵制，本轮不跑。连带无法验证：**打包后 userData 是否真变成 `%APPDATA%\meow-star-map`**（现依据 `release/win-unpacked` 实测 + `%APPDATA%` 下不存在 `NikkiGallery`/中文目录 + Electron `productName || json.name` 回退，属推断，需一次真实打包启动才算证）。
4. **`npm run e2e:smoke` / `e2e:perf` / `@perf-real`** —— 依赖 3；`perf-real` 还需 `PERF_REAL_USERDATA` 指向真实数据。
5. **appId 变更后的 NSIS 就地升级与 electron-updater 行为** —— 需两个已安装版本共存。
6. **`node --test docs/sync-integration/verify-audit.mjs`** —— 需同级 `../NikkiSync` 检出，本机不存在。
7. Storybook job、Linux 专属打包、Android —— 与本次更名无关，未执行。

---

## 十二、交付边界

阶段 1 只产出本文件。**N1–N8 属阶段 2，逐节点等用户放行后才动。** 若需调整节点粒度、把某类禁改项改为可改、或缩小 N3（DB/备份名）爆炸半径，请指明节点号。

---

## 执行记录

| 节点           | 命令                                                            | 结果                             | 关键计数                                                                       |
| -------------- | --------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| 阶段 1         | 盘点（`git grep` 三组模式 + 4 个 Explore/Plan 代理）            | `[PLAN] ✓` 交付本文              | `NikkiGallery` 259/72 文件；中文名 44/26 文件；`wxnn` 649/156 文件（多数禁改） |
| —              | `npm run i18n:guard`                                            | `✅`（基线）                     | —                                                                              |
| —              | `npm run docs:links`                                            | `✅ 无死引用`（基线 153 处提醒） | `dead = 0`                                                                     |
| N8（文档部分） | 阶段 2：`.cache/rename-scan/apply.mjs` 逐行锚定替换 + 复扫      | `[VERIFY] ✓` 交付                | 红灯 166 行 / 27 文件 → 绿灯 20 行（全部为台账保留项）；`docs:links` dead 0    |
| N1–N7          | 未开始（本轮按用户决策只动文档与展示 JSON，不改代码与打包身份） | —                                | 代码与配置残留 248 行 / 74 文件                                                |

阶段 2 的红绿读数、保留台账与已知偏差见 [`2026-10-23-rename-docs-pass.md`](./2026-10-23-rename-docs-pass.md)。
本文 §1.1 的名称映射表与 §1.2 的禁改清单仍是后续节点的取值依据。
