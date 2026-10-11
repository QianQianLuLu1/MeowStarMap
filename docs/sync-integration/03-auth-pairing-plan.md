# 同步集成 · 阶段 3：认证与配对体系计划（03-auth-pairing-plan）

> 上游参考：`NikkiSync/apps/pc-companion/src/server/{AuthService,PairingService,LocalTlsIdentityService}.ts`
> （只读参考实现逻辑，不复制其 `node:sqlite` 依赖层代码；加密 API 全部使用 Node 内置 `node:crypto`。）

## 1. 目标

在 WXNN XiangCe 主进程侧实现 NikkiSync 协议要求的认证体系三件套：

1. **TLS 自签证书管理**：首次使用生成 RSA-2048 自签证书，持久化到 WXNN 用户数据目录（不使用 NikkiSync 的目录），提供指纹查询；证书损坏可自愈。
2. **Ed25519 请求签名验证**：验证 `X-NikkiSync-*` 四头，签名基串逐字兼容上游客户端（Android `SignedHttpClient`）；±5 分钟时间窗；nonce 防重放。
3. **一次性配对流程**：一次性配对令牌（含过期时间、事务级一次性消费）、令牌兑换与设备公钥入库、配对二维码内容（`NS1|` 七段串）生成。

**本阶段明确不做**（遗留记录见 §12）：HTTP/WS 服务器与路由挂载（阶段4）、IPC handler 与设置 UI、mDNS 广播、qrcode SVG 渲染（本阶段交付 QR **内容串**，渲染属 UI 层）、NikkiSync 仓库改动（纯只读参考）。

## 2. 探查结论（计划依据，源码逐行核实）

### 2.1 认证协议（上游 `AuthService.ts` + 客户端 `SignedHttpClient.java`）

- 四个请求头：`X-NikkiSync-Device-Id`（设备主键字符串）、`X-NikkiSync-Timestamp`（**毫秒** epoch 十进制串）、`X-NikkiSync-Nonce`（16 随机字节 → base64url 无 padding）、`X-NikkiSync-Signature`（Ed25519 签名 → base64url 无 padding）。缺任一头即拒绝。
- 签名基串：`[METHOD, 原始请求目标(path+query，未规范化), 时间戳头原值, nonce 头原值, lowercase-hex(sha256(body))].join('\n')`，UTF-8 编码；空 body 的哈希 = `sha256("")`。
- 验签：`crypto.verify(null, canonicalUtf8, keyObject, sigBuffer)`（Ed25519 PureEdDSA，算法参数传 `null`）；设备公钥兼容 **PEM** 与 **base64url(SPKI DER)** 双格式解析（Android 发 base64url SPKI）。
- 时间窗：`Math.abs(now − ts) > clockSkewMs` 即拒，默认 5 分钟（**硬约束：nonce 窗口不超过 5 分钟**）。
- nonce 防重放：内存 `Map<deviceId:nonce, 过期时刻>`，TTL = 时间窗，每次验证前惰性清理过期项；进程重启清空（重放防护由时间窗兜底，与上游一致）。
- 所有认证失败（缺头/超窗/重放/未知设备/已撤销/验签失败）对外**统一 401** `{"error":{"code":"unauthorized",...}}`，不区分原因（内部日志与测试需区分 reason）。
- 整个验证过程任何异常都必须落到拒绝分支（不向上抛）。

### 2.2 配对协议（上游 `PairingService.ts` + `pairing-repository.ts` + 客户端 `PairingUri.java`）

- 令牌：`randomBytes(24).toString('base64url')`；默认 TTL 5 分钟；服务端**只存 `sha256(token)` 小写 hex**，原串仅出现在 QR 内容里。
- 一次性消费：`BEGIN IMMEDIATE` 事务内按 token_hash 查行 → missing / used（`used_at` 非空）/ expired（ISO 串比较 `expires_at <= now`）/ ok 四态；ok 时 `UPDATE ... SET used_at=? WHERE pairing_token_hash=? AND used_at IS NULL` 置位（**用状态字段而非删除行**）。
- 错误映射：`expired → pairing_expired`（HTTP 410）；`missing/used → pairing_invalid`（HTTP 401）。状态码映射属阶段4 HTTP 层，本阶段服务层抛 `PairingError(code)`。
- 配对二维码内容：`NS1|serverId|host|port|pairingToken|expiresEpochSeconds|tlsFingerprintSha256`（7 段；expires 为**秒**级 epoch；指纹 64 位小写 hex）。`buildPairingUri` 已在 `src/shared/sync/protocol.ts:339` 冻结，直接复用。
- `PairResponse`：`{serverId, serverName, serverPublicKey(PEM), deviceCredential(32B base64url), protocolVersion:1}`；`deviceCredential` 只存其 sha256（`credential_hash` 列已就位），后续认证不使用。
- 设备重复配对：UPSERT 覆盖公钥并清 `revoked_at`（`upsertPairDevice` 阶段2 已具备）。
- **初次配对不依赖 mDNS**（host/port 全在 QR 里；mDNS 仅用于二次自动发现）→ 本阶段不实现 mDNS。

### 2.3 TLS 证书（上游 `LocalTlsIdentityService.ts`）

- RSA-2048（SPKI DER 公钥 / PKCS8 PEM 私钥）+ **手写 X.509 DER**（无证书生成库）：v3、序列号 16 随机字节、`sha256WithRSAEncryption`、Issuer==Subject、有效期 [now−24h, now+10y]（UTCTime）、扩展 basicConstraints(CA) + SAN dNSName。
- 指纹：`new X509Certificate(certPem).fingerprint256` 去冒号转小写 → 64 hex。
- 客户端钉扎 leaf 证书 DER 的 SHA-256 并跳过主机名校验 → CN/SAN 具体值不影响互通。
- 上游缺陷（本阶段改进）：证书 PEM 解析失败未捕获 → 启动崩溃；本阶段改为告警 + 重建。

### 2.4 WXNN 侧既有底座

- 协议契约已冻结：认证头常量、`API_ROUTES`、`API_ERROR_CODES`、`PairRequest/PairResponse/PairingQrPayload`、`buildPairingUri`（`src/shared/sync/protocol.ts`）。
- `sync_paired_devices` 表含 `public_key`/`credential_hash`/`revoked_at`/`last_ack_revision` 全部所需列；`SyncMetadataRepository.upsertPairDevice/getPairedDevice/touchDevice/revokeDevice/ensureServerIdentity` 可直接复用；**尚无 pairing_sessions 类令牌表**（本阶段新增）。
- DDL 装配先例：`SYNC_METADATA_DDL_STATEMENTS`（sync-metadata-repository.ts:31）经 connection.ts:1373 幂等展开，纯新增表不占迁移版本号。
- 测试范式：内存 FakeDb / 注入假仓储，**不加载原生 better-sqlite3**（Electron ABI 不匹配）；服务层测试用注入时钟。
- userData 落盘先例：`app.getPath('userData')` 下自建子目录（custom-dirs.ts 模式）。

## 3. 依赖声明（已检查项目现有依赖）

| 需求 | 结论 |
|---|---|
| Ed25519/RSA 密钥生成、签名验证、哈希、X.509 解析 | **Node 内置 `node:crypto`**（`generateKeyPairSync` / `createSign` / `verify` / `createHash` / `createPublicKey` / `X509Certificate`），零第三方依赖 |
| 文件持久化 | Node 内置 `node:fs` / `node:path` |
| 配对二维码**内容** | 已冻结的 `buildPairingUri`（protocol.ts），无需新依赖 |
| 二维码**渲染**（SVG） | 本阶段不需要；阶段4/5 引入 `qrcode`（上游同款） |
| sqlite 驱动 | 既有 better-sqlite3 ^12；测试走 FakeDb，不触碰原生模块 |
| HTTP 服务器 / mDNS | 阶段4 范围，本阶段不引入 |

**不修改 `package.json`。**

## 4. 新增/修改文件及输入输出

### 新增

| 文件 | 输入 → 输出 |
|---|---|
| `src/main/sync/cert-der.ts` | 私钥 PEM + SPKI DER → 自签 X.509 证书 PEM。纯函数 DER 构造器（自写实现，DER/OID 结构与上游互操作约定一致：v3、sha256WithRSAEncryption、CA+SAN、UTCTime 有效期） |
| `src/main/sync/identity-service.ts` | 目录路径 → `SyncIdentityService`：`getOrCreateTlsIdentity()` → `{keyPem, certPem, fingerprintSha256, createdAt}`（文件缺失/损坏时生成并持久化）；`getOrCreateServerIdentity()` → `{publicKeyPem, privateKeyPem}`（PairResponse 用 Ed25519 密钥对）；`getTlsFingerprintSha256()` |
| `src/main/sync/auth-service.ts` | 注入 `{getDevice, touchDevice, clockSkewMs?, now?}` → `AuthService.verifyRequest({method, url, headers, body?})` → `{ok:true, deviceId} \| {ok:false, reason}`；reason ∈ missing_headers / malformed_timestamp / clock_skew / replayed_nonce / unknown_device / revoked_device / invalid_signature |
| `src/main/sync/pairing-service.ts` | 注入 `{sessions, devices, identity, serverIdentity, ttlMs?, now?}` → `PairingService`：`createPairingToken()` → `{token, expiresAt}`；`buildPairingQrContent({host, port, ttlMs?})` → `NS1\|...` 串；`redeemToken(PairRequest)` → `PairResponse`（失败抛 `PairingError('pairing_expired'\|'pairing_invalid'\|'bad_request')`） |
| `src/main/database/sync-pairing-repository.ts` | `SYNC_PAIRING_DDL_STATEMENTS`（建表+索引）+ `SyncPairingRepository`：`createSession({tokenHash, serverId, expiresAt})`、`consumeSession(tokenHash, nowIso)` → `'ok'\|'missing'\|'used'\|'expired'`。SQL 全静态字面量 + 参数绑定，同步直写 + 事务（resonance/sync 先例），async 方法签名保留 worker 切回接缝 |
| `src/main/sync/AGENTS.md` | 模块约定说明 |
| 测试 ×4 | `src/main/database/sync-pairing-repository.test.ts`、`src/main/sync/auth-service.test.ts`、`src/main/sync/pairing-service.test.ts`、`src/main/sync/identity-service.test.ts` |

### 修改（唯一存量文件改动）

| 文件 | 改动 |
|---|---|
| `src/main/database/connection.ts` | 导入 + 展开 `...SYNC_PAIRING_DDL_STATEMENTS`（紧跟 `...SYNC_METADATA_DDL_STATEMENTS`，2 行 + 注释；幂等 DDL，不占迁移版本号） |

### 目录决策

新代码放 `src/main/sync/`：对齐 `src/shared/sync/`（阶段1 协议）与 scanner/thumbnail 等特性目录先例；sync 是跨阶段特性子系统（阶段4 的 server/websocket/事件接线将聚合于此），不放通用横切服务所在的 `services/`。仓储照旧放 `src/main/database/`。

## 5. 启动 / 验证方式（命令表）

本阶段为纯库层（无运行时入口、无 IPC），验证全部经测试与静态检查：

| 目的 | 命令 |
|---|---|
| 新增测试（红灯→绿灯） | `npx vitest run src/main/sync src/main/database/sync-pairing-repository.test.ts` |
| 数据库层回归 | `npm run test:db` |
| 主进程回归 | `npm run test:main` |
| 类型检查 | `npm run typecheck` |
| Lint | `npm run lint` |
| 全量测试 | `npm run test` |

加密 API 行为先经 Node 官方文档核对（§7），再以 scratch 脚本实测后才进入实现（执行纪律 §6）。

## 6. 错误处理与参数校验

### 6.1 错误处理矩阵

| 故障 | 检测 | 处理 |
|---|---|---|
| 认证请求缺头 / 头为空 | `verifyRequest` 头检查 | 拒绝（reason=missing_headers） |
| 时间戳非数字 / 超出 ±5min | `Number.isFinite` + `Math.abs(now−ts)>clockSkewMs` | 拒绝（malformed_timestamp / clock_skew） |
| nonce 重放 | 内存 Map 命中 `deviceId:nonce` | 拒绝（replayed_nonce），**不写入** |
| 未知设备 / 已撤销 | 设备仓储查询 | 拒绝（unknown_device / revoked_device） |
| 验签失败 / 公钥解析异常 / base64url 非法 | try/catch 包住整个验签段 | 拒绝（invalid_signature），不向上抛 |
| 配对令牌不存在 / 已使用 | `consumeSession` → missing/used | `PairingError('pairing_invalid')` |
| 配对令牌过期 | ISO 串比较 `expires_at <= now` | `PairingError('pairing_expired')` |
| 配对请求字段缺失/非法（platform∉{ios,android}、publicKey 不可解析等） | 服务层先校验后消费令牌 | `PairingError('bad_request')`（**未消费令牌**，可重试） |
| 证书/私钥文件损坏、指纹不符 | `X509Certificate` 解析失败或重算指纹 ≠ 存储指纹 | `logger.warn` 告警 → **重建覆盖**（自愈，改进上游崩溃行为） |
| 证书目录不可创建 / 写入失败 | fs 异常 | 向上抛（启动期致命，属环境问题） |
| TLS 校验绕过 | — | 不提供任何"跳过验证"开关；客户端钉扎指纹是唯一信任锚 |

### 6.2 参数校验规则表

| 项 | 规则 |
|---|---|
| 签名头格式 | 四头全部存在且非空字符串；timestamp 必须可解析为有限数字（毫秒）；nonce/signature 按 base64url 解码，解码或验签异常一律拒绝 |
| 时间戳窗口 | `clockSkewMs` 默认 `5 * 60_000`，构造可注入但**不提供放宽到 >5min 的运行时配置** |
| nonce 规则 | 键 = `${deviceId}:${nonce}`；TTL = clockSkewMs；惰性清理；仅内存（重启清空，时间窗兜底防重放） |
| 配对令牌 | 长度 24 随机字节 base64url；TTL 默认 5 分钟；存储仅 sha256 hex；一次性靠事务内 `used_at IS NULL` 守卫 |
| PairRequest | `pairingToken` 非空；`device.deviceId/deviceName` 非空字符串；`device.platform ∈ {ios, android}`；`device.publicKey` 必须能被 `createPublicKey` 解析（PEM 或 base64url SPKI）；`appVersion` 可空 |
| host/port（QR 生成入参） | host 非空字符串；port 整数 1–65535（与客户端 `PairingUri.java` 校验对齐） |

## 7. 加密 API 核对（禁止假设，实现前完成）

需对照 Node 官方文档确认的行为（Node ≥22，Electron 41 主进程同源）：

1. `generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: {type:'spki', format:'der'}, privateKeyEncoding: {type:'pkcs8', format:'pem'} })` → `{publicKey: Buffer, privateKey: string}`。
2. `generateKeyPairSync('ed25519', {…spki/pem, pkcs8/pem})` → 双 PEM 字符串。
3. `crypto.verify(null, data, keyObject, signature)`：Ed25519 算法参数传 `null`。
4. `createPublicKey({key: Buffer, format:'der', type:'spki'})` 与 `createPublicKey(pemString)` 双格式。
5. `new X509Certificate(pem)`：`.fingerprint256` 为冒号分隔大写 hex（需归一化）；对自写 DER 证书的可解析性以 scratch 脚本实测。
6. `Buffer.from(str, 'base64url')`、`createHash('sha256')`、`createSign('RSA-SHA256')`。

以上每项在 scratch 脚本（`node -e`）中实测通过后才写实现代码；实测记录进 §13。

## 8. 证书存储位置与权限策略

- 位置：`{userData}/sync/`（Windows = `%APPDATA%/wxnn-photo-manager/sync/`）。**绝不使用** `%LOCALAPPDATA%/NikkiSync` 或上游 SQLite `app_settings` 键。
  - `server.crt` / `server.key`：TLS 证书与 RSA PKCS8 私钥 PEM。
  - `server-ed25519.pub` / `server-ed25519.key`：服务器 Ed25519 身份（PairResponse `serverPublicKey`）。
- 权限：全部写入使用 `fs.writeFileSync(path, data, { mode: 0o600 })`；目录 `fs.mkdirSync(dir, { recursive: true })`。POSIX 下私钥仅属主可读写；Windows 下 `mode` 不生效，但 userData 位于用户 Profile 内、ACL 天然限定为当前用户（等同最小化语义，文档注明）。
- 密钥材料**不落日志**；对外只暴露指纹（64 hex）。
- 损坏自愈：解析失败 / 指纹自洽校验失败 → `logger.warn` 后重新生成并原子覆盖（先写临时名再 rename 可选，简单场景直接覆盖可接受——生成频率仅首次与损坏时）。

## 9. 配对流程状态机

```
[无会话]
   │ createPairingToken() / buildPairingQrContent()
   ▼
pairing_sessions{token_hash, used_at=NULL, expires_at=now+ttl}   ←—— [待使用]（QR 已展示）
   │
   │ redeemToken(PairRequest) → consumeSession(sha256(token))（事务内）
   ├─ 行不存在 ────────────→ 'missing'  → PairingError('pairing_invalid')  [终态不变]
   ├─ used_at 非空 ─────────→ 'used'     → PairingError('pairing_invalid')  [一次性保证]
   ├─ expires_at <= now ───→ 'expired'  → PairingError('pairing_expired')
   ├─ 请求体非法（校验先于消费）→ PairingError('bad_request')  [令牌未消费，可重试]
   └─ ok：used_at 置位
        │ upsertPairDevice（UPSERT 覆盖公钥、清 revoked_at、ack 归零）
        ▼
     [已配对] → PairedResponse{serverId, serverName, serverPublicKey, deviceCredential, protocolVersion:1}
        │
        └─ revokeDevice() → revoked_at 置位 → 认证侧 rejected_device（撤销不删行）
```

认证侧独立状态：设备行存在且未撤销 + 四头齐全 + 窗内 + nonce 未见过 + 验签通过 → `touchDevice` 记 last_seen → 放行。

## 10. 基础测试用例（红灯→绿灯）

策略：仓储测试用 FakeDb（SQL 匹配桩，只覆盖实际发出的语句，未匹配语句抛错快速暴露遗漏）；服务测试注入假仓储/假身份 + 注入时钟（过期/重放场景时间可控）；身份服务测试用 `fs.mkdtemp` 临时目录走真文件系统。测试不加载原生 better-sqlite3。

- **T1 sync-pairing-repository**：createSession 写入 token_hash（非原 token）；consumeSession 四态（ok / missing / used / expired）各断言；同一 hash 二次 consume 返回 'used'（一次性守卫）。
- **T2 auth-service**：合法签名通过（现场 Ed25519 签 canonical；PEM 与 base64url SPKI 两种公钥格式）；缺任一头拒绝（4 例）；非法签名拒绝；body 篡改拒绝；时间戳超窗（过去/未来 >5min）拒绝、窗内通过；nonce 重放拒绝（同设备同 nonce 二次）；同 nonce 异设备通过（键含 deviceId，与上游一致）；未知设备拒绝；已撤销设备拒绝；成功后 touchDevice 被调用。
- **T3 pairing-service**：生成令牌 → QR 串 7 段 `NS1|` 结构断言（serverId/host/port/token/expires 秒级/指纹 64hex）；兑换全流程 → 设备入库（public_key 原串、credential_hash = sha256(返回 credential)、revoked_at 为空）；过期令牌拒（pairing_expired，注入时钟）；已用令牌拒（pairing_invalid）；未知 token 拒；platform/publicKey 非法拒（bad_request 且令牌未被消费）；同 deviceId 重配对换钥 + 清撤销；响应 serverId 与 QR 一致；库中无原 token 明文。
- **T4 identity-service**：首启生成并持久化 4 文件；重载后证书/指纹稳定；指纹 == `X509Certificate.fingerprint256` 重算归一化值（64 位小写 hex）；证书文件损坏 → 重建恢复且新证书/指纹自洽；Ed25519 身份持久稳定；（win32 跳过）私钥文件 mode 0600。

红灯确认：先提交全部测试 → `npx vitest run …` 因模块缺失/行为缺失而失败 → 逐模块实现转绿。

## 11. 可判定的验收标准

1. `npx vitest run src/main/sync src/main/database/sync-pairing-repository.test.ts` 全绿：覆盖认证成功/失败/过期/重放 4 场景与配对全流程/过期/已用 3 场景、TLS 生成/持久化/指纹/自愈。
2. `npm run test:db`、`npm run test:main`、`npm run test` 与基线（§13 记录）对比**无新增失败**。
3. `npm run typecheck` 通过；`npm run lint` 对改动文件通过。
4. `sync_pairing_sessions` 表随启动迁移创建（FakeDb 之外，DDL 常量被 connection.ts 展开）。
5. 无新增 npm 依赖；无任何凭据/密钥字面量入库入码。

## 12. 分支与提交、已识别风险与未解决问题

- 分支：`feature/sync-integration-03-auth-pairing`（自 02 分支 HEAD 7b48060）；NikkiSync 仓库零改动。分逻辑提交：docs 计划 → database 仓储 → sync 服务+测试；commitlint 通过。
- 风险①：Mimosa 安全扫描对同步直写/`RegExp.exec` 的已知误报——沿用 resonance 先例（`String.prototype.match`、静态字面量 SQL）；提交若被闸门拦，按先例对提交仓库跑 security_scan 取 seal。
- 风险②：手写 DER 证书若结构有误会被 `X509Certificate` 解析失败暴露——scratch 脚本先行验证（§7）。
- 风险③：测试文件不被 `tsc -b` 覆盖（01 计划 §10 已登记的现状）——以 eslint + vitest 兜底。

## 13. 执行记录

（执行中回填：基线测试数、scratch 验证结论、红灯/绿灯时间线、回归结果、提交清单。）
