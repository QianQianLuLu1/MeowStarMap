# 《无限暖暖》官方相册（GamePlayPhotos）扫描器定向优化 — 实施计划

> 制定日期：2026-08-29（本版为**原地升级版**：第 1–4 号子任务已实现并通过自测，本版保留其验收结论，并把第 5–8 号及新增项 A/B 展开为完整可执行子任务）
> 目标：在**不废除**现有扫描框架、ScreenShot 分类、前端展示与通用缩略图生成的前提下，修复「`GamePlayPhotos` 官方相册识别不到 / 部分用户环境扫描失败」，使扫描结果与上游 [RanAxro/nikki_albums](https://github.com/RanAxro/nikki_albums) 一致。
> 执行纪律：**每完成一个子任务必须先跑对应测试全绿，再进入下一个子任务**；报错当场修复，不带入下一步；改动范围严格限定在问题相关功能，不触碰无关模块。

---

## 0. 现状盘点（实测基线，2026-08-29）

| 能力                                    | 现状                                                                                                                                                                                                                                                  | 本版动作        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 隐藏/系统目录强制豁免                   | ✅ `isGamePlayPhotosScanExempt`（段名命中 `\x6game\saved\gameplayphotos` / `\x6game\gameplayphotos`）+ `isOfficialAlbumDir`（目录指纹：纯数字 UID 子目录或 HQ/LQ 子目录）双判据；遍历统一原生 `fsp.readdir(dir,{withFileTypes:true})`，无第三方遍历库 | 已完成，见 §6.1 |
| `X6Game\GamePlayPhotos`（无 Saved）变体 | ✅ `GAMEPLAYPHOTOS_RELATIVE_FALLBACK`                                                                                                                                                                                                                 | 已完成          |
| 官方相册专属通道                        | ✅ `scan-channels.ts` + `worker-entry.runScanChannels` 双通道编排                                                                                                                                                                                     | 已完成          |
| ScreenShot / Video 次级通道             | ✅ `SECONDARY_RELATIVE_PATHS`（`X6Game\ScreenShot` / `X6Game\Saved\ScreenShot` / `X6Game\Video`），保留原过滤与原缩略图生成                                                                                                                           | 已完成          |
| 三渠道根目录定位                        | ✅ 注册表 8 键（含 HKLM 64 位视图走 `C:\Windows\System32\reg.exe` 等价 `KEY_WOW64_64KEY`）、桌面 + 开始菜单快捷方式、5 个盘符模板、Steam/Epic 带 `X6Game` 强校验                                                                                      | 已完成          |
| UID 自动分类与隔离                      | ✅ `uid-discovery.ts`（`^\d{6,12}$`）+ `gateAccountUid` 闸门                                                                                                                                                                                          | 已完成          |
| E001–E005 + 诊断日志导出                | ✅ 五码全埋点 + 设置页时间线 + 导出 JSON/zip                                                                                                                                                                                                          | 已完成          |
| **多游戏目录选择（前端）**              | ❌ `scanner:detectGameRoots` 已实现但**零前端消费者**；`excludedPaths` schema 已就绪但渲染层无传参                                                                                                                                                    | 子任务 5        |
| **多级兜底引导 UI + 中文路径用例**      | ❌ 设置页无「选游戏根目录 / 直选 GamePlayPhotos」入口；无中文路径端到端测试                                                                                                                                                                           | 子任务 6        |
| **缩略图排除覆盖变体路径**              | ⚠️ `media-worker/worker-entry.ts` 仅排除 `%/x6game/saved/gameplayphotos/%`，未覆盖无 Saved 变体                                                                                                                                                       | 子任务 7        |
| **未知相册子目录保留原名**              | ❌ UID 下未收录目录一律归「其他」                                                                                                                                                                                                                     | 新增 A          |
| **3 秒遍历超时告警**                    | ❌ 全项目零命中                                                                                                                                                                                                                                       | 新增 B          |
| 全量验证与收尾                          | ❌ 未执行                                                                                                                                                                                                                                             | 子任务 8        |

**实测基线**：`npx vitest run src/main/scanner src/main/media-worker` → **42 文件 / 644 用例全部通过**（6.18s）。
**全量基线**：231 文件 / 4082 用例，既有环境性失败仅 `path-safety.test.ts`（Win 下 `chmodSync(0o444)` 不阻止写入）与 `GalleryStackOverflow.test.tsx`（jsdom + virtuoso 递归）两项，勿误判。

---

## 1. 依赖声明

### 1.1 外部依赖（**零新增 npm 包**）

| 类别      | 依赖                                       | 用途                                                                             | 新增 |
| --------- | ------------------------------------------ | -------------------------------------------------------------------------------- | ---- |
| Node 内置 | `fs` / `fs.promises` / `path`              | 目录遍历（原生 `fsp.readdir`，不按隐藏属性过滤）、路径拼接                       | ❌   |
| Node 内置 | `child_process.execFile`                   | `reg query`（64 位视图走 `C:\Windows\System32\reg.exe`）、PowerShell 解析 `.lnk` | ❌   |
| 既有 npm  | `better-sqlite3`                           | 媒体索引与 `app_settings` 配置持久化                                             | ❌   |
| 既有 npm  | `zod`                                      | IPC 参数校验（`src/main/ipc/validator.ts`）                                      | ❌   |
| 既有 npm  | `electron`（`dialog` / `ipcMain` / `app`） | 目录选择对话框、IPC、提权重启                                                    | ❌   |
| 既有 npm  | `sharp` / `fluent-ffmpeg`                  | 缩略图生成（仅非 GamePlayPhotos 路径）                                           | ❌   |
| 既有 npm  | `react` / `react-i18next` / `tailwind`     | 设置页新分区 UI                                                                  | ❌   |
| 既有 npm  | `vitest` / `@testing-library/react`        | 单元与组件测试                                                                   | ❌   |

**明确不引入**：`readdirp` / `fast-glob` / `glob` 等第三方遍历库（需求一要求原生 `fs.promises.readdir` 且不传过滤参数）。

### 1.2 内部模块依赖

| 模块          | 路径                                                                                                                                 | 用途                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 根目录发现    | `src/main/scanner/game-directory-discovery.ts`                                                                                       | `findGameInstallRootsByPriority` / `detectGameRootCandidates` / `getLastProbeTrail`                   |
| 相册根解析    | `src/main/scanner/gameplayphotos-root.ts`                                                                                            | 拼接与变体降级、`isOfficialAlbumDir`、E003 埋点                                                       |
| 通道编排      | `src/main/scanner/scan-channels.ts`                                                                                                  | `resolveScanChannels`、E001/E002 埋点                                                                 |
| 路径分类      | `src/main/scanner/path-classifier.ts`                                                                                                | `extractAlbumTypeFromPath` / `isGamePlayPhotosPath` / `resolveNativeThumbnailPath` / `gateAccountUid` |
| 相册类型映射  | `src/main/utils/media-constants.ts`                                                                                                  | `ALBUM_TYPE_MAP` / `ALBUM_TYPE_UNKNOWN` / `getAlbumTypeFromDirName`                                   |
| UID 发现      | `src/main/scanner/uid-discovery.ts`                                                                                                  | 纯数字 UID 目录发现、E004 埋点                                                                        |
| 诊断日志      | `src/main/scanner/scan-log-store.ts` / `scan-logger.ts`                                                                              | `ScanErrorCode`、`sendScanLogEntry`、`classifyFsError`                                                |
| 缩略图 worker | `src/main/media-worker/worker-entry.ts`                                                                                              | 生成排除与尺寸补读 SQL                                                                                |
| IPC 基建      | `src/main/ipc/validator.ts`（`wrapHandler` / `wrapHandlerNoArgs` / `schemas`）                                                       | 新通道参数校验                                                                                        |
| 提权          | `src/main/app/permission.ts`                                                                                                         | `requestAdminRelaunch`（PowerShell `Start-Process -Verb RunAs`，幂等）                                |
| 渲染层基建    | `src/renderer/pages/settings/shared.tsx`（`SectionShell` / `SettingsCard` / `SettingsToggle` / `GlobalToastContext` / `BaseDialog`） | 新分区 UI                                                                                             |

### 1.3 非依赖（明确不做）

- 不改动 `GALLERY_PATH_CONDITION` / `NOT_IN_GALLERY_PATH_CONDITION` 的逐字对称关系。
- 不改动 `extractMediaSourceFromPath` 默认分支（仅 `X6Game\Saved\ScreenShot` 归 `launcher`）。
- 不改动 `CACHE_DIR_NAMES` 跳过对非豁免路径的语义；不升级 `react-virtuoso`。
- 不新增数据库表（新配置沿用 `app_settings` 键值 `excludedScanPaths`）。

---

## 2. 启动说明

- **触发链路**：图库 `ScanButton` / 设置页兜底按钮 → `scanner:start` IPC → `ScannerWorkerBridge` → worker `startScan()`。
- **改造后执行顺序**：
  1. `findMediaDirectories(customPaths, excludedPaths)` → 游戏根目录集合（自定义恒包含并按排除集剔除）；
  2. `resolveScanChannels(roots)` → `{ officialAlbum[], secondary[], missing[] }`；
  3. 先扫**官方相册通道**（强制豁免遍历 + UID 闸门 + 原生 LQ 直连 + 不触发生成）；
  4. 再扫**次级通道**（`X6Game\ScreenShot` / `X6Game\Saved\ScreenShot` / `X6Game\Video`，保持原过滤与缩略图生成）；
  5. 全程向 `scanLogStore` 埋点（失败节点带 E001–E005）；遍历超 3 秒追加 `traverse-timeout` 告警（新增 B）。
- **无新起进程/服务**：不新增 worker 进程，不新增数据库表，不改启动时序。
- **设置页新分区挂载**：`GameRootsSection` 挂载后调用一次 `scanner:detectGameRoots({ customPaths })`（不轮询），结果缓存进组件 state。
- **降级语义**：任一根的 GamePlayPhotos 不存在 → 记 E002 继续下一个根；全部失败 → `success:false` + 错误码，渲染端展示兜底引导（选游戏根目录 / 直选 GamePlayPhotos 文件夹）。

---

## 3. 错误处理

| 错误码 | 阶段     | 含义                                     | 输出 detail                                              | 处理                                                                                                                                         |
| ------ | -------- | ---------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `E001` | 路径定位 | 未找到任何游戏安装目录                   | 已探测的全部路径模板、注册表项及各自结果（`probeTrail`） | 记 error；渲染端提示并弹出兜底引导                                                                                                           |
| `E002` | 路径定位 | 找到游戏根目录，但目标子目录不存在       | 游戏根目录路径 + 该目录下**实际子目录列表**              | 先试 `X6Game\GamePlayPhotos` 变体；仍无则记 E002 继续下一个根                                                                                |
| `E003` | 目录访问 | 目录访问被拒绝（权限不足）               | 目标路径、错误 `code`（`EPERM`/`EACCES`）、错误栈        | 记 error + 回调 `onPermissionDenied` → 主进程 `promptAdminRelaunch()`（幂等）；前端另提供「一键重启并提升权限」按钮（`app:relaunchAsAdmin`） |
| `E004` | 目录遍历 | 未找到 UID 文件夹                        | 目标路径 + 该目录下**全部条目名列表**                    | 记 warn；不中断扫描                                                                                                                          |
| `E005` | 文件读取 | 图片/元数据读取失败                      | 失败文件路径 + 错误类型（`code` 或 `Error` 名）          | 记 error；跳过该文件，不中断扫描                                                                                                             |
| —      | 目录遍历 | 单次 `readdir` 超过 3 秒无响应（新增 B） | 目标路径 + 已耗时                                        | 追加 `stage:'traverse-timeout'`、`kind:'other'` 告警，提示添加杀软信任；**只告警不中断**                                                     |

**通用原则（无静默失败）**：

- 单目录/单文件异常 → warn/error 埋点后跳过，**不吞异常**；
- 批量写入失败（`ScanBatchWriteError`）→ 继续 rethrow，扫描整体报失败；
- `detectGameRoots` IPC 失败 → 前端 Toast 明确提示并在分区内展示重试按钮，不静默空列表；
- 所有失败最终体现在 `scan:getScanLog` 轨迹中，可一键导出。

---

## 4. 参数校验

| 参数                         | 位置                       | 校验规则                                                                                                                            | 失败处理                                        |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `customKnownPaths`           | `scanner:start`            | `z.array(schemas.filePath).max(64)`                                                                                                 | `AppError.validation` + 广播 `scanner:complete` |
| `excludedPaths`              | `scanner:start`            | `z.array(z.string().min(1).max(1024)).max(64).optional()`；仅字符串校验，**不做 `assertFileReadPath` 读校验**（排除语义无提权风险） | 同上                                            |
| `path`（指定目录）           | `scanner:start`            | 现有 `assertFileReadPath` 白名单校验（保持不放宽）                                                                                  | 抛 `AppError.forbidden`                         |
| `customPaths`                | `scanner:detectGameRoots`  | `z.array(z.string().min(1).max(1024)).max(64).optional()`                                                                           | `AppError.validation`                           |
| 游戏根候选                   | `game-directory-discovery` | `typeof === 'string'` 且非空；Steam/Epic 候选须通过 `X6Game` 存在性强校验                                                           | 返回 `null` 跳过                                |
| `ScanOptions.excludedPaths`  | worker 协议                | 同 IPC 侧；worker 内二次过滤非字符串项（防御）                                                                                      | 忽略非法项                                      |
| 导出文件路径                 | `scan:exportScanLog`       | 由保存对话框返回，父目录经 `pathGuard.register`；写入用 `assertFileWritePath`                                                       | 取消返回 `{ok:false,canceled:true}`             |
| `resolveScanChannels(roots)` | 纯函数                     | 入参非数组 → 空通道集 + E001；逐项跳过非字符串                                                                                      | 不抛异常                                        |
| 渲染层目录选择               | 兜底按钮                   | `null` / 非字符串 / 空串 → 视为取消，静默返回                                                                                       | 不发起扫描                                      |
| `app:relaunchAsAdmin`        | 新 IPC                     | `wrapHandlerNoArgs`，无入参                                                                                                         | 失败返回 `{ok:false,error}`                     |

---

## 5. 已完成子任务的验收结论（第 1–4 号）

| 子任务                    | 验收结论                                                                                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 隐藏目录豁免 + 变体路径 | `scan-gpp-exemption.test.ts`(4)、`gameplayphotos-hidden-traversal.test.ts`(3)、`scan-directory.hidden.test.ts`(2) 全绿；`C:\Windows\System32` 仍被跳过，用户自建 `C:\backup\GamePlayPhotos` 不豁免 |
| 2 根目录多渠道定位扩充    | `game-directory-discovery.test.ts`（+139 行）全绿；覆盖新盘符模板、开始菜单解析、Steam 候选缺 `X6Game` 被拒、E001 埋点                                                                             |
| 3 双通道编排              | `scan-channels.test.ts`(NEW) 全绿；官方相册走豁免 + UID 闸门 + 原生 LQ，次级通道保持原过滤与生成                                                                                                   |
| 4 E001–E005 + 导出        | `scan-error-codes.test.ts`(NEW) 全绿；五码各一例断言 `code` 与必需 detail 字段；`scan-log-store.test.ts`(9) 全绿；设置页时间线 + 错误码徽章 + 导出按钮已上线                                       |

---

## 6. 待执行子任务（逐个执行，逐步验证）

### 6.5 子任务 5：多游戏目录选择（设置页前端接入）

- **修改文件**
  - `src/renderer/utils/scan-exclusions.ts`（NEW）：`loadExcludedScanPaths()` / `saveExcludedScanPaths(paths)` / `loadCustomScanPaths()`
  - `src/renderer/pages/settings/scan-sections.tsx`（MODIFY：新增 `GameRootsSection`）
  - `src/renderer/pages/settings/sections.tsx`（MODIFY：导出 `GameRootsSection`）
  - `src/renderer/pages/SettingsPage.tsx`（MODIFY：`scan` 分组注册 `scan-game-roots` 分区）
  - `src/renderer/components/scanner/ScanButton.tsx`（MODIFY：`scanner.start` 透传 `excludedPaths`）
  - `src/renderer/pages/settings/ImportRootsSection.test.tsx` 旁新增 `ScanGameRootsSection.test.tsx`（NEW）
  - `src/renderer/i18n/locales/*.json`（MODIFY：新增键，sync 补齐 12 语种）
- **输入 / 输出**
  - 输入：`window.electronAPI.scanner.detectGameRoots({ customPaths })` → `GameRootCandidate[]`（`{path, mtimeMs, hasGamePlayPhotos, source}`）
  - 输出：勾选集合写入 `settings.set('excludedScanPaths', <未勾选项>)`；扫描时 `scanner.start({ excludedPaths })`
  - 默认勾选规则：`hasGamePlayPhotos === true` 的候选中 `mtimeMs` 最大者默认勾选（全无 `hasGamePlayPhotos` 时取 `mtimeMs` 最大者）；`mtimeMs === 0`（不可 stat）排在最后
- **验收标准**
  - `npx vitest run src/renderer/pages/settings/ScanGameRootsSection.test.tsx` 全绿：候选列表渲染、默认勾选 mtime 最新项、取消勾选写入排除集、IPC 失败展示重试入口
  - `npx vitest run src/renderer` 全绿（不破坏既有用例）
  - `npx tsc -b` 中本次改动文件无新增错误

### 6.6 子任务 6：多级兜底引导 + 提权重启 + 中文路径兼容

- **修改文件**
  - `src/renderer/pages/settings/scan-sections.tsx`（MODIFY：新增 `ScanFallbackSection`，两个引导按钮 + 提权按钮）
  - `src/renderer/pages/settings/sections.tsx`、`SettingsPage.tsx`（MODIFY：注册 `scan-fallback`）
  - `src/main/ipc/handlers/app-handler.ts`（MODIFY：新增 `app:relaunchAsAdmin` → `requestAdminRelaunch()`）
  - `src/main/preload/api/app.ts`（MODIFY：暴露 `relaunchAsAdmin`）
  - `src/renderer/vite-env.d.ts`（MODIFY：类型同步）
  - `src/main/scanner/__tests__/scan-chinese-path.test.ts`（NEW）
  - `src/renderer/pages/settings/ScanFallbackSection.test.tsx`（NEW，按钮交互）
  - `src/renderer/i18n/locales/*.json`（MODIFY）
- **输入 / 输出**
  - 一级兜底：`dialog.selectDirectory()` 选「游戏安装根目录」→ 校验（提示需包含 `X6Game`）→ 写入 `customScanPaths` → `scanner.start({ customKnownPaths, path })`
  - 二级兜底：直接选 `GamePlayPhotos` 文件夹 → 主进程 `isDirectGamePlayPhotosDir` 判定后直接作为扫描根，跳过路径定位
  - 三级兜底：上述路径自动持久化到 `customScanPaths`（已支持多条），下次启动优先扫描
  - 提权：`app:relaunchAsAdmin` → `requestAdminRelaunch()`（PowerShell `Start-Process -Verb RunAs`）
- **验收标准**
  - `npx vitest run src/main/scanner/__tests__/scan-chinese-path.test.ts` 全绿：中文 + 空格 + `#` 路径端到端扫描入库数量正确
  - `npx vitest run src/renderer/pages/settings/ScanFallbackSection.test.tsx` 全绿
  - `npx vitest run src/main/ipc/handlers` 全绿（`app-handler` 新通道不破坏既有）

### 6.7 子任务 7：缩略图排除覆盖无 Saved 变体

- **修改文件**
  - `src/main/media-worker/worker-entry.ts`（MODIFY：L413-427 两条 SQL）
  - `src/main/media-worker/worker-entry.test.ts`（MODIFY：新增变体用例）
- **输入 / 输出**
  - 生成排除：`LOWER(REPLACE(file_path,'\\','/')) NOT LIKE '%/x6game/saved/gameplayphotos/%' AND ... NOT LIKE '%/x6game/gameplayphotos/%'`
  - 尺寸补读：两条 `LIKE` 取并集（`saved/gameplayphotos` 或 `gameplayphotos` 变体），仍只补读 `width/height`，不动 `thumbnail`、不写缓存
- **验收标准**
  - `npx vitest run src/main/media-worker` 全绿；新增用例断言：变体目录下文件不进入生成批次、但仍进入 `dimRows` 补读尺寸

### 6.8 子任务 8：全量验证与收尾

- **执行项**
  1. GitHub MCP 只读核对上游 `RanAxro/nikki_albums` 的 `FindUid.find()` 与相册目录映射，产出对照结论并写入本文件 §9
  2. `npm run sync-i18n-keys && npm run check-i18n-keys`
  3. `npx tsc -b`（确认本次改动文件无新增错误）
  4. 全量 `npm run test`（对比 §0 基线）
  5. `npx electron-vite build` 构建通过
  6. `open-code-review` 评审本次改动并修复问题
- **验收标准**：上述命令全部通过；上游对照结论三项正确（UID 判定、HQ/LQ 目录名、相册分类）

### 6.A 新增 A：GamePlayPhotos 内未知相册子目录保留原目录名

- **修改文件**
  - `src/main/utils/media-constants.ts`（MODIFY：新增 `resolveAlbumType(parentDirName, keepRawName)`）
  - `src/main/scanner/path-classifier.ts`（MODIFY：`extractAlbumTypeFromPath(filePath, keepRawName?)`）
  - `src/main/scanner/worker-entry.ts`（MODIFY：L873 / L945 调用点传 `isGamePlayPhotosPath(fullPath)`）
  - `src/main/scanner/__tests__/path-classifier.album.test.ts`（MODIFY：新增两类用例）
  - `src/main/scanner/__tests__/nikki-albums-compat.test.ts`（MODIFY：未知目录分类对照）
- **输入 / 输出**
  - `resolveAlbumType(name, true)`：命中 `ALBUM_TYPE_MAP` 返回映射标签，否则返回**原目录名**；空名返回 `ALBUM_TYPE_UNKNOWN`
  - `resolveAlbumType(name, false)` ≡ 现有 `getAlbumTypeFromDirName`（保持「其他」兜底，不破坏既有用例）
  - `extractAlbumTypeFromPath` 第二参数可选，默认 `false`（向后兼容 `repair-legacy-data-v1` 与全部既有测试）
- **验收标准**：`npx vitest run src/main/scanner` 全绿；新用例断言 `...\GamePlayPhotos\123456789\TravelJournal\a.jpg → 'TravelJournal'`，`...\Pictures\TravelJournal\a.jpg → '其他'`

### 6.B 新增 B：目录遍历 3 秒超时告警

- **修改文件**
  - `src/main/scanner/worker-entry.ts`（MODIFY：`scan()` 内 `fsp.readdir` 处加竞速告警）
  - `src/main/scanner/__tests__/scan-traverse-timeout.test.ts`（NEW）
- **输入 / 输出**
  - `Promise.race([readdir, timer(3000)])`：定时器先落地即 `sendScanLogEntry({stage:'traverse-timeout', level:'warn', kind:'other', detail:{path, elapsedMs}})`，**随后继续 `await` 原 readdir，不取消、不中断**
  - 定时器用 `unref()` 避免阻止进程退出；正常返回时 `clearTimeout`
- **验收标准**：`npx vitest run src/main/scanner/__tests__/scan-traverse-timeout.test.ts` 全绿；用例断言 3s 无响应产出告警且目录内容仍被完整扫描

---

## 7. 基础测试用例清单

| 测试文件                                            | 场景                                          | 断言                                                                                 |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `__tests__/scan-channels.test.ts`（既有）           | 双通道划分与豁免判定                          | `isGamePlayPhotosScanExempt` 命中/不命中                                             |
| `game-directory-discovery.test.ts`（既有）          | 5 个盘符模板、开始菜单、X6Game 强校验、E001   | 候选枚举与拒绝路径                                                                   |
| `__tests__/scan-error-codes.test.ts`（既有）        | E001–E005 各一例                              | `code` 正确且 detail 含必需字段                                                      |
| `__tests__/path-classifier.album.test.ts`（MODIFY） | 未知相册保留原名 / 非 GamePlayPhotos 仍归其他 | `TravelJournal` vs `其他`                                                            |
| `media-worker/worker-entry.test.ts`（MODIFY）       | 变体路径不生成缩略图                          | 不进生成批次，但进 `dimRows` 补读                                                    |
| `__tests__/scan-traverse-timeout.test.ts`（NEW）    | readdir 挂起 >3s                              | 产出 `traverse-timeout` 告警且扫描不中断                                             |
| `__tests__/scan-chinese-path.test.ts`（NEW）        | 中文 + 空格 + `#` 路径端到端                  | 入库数量与 UID/相册分类正确                                                          |
| `ScanGameRootsSection.test.tsx`（NEW）              | 候选列表与排除集                              | 默认勾选 mtime 最新、取消勾选写入排除集、IPC 失败可重试                              |
| `ScanFallbackSection.test.tsx`（NEW）               | 两级兜底 + 提权按钮                           | 选根目录/直选相册分别发起正确 `scanner.start` 入参；提权按钮调 `app:relaunchAsAdmin` |

---

## 8. 风险与缓解

| 风险                                            | 缓解                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| 豁免口径放宽导致用户自建同名目录被误豁免        | 双判据要求 `X6Game` 父段或 HQ/LQ/UID 指纹；反向用例已覆盖                         |
| `extractAlbumTypeFromPath` 新增参数破坏既有调用 | 参数可选默认 `false`，既有 5 处调用与测试无需改动                                 |
| 3 秒超时告警误报（慢盘/冷启动）                 | 只追加告警，不影响扫描结果；定时器 `unref()` 不影响退出                           |
| SQL 新增 `NOT LIKE` 分支影响性能                | 字符串表达式查询原本即全表扫描，新增分支不额外退化为更差量级                      |
| 前端新分区引入 i18n 缺键                        | 新增键后跑 `sync-i18n-keys`（其余语种补空串）+ `check-i18n-keys`                  |
| `detectGameRoots` 扫描注册表慢                  | 仅设置页挂载调用一次，不轮询；沿用既有 `shouldStop` 与 `MAX_PROBE_TRAIL=200` 截断 |

---

## 9. 上游口径对照结论（2026-08-29 核对）

> 核对方式：GitHub MCP（`RanAxro/nikki_albums`）与 raw.githubusercontent.com 抓取均因本机网络受限失败，
> 改用上游官方文档 <https://nikki.ranaxro.com/en/guide.html>（Path Detection / Album Categories / Multi-Account 章节）
> 与社区路径佐证（`InfinityNikki Launcher\InfinityNikki\X6Game\Saved\GamePlayPhotos`）**只读核对**，不复制任何上游代码。

| 对照项          | 上游口径                                                                                                   | 本实现                                                                         | 结论                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 相册根路径      | `[启动器]\InfinityNikki\X6Game\Saved\GamePlayPhotos`                                                       | `GAMEPLAYPHOTOS_RELATIVE`（+ 无 Saved 变体降级）                               | ✅ 一致                                                         |
| UID 判定        | 多账号（不同 UID）全部检测、按 UID 隔离；UID 为纯数字目录名                                                | `uid-discovery.ts` `^\d{6,12}$` + `gateAccountUid` 闸门                        | ✅ 一致（真实 UID 6–12 位，语义等价；仓库内注释已记录对齐依据） |
| 高清/低清目录名 | `NikkiPhotos_HighQuality` / `NikkiPhotos_LowQuality`                                                       | `ALBUM_TYPE_MAP` 双键 + `resolveNativeThumbnailPath` 同名映射                  | ✅ 一致                                                         |
| 相册分类        | 19 个相册 + 3 个资源区（Screenshots / DIY / PlantDyeing / MagazinePhotos / CustomAvatar / NikkiPhotos 等） | `ALBUM_TYPE_MAP` 覆盖上述键；**GamePlayPhotos 子树下未收录目录按原目录名分类** | ✅ 一致且更不丢信息                                             |
| 路径定位失败    | 支持在 Settings 手动选择启动器目录                                                                         | 一级兜底（选游戏根）+ 二级兜底（直选 GamePlayPhotos）+ 三级持久化              | ✅ 一致                                                         |

## 10. 本轮验收记录（2026-08-29 执行）

| 项                 | 命令                                                        | 结果                                                                                                                        |
| ------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 扫描器/worker 单测 | `npx vitest run src/main/scanner src/main/media-worker`     | ✅ 43 文件 / 658 用例全绿                                                                                                   |
| IPC / preload 单测 | `npx vitest run src/main/ipc`                               | ✅ 32 文件全绿（修复了 `scanner-handler.ts` 遗留的 `wrapHandler` 导入缺失，此前 16 用例全红）                               |
| 渲染层 / app 单测  | `npx vitest run src/renderer src/main/preload src/main/app` | ✅ 105 文件，仅既有环境性失败 `GalleryStackOverflow.test.tsx`                                                               |
| 全量测试           | `npm run test`                                              | ✅ 237 文件 / 4154 用例；失败仅 `path-safety.test.ts`（Win chmod 不阻止写入）与 `GalleryStackOverflow.test.tsx`，与基线一致 |
| i18n               | `npm run sync-i18n-keys` + `npm run i18n:check`             | ✅ 12 语种 3594 键对齐                                                                                                      |
| 类型检查           | `npx tsc -b`                                                | ✅ 本次改动文件零新增错误（剩余 24 行为既有 recovery/connection 等历史错误）                                                |
| 构建               | `npx electron-vite build`                                   | ✅ built in 4.53s                                                                                                           |

**本轮新增用例**：相册原名兜底 9 例、缩略图变体 2 例、遍历超时告警 3 例、中文路径端到端 4 例、游戏目录选择 4 例、兜底引导 5 例。
**代码评审发现并修复**：`resolveAlbumType` 用任意目录名直接下标查表会命中 `Object.prototype` 成员（如名为 `constructor` 的目录返回函数），已改为 `hasOwnProperty` 判定。

---

## 11. 变更文件汇总

| 文件                                                           | 操作             | 子任务    |
| -------------------------------------------------------------- | ---------------- | --------- |
| `docs/plans/2026-08-29-gameplayphotos-scanner-optimization.md` | MODIFY（本文件） | —         |
| `src/main/scanner/scan-channels.ts`                            | DONE(NEW)        | 3         |
| `src/main/scanner/worker-entry.ts`                             | DONE + MODIFY    | 1/3/4/6.B |
| `src/main/scanner/gameplayphotos-root.ts`                      | DONE(MODIFY)     | 1/4       |
| `src/main/scanner/game-directory-discovery.ts`                 | DONE(MODIFY)     | 2         |
| `src/main/scanner/scan-log-store.ts`                           | DONE(MODIFY)     | 4         |
| `src/main/scanner/uid-discovery.ts`                            | DONE(MODIFY)     | 4         |
| `src/main/scanner/worker-protocol.ts`                          | DONE(MODIFY)     | 3         |
| `src/main/scanner/path-classifier.ts`                          | MODIFY           | 6.A       |
| `src/main/utils/media-constants.ts`                            | MODIFY           | 6.A       |
| `src/main/media-worker/worker-entry.ts`                        | MODIFY           | 6.7       |
| `src/main/ipc/handlers/app-handler.ts`                         | MODIFY           | 6.6       |
| `src/main/ipc/handlers/scan-log-handler.ts`                    | DONE(MODIFY)     | 4         |
| `src/main/ipc/handlers/scanner-handler.ts`                     | DONE(MODIFY)     | 5         |
| `src/main/preload/api/scanner.ts`                              | DONE(MODIFY)     | 4/5       |
| `src/main/preload/api/app.ts`                                  | MODIFY           | 6.6       |
| `src/renderer/vite-env.d.ts`                                   | MODIFY           | 5/6.6     |
| `src/renderer/utils/scan-exclusions.ts`                        | NEW              | 5         |
| `src/renderer/components/scanner/ScanButton.tsx`               | MODIFY           | 5         |
| `src/renderer/pages/settings/scan-sections.tsx`                | MODIFY           | 5/6.6     |
| `src/renderer/pages/settings/sections.tsx`                     | MODIFY           | 5/6.6     |
| `src/renderer/pages/SettingsPage.tsx`                          | MODIFY           | 5/6.6     |
| `src/renderer/pages/settings/scan-log-diagnostic-section.tsx`  | DONE(MODIFY)     | 4         |
| `src/renderer/i18n/locales/*.json`                             | MODIFY           | 5/6.6     |
| `src/main/scanner/__tests__/scan-chinese-path.test.ts`         | NEW              | 6.6       |
| `src/main/scanner/__tests__/scan-traverse-timeout.test.ts`     | NEW              | 6.B       |
| `src/renderer/pages/settings/ScanGameRootsSection.test.tsx`    | NEW              | 5         |
| `src/renderer/pages/settings/ScanFallbackSection.test.tsx`     | NEW              | 6.6       |
| `src/main/scanner/__tests__/path-classifier.album.test.ts`     | MODIFY           | 6.A       |
| `src/main/media-worker/worker-entry.test.ts`                   | MODIFY           | 6.7       |

---

## 12. 验收清单（对应需求八）

| #   | 验证标准                                      | 验证手段                                                                                    |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | 原有功能无损                                  | 全量 `npm run test` 与基线一致；ScreenShot 通道用例、通用缩略图生成用例全绿                 |
| 2   | 隐藏+系统双属性目录可扫                       | `scan-gpp-exemption` / `gameplayphotos-hidden-traversal` / `scan-directory.hidden` 三组用例 |
| 3   | 与 nikki_albums 一致                          | `nikki-albums-compat.test.ts` + §9 上游对照结论                                             |
| 4   | 中文路径 / 非默认盘符 / 标准权限 / 多目录共存 | `scan-chinese-path.test.ts`、盘符模板用例、`detectGameRootCandidates` 用例                  |
| 5   | 无静默失败                                    | `scan-error-codes.test.ts`（E001–E005）+ 设置页时间线 + 一键导出                            |
