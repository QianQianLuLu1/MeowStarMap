# 阶段 4 计划：HTTPS 同步服务器 + WebSocket（NikkiSync 协议 v1）

> 状态：执行中。前置：阶段 3（认证/配对/TLS）已验收（commit 774e70d）。
> **订正（2026-10-30）**：上一行的「执行中」是当时规划快照，不可当现状读。阶段 4 已验收
> （`05-ui-scanner-integration-plan.md` 首部记 commit `015150b`）；代码侧 `src/main/sync/server/` 存在、
> 由 `initSyncServer()` 装配，但**默认不再自启**——见 `src/main/app/sync-server-setup.ts` 的
> `PORTED_SYNC_AUTOSTART_ENABLED = false`（该常量刻意保留而不删整段逻辑，回滚只需翻转它）。
> 本目录各文件首部的状态字段以 `README.md` 表 2 为唯一对账处。
> 目标：在 WXNN XiangCe 主进程启动 HTTPS 服务器，实现协议 v1 全部 API 端点与 WebSocket 事件推送。

## 1. 依赖声明（先检查已有依赖）

**零新增 npm 依赖。**

| 需求                 | 方案                                                                                                                       | 来源                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| HTTPS 服务           | `node:https`                                                                                                               | Node 内置（Electron 内置 Node 24.18.0）                                    |
| TLS 证书             | `SyncIdentityService.getOrCreateTlsIdentity()`                                                                             | 阶段 3 `src/main/sync/identity-service.ts`                                 |
| 请求验签             | `AuthService.verifyRequest({method,url,headers,body})`                                                                     | 阶段 3 `src/main/sync/auth-service.ts`（框架接缝已预留，头名大小写不敏感） |
| 配对                 | `PairingService.redeemToken()` / `buildPairingQrContent({host,port})`                                                      | 阶段 3 `src/main/sync/pairing-service.ts`                                  |
| 协议 DTO/路由/错误码 | `src/shared/sync/protocol.ts`（阶段 1 移植，禁止改语义）                                                                   | 阶段 1                                                                     |
| 数据读取             | `SyncReadRepository`：`getServerInfo/listAssets/getAssetDetail/getResourceLocation/getChanges`                             | 阶段 2 `src/main/database/sync-read-repository.ts`                         |
| 变更日志             | `SyncMetadataRepository.recordAssetChange/getCurrentRevision/rebuildMotionLinks`                                           | 阶段 2 `src/main/database/sync-metadata-repository.ts`                     |
| WebSocket            | 手写 RFC6455（握手/Accept 计算/ping-pong/text 帧），移植上游 `NikkiSync/apps/pc-companion/src/server/WebSocketHub.ts` 模式 | 上游也未用 `ws` 包                                                         |
| LAN 地址             | `network-address ^1.1.2`（已在 dependencies，share-wifi-service 在用）                                                     | 既有依赖                                                                   |

不引入 express/fastify/ws/qrcode。本服务器为纯被动服务，不发起任何出站 URL 请求。

## 2. 端点清单 → 适配层方法（协议 12 条路由全覆盖）

| #   | 方法+路径                                  | 认证       | 后端（复用）                                              | 备注                                                                                                                                                                    |
| --- | ------------------------------------------ | ---------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GET `/v1/server`                           | 无         | `SyncReadRepository.getServerInfo()`                      | capabilities 仅声明 websocketEvents/rangeRequests/metadataV1/motionAssets 4 项                                                                                          |
| 2   | POST `/v1/pair`                            | 无签名     | `PairingService.redeemToken(body)`                        | 400 bad_request / 401 pairing_invalid / 410 pairing_expired                                                                                                             |
| 3   | GET `/v1/assets`                           | 签名       | `SyncReadRepository.listAssets(query)`                    | router 预校验 limit/cursor/type/afterRevision/includeDeleted                                                                                                            |
| 4   | GET `/v1/assets/{assetId}`                 | 签名       | `getAssetDetail(assetId)`                                 | null→404 `'Asset not found'`                                                                                                                                            |
| 5   | PATCH `/v1/assets/{assetId}/metadata`      | 签名       | 校验 + `getAssetDetail`                                   | v1 只读：非对象 400；未知键 400 `'Metadata field is read-only or unsupported: <key>'`；空对象 200 no-op 返回 `{...detail, revision}`【注记1：写路径延后，移动端不调用】 |
| 6   | GET/HEAD `/v1/assets/{id}/resources/{rid}` | 签名       | `getResourceLocation()` + `fs.createReadStream`           | Range 单区间；206/416；`ETag: "sha256:<hex>"` + `X-NikkiSync-SHA256`                                                                                                    |
| 7   | GET/HEAD `.../resources/{rid}/export`      | —          | **延后**                                                  | 按未匹配路由 404【注记2：上游扩展端点（非 API_ROUTES），EXIF/旋转重编码需 sharp 管线，移动端"导出"功能受影响，属功能缺失非同步正确性问题】                              |
| 8   | GET `/v1/search/suits?q=`                  | 签名       | 空结果桩 `{query, items:[]}`                              | 【注记3：选 200 空集而非 501——验收状态码集合不含 501；getServerInfo 未声明该 capability，客户端不应依赖】                                                               |
| 9   | GET `/v1/search/clothing?q=`               | 签名       | 空结果桩                                                  | 同上；q 校验：trim 非空且 ≤80，否则 400                                                                                                                                 |
| 10  | GET `/v1/profile/stats`                    | 签名       | 空统计桩 `{libraryRevision, topSuits:[], topClothing:[]}` | 同上                                                                                                                                                                    |
| 11  | GET `/v1/changes?after=N`                  | 签名       | `getChanges(after)`                                       | after 缺失/非法→400 `'after revision is required'`；revision 过旧→200+`fullResyncRequired:true`（协议语义，不是 410）                                                   |
| 12  | WS `/ws/v1`                                | 升级头签名 | `AuthService.verifyRequest` + WsHub                       | 失败 `socket.destroy()`；成功先发 `server.hello`                                                                                                                        |

## 3. 错误处理（统一 ApiErrorBody；成功 JSON 统一 `Content-Type: application/json; charset=utf-8` + `Cache-Control: no-store`）

| HTTP | code                                                                     | 触发                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | bad_request                                                              | limit 越界 / cursor 非法 / type 非法 / afterRevision 非法 / pair body 非 JSON 或缺字段 / 搜索 q 缺失或 >80 / metadata body 非对象或键不允许 / body 超 1MB |
| 401  | unauthorized                                                             | 签名缺失/无效/时钟偏移>5min/nonce 重放/设备未知或吊销（`verifyRequest` 全部失败原因统一映射，阶段 3 §2.2 既定）                                           |
| 401  | pairing_invalid                                                          | pair token 缺失/已用                                                                                                                                      |
| 410  | pairing_expired                                                          | pair token 过期                                                                                                                                           |
| 404  | not_found                                                                | 路由未匹配（含 export）、assetId 不存在                                                                                                                   |
| 404  | resource_not_ready                                                       | 资源不存在/未 stable、源文件 stat 失败                                                                                                                    |
| 416  | （无 body，头 `Content-Range: bytes */<size>` + `Accept-Ranges: bytes`） | Range 不可满足                                                                                                                                            |
| 500  | internal_error                                                           | 未捕获异常（英文 message=error.message）+ log.error                                                                                                       |

资源端点响应头（照上游 LocalSyncServer）：`ETag: "sha256:<hex>"`、`X-NikkiSync-SHA256: <hex>`、`Accept-Ranges: bytes`、`Cache-Control: private, max-age=31536000, immutable`、`Content-Disposition: inline; filename*=UTF-8''...`；206 另加 `Content-Range: bytes <start>-<end>/<size>`；HEAD 同头无 body。无 If-None-Match/304 处理（客户端不用）。

## 4. 参数校验（router 层预校验，阶段 2 仓储校验兜底）

- `limit`：默认 100，整数 1..500（`parseQuery` 只接受十进制数字串）
- `cursor`：base64url 可解码 JSON `{t:string, id:number}`
- `type`：`isAssetType` 枚举
- `afterRevision` / `after`：Number.isSafeInteger ≥ 0
- `includeDeleted`：仅字符串 `'true'` 生效
- `assetId`：`/^\d+$/`（与阶段 2 `parseAssetId` 一致；不匹配→404 not_found）
- body：仅 pair/metadata 有，上限 1 MB，超出→400 `'request body too large'`
- Range：`/^bytes=(\d*)-(\d*)$/` 仅单区间（含逗号/多区间→416）；`bytes=A-B`/`A-`/`-N` 后缀；end 越界钳制到 size-1；start≥size 或 end<start→416

## 5. WebSocket 事件类型与触发时机（事件驱动，不轮询）

- **升级认证**：`GET` + 原始 `req.url` + 4 个 `X-NikkiSync-*` 头 + 空 body → `AuthService.verifyRequest`；失败直接 `socket.destroy()`（无 HTTP 响应，同上游）。成功完成 RFC6455 握手（`Sec-WebSocket-Accept = base64(sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))`，版本须 13）。
- **连接建立**立即发 `server.hello {protocolVersion, serverId, libraryRevision(getCurrentRevision), occurredAt}`；新连接不回放历史（baseline=当前 revision，更早变更走 /v1/changes，同上游）。
- **广播触发**：
  - 单条变更（收藏/评分/标签/笔记/分类/服装/软删/恢复/改名 handler 挂点）：`recordAssetChange` 成功后立即广播 `asset.created|asset.updated|asset.deleted {revision, assetId, occurredAt}`。
  - 扫描开始（扫描 IPC 触发点）：广播 `library.rescan.started {revision, occurredAt}`。
  - `runPostScanActions`：`rebuildMotionLinks()` → 按 `created_at/updated_at ≥ 扫描开始时间` 批量写 journal（新发现=created，已有变更=updated；不逐条广播，避免移动端事件风暴——客户端收到任意事件都会走 /v1/changes 增量）→ 广播一次 `library.rescan.completed {revision, occurredAt, changedAssets:N}`。
- **客户端→服务器**：仅 ping(0x9)→pong(0x8a)（原样回显 payload）与 close(0x8)→清理；其余帧忽略；帧上限 2MB。
- **journal 永远写**（服务器未运行也写，保证 /v1/changes 正确）；广播仅运行时进行。

## 6. 进程部署方案及理由：主进程

1. 阶段 2/3 全部服务是主进程构造注入的纯 Node 类，DB 三件套（`getDatabase()/getWorkerBridge()/getDbPath()`）仅主进程可得；utilityProcess 部署需跨进程桥接全部仓储与认证状态，复杂度远超收益。
2. 上游参考实现 `LocalSyncServer` 同样运行在 pc-companion 单进程主循环。
3. 阻塞风险可控：文件经 `fs.createReadStream` 流式发送（异步 IO）、sha256 惰性回填异步（阶段 2 `hashFile`）、JSON 载荷小（≤500 条 summary）、客户端为局域网 1-2 台手机；`server.setTimeout(30s)`。
4. 生命周期：`lifecycle.ts` 在 `dbManager.initialize` 之后启动（照 `backupService.init(ctx.dbManager)` 模式）；`cleanup.ts` 在 `wifiShareService.stop()` 附近、`dbManager.close()` 之前 `stop()`。优雅关闭：停收新连接 → WS 全部发 close 帧 → 活动流 3s 宽限 → `closeAllConnections()` → `server.close()`。
5. 装配遵守 `src/main/sync/AGENTS.md`：`src/main/sync/` 不 import electron、不注册 ipcMain；userData 路径与 electron-log 由装配层注入。

## 7. 需修改/新增文件（完整路径）

**新增（`src/main/sync/server/`，纯 Node；禁 import electron；日志/错误消息英文；lib<ES2021 禁 `String.replaceAll`；Mimosa 红线：不用 `RegExp.exec`、SQL 只在仓储层）**

| 文件                                  | 内容                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/sync/server/types.ts`       | `SyncApiServices` 最小服务端口接口（HTTP 层依赖面，测试可注入内存 fake）、`SyncServerOptions`/`SyncServerStatus`、`SyncEventSink` |
| `src/main/sync/server/api-error.ts`   | `ApiHttpError {status, code, message}` + `ApiErrorBody` 序列化                                                                    |
| `src/main/sync/server/body.ts`        | 读 body（1MB 上限）+ JSON 解析                                                                                                    |
| `src/main/sync/server/range.ts`       | `parseRangeHeader(header, size)` → `{start,end}` / `'unsatisfiable'` / null                                                       |
| `src/main/sync/server/ws-hub.ts`      | RFC6455：握手 Accept、帧编解码、ping-pong、客户端注册、`broadcast(text)`                                                          |
| `src/main/sync/server/api-router.ts`  | 路由匹配 + 各端点 handler + 错误映射 + 资源流式响应                                                                               |
| `src/main/sync/server/sync-server.ts` | `SyncServer` 门面：`https.createServer(tls)` + hub + router；`start({port})`/`stop()`/`getStatus()`；端口冲突重试                 |

**新增（装配/IPC）**

| 文件                                    | 内容                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/app/sync-server-setup.ts`     | `initSyncServer(ctx)`：`{userData}/sync` 目录、electron-log→`SyncLogger` 适配、仓储/认证/配对/门面组装、`SyncEventSink` 实现、按 `getSetting('sync.serverEnabled', true)` 自启 |
| `src/main/ipc/handlers/sync-handler.ts` | 顶部 `// @core-change:` 注释；`sync:getStatus` / `sync:startServer` / `sync:stopServer` / `sync:createPairingQr`（返回 NS1 内容串；SVG 渲染留阶段 5）                          |

**修改**

| 文件                              | 改动                                                 |
| --------------------------------- | ---------------------------------------------------- |
| `src/main/app/app-context.ts`     | 加 `syncServer?` / `syncEvents?`                     |
| `src/main/app/lifecycle.ts`       | bootstrap 中启动 sync server                         |
| `src/main/app/cleanup.ts`         | `performCleanup` 中 `stop()`（dbManager.close 之前） |
| `src/main/app/ipc-setup.ts`       | `registerSyncHandlers(ctx)`                          |
| `src/main/ipc/handler-context.ts` | 加可选 `syncEvents`                                  |

**事件接线（gated 目录，均加 `// @core-change:` 注释）**：`src/main/ipc/handlers/media-handler.ts`（rating/favorite/tags/notes/category/outfit→asset.updated）、`src/main/ipc/handlers/media-lifecycle-handler.ts`（softDelete/永久删除/清空回收站→asset.deleted；restore→asset.updated）、`src/main/ipc/handlers/file-rename-handler.ts`（asset.updated）、`src/main/ipc/handlers/scanner-handler.ts`（rescan.started/completed + 批量 journal）

**文档/测试**：本文件；`src/main/sync/server/range.test.ts`、`src/main/sync/server/api-router.test.ts`、`src/main/sync/server/sync-server.integration.test.ts`

## 8. 启动/验证方式

- 默认端口 **27124**（上游无固定端口约定，配对 URI 显式携带 host:port，可自定）；`getSetting('sync.serverPort')` 可覆盖（仅主进程读取，本阶段无 UI）。
- 端口冲突策略：EADDRINUSE→+1 重试至 +10→全占则启动失败，log.error 且 `getStatus()` 可见；实际绑定端口写入状态并用于 QR。
- 应用启动自动拉起（`sync.serverEnabled` 默认 true）。
- 手动验证：启动应用后 `curl -k https://127.0.0.1:27124/v1/server`（200）、`curl -k https://127.0.0.1:27124/v1/assets`（401）；签名请求与 WS 走集成测试。
- 测试一律 `127.0.0.1:0`（系统分配端口），不假设可用。

## 9. 基础测试用例（vitest node 分片；红灯→绿灯）

`sync-server.integration.test.ts`：真 `https.createServer`（port 0，`cert-der.ts` 生成自签证书）+ 内存 fake services + Ed25519 签名 helper（照上游 `local-sync-server.test.ts:53-63`）+ `node:https` 客户端（rejectUnauthorized:false）+ tls 原始 socket 手写 WS 升级（照上游 250-258）。

用例清单：

1. GET /v1/server 无认证 200，字段符合 ServerInfoResponse
2. GET /v1/assets 无签名→401 `{error:{code:'unauthorized'}}`
3. 签名列表 200 items/nextCursor/libraryRevision；limit=0→400；cursor 非法→400；type 非法→400；afterRevision 非法→400
4. 详情 200/404
5. PATCH metadata：非对象 400；未知键 400；协议键→400 read-only；空对象 200 带 revision
6. 资源：无 Range 200（ETag/X-NikkiSync-SHA256/Accept-Ranges/Content-Length）；`bytes=2-5`→206 + Content-Range + 4 字节内容逐字节断言；`bytes=-N` 后缀；`bytes=999999-`→416+`Content-Range: bytes */<size>`；多区间→416；HEAD 无 body
7. /v1/changes：after 缺失→400；after=0→200 changes/fullResyncRequired
8. pair：合法 token→200 PairResponse；重放→401 pairing_invalid；过期→410 pairing_expired；body 非 JSON→400
9. search q 缺失→400、合法→200 空集；profile/stats→200
10. WS：无签名升级→socket 销毁；合法升级→101 + server.hello；record 变更→收到 asset.created；ping→pong
11. stop 后端口释放、活动连接优雅关闭
12. 端口冲突：先占 27124 再 start→绑定 27125

## 10. 可判定验收标准

- [ ] 所有 API 端点可通过 curl 或测试客户端访问，返回格式符合协议 DTO
- [ ] 未认证请求返回 401（ApiErrorBody 格式）
- [ ] 资源下载支持 Range（206 + Content-Range 头验证）
- [ ] WS 连接后收到 server.hello，触发变更后收到对应事件
- [ ] 服务器可正常启动/停止，端口冲突有明确处理
- [ ] `npm run typecheck` 通过
- [ ] 现有测试无新增失败（基线：346 文件 / 5528 通过 + 2 skipped）
- [ ] 改动已 commit（NikkiSync 侧无改动，确认独立分支）

## 11. 执行步骤

1. 本计划文档 → 2. 切分支 `feature/sync-integration-04-http-server` → 3. 红灯测试 → 4. 实现 `server/` 模块转绿 → 5. 装配+IPC+事件接线（每步 typecheck+相关测试）→ 6. 回归门禁：`npm run typecheck` + `npm run lint` + `npm run test:main` + 全量 `npm test` → 7. commit（若 Mimosa L3 闸门拦截：对提交仓库跑 security_scan 取 seal 后重新 add+commit）→ 8. 自检清单核对。

## 12. 执行记录

**分支**：`feature/sync-integration-04-http-server`（自 `feature/sync-integration-03-auth-pairing` 切出）。

**红灯→绿灯**：先写 `range.test.ts` / `api-router.test.ts` / `sync-server.integration.test.ts`（3 文件全因模块不存在失败），实现 `src/main/sync/server/` 7 个模块后 45/45 通过。

**实现要点与计划偏差**：

1. **clothing 缩略图端点补记**：计划 §2 表格漏列 API_ROUTES.clothingThumbnail（协议 12 路由之一）；实现为 404 resource_not_ready 桩 `'Clothing thumbnail is unavailable'`（与上游"源不可用"同语义，计划注记3 同理）。
2. **Mimosa 拦截与处理**（两次）：① 集成测试客户端禁用证书校验被拦 → 改为 `ca` 钉扎测试证书 + 证书链校验开启 + 跳过主机名比对——与真实 Android 客户端 PinnedTls 的信任模型（信任根=钉扎叶子证书而非主机名）一致且更严谨；② ws-hub 的 SHA-1 被标记弱加密 → 误报，SHA-1 是 RFC 6455 §1.3 规定的 Sec-WebSocket-Accept 固定推导公式（非安全原语），已注释说明。
3. **批量 journal**：`SyncMetadataRepository` 新增 `recordAssetChanges`（单事务逐条 INSERT（MAX+1）+ 镜像更新一次；校验提取为 `assertChangeInput` 共用）。理由：万级首扫不能逐条开事务；FakeDb 已匹配同款 SQL，新增 3 个用例（B1 衔接/B2 空批/B3 整体回滚）。
4. **扫描水位线**：主进程拿不到 worker 逐行写入明细，采用"扫描前 MAX(id) 水位线（id 越线=新发现，精确）+ ISO 时间窗（扫描期间行变化）"；崩溃恢复扫描取应用启动时间 + 水位线 0（全量补账保证收敛）。**已知限制**：上次扫描结束到本次发起之间被外部修改/失踪标记的行不进本批 journal。
5. **SyncServerHandle 等装配类型下沉** `sync/server/types.ts`：sync-handler 收 HandlerContext，避免 ipc→app 的类型循环依赖；sync-server-setup 转出口。
6. **扫描增量窗口选择**：`indexed_at` 每次 upsert 都刷新（全表触碰），不能做变更信号；`created_at/modified_at` 为文件 birthtime/mtime 的 ISO 串，可与 ISO 水位线直接字典序比较。

**回归结果**：

- `npm run typecheck` ✅（主进程 tsc -b + scripts）
- `npm run lint` ✅ 0 error（11 个 warning 全为 renderer 测试文件既有 BOM，非本次引入）
- `npx vitest run src/main/sync src/main/database` ✅ 574 通过 + 2 skipped
- 全量 `npm test` ✅ **349 文件 / 5576 通过 + 2 skipped**（基线 346/5528+2，净增 48 用例，无新增失败）
- 既有 `ipc-setup.test.ts` 补 mock：registerSyncHandlers（该测试显式枚举全部 handler 模块）

**手动验证路径**：启动应用后 `curl -k https://127.0.0.1:27124/v1/server`（200）；`curl -k https://127.0.0.1:27124/v1/assets`（401 unauthorized）；签名请求与 WS 经集成测试覆盖（含配对→签名→WS 全链路）。

**未解决问题（不阻塞阶段 5）**：

- PATCH metadata 全字段只读（写回 editor_metadata 需逆向映射，延后；移动端不调用）
- export 扩展端点延后（移动端"导出"功能将失败）
- 搜索/统计/clothing 缩略图为空桩；mDNS 广播、QR SVG 渲染、设置 UI 归阶段 5
- sync.serverEnabled / sync.serverPort 设置项仅主进程读取（未进 RENDERER_PREF_KEYS 白名单，无 UI）
