# AGENTS.md — `src/main/sync`（NikkiSync 同步集成 · 主进程侧服务）

本目录承载 NikkiSync 同步集成的 **主进程侧服务层**（协议契约在
[`../../shared/sync/`](../../shared/sync/)，持久化底座在
[`../database/`](../database/)）。四条硬性编码约定与校验/提交口径见
[`docs/CODING_CONVENTIONS.md`](../../../docs/CODING_CONVENTIONS.md)（唯一真相源）。集成计划与阶段记录见
[`docs/sync-integration/`](../../../docs/sync-integration/)。

## 模块定位与依赖方向

```
装配层（不在本目录）              本目录
app/sync-server-setup.ts ──→  server/sync-server.ts（HTTPS + WS）
                                    │ 挂载 verifyRequest
                                    ▼
app/lifecycle.ts（sync-integration 阶段 4）initSyncServer(ctx)
                                    │
auth-service / pairing-service / identity-service / cert-der
        │                                   │
shared/sync/protocol.ts（冻结契约）    database/sync-*-repository
```

- **只依赖**：`node:crypto` / `node:fs` / `node:http` 等 Node 内置模块、`../../shared/sync/protocol`
  （冻结契约，禁改）、`../database/sync-*-repository`（持久化）。**不 import Electron**——
  本目录保持纯 Node 可测性；userData 路径、electron-log、单例生命周期由
  `../app/sync-server-setup.ts` 装配层注入。
- **被依赖**：`../app/sync-server-setup.ts`（组装并决定是否自启）、
  `../ipc/handlers/sync-handler.ts`（`sync:*` 6 个通道：getStatus / startServer /
  stopServer / createPairingQr / listDevices / revokeDevice）。
  本目录**不注册 `ipcMain.handle`**，也不自行决定启动时机。

### 与 `src/main/nikkisync/` 的关系（两条并行轨道，易被误读为互相取代）

| 轨道   | 目录            | LAN 服务由谁提供                                    | 通道前缀      |
| ------ | --------------- | --------------------------------------------------- | ------------- |
| 移植面 | 本目录          | `server/sync-server.ts`（本仓自研 HTTPS+WS）        | `sync:*`      |
| 内嵌面 | `../nikkisync/` | 上游 `@nikkisync/pc-companion` 的 `LocalSyncServer` | `nikkisync:*` |

两者**并存且都还在**，但当前生效的是内嵌面：`sync-server-setup.ts:63` 的
`PORTED_SYNC_AUTOSTART_ENABLED = false`（阶段 3 决策）使移植面**不再自启**——
`initSyncServer()` 仍在 `lifecycle.ts:340` 被调用（装配与 `sync:*` 通道保持可用），
但默认不监听端口；设置页的「同步服务」节已改由真实 NikkiSync `LocalSyncServer` 接管。
因此：`sync/` 的服务器代码不是死代码也不是规划中，而是**已交付但默认静默**；
要改 LAN 服务行为时先确认用户实际走的是哪一面，别只改静默的那一侧。

## 文件职责

| 文件                                                | 职责                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-service.ts`                                   | `AuthService.verifyRequest({method,url,headers,body})`：Ed25519 签名验证、±5min 时间窗、nonce 内存防重放；失败 reason 内部细分、对外统一 401                                                     |
| `pairing-service.ts`                                | `PairingService`：一次性令牌生成/兑换、设备公钥入库、NS1 二维码内容；`PairingError(code)`                                                                                                        |
| `identity-service.ts`                               | `SyncIdentityService`：TLS 自签证书 + Ed25519 服务器身份的文件持久化（`{userData}/sync/`）、指纹查询、损坏自愈                                                                                   |
| `cert-der.ts`                                       | 纯函数 X.509 v3 DER 构造（零依赖手写，结构与上游互操作约定一致）                                                                                                                                 |
| `server/sync-server.ts`                             | 移植面 HTTPS + WS 服务生命周期（TLS 身份来自 `identity-service`，端口取设置 `sync.serverPort` 默认 27124，EADDRINUSE 时 +1 重试）                                                                |
| `server/api-router.ts` + `api-error.ts` + `body.ts` | Protocol v1 端点路由、统一错误形状、请求体读取与上限                                                                                                                                             |
| `server/range.ts` / `jpeg-export.ts`                | Range 分段（206/416）与 JPEG 导出实现。注意：本目录**没有** `export-route.ts`，导出端点由 `api-router.ts` 装配、`jpeg-export.ts` 实现，`export-route.test.ts` 是经 `api-router` 验证该端点的测试 |
| `server/ws-hub.ts`                                  | WS 事件汇：`server.hello` 握手与 `asset.created` 等增量广播                                                                                                                                      |
| `server/types.ts`                                   | 服务面内部类型（零运行时依赖）                                                                                                                                                                   |

## 硬性约定

1. **协议兼容是最高约束**：签名基串、头名、令牌/QR 格式、错误码与上游
   NikkiSync 逐字对齐（客户端为第三方 Android 应用，改了就连不上）。
   改动任何 wire 格式前必须核对 `docs/sync-integration/00-code-audit-report.md` §2。
2. **安全红线**：nonce 窗口不超过 5 分钟；配对令牌一次性（事务级 used_at 置位）
   且只存 sha256；私钥文件 mode 0o600；不提供任何"跳过验证"开关；密钥材料不进日志。
3. **SQL 在 database/ 侧**：本目录不直接写 SQL；新增持久化需求在
   `../database/sync-pairing-repository.ts` 等仓储文件中实现（静态字面量 + 参数绑定）。
4. **依赖注入优先**：时钟（`now`）、仓储、目录、logger 全部构造注入——过期/重放/
   损坏场景必须可在单测中确定性复现。单例装配在阶段4 的 application 装配点完成。
5. **测试与源码同目录**（`*.test.ts`，Vitest node project）：认证/配对测试注入假仓储
   - 固定时钟；身份服务测试用 `fs.mkdtemp` 真临时目录；不加载原生 better-sqlite3。
