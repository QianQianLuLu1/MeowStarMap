# 游戏目录三渠道发现与 UID 隔离

> 配套实现：`src/main/scanner/game-directory-discovery.ts`、`src/main/scanner/path-classifier.ts`、
> `src/main/scanner/worker-entry.ts`（扫描入口）、`src/main/media-worker/worker-entry.ts`（缩略图豁免）。
> 本文件说明《无限暖暖》官方相册目录（X6Game\Saved\GamePlayPhotos）作为主扫描源的渠道定位、
> UID 自动隔离与缩略图豁免规则。

## 1. 三渠道根目录定位（启动器 > Steam > Epic，命中即止）

统一入口 `findGameInstallRootsByPriority()`，按以下优先级解析游戏安装**根目录**：

1. **官方启动器版（最高优先级）** —— `findOfficialLauncherGamePaths()`：
   - 常见安装路径枚举：基于本机可达盘符（`getAvailableDrives` 的 C–Z 范围）拼接
     `<盘符>:\Program Files\InfinityNikki Launcher\InfinityNikki\` 与 `Program Files (x86)` 变体；
   - Windows 注册表：`HKCU\Software\InfinityNikki Launcher` / `HKLM\...\InfinityNikki Launcher` 的
     `GamePath` / `InstallPath`；
   - 启动器目录 `config.ini` / `settings.json` 解析出的游戏安装路径；
   - 桌面快捷方式（`.lnk`）目标路径反向定位。
   - 每个候选经 `validateGameRoot()` 校验（存在 `X6Game\Saved\GamePlayPhotos` 或 `X6Game`）后入库。
2. **Steam 版** —— `findSteamGamePaths()`：注册表 `Software\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 2732520` + `libraryfolders.vdf` 解析库目录。
3. **Epic 版** —— `findEpicGamePaths()`：Epic Games Launcher 注册表 / 清单文件定位。

**优先级语义**：任一渠道返回非空即采用其全部结果并**立即返回，不再降级**查询后续渠道
（"优先匹配到此渠道后不再降级"）；三渠道全空返回 `[]`，不抛异常。非 Windows 平台各函数直接返回空数组。

`findMediaDirectories()` 拿到根目录后统一拼接 `X6Game\Saved\GamePlayPhotos` 子路径纳入扫描。

## 2. GamePlayPhotos 扫描与 UID 隔离

- **隐藏目录强制遍历**：`scanDirectory()` 使用 `fsp.readdir(dir, { withFileTypes: true })`，
  不做任何 `FILE_ATTRIBUTE_HIDDEN` / `FILE_ATTRIBUTE_SYSTEM` 属性过滤，强制递归、不得跳过
  （GamePlayPhotos 默认带 Windows 隐藏属性）。
- **动态 UID 自动识别与隔离**：根目录下所有纯数字命名的子文件夹即账号 UID（`extractUidFromPath` 正则匹配，
  禁止硬编码）。以每个 UID 目录为边界，其下媒体归属对应账号；不同 UID 在数据库索引
  （`account_uid` 列）、前端分类、账号管理中完全隔离，支持多账号并行扫描。
- **原生相册子目录识别**：每个 UID 下 `NikkiPhotos_HighQuality`（高清原图）、`NikkiPhotos_LowQuality`（低清缩略图）
  及其他游戏相册子目录（如 `MagazinePhotos`、`Videos` 等）由 `extractAlbumTypeFromPath` →
  `getAlbumTypeFromDirName` 按子目录名归类到对应相册类型；未匹配走 `unknown` 兜底。

## 3. 缩略图处理规则

- **GamePlayPhotos 路径全局禁用缩略图自动生成**：扫描入库时 `resolveNativeThumbnailPath()` 将 HQ 图片的
  `thumbnail` 列直接指向同名 LQ 文件（`NikkiPhotos_LowQuality` 下的原生缩略图），不触发缩略图生成、
  不重复存储、不占额外磁盘。`media-worker` 的批量生成 SQL 以
  `LOWER(REPLACE(file_path,'\','/')) NOT LIKE '%/x6game/saved/gameplayphotos/%'` 排除该路径，
  永不生成新缩略图文件。
- **ScreenShot 路径补充规则**：`X6Game\ScreenShot` 保留扫描，经 `path-classifier` 归类为 `local_screenshot`
  （本地截图，不关联任何 UID），保留原有缩略图生成逻辑正常生成。

## 4. 渠道优先级 / 隐藏遍历 / UID 隔离 测试清单

| 验证点                                  | 测试文件                                                                          | 关键断言                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 常见安装路径枚举（C: 及盘符变体命中）   | `src/main/scanner/game-directory-discovery.test.ts`                               | `findOfficialLauncherGamePaths` 命中 `C:\Program Files\InfinityNikki Launcher\InfinityNikki` 及 D: 变体；非游戏目录被 `validateGameRoot` 拒 |
| 渠道优先级解析（启动器 > Steam > Epic） | `src/main/scanner/game-directory-discovery.test.ts`                               | 启动器命中后不查询 Steam/Epic 注册表键；三空返回 `[]`                                                                                       |
| `findMediaDirectories` 接入优先级解析器 | `src/main/scanner/__tests__/worker-entry.findMediaDirectories.test.ts`            | 9 用例全过，行为等价于 steam+epic 合并                                                                                                      |
| 隐藏目录强制遍历                        | `src/main/scanner/__tests__/scan-directory.hidden.test.ts`                        | `attrib +h` 标记的 GamePlayPhotos 内部文件仍被扫描入库                                                                                      |
| 多 UID 自动隔离                         | `src/main/scanner/__tests__/scan-directory.multi-uid.test.ts`                     | 两数字 UID 下照片 `account_uid` 各自正确、无混同                                                                                            |
| 原生相册子目录识别                      | `src/main/scanner/__tests__/path-classifier.album.test.ts`                        | `NikkiPhotos_HighQuality/LowQuality` 等归类正确、互不混同                                                                                   |
| GamePlayPhotos 缩略图豁免               | `src/main/media-worker/worker-entry.test.ts`（既有 42 用例）                      | GamePlayPhotos 行被生成 SQL 排除；ScreenShot/普通路径正常生成                                                                               |
| 原生 LQ 缩略图关联入库                  | `src/main/scanner/__tests__/worker-entry.native-thumbnail.test.ts`（既有 5 用例） | HQ+LQ 命中 → `thumbnail` = 原生 LQ 路径                                                                                                     |

> 注：`game-directory-discovery.test.ts` 中"注册表全部失败 → 降级到配置文件解析（JSON 格式）"用例曾为
> **改动前即存在的预先失败项**（与本次三渠道优先级改造无关，当时已用 `git stash` 基线复现），未纳入该轮改动范围。
> 现况（2026-10-10 全量 `npm test`：337 个测试文件 / 5331 个用例）：该失败已不存在，此段保留为当轮取证记录。
