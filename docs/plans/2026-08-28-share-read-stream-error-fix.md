# 修复：WiFi 分享读流无 error 监听导致的静默失败与 fd 泄漏（H2）

- 日期：2026-08-28
- 类别：bug / 资源泄漏
- 影响面：`src/main/services/share-wifi-service.ts` 的 `/download` 与 `/thumb` 回包
- 关联文件：`src/main/services/share-wifi-service.ts`、`src/main/utils/managed-read-stream.ts`（新增）、`src/main/app/media-protocol.ts`
- 方案文档：`docs/plans/2026-08-28-share-read-stream-error-fix.md`

## 一、问题

原实现（`share-wifi-service.ts` `serveFile`）：

```ts
try {
  // …
  if (range) {
    if (start >= 0 && end < fileSize && start <= end) {
      res.writeHead(206, { … })
      fs.createReadStream(file.path, { start, end }).pipe(res) // ← 477
      return
    }
  }
  res.writeHead(200, { 'Content-Length': fileSize })
  fs.createReadStream(file.path).pipe(res) // ← 484
} catch (err) {
  res.writeHead(500, …)
  res.end(`读取文件失败: ${…}`)
}
```

`pipe()` 只是一个同步注册动作——它一返回，`try` 块就执行完毕。之后任何**异步阶段**的错误都
进不了这个 `catch`：

| 触发场景                               | 原实现表现                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| 文件被移走 / 被占用（Windows 文件锁）  | 读流抛 ENOENT/EACCES/EBUSY，无人监听                                          |
| 权限变更、磁盘 IO 错误                 | 同上                                                                          |
| `Readable.pipe()` 把源错误转发到 `res` | `ServerResponse` 无 `error` 监听 → 升级为未捕获异常或静默 reset（ECONNRESET） |
| 源流未显式 `destroy()`                 | fd 不保证归还，长时间分享 + 频繁失败逐步耗尽句柄                              |

用户可观察后果：手机上"下载到一半断掉"，服务端零日志（排障无从下手），Windows 上被读过的文件
在分享期间删不掉。

同项目 `media-protocol.ts` 的 `createManagedReadStream` 正是为此而写（error 监听 + abort 取消 +
显式 destroy），此处属漏用。

## 二、修复方案：抽公共工具 + 传输级兜底

```mermaid
flowchart TD
  A[serveFile] --> B[parseRange → range?]
  B --> C[createManagedReadStream: 流自带 error → destroy + logger.warn + onError]
  C --> D[writeHead 206/200]
  D --> E[res.on error → fail / res.on close → destroy 兜底]
  E --> F[stream.pipe(res)]
  F --> G{异步错误?}
  G -- 流报错 --> H[fail: destroy 流 → headersSent? destroy res : 500+文案]
  G -- 客户端断开 --> I[res close → destroy 流，归还 fd]
```

### 2.1 `src/main/utils/managed-read-stream.ts`（新增）

把 `media-protocol.ts` 的私有 `createManagedReadStream` 提升为公共工具，签名改为选项对象并新增
`onError` 回调：

```ts
export interface ByteRange {
  start: number
  end: number
}

export interface ManagedReadStreamOptions {
  signal?: AbortSignal // abort 时立即 destroy，流 close 后摘监听
  range?: ByteRange // 省略则读整个文件（内部传 {}，不传 { start: undefined }）
  onError?: (error: unknown) => void // 内部 destroy + logger.warn 之后回调
}
```

职责边界：**工具管资源与日志，调用方管响应语义**。这样调用方不必再挂第二个 `error` 监听
（否则会出现两条日志、顺序不可控）。

`media-protocol.ts` 删除本地实现与 `ByteRange`，改为 import；`parseRangeHeader` /
`RANGE_UNSATISFIABLE` / 416 逻辑一律不动。

### 2.2 `serveFile` 重写

```ts
let stream: fs.ReadStream | null = null
let settled = false

const fail = (err: unknown): void => {
  if (settled) return
  settled = true
  if (stream && !stream.destroyed) stream.destroy()   // 归还 fd
  if (res.writableEnded) return
  try {
    if (res.headersSent) res.destroy()                // 无法改状态码：断连优于截断的"成功"响应
    else { res.writeHead(500, …); res.end(t('main.share.http.readFailed')) }
  } catch { /* 响应已不可用，兜底逻辑自身不能再抛 */ }
  logger.error(t('main.share.log.readFailed', { path: file.path }), err)
}
```

关键点：

1. **单一失败出口**：`stream 'error'` / `res 'error'` / 同步 `catch` 共用；`pipe()` 会把同一个错误
   同时送到流和响应，`settled` 保证只落一次日志、只处理一次响应。
2. **先建流再 `writeHead`**：建流若同步抛错（Range 非法等），响应头仍未发出，可正常回 500。
3. **`res.on('close')` 兜底**：客户端中途取消（手机上点返回）时销毁读流，避免 fd 悬挂。
4. **响应语义**：未发头 → 500 + 本地化文案；已发头 → 断连，避免客户端拿到截断却标记为 200 的响应。
5. **顺带消除一处 i18n 违规**：`读取文件失败: ${…}` 硬编码改为 `t('main.share.http.readFailed')`。
6. **不升级 Range 语义**：越界 Range 仍回落 200 全量（播放器对 416 兼容性差异大），仅抽出
   `parseRange` 让判定集中且可测。

### 2.3 i18n

- 新增 `main.readStream.log.streamErrorDestroyed`（通用读流日志，去掉了原 `[Media Protocol]` 前缀）；
  原 `main.mediaProtocol.log.streamErrorDestroyed` 随之删除。
- 新增 `main.share.http.readFailed`、`main.share.log.readFailed`（含 `{{path}}`，不记 PIN/token）。
- 12 份 locale 通过 `npm run sync-i18n-keys` 对齐，`npm run i18n:check` 校验通过。

## 三、验证

| 项目                                                         | 结果                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `share-wifi-service.test.ts`（mock 流，7 例新增）            | 12 passed                                                                                         |
| `share-wifi-service.connection.test.ts`（真实 fs，2 例新增） | 6 passed                                                                                          |
| `media-protocol.test.ts`（抽取后回归）                       | 21 passed                                                                                         |
| 全量 `npx vitest run`                                        | 4091 tests / 4089 passed / 2 failed（既有环境性失败：path-safety 只读目录、GalleryStackOverflow） |
| `npx tsc -b`                                                 | 改动文件 0 错（剩余均为既有错误）                                                                 |
| ESLint + Prettier（改动文件）                                | 0 问题                                                                                            |

新增用例覆盖：200/206/越界 Range 回落、同步阶段失败回 500、异步流错误（`destroy` + `res.destroy` +
日志留痕 + 不抛未捕获异常）、`res close` 释放 fd、源流与响应双报错时 `fail` 只执行一次；
集成用例用真实 8MB 文件验证"客户端中途断开后源文件可删除"（Windows 未释放 fd 会 EBUSY）。

## 四、遗留与非目标

- Range 越界仍回落 200（未升级 416）；不合法 Range 头（如 `bytes=abc`）同样回落 200。
- PIN 明文写日志（审查报告 M8）未动，属独立议题。
- 未改动 `media-protocol.ts` 的白名单/416 逻辑。
