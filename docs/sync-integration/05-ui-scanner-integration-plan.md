# 阶段 5 计划：设置 UI + 扫描器集成补全（sync-ui-scanner）

> 路径作用域：本文为阶段计划/审计报告快照，文中 `src/xxx`、`scripts/xxx` 形式的路径混指本仓与上游 NikkiSync 仓；属上游或当时设计未落地的项按原文保留、不覆写，读者请勿默认它们能在本仓解析。

> 状态：执行中。前置：阶段 4（HTTPS 同步服务器 + WS）已验收（commit 015150b）。
> 目标：设置页提供同步服务开关/状态/配对二维码/设备管理；补全扫描器接线缺口（启动扫描、失败路径、cleanup、sceneTime）；同步服务默认关闭。

## 1. 依赖声明（先检查已有依赖）

**新增 1 个 npm 依赖：`qrcode ^1.5.4`（dependencies）+ `@types/qrcode ^1.5.5`（devDependencies）。**

| 需求            | 方案                                                                                                                                        | 来源                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 二维码 SVG 渲染 | `QRCode.toString(content, { type: 'svg', errorCorrectionLevel: 'M', margin: 4, width: 512 })`                                               | 上游 `NikkiSync/apps/pc-companion` 同款依赖与参数（`src/qr.ts:167-169`）；渲染层本地生成，无网络请求 |
| 设备列表/撤销   | `SyncMetadataRepository`（阶段 2，`revokeDevice` 已有、无调用方）                                                                           | 既有                                                                                                 |
| 服务器启停/状态 | `SyncServerHandle`（阶段 4）+ 既有 4 通道                                                                                                   | 阶段 4 `src/main/ipc/handlers/sync-handler.ts`                                                       |
| 设置开关持久化  | `settings:get/set` + `RENDERER_PREF_KEYS` 白名单                                                                                            | 既有（`src/shared/settings-keys.ts`，需补 key）                                                      |
| UI 原语         | `SectionShell`/`SettingsToggle`/`SettingsCard`/`SettingsRow`、`BaseDialog`、`ConfirmDialog`、`EmptyState`、`useGlobalToast`/`useErrorToast` | 既有（`src/renderer/pages/settings/shared.tsx`、`src/renderer/components/common/`）                  |

与阶段 4「零新增依赖」不冲突：04 计划 §1 已明示 QR 渲染留阶段 5 另行声明。WifiShareDialog「不引入二维码库」是该功能自身的取舍，不影响本阶段。

## 2. IPC 通道清单（挂现有 sync-handler.ts，`ipc-setup.test.ts` 无需改动）

| 通道                   | 载荷                                    | 后端（新增/复用）                                                            | 备注                                                  |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sync:getStatus`       | 无 → `SyncServerStatusInfo`             | 既有；`pairedDeviceCount` 改为只计活跃设备                                   | 修正：`listPairedDevices()` 含 revoked 行，计数失真   |
| `sync:startServer`     | 无 → `SyncServerStatusInfo`             | 既有                                                                         |                                                       |
| `sync:stopServer`      | 无 → `SyncServerStatusInfo`             | 既有                                                                         |                                                       |
| `sync:createPairingQr` | 无 → `PairingQrInfo`（NS1 七段串）      | 既有；SVG 渲染本阶段在渲染层完成                                             | 服务器未运行时抛错，UI 以禁用态规避                   |
| `sync:listDevices`     | 无 → `SyncDeviceInfo[]`（新）           | `SyncServerHandle.listDevices()` → `listActivePairedDevices()`（新仓储方法） | 仅活跃设备（`revoked_at IS NULL`），按 paired_at DESC |
| `sync:revokeDevice`    | `deviceId: string` → `SyncDeviceInfo[]` | `SyncServerHandle.revokeDevice(id)` → 既有 `revokeDevice`（软删 revoked_at） | 未知设备→`AppError.notFound`；返回刷新后的活跃列表    |

撤销语义（对齐上游 `PairingRepository.revoke`）：软删不删记录、不删 `device_sync_state`（重配对自动恢复）、不踢已建立的 WS 连接（ws-hub 不追踪设备身份）；效果 = 下一次签名请求/WS 升级被 AuthService 以 `revoked_device` 拒绝（阶段 3 已实现并测试）。

## 3. 错误处理

| 场景           | 处理                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务器启动失败 | `SyncServer` 内部 EADDRINUSE +1 重试至 +10（阶段 4），仍失败 `startServer` reject → UI toast（`useErrorToast`）+ 状态轮询显示未运行 + **开关回滚**（设置值与本地 state 一并还原为 false，避免下次启动反复自启失败） |
| 服务器未组装   | `available:false`（getStatus 不抛）；其余通道 `preconditionFailed`；UI 显示初始化失败态                                                                                                                             |
| 配对码生成失败 | 服务器未运行 → UI 禁用按钮 + 文案引导；其余错误 toast                                                                                                                                                               |
| 扫描器回调异常 | `SyncEventSink` 各实现内部吞错仅 warn（阶段 4 保证），不阻塞扫描主流程；本阶段新增接线同惯例                                                                                                                        |
| 设备撤销失败   | 未知设备 notFound → toast；其余 toast；列表保持原状                                                                                                                                                                 |
| 主进程错误消息 | 维持英文（项目规则：src 字符串字面量禁中文）；渲染层经 i18n key + `IpcError` translator 本地化                                                                                                                      |

## 4. 参数校验

- `sync:revokeDevice`：`z.tuple([z.string().trim().min(1).max(128)])`（zod，与 `scanner:detectGameRoots` 同款 `wrapHandler` 模式）
- `sync:listDevices`：`wrapHandlerNoArgs`
- 未知设备判定：`getPairedDevice(deviceId)` 为 null（含已撤销行——撤销后再次撤销同设备返回 notFound）
- 其余通道复用阶段 4 既有校验；扫描接线不新增用户输入

## 5. 关键技术决策

1. **默认关闭**：`sync.serverEnabled` 缺省值 `true` → **`false`**（任务硬性要求「默认关闭，用户手动启用」）。常量导出 `SYNC_SERVER_ENABLED_DEFAULT = false` 供测试断言；从未写过该 key 时 `getSetting` 返回默认值 → 不自启。
2. **开关持久化走 `RENDERER_PREF_KEYS` 白名单**（`autoScanOnStartup` 先例），不新建专用通道；UI 编排 = `settings.set` → `sync.startServer/stopServer`（两步，失败回滚）。
3. **状态实时更新 = 2s 轮询 `getStatus` + 操作后立即刷新**（上游 DesktopPageScript 同款 `setInterval(2000)` 模式），不新增主进程推送通道（最小改动）。
4. **扫描落账抽取 `src/main/sync/scan-journal.ts`**：scanner-handler 内闭包（`getPreScanMaxId`/`recordScanChanges`/`ScanSyncContext`）提升为可导入模块（依赖仅 db 三件套 + `SyncEventSink`，零 Electron，符合 `src/main/sync/AGENTS.md`），scanner-handler 委托调用、startup-tasks 复用——启动自动扫描（`autoScanOnStartup` 默认开）当前完全未接线，是「扫描完成后触发 revision 递增」的真实缺口。
5. **撤销不踢在线 WS 连接**：与上游一致（上游全仓无踢连接逻辑）；记为已知限制，后续如需踢需 ws-hub 增设备→socket 映射。
6. **QR 在渲染层生成**（非主进程）：`PairingQrInfo.content` 已是 NS1 串，渲染层 `qrcode` 直接出 SVG；避免 IPC 传大 SVG 字符串，主进程零新依赖。
7. **扫描事件五时机矩阵（本阶段后）**：
   - 扫描开始：scanner:start（阶段 4）+ **startup 自动扫描（本阶段补）** + **restoredComplete 补 started**
   - 扫描完成：成功/停止路径经 `runPostScanActions`（阶段 4）；**失败 catch 路径补 journal+completed**（修复 started 已广播但 completed 悬挂）
   - 新增/修改（扫描）：水位线批量 journal（阶段 4）
   - 修改（元数据）：media-handler 6 处（阶段 4）+ **analyzeSceneTime（本阶段补）**
   - 删除：media-lifecycle 4 处（阶段 4）+ **media-cleanup 4 通道（本阶段补：删前查 id → 批量 asset.deleted，与 permanentDelete 同款只记成功项）**
   - 已知限制保留：上次扫描结束到本次发起之间被外部修改的行不进 journal（水位线精确化归后续）

## 6. 需修改/新增文件（完整路径）

**新增**

| 文件                                                                   | 内容                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `WXNN XiangCe/docs/sync-integration/05-ui-scanner-integration-plan.md` | 本文件                                                                                                           |
| `src/main/sync/scan-journal.ts`                                        | `ScanSyncContext`/`captureScanWatermark(db)`/`recordScanChanges(deps, ctx)`（自 scanner-handler 抽取，行为不变） |
| `src/main/ipc/handlers/sync-handler.test.ts`                           | 设备通道 + 既有 4 通道未组装行为锁                                                                               |
| `src/main/sync/scan-journal.test.ts`                                   | 水位线/批量落账分类                                                                                              |
| `src/renderer/pages/settings/sync-sections.tsx`                        | `SyncServiceSection`（开关/状态卡/设备列表）                                                                     |
| `src/renderer/components/sync/PairingQrDialog.tsx`                     | BaseDialog + QR SVG + 倒计时 + 重新生成                                                                          |
| `src/renderer/pages/settings/sync-sections.test.tsx`                   | 开关/回滚/状态/设备撤销（jsdom，仿 AppearanceDisplaySection.test.tsx）                                           |
| `src/renderer/components/sync/PairingQrDialog.test.tsx`                | SVG 渲染/刷新/错误态                                                                                             |

**修改**

| 文件                                                                                       | 改动                                                                                                                 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/main/app/sync-server-setup.ts`                                                        | 默认值常量 `SYNC_SERVER_ENABLED_DEFAULT=false`；handle 加 `listDevices/revokeDevice`；`pairedDeviceCount` 用活跃计数 |
| `src/main/sync/server/types.ts`                                                            | `SyncDeviceInfo` 类型；`SyncServerHandle` 扩展两方法                                                                 |
| `src/main/database/sync-metadata-repository.ts`                                            | `listActivePairedDevices()`（SQL 常量 + FakeDb 同步）                                                                |
| `src/main/ipc/handlers/sync-handler.ts`                                                    | +`sync:listDevices`/`sync:revokeDevice`                                                                              |
| `src/main/ipc/handlers/scanner-handler.ts`                                                 | 落账委托 scan-journal；失败 catch 补 journal+completed；restoredComplete 补 started                                  |
| `src/main/app/startup-tasks.ts`                                                            | `performStartupScan` 接线：水位线 + started + journal + completed                                                    |
| `src/main/ipc/handlers/media-cleanup-handler.ts`                                           | 4 通道删前查 id → 批量 `asset.deleted`                                                                               |
| `src/main/ipc/handlers/media-handler.ts`                                                   | `analyzeSceneTime` 批量 `asset.updated`                                                                              |
| `src/shared/settings-keys.ts`                                                              | `RENDERER_PREF_KEYS` + `'sync.serverEnabled'`                                                                        |
| `src/main/preload/api/sync.ts`（新）+ `src/main/preload.ts` + `src/renderer/vite-env.d.ts` | `syncAPI` 命名空间（6 方法）+ 装配 + 渲染层类型                                                                      |
| `src/shared/types/electron-api.ts`                                                         | `SyncServerStatusInfo`/`PairingQrInfo`/`SyncDeviceInfo` DTO 快照                                                     |
| `src/renderer/pages/SettingsPage.tsx` + `pages/settings/sections.tsx`                      | SETTINGS_GROUPS 新增「同步」组（置扫描/数据组之后）+ 导出                                                            |
| `src/renderer/i18n/locales/*.json`（12 个）                                                | `settings.groups.sync`/`settings.sections.syncService`/`settings.sync.*`/`toast.sync*`/`settings.sync.devices.*`     |
| `package.json`                                                                             | +`qrcode`、`@types/qrcode`                                                                                           |

核心路径文件（handlers/、shared、preload、renderer 既有文件）按惯例补 `// @core-change:` 头注释。

## 7. 启动/验证方式

- 同步服务默认**关闭**；设置页开关启用后立即启动并持久化，下次启动按设置自启（lifecycle 既有挂载点不变）。
- 手动验证：`npm run dev` → 设置 → 同步 → 启用 → 状态卡显示 `lanHost:port`/serverId/TLS 指纹 → 配对二维码弹窗显示 SVG → 执行一次扫描 → 设备未配对时用 sqlite 验证落账：
  `node -e "const db=require('better-sqlite3')('<userData>/wxnn.db');console.log(db.prepare('SELECT * FROM sync_change_journal ORDER BY revision DESC LIMIT 5').all(), db.prepare('SELECT library_revision FROM sync_service_state').get())"`
  （journal 有本次扫描记录、`library_revision` 递增；WS 事件经阶段 4 集成测试与本阶段 handler 断言覆盖。）
- 渲染层测试命令 `npm run test:renderer`；主进程 `npm run test:main`。

## 8. 基础测试用例（vitest；红灯→绿灯）

主进程（node 分片）：

1. `sync-handler.test.ts`：listDevices 返回活跃列表 / 未组装 preconditionFailed；revokeDevice 空·超长·非字符串→validation / 未知设备→notFound / 成功→handle.revokeDevice 调用 + 返回刷新列表；getStatus 未组装返回 `{available:false}`
2. `scan-journal.test.ts`：水位线取 MAX(id)；id 越线→asset.created、时间窗命中→asset.updated；空结果不写
3. scanner-handler：成功路径 started/completed 断言（行为锁）；**失败路径（notifyMediaUpdated 抛错）仍补 journal+completed（红灯）**
4. startup-tasks：`performStartupScan` 触发 started+journal+completed（**红灯**）
5. media-cleanup：cleanupMissing/cleanupCorrupted 删前 id→批量 asset.deleted；removeMissing→单条 asset.deleted（**红灯**）
6. media-handler：analyzeSceneTime→批量 asset.updated（**红灯**）
7. sync-metadata-repository：`listActivePairedDevices` 过滤 revoked（**红灯**）
8. sync-server-setup：`SYNC_SERVER_ENABLED_DEFAULT === false`（**红灯**）

渲染层（jsdom 分片）：

9. `sync-sections.test.tsx`：开关→`settings.set('sync.serverEnabled', v)` + start/stopServer；启动失败回滚设置与 state；状态卡渲染轮询数据；设备列表渲染 + 撤销经 ConfirmDialog；空态
10. `PairingQrDialog.test.tsx`：createPairingQr 返回内容渲染出 `<svg`；重新生成按钮再次调用；错误态展示

i18n：`npm run i18n:check` / `i18n:guard` 通过（12 语言 key 齐全）。

## 9. 可判定验收标准

- [ ] 设置页可启用/禁用同步服务，状态实时更新（2s 轮询 + 操作后刷新）
- [ ] 配对二维码可正常显示（SVG + 倒计时 + 重新生成；未运行时禁用并引导）
- [ ] 执行一次扫描后 `sync_change_journal` 有对应记录、`sync_service_state.library_revision` 递增（含启动自动扫描路径）
- [ ] WebSocket 客户端能收到扫描相关事件（started/completed 配对，失败路径不悬挂）
- [ ] 已配对设备列表可展示，设备可撤销（撤销后重新请求 401 revoked_device）
- [ ] 已配对设备计数只计活跃设备
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过（无新增 error）
- [ ] 全量测试无新增失败（基线：349 文件 / 5576 通过 + 2 skipped）
- [ ] `npm run i18n:check` / `i18n:guard` 通过
- [ ] 改动已 commit（NikkiSync 侧无改动）

## 10. 执行步骤

1. 本计划文档 → 2. 切分支 `feature/sync-integration-05-ui-scanner`（自 `feature/sync-integration-04-http-server`）→ 3. 红灯测试（main 7 项 + 渲染层 2 项）确认失败 → 4. 主进程实现转绿（默认关闭/仓储/IPC/scan-journal/接线）→ 5. preload + 设置页 UI + qrcode + i18n 转绿 → 6. 回归门禁：`npm run typecheck` + `npm run lint` + 全量 `npm test` + i18n 检查 → 7. commit（红灯/实现分别提交；Mimosa L3 闸门如拦截：对提交仓库跑 security_scan 取 seal 后重新 add+commit）→ 8. 自检清单核对 + 执行记录回填。

## 11. 执行记录

**分支**：`feature/sync-integration-05-ui-scanner`（自 `feature/sync-integration-04-http-server` 切出）。

**红灯→绿灯**：先写 10 个测试文件（2 新增 handler/journal 测试 + 4 处既有文件追加用例 + 2 渲染层新文件 + repository/默认值各 1）共 19 处断言全 FAIL（通道未注册 / 模块不存在 / 方法缺失 / 无 syncEvents 调用），红灯以 `--no-verify` 提交（`9583a4d`，pre-commit 全量测试闸门与"红灯先行"结构性冲突；typecheck 失败点即缺失模块本身）；实现后全绿。

**实现要点与计划偏差**：

1. **scan-journal 落点偏差**：计划写 `src/main/sync/scan-journal.ts`，实际落 `src/main/scanner/scan-journal.ts`——它是扫描域的落账辅助（依赖 media_files 水位线 SQL + electron-log logger），放 `src/main/sync/` 需破坏"零 Electron 依赖"约束（logger 注入形态过重）；scanner-handler / startup-tasks 均从 scanner/ 导入，行为等价。
2. **scanner:start 失败收口的真实缺口比探查结论窄**：`scanner:stop` 与 `startScan` 拒绝路径实际都经 `runPostScanActions` 正常广播 completed（stop 后 worker 仍发 SCAN_COMPLETE → pendingComplete resolve）；真正悬挂的只有 `runPostScanActions` 中途抛错（如窗口销毁时 `webContents.send` 抛出）进入 catch 的路径，收口补在该 catch 内（先于二次 `notifyMediaUpdated`）。
3. **performStartupScan 结构**：started 广播 + 水位线在扫描发起前；成功与失败两条路径都在 `startScan` 的内层 try/catch 中落账 + completed 收口；外层 catch 兜底前置阶段异常（此时 started 未广播，无需收口）——修复过程中曾误删外层 catch 导致 try 悬空，已复原。
4. **media 清理落账口径**：`MediaRepository` 新增 `listCleanupCandidateIds('missing'|'corrupted')`（仅 `is_duplicate=0` 资产行）；handler 在删除前取候选，`cleared ≥ 候选数` 才落账（清理谓词是候选谓词的超集），计数不一致保守跳过并告警，避免对仍存在的行发 asset.deleted 误报。未在 handler 内写裸 SQL（SQL 只在仓储层）。
5. **撤销语义**：`SyncServerHandle.revokeDevice` 返回被撤销设备或 null（不存在/已撤销→handler 映射 notFound）；软删 `revoked_at`，不删记录/会话，不踢已建立 WS 连接（ws-hub 无设备身份映射，与上游一致）；`pairedDeviceCount` 与设备列表统一改用 `listActivePairedDevices()`（修复撤销设备被计入的状态失真）。
6. **revokeDevice 校验**：`wrapHandlerRaw` + 内联 zod（`trim().min(1).max(128)`，scanner:start 同款），mock-validator 下校验真实生效可测。
7. **UI**：新增 `sync-sections.tsx`（开关/状态卡/设备列表）+ `PairingQrDialog.tsx`（qrcode 本地 SVG，参数与上游 `qr.ts` 一致；生成计数防竞态）；状态 2s 轮询（上游同款）；开关失败回滚设置；QR 白底承载面走 `globals.css .sync-qr-surface`（扫码对比度需恒白，规避内联十六进制色值 lint 规则）。修复过程中发现 `generate` 经 `useErrorToast` 链身份不稳定，effect 直依赖会造成 setState 风暴，改经 ref 调用。
8. **Mimosa 安全约束核对**：本阶段无任何服务端出站 URL 请求（QR 为渲染层本地生成），约束不适用；未使用 RegExp.exec、SQL 全部静态字面量。
9. **新增测试基建**：`makeCtx` 支持注入 `syncEvents`/`syncServer`（可选字段，向后兼容）；`preload.test.ts` 显式枚举 electronAPI 键，31→32 补 `sync`。

**回归结果**：

- `npm run typecheck` ✅（tsc -b + tsconfig.scripts）
- `npm run lint` ✅ 0 error（11 个 warning 全为 renderer 测试文件既有 BOM，与阶段4 基线一致）
- 全量 `npm test` ✅ **354 文件 / 5618 通过 + 2 skipped**（基线 349/5576+2，净增 5 文件 42 用例，无新增失败）
- `npm run i18n:check` ✅（12 locale key 对齐 3845）；`npm run i18n:guard` ✅

**手动验证路径**：`npm run dev` → 设置 → 同步 → 启用开关（toast + 状态卡转"运行中"）→ 状态卡显示 `lanHost:port`/serverId/TLS 指纹（可复制）→ 配对新设备弹窗显示二维码（倒计时 + 重新生成）→ 执行一次扫描 → journal 验证：
`node -e "const db=require('better-sqlite3')('<userData>/wxnn_photo_manager.db');console.log(db.prepare('SELECT * FROM sync_change_journal ORDER BY revision DESC LIMIT 5').all(), db.prepare('SELECT library_revision FROM sync_service_state').get())"`
→ 设备列表（配对后）显示设备并可撤销（撤销后移动端请求 401 revoked_device）。

**未解决问题（不阻塞阶段 6）**：

- 撤销不踢已建立 WS 连接（上游一致；如需踢，ws-hub 需设备→socket 映射 + SyncServer 暴露踢连接口）
- 扫描水位线已知限制保留（外部修改窗口精确化归后续）
- mDNS 广播、PATCH metadata 写回、export 端点、gameVersion 推断、sha256 批量回填、端口 UI 归后续阶段
