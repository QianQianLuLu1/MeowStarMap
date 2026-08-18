# 解密服务网络 FFI 阻塞 + 全局 mutex 死锁 — 调研与实施计划

> **状态（2026-08-17）：已实施完成（修复批次 27，组17-1）。**
> 落地内容：`src/main/decryption-worker/`（worker-protocol / dll-path / bridge / worker-entry）+ electron.vite.config.ts 单独打包入口 + decryption-service 本地提取/网络解码拆分（网络 FFI 移出全局 mutex，经桥异步请求，8s 硬超时优雅降级）+ application/app-context/cleanup/recovery 装配。
> 验证：`tsc -b` 0 错误；相关测试 71/71 通过（decryption-worker bridge+entry 22、decryption-service 27、recovery 22）；src/main 全量 2232/2233（唯一失败为 ipc-validate 组5-2 本机 EBUSY 环境限制，与改动无关）；`npm run build` 产出 CJS bundle `dist/main/main/app/decryption-worker.js`（koffi 正确外部化）。
> 与计划的差异：无——按第 2 节推荐方案原样实施。以下为实施前的调研与计划存档。

> 范围：仅调研 + 计划，不改动任何源码。
> 主文件：`src/main/services/decryption-service.ts`
> 目标：把同步网络 FFI（`cloth_diy_decode_network` / `home_build_decode_network`）移出全局 mutex，路由到独立子进程，加硬超时(8s)与失败兜底，同时保持本地 C 内存调用留在 mutex 内。

---

## 0. 背景与现状结论

`decryption-service.ts` 用一条 promise 链 `mutexChain` 把所有 DLL 调用串行化，目的是避免并发操作 C 内存导致 use-after-free（`decryption-service.ts:256-264`）。但其中 **Group 3 / Group 4 分享码解码** 在 mutex 内部调用了 **同步、且无超时的真实网络 I/O FFI**（`:1148`、`:1227`）。

后果：

- 网络慢 / 被墙时，该同步 FFI 冻结 worker 的事件循环；
- 因为它占据全局 mutex 链的头/中途位置，`decodeFileParams`（照片参数解密，核心功能）、`encodeCameraParams` 全部排队等待 → **主线程与核心功能被拖垮**。

关键发现（超出原始描述）：**`home_build_decode_network`（`:1227`）与 `cloth_diy_decode_network`（`:1148`）是同一类问题**，必须一并处理，否则 HomeBuild 分享码仍会阻塞全局 mutex。

---

## 1. 风险点清单（带 file:line）

| #   | 风险点                          | 位置                                                                   | 说明                                                                                                                                                                 |
| --- | ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 全局 mutex 串行化所有 DLL 调用  | `decryption-service.ts:256-264`                                        | `withMutex` 把 4 个导出函数全部挂到同一条 promise 链；任一阻塞都会拖垮其余                                                                                           |
| R2  | 同步网络 FFI（ClothDiy）无超时  | `decryption-service.ts:1148`                                           | `fns.clothDiyDecodeNetwork(shareCode)` 是 koffi 同步调用，内部做真实网络 I/O，无超时、不可被 JS 中断                                                                 |
| R3  | 同步网络 FFI（HomeBuild）无超时 | `decryption-service.ts:1227`                                           | 与 R2 同构，原始描述未提及但同样危险                                                                                                                                 |
| R4  | 分享码解码被包进 mutex          | `decryption-service.ts:1117`、`1211`                                   | 两个解码函数都 `return withMutex(async () => {...})`，排在 mutex 链上，互相排队                                                                                      |
| R5  | 核心功能被连坐阻塞              | `decryption-service.ts:921`、`1060`                                    | `decodeFileParams`（照片参数解密）、`encodeCameraParams` 在同一 mutex 链；网络解码在其前时直接 stall                                                                 |
| R6  | worker 内 `app` 模块不可用      | `decryption-service.ts:138-148`（`findDllPath` 用 `app.getAppPath()`） | `utilityProcess` 子进程无法 `import { app } from 'electron'`，worker 不能复用 `findDllPath` 解析 DLL 路径，必须由主进程把 `dllPath` 传进子进程                       |
| R7  | 冻结的 worker 无法自我终止      | —                                                                      | 同步 FFI 阻塞期间，worker 内部 `setTimeout`/STOP 消息都不会触发；**只有主进程能 `worker.kill()` 它并重启**                                                           |
| R8  | 现有单测直接 mock FFI，需迁移   | `src/main/services/decryption-service.test.ts:371-498`                 | 现有 `decodeClothDiyShareCode` / `decodeHomeBuildShareCode` 单测 mock 的是 `fns.clothDiyDecodeNetwork`；改造后网络解码走子进程桥，需改为 mock 桥的 `decodeNetwork()` |
| R9  | 进程退出需清理子进程            | `src/main/app/cleanup.ts:62` 仅 dispose scanner 桥                     | 新增的解密 worker 必须在 `cleanup.ts` 中 `dispose()`，否则退出残留进程                                                                                               |

---

## 2. 推荐方案

### 2.1 总体思路

采用项目已有的 **`utilityProcess.fork` 子进程范式**（media-worker、scanner-worker 均已验证），新增一个**专用「解密网络解码子进程」**。把「会阻塞的同步网络 FFI」整体下沉到子进程，主进程只保留本地 C 内存调用（`decodeFileParams` / `encodeCameraParams` 以及本地时间戳/UID/服务器号提取）在全局 mutex 内。

> 复用依据：项目已有 3 套同构的 worker 桥（media / scanner / thumbnail），模式为 `bridge.ts`(主进程侧，管 `utilityProcess.fork`+`WORKER_READY` 握手+`WorkerRestartPolicy`+崩溃监听) + `worker-entry.ts`(子进程侧，`process.parentPort` 收发) + `worker-protocol.ts`(消息协议)。本方案**完全复用该范式**，不引入新机制。

### 2.2 主进程侧（留在 mutex 内的部分）

- `decodeFileParams`（Group 1，`:914`）与 `encodeCameraParams`（Group 2，`:1059`）：**保持不变**，继续用 `withMutex` 串行化本地 C 内存调用（快、无网络）。
- `decodeClothDiyShareCode`（`:1116`）/ `decodeHomeBuildShareCode`（`:1210`）：**改为薄壳**——在 mutex 内做本地提取（时间戳 / uidBytes / server，均为本地内存操作），**网络解码那一步改为异步请求解密 worker 桥**并 `Promise.race` 8s 超时；拿到结果后拼装成与现在完全一致的结构体返回（保证 `decrypt-handler.ts:72-122` 的 IPC 契约不变）。
  - 本地提取若失败（如非法分享码），仍走现有错误分支，不进网络。
  - 网络部分独立后，即便它很慢，也**不再占用全局 mutex 链**，照片参数解密不受影响。

### 2.3 子进程侧（网络解码）

新增 `src/main/decryption-worker/worker-entry.ts`：

- 惰性 `koffi.load(dllPath)`（dllPath 由主进程经 `DECRYPT_WORKER_INIT` 消息下发，规避 R6）。
- 内部绑定 `clothDiyShareCodeFromCodeStr` / `clothDiyDecodeNetwork` / `freeClothDiyShareCode` 与 HomeBuild 对应函数；持有**自己的 `mutexChain`** 串行化本进程 C 调用（与 media-worker 保持一致）。
- 收到 `NETWORK_DECODE` 命令：用 `codeStr` 重建 shareCode → 调同步网络 FFI → 读 `CBytes` 转 string → `postMessage` 回 `{requestId, status, networkData}`。
- 子进程内也尝试软超时（若 C 库支持），但**不依赖它**作为硬保证。
- 完全照搬 media-worker 的兜底：`process.on('uncaughtException'/'unhandledRejection')` → 发 `WORKER_ERROR` → `cleanupAndExit()`；启动完成发 `WORKER_READY`。

### 2.4 硬超时(8s)与失败兜底（关键设计）

**8s 硬超时必须在主进程侧用 `Promise.race` 实现，而非依赖子进程内部定时器**（R7）：

- 主进程桥维护 `pending: Map<requestId, {resolve,reject}>`。
- 每次 `decodeNetwork()`：`Promise.race([ workerRoundTrip(requestId), timeout(8000) ])`。
- 若 8s 内未收到结果：
  1. 主进程**立即**以「优雅兜底」resolve：返回 `success:true` + `networkData: undefined` + `error: t('main.decryption.error.networkTimeout')`，保持分享码其余字段（timestamp/uid/server）可用（与现有 status≠0 时的优雅行为一致）。
  2. 主进程 **`worker.kill()` 冻结的子进程**，并借 `WorkerRestartPolicy` 延迟重启，恢复后续请求能力。
- 若 worker 正常返回 status≠0（如 `10: NetworkError`），同样走兜底分支，返回 `success:true + error`，不抛异常。
- 这样**主线程永远不被冻结**，且全局 mutex 不再包含网络调用。

### 2.5 更优复用点（写入计划，供评估）

1. **DLL 路径注入**：主进程 `getLib()` 已加载 DLL，应把已解析的 `dllPath` 直接传给 worker（经 `DECRYPT_WORKER_INIT`），不要子进程再调 `findDllPath`（规避 R6，且 dev/asar 路径更稳）。
2. **抽取 `BaseUtilityProcessWorker`**：media / scanner / thumbnail / 即将新增的 decryption 四套桥高度同构（fork + `WORKER_READY` 15s 握手 + `WorkerRestartPolicy` + crash listener + `MEDIA/SCAN/..._LOG` 转发 + dispose 模板）。可考虑抽公共基类减少重复（**非本次必做**，列为后续优化）。
3. **崩溃统一上报**：复用 `recovery.ts:84` 的 `registerWorkerCrashListener` 模式，为解密 worker 也注册崩溃提示。

---

## 3. 需要新增 / 修改的文件清单

### 新增

| 文件                                              | 作用                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/decryption-worker/worker-entry.ts`      | 子进程入口：加载 DLL、`NETWORK_DECODE`/`DECRYPT_WORKER_INIT`/`DECRYPT_WORKER_DISPOSE` 消息处理、内部 mutex、兜底退出                               |
| `src/main/decryption-worker/worker-protocol.ts`   | 主↔子进程消息协议（`NETWORK_DECODE` 命令 / `NETWORK_DECODE_RESULT` 事件 / `WORKER_READY` / `WORKER_ERROR` / `DECRYPT_WORKER_INIT`）                |
| `src/main/decryption-worker/bridge.ts`            | 主进程侧桥：惰性 `utilityProcess.fork`、15s `WORKER_READY` 握手、8s 硬超时 `Promise.race`、`pending` Map、`WorkerRestartPolicy`、崩溃监听、dispose |
| `src/main/decryption-worker/bridge.test.ts`       | 桥单测（握手超时、8s 超时兜底、崩溃重启、请求/响应匹配）                                                                                           |
| `src/main/decryption-worker/worker-entry.test.ts` | 子进程协议单测（mock koffi，验证 status 映射、CBytes→string、错误回传）                                                                            |

### 修改

| 文件                                                        | 改动                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/services/decryption-service.ts`                   | `decodeClothDiyShareCode` / `decodeHomeBuildShareCode` 改为：本地提取留在 mutex，网络解码改调 `DecryptionWorkerBridge.decodeNetwork()` 并 8s 兜底；导出 `setDecryptionWorkerConfig({dllPath})` 供 app 初始化注入路径；`disposeDecryptionService` 增加 `bridge.dispose()` |
| `src/main/app/application.ts`（`67-73` 附近）               | 实例化 `DecryptionWorkerBridge`（与 `mediaWorkerBridge` 同位置）                                                                                                                                                                                                         |
| `src/main/app/app-context.ts`                               | `HandlerContext` 增加 `decryptionWorkerBridge` 字段（或直接由 service 内部持有单例）                                                                                                                                                                                     |
| `src/main/app/cleanup.ts`（`62` 附近）                      | `cleanup()` 中增加 `ctx.decryptionWorkerBridge?.dispose()`（R9）                                                                                                                                                                                                         |
| `src/main/app/recovery.ts`（`84` 附近）                     | 为解密 worker 注册 `registerWorkerCrashListener`（可选，复用现有模式）                                                                                                                                                                                                   |
| `src/main/services/decryption-service.test.ts`（`371-498`） | 将直接 mock `fns.clothDiyDecodeNetwork` 的用例改为 mock `DecryptionWorkerBridge.decodeNetwork()`，并新增超时/兜底用例（R8）                                                                                                                                              |

> 注：IPC 边界 `decrypt-handler.ts:72-122` **无需改动**，返回结构保持 `{ok, data:{timestamp,uidBytes,networkData}}` 与 `{ok, data:{server,networkData}}` 不变。

---

## 4. 回归测试建议

必须覆盖三类：网络超时 / 互斥串行 / 失败兜底。

1. **网络超时（核心）**
   - 用 mock worker 在 >8s 后才回 `NETWORK_DECODE_RESULT` → 断言主进程在 ~8s 内返回 `success:true, networkData:undefined, error:'networkTimeout'`，且**不抛异常、不卡死**。
   - 断言超时后桥对冻结 worker 执行 `kill()` 并触发 `WorkerRestartPolicy` 重启（后续请求可成功）。
2. **互斥串行（不回归）**
   - 并发调 `decodeFileParams` + `decodeClothDiyShareCode`：断言 `decodeFileParams` 不受网络解码耗时影响（保留现有 `decryption-service.integration.test.ts:388-404` 的并发用例并扩展，确认照片参数解密耗时与网络解码解耦）。
   - 子进程内部 `mutexChain` 串行化：连续发 3 个 `NETWORK_DECODE`，断言逐个处理、无 C 内存 use-after-free（参考 media-worker 的 `withMutex` 单测思路）。
3. **失败兜底**
   - worker 返回 `status=10 (NetworkError)` → 断言 `success:true + error` 且 timestamp/uid/server 仍返回（优雅降级，行为同现状 `:1175-1179`）。
   - 非法 `codeStr` → 主进程本地提取阶段直接返回失败，根本不进网络（保持现有 `:1124` 分支）。
   - worker 崩溃（`uncaughtException`）→ 断言主进程收到 `WORKER_ERROR`、合成兜底、自动重启后下一请求成功（对齐 `media-worker/bridge.test.ts` 的崩溃恢复用例）。
4. **生命周期**
   - `cleanup()` 调用后 worker 进程退出（无残留）；`app` 启动→解码→退出全链路单测（扩展 `cleanup-perform-cleanup.test.ts`，加入解密 worker dispose 断言）。

---

## 5. 分阶段实施步骤

**阶段 0 — 脚手架（低风险，纯新增）**

1. 新建 `decryption-worker/worker-protocol.ts`，定义消息协议。
2. 新建 `decryption-worker/bridge.ts`，实现 `utilityProcess.fork` + `WORKER_READY` 15s 握手 + `WorkerRestartPolicy` + `pending` Map + 8s `Promise.race` 超时 + `dispose()`，先以 no-op worker 验证握手/重启/dispose。
3. 新建 `decryption-worker/worker-entry.ts`，先实现 `WORKER_READY` + `DECRYPT_WORKER_INIT`(接收 dllPath) + `DECRYPT_WORKER_DISPOSE`，`NETWORK_DECODE` 暂返回空成功。

**阶段 1 — 子进程网络解码（核心）** 4. worker 内惰性 `koffi.load(dllPath)`，绑定 ClothDiy/HomeBuild 两组函数，加内部 `mutexChain`。5. 实现 `NETWORK_DECODE`：重建 shareCode → 同步 FFI → 读 `CBytes` 转 string → 回传 `status`+`networkData`；加 `uncaughtException`/`unhandledRejection` 兜底退出。6. 补 `bridge.test.ts` + `worker-entry.test.ts`（协议、崩溃恢复）。

**阶段 2 — 主进程接入（改行为）** 7. `decryption-service.ts`：`decodeClothDiyShareCode` / `decodeHomeBuildShareCode` 拆「本地提取(mutex) + 网络解码(桥, 8s 兜底)」；导出 `setDecryptionWorkerConfig({dllPath})`。8. `application.ts` / `app-context.ts` 实例化并注入桥；`cleanup.ts` 加 dispose；`recovery.ts` 注册崩溃监听。9. 迁移 `decryption-service.test.ts` 相关用例到 mock 桥，新增超时/兜底用例。

**阶段 3 — 验证与灰度** 10. 跑 `decryption-service.integration.test.ts` 并发用例，确认照片参数解密与网络解码解耦。11. 手动验证：被墙/慢网下解码分享码不再冻结主线程，且 `decodeFile` 仍可正常返回；超时后 UI 显示「网络数据获取失败」但时间戳/UID 仍展示。12. 评估是否抽出 `BaseUtilityProcessWorker`（优化项，不在本计划强制范围）。

---

## 6. 决策摘要（给评审）

- **方案**：网络解码下沉到专用 `utilityProcess` 子进程，复用 media/scanner worker 范式。
- **必保**：`decodeFileParams`/`encodeCameraParams` 等本地 C 调用留在主进程全局 mutex；核心照片解密零回归。
- **硬保证**：8s 超时在主进程侧 `Promise.race` 实现，超时即优雅兜底 + kill 冻结 worker + 自动重启。
- **契约不变**：IPC 返回结构、`decrypt-handler` 无需改动；仅需迁移现有单测的 mock 对象。
- **工作量**：5 新文件 + 6 修改点，模式成熟、风险可控。
