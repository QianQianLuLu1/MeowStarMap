# IPC 响应契约文档

## 1. 机制概述

### 1.1 双层 success 结构

项目 IPC 通信采用**双层 success 包装**，理解此结构是避免「扫描失败」类 bug 的关键。

```
主进程 handler 返回值
  ↓ wrapHandler 包装
IpcResponse<T> = { success: true, data: T } | { success: false, error: IpcError }
  ↓ ipcRenderer.invoke 传输
preload call<T>() 解包
  ↓ success=true → 返回 data（丢弃外层 success）
  ↓ success=false → 抛出 IpcError
前端拿到的值 = handler 的原始返回对象
```

### 1.2 关键约束

**前端拿到的值是 handler 的原始返回对象**，不包含外层 `IpcResponse.success`。

如果前端代码检查 `res.success`，则 handler 的返回值**必须包含 `success: true` 字段**。否则 `res.success` 为 `undefined`（falsy），前端会误判为失败。

### 1.3 preload `call()` 解包逻辑

```ts
// src/main/preload.ts
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (res && res.success) {
    return res.data  // ← 返回内层 data，外层 success 被丢弃
  }
  if (res && !res.success && res.error) {
    throw new IpcError(res.error.code, res.error.message, ...)
  }
  throw new IpcError('IPC_MALFORMED_RESPONSE', ...)
}
```

### 1.4 `wrapHandler` 包装逻辑

```ts
// src/main/ipc/validator.ts
wrapHandler(ctx, schema, handler) =>
  async (...args) => {
    try {
      const data = await handler(parsedArgs)  // handler 返回值
      return { success: true, data }          // 包装为 IpcResponse
    } catch (e) {
      return { success: false, error: ... }
    }
  }
```

## 2. 重复/相似检测域 IPC 契约

以下通道的返回值**必须包含 `success: true`**，因为前端 `DuplicatesPage.tsx` 会检查此字段。

### 2.1 `media:findDuplicates`

| 属性         | 值                                              |
| ------------ | ----------------------------------------------- |
| 通道         | `media:findDuplicates`                          |
| Handler 文件 | `src/main/ipc/handlers/duplicate-handler.ts`    |
| 参数         | 无                                              |
| 返回类型     | `ScanResult`（`src/shared/types/duplicate.ts`） |

**返回值结构**：

```ts
{
  success: true,           // ← 必须！前端检查此字段
  duplicates: DuplicateItem[][],  // 重复分组
  bestItemIds: (number | null)[], // 每组推荐保留的文件 id
  totalGroups: number,
  totalFiles: number,
  wastedBytes: number,
  scannedFiles: number,
  cancelled?: boolean      // 用户取消时为 true
}
```

### 2.2 `media:findSimilar`

| 属性         | 值                                         |
| ------------ | ------------------------------------------ |
| 通道         | `media:findSimilar`                        |
| Handler 文件 | `src/main/ipc/handlers/similar-handler.ts` |
| 参数         | `{ threshold?: number }`（默认 5）         |
| 返回类型     | `ScanResult`                               |

**返回值结构**：

```ts
{
  success: true,
  duplicates: DuplicateItem[][],
  bestItemIds: (number | null)[],
  totalGroups: number,
  totalFiles: number,
  wastedBytes: number,
  scannedFiles: number,
  threshold: number,       // 相似检测特有：实际使用的阈值
  hashedFiles: number,     // 相似检测特有：已计算 pHash 的文件数
  cancelled?: boolean
}
```

### 2.3 `media:generatePhash`

| 属性         | 值                                               |
| ------------ | ------------------------------------------------ |
| 通道         | `media:generatePhash`                            |
| Handler 文件 | `src/main/ipc/handlers/similar-handler.ts`       |
| 参数         | 无                                               |
| 返回类型     | `PhashResult`（`src/shared/types/duplicate.ts`） |

**返回值结构**：

```ts
{
  success: true,
  message: string,         // 'pHash 补算完成'
  processed: number,       // 本次处理的文件数
  total: number            // 总待处理文件数
}
```

### 2.4 `media:markDuplicates`

| 属性         | 值                                                        |
| ------------ | --------------------------------------------------------- |
| 通道         | `media:markDuplicates`                                    |
| Handler 文件 | `src/main/ipc/handlers/duplicate-handler.ts`              |
| 参数         | 无                                                        |
| 返回类型     | `MarkDuplicatesResult`（`src/shared/types/duplicate.ts`） |

**返回值结构**：

```ts
{
  success: true,
  message: string,           // '重复标记完成'
  markedDuplicates: number,  // 标记为重复的文件数
  totalGroups: number        // 重复分组数
}
```

### 2.5 `media:softDelete`

| 属性         | 值                                                 |
| ------------ | -------------------------------------------------- |
| 通道         | `media:softDelete`                                 |
| Handler 文件 | `src/main/ipc/handlers/media-lifecycle-handler.ts` |
| 参数         | `number[]`（媒体 id 数组）                         |
| 返回类型     | 内联类型                                           |

**返回值结构**：

```ts
{
  message: string // '已将 N 个文件移至回收站'
}
```

## 3. 共享类型定义

所有跨进程共享的类型定义在 `src/shared/types/duplicate.ts`，通过 `src/shared/types/index.ts` 统一导出。

| 类型                   | 用途                                | 消费方                                  |
| ---------------------- | ----------------------------------- | --------------------------------------- |
| `DuplicateItem`        | 重复/相似检测中的单条媒体项         | handler 返回 → preload → DuplicatesPage |
| `ScanResult`           | findDuplicates / findSimilar 返回值 | handler → preload → DuplicatesPage      |
| `PhashResult`          | generatePhash 返回值                | handler → preload → DuplicatesPage      |
| `MarkDuplicatesResult` | markDuplicates 返回值               | handler → preload → DuplicatesPage      |

## 4. 新增 Handler 检查清单

新增 IPC handler 时，逐项检查：

- [ ] handler 返回值是否需要 `success` 字段？（前端是否检查 `res.success`）
- [ ] 返回值类型是否提取到 `src/shared/types/` 下？
- [ ] preload 泛型标注是否使用了共享类型？
- [ ] 单元测试是否验证了内层 `data.success`？
- [ ] 是否有 `simulateCall` 集成测试验证 preload 解包后的值？
- [ ] 本文档是否已更新对应通道的契约？

## 5. 历史教训

**2026-07-31 「扫描失败」bug**：handler 返回值缺少 `success` 字段，导致前端 `res.success` 为 `undefined`（falsy），所有扫描操作均被误判为失败。根因是 IPC 双层 success 结构中，内层 data 的 `success` 字段与外层 IpcResponse 的 `success` 字段容易混淆，且测试仅验证了外层。
