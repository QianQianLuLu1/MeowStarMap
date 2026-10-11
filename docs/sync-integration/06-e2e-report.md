# 阶段6：WXNN XiangCe ↔ NikkiSync 端到端联调报告（06-e2e）

> 状态：已完成（S13 Android 真实客户端因环境缺失未覆盖，阻塞原因与补齐步骤见 §6）
> 计划：`06-e2e-plan.md` ｜ 分支：WXNN `feature/sync-integration-06-e2e`、NikkiSync `e2e/wxnn-xiangce-server`
> 联调日期：2026-10-11 ｜ 结论先行：**协议 v1 全部核心端点 + WebSocket + Range + 配对→认证→浏览全流程联调通过（13/13 场景全绿）；两仓库回归零新增失败；未解决高优先级问题 0 项。**

## 1. 联调环境

| 组件                | 版本/配置                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WXNN XiangCe 服务端 | 真实装配链（`sync-server-setup.ts` 同款）：真实 SQLite + 自签 TLS + Ed25519 认证 + SyncServer，运行于 `ELECTRON_RUN_AS_NODE=1 electron --import tsx`（better-sqlite3 为 Electron ABI，plain Node 不可加载，已实测）                                        |
| 启动器              | `scripts/sync-e2e/launch-server.ts`：临时库注入 fixture（6 JPEG 照片 + 1 motion 对 + 1 视频 + 1 已删除项，共 10 资产/revisions 1-10）；仅回环的控制端口（注入资产 / 创建新鲜·过期配对会话 / 广播 rescan / 下发证书）；`--serve`/`--qr` 支持模拟器·真机复用 |
| 驱动测试            | `NikkiSync/apps/pc-companion/test/wxnn-cross-server.test.ts`（新增，attach-only），`node --test` 运行，TLS 钉扎语义对齐 Android PinnedTls（叶子证书指纹=唯一信任锚 + servername 校验证书 SAN wxnn.local，未关闭任何校验）                                  |
| 兼容性基准          | `local-sync-server.test.ts`（参考服务端可执行规格，未改动）+ Android 客户端源码行为（`NikkiSyncClient.java` 等，未改动）                                                                                                                                   |
| 运行方式            | 启动器后台 → `WXNN_E2E_INFO` 注入驱动：`npm run test:wxnn-e2e`（NikkiSync 侧，新增 npm script，默认 `npm test` 清单不变）                                                                                                                                  |

## 2. 场景结果（最终运行，DRIVER_EXIT=0）

| 场景 | 内容                                                                                                                                                                             | 结果 | 耗时 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| S0   | 环境自检（可达性 + 指纹钉扎）                                                                                                                                                    | ✅   | 1ms  |
| S1   | 服务器信息（免签契约、capabilities、revision）                                                                                                                                   | ✅   | 9ms  |
| S2   | 配对正常（serverId 一致、公钥可解析、credential）                                                                                                                                | ✅   | 3ms  |
| S3   | 配对异常（复用→401 pairing_invalid、伪造→401、过期→410 pairing_expired、缺字段→400）                                                                                             | ✅   | 3ms  |
| S4   | 认证（无签名/坏签名/±5min 时钟窗外/未知设备/nonce 重放→一律 401 unauthorized）                                                                                                   | ✅   | 4ms  |
| S5   | 分页图库（limit 0/501→400；limit=1 keyset 走到 nextCursor=null 共 8 项无重复；type=motion_photo/video 过滤；includeDeleted=9）                                                   | ✅   | 13ms |
| S6   | 资产详情（motion 块/资源清单/隐私剥离/404）                                                                                                                                      | ✅   | 6ms  |
| S7   | 元数据（PATCH {} → 200 no-op；非空 → 400 只读，客户端从不发送非空）                                                                                                              | ✅   | 3ms  |
| S8   | 资源下载（200 全量含 X-NikkiSync-SHA256/ETag/Disposition；HEAD；`0-9`/`-5`/`5-`→206+Content-Range；越界/畸形/多段→416+`bytes */size`；缺失→404 resource_not_ready）              | ✅   | 9ms  |
| S9   | 增量变更（after=0 全量 journal；after=最新→空；缺参/负数→400；控制端注入→增量出现 asset.created）                                                                                | ✅   | 6ms  |
| S10  | WebSocket（签名升级 101、首帧 server.hello、ping→pong 回显、注入资产→asset.created 推送、无签名升级被断连）                                                                      | ✅   | 8ms  |
| S11  | export（401 免签；rotation=91/多余参数/缺参→400；200 无损 JPEG + `X-NikkiSync-Export: jpeg-exif-v1`/`Rotation`/`Exif`/`SHA256`(导出字节)；exif=false&rotation=0 原样返回；HEAD） | ✅   | 8ms  |
| S12  | 搜索/统计空桩形状 + 服装缩略图 404                                                                                                                                               | ✅   | 2ms  |

## 3. 问题记录与修复（红灯→绿灯）

### E2E-1：详情 metadata 泄漏 NUAN5 载荷键（隐私契约）

- 场景：S6 ｜ 优先级：高 ｜ 状态：**已修复**
- 现象：fixture 在 editor_metadata 顶层注入 `nativeParamPayload`/`nativeParamNuan5Md5` 后，`GET /v1/assets/{id}` 的 `metadata.raw` 原样带出（驱动红灯 `true !== false`）。上游参考实现剥离这两个键（`LocalSyncServer`/row-mappers 契约：NUAN5 解密载荷/校验键不得出库，`nativeParamToken` 保留）。
- 根因：`src/main/database/sync-row-mappers.ts` `buildPhotoMetadata` 将 editor_metadata JSON 整体透传为 raw，无剥离。
- 修复：`buildPhotoMetadata` 浅拷贝 raw 后 `delete raw.nativeParamPayload`、`delete raw.nativeParamNuan5Md5`；新增单测 M11e（`sync-row-mappers.test.ts`）。
- 验证：单测 56/56 绿；驱动 S6 转绿。注：WXNN 自身编辑器元数据格式不产生这两个键，本修复为对齐协议隐私契约的防御性收敛（红→绿证据：`/tmp` 运行记录 run3 红 → run4 绿）。

### E2E-2：export 扩展端点缺失（阶段4 刻意延后项）

- 场景：S11 ｜ 优先级：高 ｜ 状态：**已实现**（本阶段计划决策，用户确认）
- 现象：真实客户端保存 JPEG 默认调用 `/v1/assets/{id}/resources/{rid}/export?exif=&rotation=`，WXNN 落入 `Route not found`（404）。该红灯在阶段4 已知（api-router.test.ts"延后"用例），本阶段先实现后联调。
- 修复：移植上游 `photo-export.mjs` 的无损 JPEG EXIF 重写（`src/main/sync/server/jpeg-export.ts`，MIT，永不重编码像素）；api-router 新增路由（语义照抄上游 `exportStill`：参数白名单 400、仅就绪普通照片 JPEG 源 404、单飞 429、源字节 stat+哈希校验 409、四校验头 + no-store、HEAD）。新增单测 `jpeg-export.test.ts`（5）+ `export-route.test.ts`（6）；更新旧"延后"用例为新契约。
- 验证：11 项新单测 + 驱动 S11 全绿；导出字节经 sha256 校验、含 Momo Camera EXIF、raw 敏感键不进入导出文件、源文件不可变。

### 驱动侧修正（非服务端问题，记录备查）

- S7 首跑 401：PATCH 签名误用空 body（应签名实发字节）；S8 首跑选中视频：`_primary` 预览过滤未限定 `type==='photo'`（列表按 modified_at DESC）。修正驱动后重跑。
- fixture 形状修正：隐私键须置于 editor_metadata 顶层（WXNN 的 editor JSON 即协议 raw 本身），修正后 S6 红灯成立。

## 4. 已知差异（评估均为不阻塞，均有依据）

| #   | 差异                                                                      | 依据                                                                         |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | PATCH metadata 只读（上游参考服务端允许写回）                             | Android 客户端全仓零调用点（`updateMetadata` 仅定义）；用户确认保持只读      |
| 2   | 搜索/统计为空桩、clothing 缩略图 404                                      | 客户端不读 capabilities、无条件调用并以空结果渲染；空桩返回协议正确形状      |
| 3   | AssetSummary 不含 `gameVersion/gameVersionSource`（上游服务端含）         | 客户端 JsonCodec 按已知字段读取，可选字段缺失容忍                            |
| 4   | capabilities 未声明 suitSearch/clothingSearch/profileStats                | 与"空桩"一致；客户端不读该字段                                               |
| 5   | mDNS 广播未实现                                                           | 客户端首次配对仅走 QR/URI；mDNS 仅用于已配对服务的重发现（不影响首配与浏览） |
| 6   | 撤销设备不踢已建立 WS 连接                                                | 与上游一致（下次签名请求/WS 升级被拒）                                       |
| 7   | TLS：客户端不校验主机名（钉扎指纹）；驱动以 SAN wxnn.local 完成主机名校验 | 信任判定等价：根均为钉扎的叶子证书                                           |

## 5. 回归门禁

| 门禁                     | 结果                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WXNN `npm test`          | ✅ **356 文件 / 5633 通过 + 2 跳过，0 失败**（基线 354/5618 + 2 跳过；+2 文件/+15 测试均为本阶段新增且全绿）                                                                           |
| WXNN `npm run typecheck` | ✅ 0 错（顺带修复三处潜在 TS6138：sync 两仓储与 ws-hub 的刻意未读形参改为下划线前缀，签名不变、运行时零影响——主工程 `tsc -b --force` 0 错实证其为 scripts 工程严格度差异所致的潜在项） |
| WXNN `npm run lint`      | ✅ 0 错误（11 条 BOM 警告为既有渲染层测试文件，与本阶段无关）                                                                                                                          |
| NikkiSync `npm test`     | ✅ 131/131 通过，0 失败（基准套件零改动；新驱动文件不进默认清单）                                                                                                                      |

## 6. S13 Android 真实客户端：环境阻塞取证与补齐路径

`android-emulator` 插件（v0.1.0）`android_preflight` 权威结论（本机 win32）：**Android SDK root / adb / emulator / sdkmanager / avdmanager / Java 全部缺失**，仅 Gradle wrapper 就绪。按插件守则，SDK 安装（Android Studio SDK Manager 或命令行工具）、SDK 许可确认、WHPX/虚拟化检查均属用户侧交互操作，无法在本阶段自动完成。

补齐后即可执行（工具链已就绪并验证）：

1. 安装 Android Studio + SDK（cmdline-tools、platform-tools、emulator、platforms;android-35、build-tools;35.0.0、system-images;android-35;default;x86_64）+ JDK 17，接受 SDK 许可。
2. `NikkiSync` 根目录 `npm run mobile:build` 构建 APK → 插件 `android_build_and_run` 或 `adb install` 安装。
3. 启动器 `--serve --qr --host 0.0.0.0`（或 `--pair-host 10.0.2.2` 供模拟器）长驻，输出 NS1 二维码与 `nikki-sync://pair?...` 完整 URI。
4. 模拟器经插件 `android_open_url` 深链注入自动配对（Manifest 已有 VIEW/BROWSABLE intent-filter）→ `android_screenshot`/`android_ui_*` 验证图库网格、详情、保存（export 路径）、WS 增量刷新。

## 7. 验收标准对照

- [x] 协议 v1 核心端点（server/pair/assets/asset detail/metadata/resource/changes）联调通过（S1-S9）
- [x] WebSocket 事件推送正常（S10：hello/asset.created/无签名拒绝/ping-pong）
- [x] 资源下载 Range 请求正常（S8：206/416/Content-Range/全量哈希头）
- [x] 配对→认证→浏览全流程无阻塞性问题（S2→S4→S5/S6/S8 链路）
- [x] 联调报告无未解决高优先级问题（仅 §4 已评估不阻塞差异 + §6 环境阻塞记录）
- [x] WXNN 全量测试通过，无新增失败（356 文件 / 5633 + 2 跳过）；typecheck/lint 通过；NikkiSync 基线 131/131
- [x] 红灯→绿灯流程已执行（E2E-1 隐私、E2E-2 export）
- [x] 计划文件 `06-e2e-plan.md` 已提交（b9816ac）；NikkiSync 改动在独立分支

## 8. 提交状态（2026-10-11）

Mimosa L3 提交闸门在 NikkiSync 仓库完成首次 deep 扫描（14 项上游既有高危留痕）后，
对本工作区内**所有** Agent 发起的 `git commit` 硬拦（拦截项全部为 NikkiSync 上游
284d4a6 既有代码：windows-shell/mobile/pc-companion 等，与本次改动无关；阶段纪律
禁止修改客户端）。经用户确认采用官方开关放行；实测钩子进程继承 ZCode 主进程环境
（`run-hook.cjs` spawn 不透传 shell 内联 env），开关需 `setx MIMOSA_NO_GIT_GATE 1`
并重启 ZCode 才能生效——故改用等价路径：**全部改动已暂存，由用户在终端直接执行
提交**（闸门仅约束 Agent 发起的提交，人类提交不在其管辖内）。三条命令见阶段
收尾消息；暂存内容与上述 diff 完全一致。
