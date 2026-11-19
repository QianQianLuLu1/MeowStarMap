# 同步控制台审查修复轮实施计划（2026-11-19）

> 范围：未发布提交 `af3f477..HEAD`（4426ffe / bb927fb / 4fb72a4）+ 工作区同步控制台前端（console/ 视图拆分、SyncInspirationPanel、usePairingQr、inspiration-filter）。
> 裁决：全部纳入本轮；先打包再冒烟；版本号保持 2.5.7-beta（四处声明位只核对）。

## 一、依赖声明

零新增依赖。`npm install` 后必须重跑 `npm run link:nikkisync`（install 会剪掉 `node_modules/@nikkisync/*` junction；上游克隆 `../NikkiSync` 在位），`npm run verify:nikkisync` 复验。

## 二、启动与运行说明

- 环境：Windows x64、Node ≥24、上游 NikkiSync 克隆已构建（dist 在位）。
- 开发启动：`npm run dev`；构建：`npm run build`；打包：`npm run dist:win`。
- 验证顺序（全绿才提交）：`npm install` → `link:nikkisync` → `build` → `test` → `typecheck` → `dist:win`（供冒烟产物）→ `e2e:smoke` → `test:ci-linux` → 提交 → 版本核对 → 最终 `dist:win`。
- 每次代码变更后 `npm run verify`（只读）。

## 三、错误处理

- 主进程业务错误一律 AppError 家族，经 wrapHandler 统一转 IpcError；子进程失败 fail-closed 上报 `failed` + reason，不假成功。
- journal/热点状态持久化失败 ⇒ 动作报 failed（不吞错继续）；restore 失败绝不清 journal。
- UAC 提权外层 `-PassThru` 检查内层 ExitCode，非 0 透出；拒绝识别以退出码 1223/0x800704C7 为主判据、多语言文本兜底；外层脚本声明 UTF8 输出编码修 GBK 乱码。
- 渲染层 IPC 失败保留上次成功观测值（useSyncOverview），不瞬时置 null 造成二维码抖动。

## 四、参数校验

- 11 条外壳/控制台通道改 `wrapHandler + z.tuple([schema.optional().default({})])`：位置参数数组按元组校验，非法 action 产 VALIDATION_ERROR 结构化 issues。
- journal 逐条形状校验（name 非空 string / enabled boolean / profile 白名单 `^(Any|Domain|Private|Public)(,(Domain|Private|Public))*$`），任一非法整体拒绝 restore；buildApplyScript 对 profile 二次白名单（防本地篡改注入 PowerShell）。
- 非法端口（含 0）⇒ failed/reason，与 runNetworkAuth 同口径。
- 子进程分层超时：查询 60s / UAC 300s，maxBuffer 16MB（shell-exec.ts 纯函数）。

## 五、基础测试用例（正常/异常/边界）

| 子任务         | 涉及文件                                                                                                                                       | 输入/输出                                      | 验收标准                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1.1 M1+M5+M7  | `src/main/ipc/handlers/nikkisync-handler.ts`（@core-change 替换）、新增 `src/main/app/shell/shell-exec.ts`(+test)、`nikkisync-handler.test.ts` | invoke 通道入参 → IpcResponse                  | 正常：8 通道合法入参默认 disabled 返回 success；异常：非法 action ⇒ VALIDATION_ERROR、篡改 journal ⇒ nothing-to-restore 零子进程；边界：零参调用 ⇒ 缺省 {} |
| T1.2 M2        | `src/main/app/shell/temporary-hotspot.ts` + `shell-network-hotspot.test.ts`                                                                    | stop/start + 持久化注入 → HotspotControlResult | stop 外来热点零脚本执行；writeState 失败 ⇒ failed 带 reason；status 仍查询                                                                                 |
| T1.3 M3+M6     | `network-authorization.ts` / `network-conflict-repair.ts` elevated 包装 + 测试                                                                 | 脚本文本 / execFile 失败 → 结果                | 外层含 -PassThru/ExitCode/UTF8；1223 ⇒ elevation-declined；restore 失败 clearJournal 零调用                                                                |
| T1.4 M4+M9+M10 | `network-conflict-repair.ts` + 测试                                                                                                            | 规则集/port/journal → plan/结果                | Block⇒enabled:false、禁用 Allow⇒enabled:true；二次 repair 合并首见优先；写 journal 失败零 apply；Any 端口识别；port=0 ⇒ failed；runRepair 编码脚本非 JSON  |
| T1.5 M8        | `src/main/nikkisync/runtime-manager.ts` + `runtime-manager.test.ts`                                                                            | server.start 二次失败 → restartSyncService     | resolve 返回 syncStatus + warn 日志，永不 reject                                                                                                           |
| T2.1 R4        | `console/SettingsView.tsx` + 测试                                                                                                              | 挂起期间二次点击                               | selectDirectory/remove/rescan mock 仅 1 次调用                                                                                                             |
| T2.2 R3        | `console/SettingsView.tsx`、`console/ConnectView.tsx` + 测试                                                                                   | 连拨两开关 / 切走后在途返回                    | 第二次 onFlagsChanged 同含两开关新值；切走后不再 setState                                                                                                  |
| T2.3 R5        | `console/useSyncOverview.ts` + 新增测试                                                                                                        | 首轮成功次轮失败                               | 保留首轮值；cleanup 后计时器清零                                                                                                                           |
| T2.4 R6/R7     | `PairingQrDialog.tsx` 尾换行；`SyncInspirationPanel.test.tsx` 增量                                                                             | —                                              | prettier 绿；新 UI 面 2–3 用例                                                                                                                             |
| T3 i18n        | `src/renderer/i18n/locales/*.json`（12 语）+ 新增 `sync-console-keys.test.ts`                                                                  | 键清单 → 键值                                  | 键集测试红→绿；i18n:guard + i18n:check 双绿；11 语非空                                                                                                     |

TDD 纪律：每个修复先写失败测试（红）→ 最小修复（绿）→ 重跑确认；修复前测试必须失败。

## 六、提交与打包

4 个 Conventional Commits：① fix(nikkisync) 主进程十项；② feat(sync-console) 前端拆分与竞态修复；③ feat(i18n) 12 语键补齐；④ docs(changelog) 回写条目与产物读数。CHANGELOG 条目写 [2.5.7-beta] 节（[Unreleased] 已收口）。提交前后各做一次工作区快照比对（另一会话曾并行写入 console/，持续变动即停）。最终 `dist:win` 产物 MeowStarMap-Setup-2.5.7-beta.exe + verify:dist 通过。
