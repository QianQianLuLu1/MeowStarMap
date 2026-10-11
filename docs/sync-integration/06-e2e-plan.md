# 阶段6：WXNN XiangCe ↔ NikkiSync 端到端联调计划（06-e2e）

> 状态：执行中 ｜ 前置：阶段0–5 完成（基线 354 文件 / 5618 通过 + 2 跳过，HEAD a54674f）
> 关联：`01-protocol-port-plan.md`（协议契约）、`04-http-server-plan.md`（HTTP/WS 实现）、`05-ui-scanner-integration-plan.md`（UI/扫描）

## 1. 目标与范围

使用 NikkiSync 仓库的测试工具（`apps/pc-companion/test/` 集成测试 = "可执行规格"）与/或真实客户端，验证 WXNN XiangCe 作为同步服务端与 NikkiSync 客户端**完全兼容**。

**兼容性基准（不可修改以适配服务端）**：

- 客户端参考：`NikkiSync/apps/mobile`（真实 Android 客户端，纯 Java）
- 可执行规格：`NikkiSync/apps/pc-companion/test/local-sync-server.test.ts`（协议 v1 全场景）
- 协议契约：`NikkiSync/packages/protocol/src/index.ts`（与 WXNN `src/shared/sync/protocol.ts` 同源于上游 284d4a6，冻结不改）

**已确认的范围决策**（用户 2026-10-11 确认）：

1. Android 真实客户端：使用 ZCode `android-emulator` 插件 + 模拟器；环境缺失时按降级条款处理。
2. `export` 端点：本阶段实现（真实客户端保存 JPEG 默认调用，当前 404），红灯→绿灯。
3. PATCH metadata：保持 v1 只读（已核实 Android 客户端零调用点），报告记录与参考服务端差异。

## 2. 已核实的客户端行为事实（探索结论）

| 客户端行为                                                                             | 出处                                                 | 对服务端的要求                       |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------ |
| pair 无签名 POST，校验响应 serverId=QR                                                 | `NikkiSyncClient.java:44-56`                         | 200 契约字段齐全；400/401/410 错误码 |
| loadLibrary：`limit=100&cursor=…` 循环到 nextCursor=null（上限 200 页）                | `MainActivity.java:1536-1565`                        | keyset 分页、无重复、稳定顺序        |
| 配对后立即连 WS `/ws/v1`（签名升级）                                                   | `MainActivity.java:1511-1534`                        | 首帧 `server.hello`                  |
| WS 事件不按名分发：任何事件 revision>本地 → `GET /v1/changes?after=`                   | `MainActivity.java:1567-1620`                        | 事件含 revision；changes 契约        |
| 保存 JPEG 默认走 `/export?exif=&rotation=`，校验 `X-NikkiSync-Rotation/Exif/Export` 头 | `OriginalSaver.java:50-60`                           | export 端点必须实现                  |
| 下载校验 `X-NikkiSync-SHA256`（64hex 且=流哈希），失败删除落盘文件                     | `OriginalSaver.java:61-105`                          | 资源与 export 响应必须带正确哈希头   |
| TLS：叶子证书 SHA-256 指纹钉扎（HTTPS+WSS 同源），主机名不校验                         | `PinnedTls.java:20-51`                               | 配对载荷指纹=证书指纹                |
| 深链 `nikki-sync://pair?…`（VIEW/BROWSABLE）可免扫码配对                               | `AndroidManifest.xml:44-49`、`PairingUri.java:13-41` | 自动化配对通道                       |
| 从不读 capabilities；无条件调用 search/stats/clothing thumbnail                        | 全仓 grep                                            | stub 空结果可容忍                    |
| PATCH metadata 已定义但全仓零调用                                                      | `NikkiSyncClient.java:76-81`                         | 只读语义无影响                       |

## 3. 联调环境准备

### 3.1 WXNN 启动器 `scripts/sync-e2e/launch-server.ts`

真实组件装配（与 `sync-server-setup.ts` 同款装配，非简化替身）：

- 临时目录真实 SQLite（better-sqlite3，Electron ABI）；fixture：约 8 张带 EXIF 的 JPEG（sharp 生成）、1 组 motion（JPEG+MP4）、1 视频、1 已删除；经真实仓储写入并走 `recordAssetChange` 写 journal。
- 真实 TLS identity（自签）+ AuthService + PairingService + SyncServer；host/port 参数化。
- 输出一行 `WXNN_E2E_INFO` JSON：host/port/serverId/tlsFingerprint/NS1 紧凑 URI/`nikki-sync://pair` 完整 URI（host 可注入 `10.0.2.2` 供模拟器）；`--serve` 长驻。
- 控制端口（仅 127.0.0.1）：注入新资产（journal+WS 广播）、创建新鲜/过期配对会话。
- 运行时：`ELECTRON_RUN_AS_NODE=1 electron --import tsx`（已探测：plain Node 加载 better-sqlite3 失败，Electron ABI 可加载）。

### 3.2 NikkiSync 驱动 `apps/pc-companion/test/wxnn-cross-server.test.ts`

- 新增文件（不修改既有测试）；自包含签名 helper（复制自 `local-sync-server.test.ts`，注明原因）。
- spawn 模式（传 WXNN 根路径自动启停启动器）/ attach 模式（外部 `--serve`）。
- 新增 npm script `test:wxnn-e2e`；默认 `npm test` 文件清单不动。构建走根 `npm run build`（wechat-runtime esbuild 先行的既有顺序）。

### 3.3 Android 模拟器（S13）

- ZCode `android-emulator` 插件（`android-dev` 技能）：preflight → 构建（`:app:assembleDebug`）→ 安装 → `android_open_url` 深链配对（host=10.0.2.2）→ screenshot/UI dump 验证。
- 环境现状（已探测）：本机无 JDK/SDK/adb/模拟器；插件环境安装含交互步骤（Android Studio SDK Manager、SDK 许可证、WHPX），按插件守则需用户操作 → 可自动化部分执行，其余记录于报告。

## 4. 场景清单与预期结果

| #   | 场景                 | 验证方法                                                                                                                      | 预期结果                                                                        |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| S0  | 环境自检             | 启动器 INFO 解析、指纹=证书 SHA-256                                                                                           | INFO 完整、可连接                                                               |
| S1  | 服务器信息           | 无签名 GET /v1/server                                                                                                         | 200：protocolVersion=1、serverId=wxnn-*、name、libraryRevision、capabilities    |
| S2  | 配对正常             | POST /v1/pair（令牌+Ed25519 SPKI）                                                                                            | 200：serverId 与 URI 一致、serverPublicKey、deviceCredential、protocolVersion=1 |
| S3  | 配对异常             | 复用令牌/伪造/过期/缺字段                                                                                                     | 401 pairing_invalid / 401 / 410 pairing_expired / 400 bad_request               |
| S4  | 认证与签名           | 无签名/坏签名/超±5min/重放 nonce                                                                                              | 一律 401 `{"error":{"code":"unauthorized",…}}`                                  |
| S5  | 分页图库             | limit 1..500、默认 100、越界 400；cursor 走到 null；type/afterRevision/includeDeleted                                         | `{items,nextCursor?,libraryRevision}`，字段=AssetSummary，无重复                |
| S6  | 资产详情             | 正常/未知 id/非数字 id                                                                                                        | 200 `{asset:{schemaVersion,source.game,resources[],motion?…}}`；404             |
| S7  | 元数据               | PATCH {} → 200+revision；非空 → 400                                                                                           | 只读语义（客户端从不发非空）                                                    |
| S8  | 资源下载+Range       | 200 全量（SHA 头/ETag/Accept-Ranges/Content-Type/Disposition）；HEAD；`0-9`/`5-`/`-5` → 206；畸形/越界/多段 → 416；缺失 → 404 | 逐头对齐参考实现                                                                |
| S9  | 增量变更             | after=0 / after=最新 / 缺参 / 注入新资产后                                                                                    | `{changes[],libraryRevision,fullResyncRequired}`；400 非法 after                |
| S10 | WebSocket            | 签名升级 /ws/v1：hello 首帧、asset.created、无签名断连、ping/pong、close                                                      | 帧格式与 WsEvent 一致                                                           |
| S11 | export               | `?exif=true&rotation=90` → 200 JPEG+`X-NikkiSync-Export/Rotation/Exif/SHA256`；非法 query/带 Range → 400                      | 红灯起（404）→ 实现后全绿                                                       |
| S12 | 搜索/统计/服装缩略图 | stub 端点形状                                                                                                                 | 200 空结果形状正确；缩略图 404 resource_not_ready                               |
| S13 | Android 真实客户端   | 深链配对→网格→详情→保存→WS 刷新（screenshot/UI dump 取证）                                                                    | 配对成功、出图、保存落相册、增量刷新                                            |

## 5. 红灯→绿灯与问题修复流程

每个失败项：在驱动测试固化复现用例 → 确认红（记录实际响应）→ 定位根因（**只修 WXNN 侧**，客户端为基准）→ 修复 → 重跑确认绿 → 计入报告；涉及服务端行为修复时同步补 WXNN 侧单测。

问题记录模板（报告用）：

```
### E2E-<序号>：<标题>
- 场景：S<x> ｜ 优先级：高/中/低 ｜ 状态：已修复/未解决（阻塞/不阻塞）
- 现象：<实际响应/行为>
- 根因：<定位结论，含 file:line>
- 修复：<改动点> ｜ 验证：<复现用例绿 + WXNN 单测>
```

## 6. 回归门禁与提交

- WXNN：`npm test`（零新增失败；export 新增测试允许总数增长）+ `npm run typecheck` + `npm run lint`。
- NikkiSync：`npm test` 既有套件零改动零失败。
- 分支：WXNN `feature/sync-integration-06-e2e`；NikkiSync `e2e/wxnn-xiangce-server`（基于 284d4a6）。每阶段节点 commit；提交前按 Mimosa 流程对提交仓库跑 `security_scan` 取 seal。
- 测试输出先落文件再判退出码（避免管道掩盖失败）。

## 7. 可判定验收标准

1. S1–S10、S12 全部通过；S11 export 实现后全部通过；每个历史失败项都有"红→修→绿"记录。
2. S13 完成模拟器验证，或报告记录明确的环境阻塞原因与后续步骤（不构成未解决高优问题的条件：仅当协议级套件发现阻塞缺陷且未修复时才算）。
3. WebSocket 事件推送、Range 请求、配对→认证→浏览全流程均有通过的自动化断言。
4. 报告中无未解决的高优先级问题。
5. WXNN 全量测试/typecheck/lint 通过且无新增失败；NikkiSync 既有套件不受影响。

## 8. 风险与规避

| 风险                                                  | 规避                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------- |
| better-sqlite3 Electron ABI                           | 启动器经 `ELECTRON_RUN_AS_NODE=1 electron` 运行（已探测可行） |
| 启动器装配与 `sync-server-setup.ts` 漂移              | import 真实模块装配；不复制逻辑                               |
| NikkiSync 构建顺序 quirk（GalleryRuntime.mjs 生成物） | 始终从仓库根 `npm run build`                                  |
| 模拟器网络/防火墙                                     | 模拟器 host=10.0.2.2；真机需同网段+放行入站                   |
| 管道掩盖退出码                                        | 输出落文件后判 EXIT                                           |
| 服务端出站请求（SSRF 约束）                           | 本阶段零新增出站请求（现栈已核实为纯被动服务端）              |
