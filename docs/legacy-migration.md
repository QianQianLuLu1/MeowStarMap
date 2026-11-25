# 旧版数据迁移（wxnn-photo-manager → MeowStarMap）

> 背景：2.3.x 旧版产品名为「无限暖暖相册管理工具」（`wxnn-photo-manager`），
> 安装目录/用户数据/数据库名均与新版本不同。升级时需要把旧数据合并进新库，再清理旧版。

## 1. 旧数据位置

| 项         | 路径                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| 旧安装     | `%LOCALAPPDATA%\Programs\wxnn-photo-manager`                                  |
| 旧用户数据 | `%APPDATA%\wxnn-photo-manager`                                                |
| 旧数据库   | `%APPDATA%\wxnn-photo-manager\database\wxnn_photo_manager.db`（schema v1/v2） |
| 旧更新缓存 | `%LOCALAPPDATA%\wxnn-photo-manager-updater`                                   |
| 旧卸载项   | `HKCU\...\Uninstall\{5f8a9edf-09a0-5e13-8482-ce1be4d0cc2c}`                   |
| 新数据库   | `%APPDATA%\meow-star-map\database\meow_star_map.db`（schema v3）              |

## 2. 合并策略（逐条导入）

| 表                                                                               | 规则                                                                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `categories`                                                                     | 系统分类按 `sort_order` 映射（旧中文名 → 新英文名，避免重复）；用户分类按 `name` 去重；记录旧 id→新 id 映射                 |
| `media_files`                                                                    | 按 `file_path`：新库已有 → 只补空字段（tags/rating/favorite/category/notes/时间/哈希等）；没有 → 插入；`category_id` 走映射 |
| `app_settings`                                                                   | 按 `key`，只补缺失项                                                                                                        |
| `import_roots` / `filter_presets` / `character_profiles` / `watermark_templates` | 按自然键（root_path / name / uid）补缺失                                                                                    |
| `edit_history` / `operation_history`                                             | 按 `media_id` 映射后导入（源表为空时无操作）                                                                                |
| `pending_renames` / `scan_history`                                               | 按 `old_path` / `start_time` 去重导入                                                                                       |
| `media_fts`                                                                      | 迁移结束后重建                                                                                                              |

- **逐条 try/catch**：单条失败写入 `legacy-migration-report.json` 的 `issues[]`，不中断整体；
- **默认 dry-run**：`--apply` 才写入，写入前自动备份新库（`*.bak-<timestamp>`）；
- 迁移报告默认落在新库同目录，供后续人工修复。

## 3. 文件迁移

- `thumbnails/`、`backups/`、`plugins/`、`search-index/`、`logs/` 用「只补缺失」方式复制（不覆盖新版文件）；
- `search-index` 迁到 `search-index-legacy/`，新版会重建自己的索引；
- 插件：复制 `plugins/` 目录；读取旧 `plugins.json`，逐个校验 manifest（engines / permissions / type）；
  不兼容项标记 `incompatible: true` 并**不加载**，记录到迁移报告。

## 4. 当前落地状态

- [x] 数据库合并脚本 `scripts/migrate-legacy-wxnn.ts`（dry-run / apply / 报告 / 幂等）
- [x] 本机实库迁移：media 3769→4122（353 新增 + 1280 合并）、categories 7、scan_history +8、
      错误 0、`integrity_check=ok`，新版应用启动正常
- [x] 文件复制：thumbnails / backups / plugins / search-index / logs
- [ ] 安装器/应用首启自动检测与触发（目前为手动脚本）
- [ ] 插件兼容性标记的自动化（当前旧 `plugins.json` 为空，无实际插件可迁）
- [ ] 迁移成功后删除旧安装目录/旧用户数据/旧更新缓存/旧卸载项（待人工复核后执行）

## 5. 运行方式

`better-sqlite3` 是按 Electron ABI 编译的，脚本需用 Electron 的 Node 运行：

```powershell
# 1) 打包脚本（按 Electron ABI 运行 needs CJS）
npx esbuild scripts/migrate-legacy-wxnn.ts --bundle --platform=node --format=cjs `
  --external:better-sqlite3 --outfile=.cache/legacy-migrate.cjs

# 2) dry-run
$env:ELECTRON_RUN_AS_NODE='1'
.\node_modules\electron\dist\electron.exe .cache/legacy-migrate.cjs `
  --old-db="$env:APPDATA\wxnn-photo-manager\database\wxnn_photo_manager.db" `
  --new-db="$env:APPDATA\meow-star-map\database\meow_star_map.db"

# 3) apply（自动备份新库）
.\node_modules\electron\dist\electron.exe .cache/legacy-migrate.cjs ... --apply
```

## 6. 回滚

- 新库备份：`%APPDATA%\meow-star-map\database\meow_star_map.db.bak-<timestamp>`；
- 旧库/旧数据在清理前保持原样；
- 迁移只做「补缺失/合并」，不删除新库已有记录。
