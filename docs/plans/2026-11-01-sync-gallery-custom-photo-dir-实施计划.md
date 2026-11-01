# 同步图库「自定义照片目录」实施计划（经批准后落盘，按节点红→绿执行）

> 生成日期：2026-11-01 · 本仓 `main` @ `7598c29`（`meow-star-map 2.5.6`）
> 真相源：`src/main/app/nikkisync-runtime-setup.ts`（`SETTING_GAME_ROOT` 读取端）· `src/main/nikkisync/AGENTS.md` · `src/main/ipc/handlers/AGENTS.md` · `src/renderer/AGENTS.md` · `docs/IPC_CONTRACT.md` · `docs/CODING_CONVENTIONS.md`
> 落盘状态：本文于 2026-11-01 落盘于 `docs/plans/`（已核对目录无重名）。

---

## 0. 本轮已裁决的四项（不再讨论，作为约束使用）

| #   | 裁决                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **两者都做**：gameRoot 替代默认游戏照片根（主功能）+ K6 额外目录支持手输路径（增强）                                                                                                                                              |
| 2   | 校验口径：**存在 + 目录 + 可读必须**；可写探测仅作警告提示，不阻断保存                                                                                                                                                            |
| 3   | 生效时机：**保存后提示重启应用**（仿备份/缓存目录 `needRestart` 模式）。理由：运行期换根须整会话重建（`runtime-manager.ts:512-516`）且重建不重起局域网同步服务；「清除回默认」同会话内受 `deps.defaults` 快照滞后限制无法即时生效 |
| 4   | UI 落点：**「同步服务」二级页（`SyncServicePage`）新增分区**，与 K6 额外目录并列归组（都是扫描来源）                                                                                                                              |

## 1. 目标与范围

### 1.1 背景

「同步图库」数据来自内嵌 NikkiSync 运行时的扫描根。默认路径 = 上游自动发现的游戏安装根；主进程已有设置键 `nikkisync.gameRoot` 的**完整读取端**（`buildSessionOptions`，`nikkisync-runtime-setup.ts:141-146`，env `NIKKI_NIKKISYNC_GAME_ROOT` 优先、设置键次之、空值回退上游自动发现），但**全仓无写入点**。K6「额外照片目录」仅支持系统对话框选目录。本次补齐两处配置能力：路径输入框 + 浏览入口、合法性校验（存在/目录/可读必须/可写提示）、持久化（SQLite `app_settings`）、重启后自动恢复（读取端既有，零改动）、未设置时回退默认。

### 1.2 不做项

- 不改 `buildSessionOptions` / 运行时读取链（读取端已就绪）。
- 不做「保存后立即重扫生效」（裁决 3）。
- 不把 `nikkisync.gameRoot` 加进 `RENDERER_PREF_KEYS`（路径敏感键走专用通道，与 `backupDir` 同口径）。
- 不动 K6 既有 `inspect-extra-directory` 的 pathGuard 门禁语义（手输路径经新 `admit-directory` 通道校验+登记后放行）。
- 不做版本号变更（条目进 `CHANGELOG.md` `[Unreleased]`）。
- e2e 不在本轮范围（nikkisync-runtime 套件需 `@nikkisync` 建链门控；单测+组件测试+人工清单覆盖）。

## 2. 通道设计（4 条新 IPC，全部进 `docs/IPC_CONTRACT.md`）

| 通道                        | 入参       | 返回                                        | 语义                                                                                             |
| --------------------------- | ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `nikkisync:get-game-root`   | 无         | `{ gameRoot: string }`（`''`=默认自动发现） | 读持久化设置（`dbManager.getSetting`，非运行时状态）                                             |
| `nikkisync:set-game-root`   | `{ path }` | `{ gameRoot, needRestart: true, writable }` | 校验 → 持久化 → 渲染层提示重启                                                                   |
| `nikkisync:reset-game-root` | 无         | `{ needRestart: true }`                     | 清空设置回默认                                                                                   |
| `nikkisync:admit-directory` | `{ path }` | `{ path }`                                  | K6 手输预检：校验 → `pathGuard.registerUserPickedDir` → 渲染层再走既有 `inspect-extra-directory` |

校验 helper（`nikkisync-handler.ts` 内私有函数，仿 `settings-handler.ts` 的 `assertCustomScanPaths` 先例）：

1. win32 绝对路径正则（与 `inspectDirectorySchema` 同款 `/^([A-Za-z]:[\\/]|\\\\|\/)/`）；
2. `isSensitivePath`（`src/main/utils/ipc-validate.ts`）拒系统敏感目录（任意盘符 Windows / Program Files / ProgramData、UNC 管理共享、主目录凭据目录）→ `AppError.forbidden`；
3. `existsSync` + `isDirectory` → 否则 `AppError.validation`；
4. `fs.promises.access(dir, R_OK)` 必过 → 否则 `AppError.forbidden`；
5. `W_OK` 探测 fail-open：任何异常归为 `writable: false`，仅随响应返回，不阻断。

安全说明：gameRoot **不**登记 pathGuard（运行时扫描器在主进程直接 fs 读；扫出的照片经 `resource-allowlist` 授权 `media://`，无需扩权）；K6 admit 登记是为了过 inspect 既有 `isUserPickedDir || assertFileReadPath` 门禁，信任级别与 `dialog:selectDirectory`（同样登记 + 敏感目录拒绝）一致。

设置键写入：`ctx.dbManager.setSetting('nikkisync.gameRoot', dir)`（仿 `nikkisync-handler.ts:216` 直读先例，不 import app 层常量；字符串键加注释交叉引用 `SETTING_GAME_ROOT`）。

## 3. 依赖声明

**无新增 npm 依赖。** 全部复用：electron `dialog`（既有 `dialog.selectDirectory` / `showMessageBox` 桥）、zod（既有）、`isSensitivePath`（`src/main/utils/ipc-validate.ts`）、`pathGuard`（`src/main/ipc/validator.ts`）、渲染层 `SectionShell/SettingsCard/SettingsRow`（`pages/settings/shared`）、`useErrorToast`、i18n 既有设施。

## 4. 启动说明

- 环境准备：Node 26.3.0（本机既有）；`npm install`（若重装须补 `npm run link:nikkisync`，本轮单测不依赖建链）；无需 `npm run build`（单测走 vitest，electron 别名指向 inert mock）。
- 启动命令（人工验证）：`npm run dev`。
- 单测：`npx vitest run <file>`；分层：`npm run test:main` / `npm run test:renderer`。
- 验证方式：见 §10 全局验证矩阵；i18n 键守卫 `npm run i18n:guard`；只读预检 `npm run verify`。

## 5. 节点设计（每步红→绿闭环，Agent 亲自运行验证）

### N0 落盘计划文件

- 文件：`docs/plans/2026-11-01-sync-gallery-custom-photo-dir-实施计划.md`（本文）。
- 输入/输出：批准的计划 → 入仓计划文档（含 §13 读数回写节）。
- 验收：文件存在、内容与本计划一致。

### N1 主进程测试红灯

- 文件：`src/main/ipc/handlers/nikkisync-handler.test.ts`（新增 describe，复用 `makeCtx`/`getHandler`）；`src/main/ipc/handlers/settings-handler.test.ts`（新增拒绝用例）。
- 输入/输出：通道不存在 → 新用例全部失败（红）；既有用例不受影响。
- 验收：`npx vitest run src/main/ipc/handlers/nikkisync-handler.test.ts src/main/ipc/handlers/settings-handler.test.ts` → 新用例红、既有绿。

### N2 主进程实现绿灯

- 文件：
  - `src/main/ipc/handlers/nikkisync-handler.ts`（受保护路径）：4 个 zod schema + 校验 helper + 4 条通道；**替换**顶部 `@core-change` 注释为新原因（「新增 game-root 三通道与 admit-directory 目录预检通道」）。
  - `src/shared/settings-keys.ts`：`SECURITY_SENSITIVE_KEYS` 增 `'nikkisync.gameRoot': 'nikkisync:set-game-root'`。
  - `src/shared/types/electron-api.ts`：`NikkiSyncGameRootInfo` / `NikkiSyncSetGameRootInput` / `NikkiSyncSetGameRootResult` / `NikkiSyncAdmitDirectoryInput` / `NikkiSyncAdmitDirectoryResult`。
- 输入/输出：N1 用例转绿；通道契约定型。
- 验收：N1 全绿；`npx vitest run src/main/ipc/handlers` 全绿（无回归）。

### N3 preload 与桥类型

- 文件：`src/main/preload/api/nikkisync.ts`（受保护路径，**替换** `@core-change`，加 4 方法 + shared 类型 import）；`src/renderer/vite-env.d.ts`（nikkisync 命名空间加 4 签名，按文件既有形态复用 shared 类型）。
- 输入/输出：`window.electronAPI.nikkisync.{getGameRoot,setGameRoot,resetGameRoot,admitDirectory}` 可用。
- 验收：`npm run typecheck` 绿；`npx vitest run src/renderer/stores/nikkisyncContractTypes.test.ts src/main/nikkisync/protocol-contract.test.ts` 不回归。

### N4 渲染层测试红灯

- 文件：`src/renderer/pages/sync-gallery/SyncServicePage.test.tsx`（jsdom + electronAPI stub，既有 (a)–(r) 契约之后追加新契约组）。
- 用例：默认值展示（`''` → 「默认（自动发现）」文案）；浏览按钮调 `dialog.selectDirectory` 并填入输入框；保存成功 → 成功 Toast + `needRestart` 重启弹窗流；服务端错误 → 错误 Toast 且输入保留；`writable:false` → 警告 Toast；重置 → `resetGameRoot` + 重启弹窗；K6 手输路径 → 先 `admitDirectory` 后 `inspectExtraDirectory`；admit 失败 → 错误 Toast。
- 验收：新用例红（组件尚无该 UI）、既有 (a)–(r) 绿。

### N5 渲染层实现绿灯

- 文件：`src/renderer/pages/sync-gallery/SyncServicePage.tsx`：
  - ④ K6 分区上方新增「照片目录」分区（复用 `SectionShell/SettingsCard/SettingsRow`、`busy` 锁、`useErrorToast`）：当前值展示（自定义路径等宽字体 or 「默认（自动发现）」）；输入框 + 「浏览…」（`dialog.selectDirectory()` 填入，取消返回 null 忽略）+ 「保存」（客户端预校验空/非绝对路径 → `setGameRoot` → 成功 Toast（`writable:false` 追加警告）→ `needRestart` 时仿 `data-sections.tsx:150-199` 弹 `dialog.showMessageBox` 确认重启 → `app.relaunch()`）+ 「恢复默认」（`resetGameRoot` → 同款重启弹窗）。
  - K6 分区：新增手输入口行（输入框 + 「浏览…」 + 「预检并添加」→ `admitDirectory({path})` → 既有 `inspectExtraDirectory` proposal → confirm 流复用）。
- 输入/输出：页面挂载时 `getGameRoot` 回填；保存/重置后刷新本地状态。
- 验收：N4 全绿。

### N6 i18n 12 语言

- 文件：`src/renderer/i18n/locales/*.json`（12 包）+ `src/renderer/i18n/locales/sync-service-keys.test.ts`（键位守卫先改期望→红）。
- 键位：`syncService.photoDirectories.*`（title/description/currentLabel/defaultValue/inputPlaceholder/browse/save/reset/saved/savedNotWritable/resetDone/restartPrompt/invalidEmpty/invalidAbsolute + 重启弹窗文案）与 `syncService.extraDirectories.inputPlaceholder` 等手输键。zh-CN 基准 → sync → 其余 11 包按既有批量填充配方。
- 验收：`npx vitest run src/renderer/i18n/locales` 绿 + `npm run i18n:guard` 绿。

### N7 文档

- 文件：`docs/IPC_CONTRACT.md`（4 通道契约）；`CHANGELOG.md`（`[Unreleased]` Added 条目，含计划文档链接）；本文 §13 回写执行读数。
- 验收：文档键位与实现一致（通道名/入参/返回体逐字段）。

### N8 全量回归

- 命令：`npm run verify` → `npm test`（全量）→ `npm run lint` → `npm run typecheck` → `npm run typecheck:e2e` → `npm run i18n:guard` → `git status --porcelain` 复核。
- 验收：全绿、无新增失败项；工作区无钩子残留意外改动。

## 6. 错误处理

- 主进程：zod 失败 → `AppError.validation`（`parseAndRun` 既有）；相对/不存在/非目录 → `validation`；敏感目录、不可读 → `forbidden`；`setSetting` 抛错由 `wrapHandler` 收敛为统一错误。错误消息英文（`src/**` 中文硬编码护栏），本地化由渲染层承担。
- 可写探测 fail-open：任何异常（EACCES/EROFS/其他）归为 `writable:false`，绝不阻断、绝不上抛。
- 运行时未启用/未建链不影响 4 条通道（只碰 `dbManager` 与 fs，不 `requireRuntime`）。
- 渲染层：失败 Toast（`useErrorToast`）+ 保留输入值；「已保存，将在下次启动时生效」文案明确取消重启时的语义；`writable:false` 追加可写警告 Toast。
- 日志：主进程 logger（`deps.log` 同款风格）在 set/reset 成功时记 info，校验拒绝记 warn（脱敏路径，复用 `maskPath` 语义——错误消息本身走 AppError）。

## 7. 参数校验

- `path`：string，trim 后长度 1..512（gameRoot，与 `scanSchema.gameRoot` 同界）/ 1..4096（admit，与 `inspectDirectorySchema` 同界）；win32 绝对路径正则；`isSensitivePath` 黑名单；`existsSync`+`isDirectory`+`R_OK` 必过；`writable` 仅随响应返回、不参与判定。
- 返回体字段固定：`{ gameRoot }` / `{ gameRoot, needRestart, writable }` / `{ needRestart }` / `{ path }`，契约入 `docs/IPC_CONTRACT.md`。
- 无新增可选入参、无数组入参；渲染层客户端预校验仅作 UX 提示，服务端校验是唯一真相源。

## 8. 基础测试用例（正常 / 异常 / 边界）

| 类   | 用例（N1 主进程）                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 | set 真实 tmpdir → `setSetting` 持久化 + 返回 `{gameRoot, needRestart:true, writable}`；get 回读；reset → `''` + needRestart；admit 后 inspect 放行（isUserPickedDir 短路）                                                                  |
| 异常 | 相对路径 → validation；不存在目录 → validation；文件（非目录）→ validation；`C:\Windows\System32` / `C:\Program Files\X` → forbidden；vi.mock `fs.promises.access` EACCES → forbidden；settings:set `nikkisync.gameRoot` 被拒并提示专用通道 |
| 边界 | 512 字符恰好通过 / 513 拒绝；前后空白 trim 后入库；`getSetting` 返回非字符串（历史脏值）→ get 回退 `''`；重复 set 同值幂等；admit 与 set 同界不同（4096 vs 512）                                                                            |

渲染层用例（N4）见节点清单；i18n 用例（N6）为键位守卫（12 包逐 key 齐全）。TDD 红灯先行：修复前必须红，修复后绿；既有用例（`nikkisync-handler.test.ts` 31 通道、`SyncServicePage.test.tsx` (a)–(r)）保持绿。

## 9. 回滚方案

单提交序列、无 schema 迁移、无依赖变更：回滚 = revert 对应提交。新设置键 `nikkisync.gameRoot` 空值语义与历史行为完全一致（读取端早已存在），残留数据无副作用。

## 10. 全局验证矩阵

| 检查       | 命令                            | 时机     |
| ---------- | ------------------------------- | -------- |
| 相关单测   | `npx vitest run <改动文件相关>` | 每节点后 |
| 只读预检   | `npm run verify`                | N2/N5 后 |
| 全量单测   | `npm test`                      | N8       |
| 静态检查   | `npm run lint`                  | N8       |
| 类型检查   | `npm run typecheck`             | N3/N8    |
| e2e 层类型 | `npm run typecheck:e2e`         | N8       |
| i18n 守卫  | `npm run i18n:guard`            | N6/N8    |
| 工作区复核 | `git status --porcelain`        | N8       |

## 11. 人工验证清单（无法自动化项）

1. `npm run dev`：设置自定义路径 → 提示重启 → 重启后同步图库出该目录照片（`runtime-status` 的 gameRoot 生效）。
2. Program Files / Windows 目录被拒并给出提示；只读目录保存成功但出现「不可写」警告。
3. K6 手输目录 → 预检提案 → 确认添加 → 照片入库；admit 非法路径被 Toast 拒绝。
4. 未设置自定义路径时同步图库走自动发现（回归确认）；清除自定义路径 → 重启 → 回到自动发现。
5. 保存动作不影响运行中的局域网同步服务（重启语义生效前的会话不动）。

## 12. 待提问项

无（四项裁决见 §0）。

## 13. 执行读数回写

（执行完成后回填：各节点验证命令与结果、提交 SHA、全量回归读数。）
