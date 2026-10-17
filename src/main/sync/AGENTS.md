# AGENTS.md — `src/main/sync`（NikkiSync 同步集成 · 主进程侧服务）

本目录承载 NikkiSync 同步集成的 **主进程侧服务层**（协议契约在
[`../../shared/sync/`](../../shared/sync/)，持久化底座在
[`../database/`](../database/)）。集成计划与阶段记录见
[`docs/sync-integration/`](../../../docs/sync-integration/)。

## 模块定位与依赖方向

```
阶段4（规划中）                本目录
HTTP/WS 服务器 ──────────→  auth-service / pairing-service / identity-service
                                    │
shared/sync/protocol.ts（协议契约，只读）        database/sync-pairing-repository.ts
```

- **只依赖**：`node:crypto` / `node:fs` 等 Node 内置模块、`../../shared/sync/protocol`
  （冻结契约，禁改）、`../database/sync-*-repository`（持久化）。**不 import Electron**——
  本目录保持纯 Node 可测性；userData 路径、electron-log 由阶段4 装配层注入。
- **被依赖**：阶段4 的 HTTP 服务器（挂载 `verifyRequest`）、IPC handler（配对 QR 展示）。
  本目录不注册 `ipcMain.handle`、不启动服务器。

## 文件职责

| 文件                  | 职责                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-service.ts`     | `AuthService.verifyRequest({method,url,headers,body})`：Ed25519 签名验证、±5min 时间窗、nonce 内存防重放；失败 reason 内部细分、对外统一 401 |
| `pairing-service.ts`  | `PairingService`：一次性令牌生成/兑换、设备公钥入库、NS1 二维码内容；`PairingError(code)`                                                    |
| `identity-service.ts` | `SyncIdentityService`：TLS 自签证书 + Ed25519 服务器身份的文件持久化（`{userData}/sync/`）、指纹查询、损坏自愈                               |
| `cert-der.ts`         | 纯函数 X.509 v3 DER 构造（零依赖手写，结构与上游互操作约定一致）                                                                             |

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
