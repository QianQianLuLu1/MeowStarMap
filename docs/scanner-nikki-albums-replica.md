# 完全复刻 nikki_albums 游戏相册扫描器（强制对齐实施报告）

> 目标：100% 对齐 https://github.com/RanAxro/nikki_albums 的 Windows 端相册扫描实现，
> 确保本项目扫描结果与 nikki_albums 在「照片数量 / UID 分类 / 相册分类 / 原生缩略图复用 / 隐藏目录可读」上完全一致。

## 一、依赖声明（Dependencies）

- 无新增 npm 依赖。全部复用现有模块：
  - `fs` / `fs/promises` / `path` / `child_process`（Node 内置）
  - `src/main/scanner/game-directory-discovery.ts`（`findGameInstallRootsByPriority`、`parseEpicManifests`、`findSteamGamePaths`、`findOfficialLauncherGamePaths`）
  - `src/main/scanner/gameplayphotos-root.ts`（`resolveGamePlayPhotosScanRoots`、`GAMEPLAYPHOTOS_RELATIVE`）
  - `src/main/scanner/path-classifier.ts`（`extractUidFromPath`、`extractAlbumTypeFromPath`、`extractMediaSourceFromPath`、`resolveNativeThumbnailPath`、`isGamePlayPhotosPath`）
  - `src/main/scanner/worker-entry.ts`（`findMediaDirectories`、`scanDirectory`、新增 `isGamePlayPhotosScanExempt`）
- 测试框架：Vitest（沿用 `src/main/scanner/__tests__/`）。

## 二、启动说明（Startup / How to run）

```powershell
# 1. 依赖（本机受 Safe-Delete 网关限制，只能增量安装）
npm install

# 2. 单元测试（全量）
npx vitest run
# 仅本项目相关用例
npx vitest run src/main/scanner/__tests__/scan-gpp-exemption.test.ts `
  src/main/scanner/__tests__/nikki-albums-compat.test.ts `
  src/main/scanner/__tests__/epic-manifests.test.ts

# 3. 构建（禁止 npm run build，其 clean 步触发 Safe-Delete EPERM；改用）
npx electron-vite build
# 构建后写主进程加载声明（打包需要）
Set-Content -Path dist/main/package.json -Value '{"type":"commonjs"}'
```

生产扫描入口：`scanDirectory(rootPath, incremental=false, applyFilters=true)` 由 `startScan` 经
`findMediaDirectories()` → `resolveGamePlayPhotosScanRoots()` 串联调用；三渠道游戏根定位命中即止。

## 三、错误处理（Error handling）

| 场景                                 | 处理                                                                | 位置                                       |
| ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------ |
| 官方启动器注册表/配置读取失败        | 抛错被上层 `catch`，降级到下一渠道（Steam/Epic），不中断            | `findOfficialLauncherGamePaths`            |
| Steam / Epic 注册表缺失              | 返回空数组，继续下一渠道                                            | `findSteamGamePaths` / `findEpicGamePaths` |
| Epic 清单目录不存在 / 解析异常       | `parseEpicManifests` 内部 try/catch，降级返回 `[]`                  | `parseEpicManifests`                       |
| 游戏根目录 `validateGameRoot` 不通过 | 该根不纳入结果                                                      | `findGameInstallRootsByPriority`           |
| `scanDirectory` 单文件元数据读取失败 | 单文件 `try/catch`，记录 `capturedError` 跳过该文件，继续遍历       | `scanDirectory` 文件分支                   |
| 数据库未连接（`db===null`）          | `saveBatchToDatabase` 直接 `return 0`；`autoRegisterUid` 早退，不抛 | `worker-entry`                             |
| 符号链接环                           | `visitedRealPaths` 记录真实路径，重复则跳过                         | `scanDirectory`                            |

## 四、参数校验（Parameter validation）

- `findMediaDirectories(customPaths?: string[])`：`customPaths` 逐项做存在性 `fs.access` 校验，不存在则 `warn` 并跳过；非 string 项被 `continue` 过滤，不会污染结果集。
- `scanDirectory(rootPath, incremental, applyFilters)`：`rootPath` 经 `isGamePlayPhotosScanExempt` 判定豁免；`MAX_SCAN_DEPTH=15` 限制递归深度，防止异常深目录栈溢出。
- `parseEpicManifests`：`installLocation` 经 `fs.access` 校验真实存在才采纳；清单扩展名必须为 `.item` / `.json`，其余忽略。
- UID 识别：`/[\/](\d{6,12})[\/]/` 动态正则，禁止硬编码任何具体数字。

## 五、基础测试用例（Base test cases）

| 测试文件                                            | 验证点                                                                                                     | 验收标准   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------- |
| `epic-manifests.test.ts`（新增）                    | `parseEpicManifests` 匹配 InfinityNikki 清单；忽略非尼基清单/不存在目录；目录缺失降级                      | 3 例全通过 |
| `scan-gpp-exemption.test.ts`（新增）                | `isGamePlayPhotosScanExempt` 判定；GPP 树下缓存子目录与小图均被收录；对照组被跳过                          | 4 例全通过 |
| `nikki-albums-compat.test.ts`（新增）               | 每张照片 UID/相册/来源与 `path-classifier` 纯函数一致；HQ 复用原生 LQ 缩略图且无新增文件；隐藏目录仍被遍历 | 4 例全通过 |
| `worker-entry.findMediaDirectories.test.ts`（改写） | 收敛后仅含自定义路径 + 三渠道根目录，签名搜索零调用，移除软过滤                                            | 5 例全通过 |
| `resolve-gameplayphotos.test.ts`（补 mock）         | `app.getPath` 崩溃修复（补齐 electron mock）                                                               | 6 例全通过 |

**全量结果**：`npx vitest run` → 208 测试文件 / 3816 用例全部通过；`npx electron-vite build` → `✓ built in 4.11s`（exit 0）。

## 六、与 nikki_albums 的最终对齐校验（spec 六）

| 校验项                        | 本实现保证                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| ① 带元数据照片数量一致        | 仅走三渠道根目录 + 硬编码 `X6Game\Saved\GamePlayPhotos`，移除用户数据/全盘枚举，杜绝 nikki_albums 不含的来源                      |
| ② UID / 相册分类对应          | UID 动态正则 `\d{6,12}`；相册按原目录名分类（HighQuality/LowQuality/其余），与 `path-classifier` 单测对齐                         |
| ③ GamePlayPhotos 无新增缩略图 | `scanDirectory` 下原生 LQ 直接复用，`thumbnail` 指向 `resolveNativeThumbnailPath`，不产生生成缓存文件（测试已断言目录快照无变化） |
| ④ 隐藏目录无需显示隐藏文件    | `scanDirectory` 用 `readdir` 递归，不跳过 `FILE_ATTRIBUTE_HIDDEN/SYSTEM`；`isGamePlayPhotosScanExempt` 豁免所有层级跳过           |

## 七、修改文件清单

- `src/main/scanner/worker-entry.ts`
  - `findMediaDirectories`：移除 `getUserDataPaths` 低置信通道与 `infinitynikki` 软过滤，仅返回「自定义路径 ∪ 三渠道游戏根目录」。
  - 新增导出纯函数 `isGamePlayPhotosScanExempt(rootPath)`。
  - `scanDirectory`：在 GamePlayPhotos 根下豁免「缓存子目录跳过」与「小图过滤」。
- `src/main/scanner/game-directory-discovery.ts`
  - `parseEpicManifests` 加 `export`（供单测锁定）。
  - `findEpicGamePaths` 已含 `C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests` 清单解析（G1 实装于前期，本次锁定）。
- `src/main/scanner/__tests__/worker-entry.findMediaDirectories.test.ts`：改写为收敛后语义。
- `src/main/scanner/__tests__/resolve-gameplayphotos.test.ts`：补齐 electron `app` mock（修复 pre-existing 崩溃）。
- 新增 `src/main/scanner/__tests__/epic-manifests.test.ts`、`scan-gpp-exemption.test.ts`、`nikki-albums-compat.test.ts`。

## 八、验证纪律记录

- 每段代码仅审查一次，审查项具体：G2 移除 `getUserDataPaths` 调用与软过滤、G3 豁免仅限 `isGamePlayPhotosScanExempt` 命中、G4 断言逐字段与 `path-classifier` 一致 + 目录快照无新增。
- 发现并修复的真实缺陷：`isGamePlayPhotosPath` 要求尾部分隔符（面向文件路径），而扫描根本身无尾部分隔符 → 豁免不会触发；已在 `isGamePlayPhotosScanExempt` 中同时匹配根目录与后代路径。
- 构建验证：本机禁用 `npm run build` 的 clean（Safe-Delete 网关 EPERM），改用 `npx electron-vite build` + 写 `dist/main/package.json {type:"commonjs"}`，构建成功。
