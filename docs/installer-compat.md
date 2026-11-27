# Windows 安装器与更新链路

> 状态：2.5.7 正式更新链路使用 Tauri 自研安装器；NSIS 安装包同时保留用于兼容分发。

## 1. 安装与升级

- 默认安装目录为 `%LOCALAPPDATA%\Programs\MeowStarMap`，也接受显式绝对路径。
- 已存在目录只有满足以下任一条件才允许覆盖：空目录、`install-manifest.json` 匹配的应用目录、或注册表记录且含预期应用 exe 的旧安装目录。其他非空目录拒绝替换。
- 解包与校验阶段可取消并清理 staging；首次重命名旧目录后进入不可逆提交点，取消禁用。
- payload 清单可选；缺清单时保留跳过 SHA256 的行为，但 footer、长度、版本、格式与算术边界仍强制校验。
- 旧版 `wxnn-photo-manager` 数据迁移前必须确认旧进程已停止，并一致复制 SQLite 主库、WAL 与 SHM；失败不写迁移标记。
- 卸载注册表写入失败视为安装失败，不留“文件已安装但无法卸载”的成功假象。

## 2. 应用侧契约

- `src/main/app/install-manifest.ts` 在打包态启动时向安装目录与 `userData` 原子写入 `install-manifest.json`。
- `src/main/app/external-installer.ts` 只接受绝对、非 UNC、非符号链接、存在且非空的 `.exe`，启动前再次核对 dev/ino/size/mtime。
- 正式更新只使用 electron-updater `downloadUpdate()` 返回路径或 `update-downloaded.downloadedFile`，经主进程校验后保存在内存；渲染层不能传安装器路径。
- `app:update:install` 与 preload `installUpdate()` 保持无参契约。安装器以 `--updated --force-run` 启动，完成后由安装器负责重启应用。
- 2.5.7 同版本客户端不会立即自动升级；Tauri 更新链路从下一版本实际生效。

## 3. 发布产物

最终打包必须使用同一份 `release/win-unpacked`：

```bash
npm run dist:win
npm run build:installer
npm run verify:dist
```

- NSIS：`release/MeowStarMap-Setup-<version>.exe`
- Tauri：`release/MeowStarMap-Installer-<version>.exe`
- payload：`release/payload.zip` 与 `release/payload.zip.json`
- 正式更新元数据：`release/latest.yml`，`path` 与 `files[].url` 指向 Tauri 安装器
- 兼容元数据：`release/latest-installer.yml`

`latest.yml` 的 SHA512 使用 base64，size 为 Tauri 安装器实际字节数；两个安装器必须来自同一次最终 `win-unpacked`。

## 4. 验证

- Rust：`cargo test`、`cargo fmt --check`、`cargo clippy -- -D warnings`。
- 应用侧：更新路径、外部安装器二次校验、原子清单与 IPC 无参契约测试。
- 打包后：`verify:dist`、Playwright 冒烟、性能基线、payload footer/哈希/版本与 feed 一致性校验。
