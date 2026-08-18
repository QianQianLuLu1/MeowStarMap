# 修复扫描器在单目录扫描时误跳过用户文件的计划

> **本文件仅是计划文档，不含代码改动。** 实施时按"需要修改的具体代码位置"逐处编辑。

## 1. 问题描述

`src/main/scanner/worker-entry.ts` 的 `scanDirectory` 函数内置两道过滤，用于在全盘扫描时避免把游戏缓存缩略图当作正式照片入库：

1. **缓存目录跳过**（约第 966 行）：遇到名为 `cache` / `temp` / `tmp` / `thumbnail` / `thumbnails` / `preview` / `previews` / `.thumbs` / `thumb` 的子目录直接 `continue`，不递归。
2. **小图片过滤**（约第 972-975 行）：非视频且 `stats.size < 5 * 1024`（5KB）的图片直接 `continue`。

这两道过滤对**全盘扫描**是合理的——游戏目录下确实存在大量缓存缩略图（通常 < 5KB，且位于 `Temp` / `Thumbnail` 子目录），不过滤会导致缓存图被误入库。

但对**单目录扫描**（用户通过导入向导 `scanRoot → startScan({ path, incremental: true })` 显式指定一个目录导入）而言，这两道过滤会误伤用户文件：

- 用户导入的目录里若恰好有名为 `preview` / `thumbnail` 的子文件夹（例如用户自己整理的"预览图"目录），整个子树会被静默跳过。
- 用户导入的小于 5KB 的图片（例如头像、小拼图、低分辨率截图）会被静默跳过。

两种扫描场景的调用链（`startScan`，第 1284 行起）：

| 场景                       | 触发条件                            | 调用 `scanDirectory` 的位置 | 当前是否过滤                 |
| -------------------------- | ----------------------------------- | --------------------------- | ---------------------------- |
| 全盘扫描                   | `options.fullScan && !options.path` | 第 1337 行                  | 过滤（合理）                 |
| 自动发现游戏目录           | `!options.path`（且非 fullScan）    | 第 1372 行                  | 过滤（合理，游戏目录含缓存） |
| **单目录扫描（导入向导）** | `options.path` 存在                 | **第 1396 行**              | **过滤（误伤用户文件）**     |

关键事实：第 1396 行只有在 `options.path` 存在时才会被执行（见下方"调用链追踪"）。因此只要在该调用点禁用过滤，即可精准修复导入向导场景，不影响其余两种扫描。

## 2. 修复方案

**最小改动方案：给 `scanDirectory` 增加一个布尔参数 `applyFilters`（默认 `true`，保持现有行为），仅在单目录扫描调用点传 `false`。**

### 方案选型说明

- **区分场景的判据**：用 `options.path` 是否存在，而不是 `options.fullScan`。
  - 原因：自动发现游戏目录的场景（第 1372 行）`fullScan` 为 falsy 且 `path` 为空，但它扫描的是游戏目录，**仍需过滤缓存**。若用 `!options.fullScan` 作为禁用判据，会把自动发现场景也卷入，错误地关掉过滤。
  - 而 `options.path` 仅在单目录扫描时存在，恰好对应唯一的误伤场景。
- **传递方式**：在 `startScan` 内部判断后通过新参数传给 `scanDirectory`，而非把整个 `options` 传进 `scanDirectory`。保持 `scanDirectory` 接口简单、不依赖 `ScanOptions` 结构。
- **默认值**：`applyFilters = true`。这样第 1337、1372 行的两个调用点**无需任何改动**即维持原行为，改动面最小。

### 调用链追踪（确认第 1396 行 = 单目录扫描）

```
startScan(dbPath, options)
  ├─ 1355: let targetPath = options?.path
  ├─ 1357: if (!targetPath) {              // path 为空 → 自动发现分支
  │           ...findMediaDirectories...
  │           if (gameDirs.length > 0) return ...   // 找到则提前 return（1372 行的扫描在此分支内）
  │           targetPath = null                      // 没找到 → 置空
  │        }
  ├─ 1390: if (!targetPath) return 失败     // 仍未拿到 path → 报错返回
  └─ 1396: scanDirectory(targetPath, ...)   // 仅当 options.path 原本就存在时才到达此处
```

结论：第 1396 行的 `targetPath` 必然来自 `options.path`，在此处传 `false` 安全且精准。

## 3. 需要修改的具体代码位置

文件：`src/main/scanner/worker-entry.ts`

---

### 改动点 A：`scanDirectory` 函数签名（第 886-889 行）

新增第三参数 `applyFilters = true`。

**修改前：**

```ts
async function scanDirectory(
  rootPath: string,
  incremental?: boolean
): Promise<{ files: MediaFile[]; savedCount: number }> {
```

**修改后：**

```ts
async function scanDirectory(
  rootPath: string,
  incremental?: boolean,
  // 单目录扫描（导入向导）传 false 可禁用缓存目录跳过与小图片过滤，避免用户文件被误跳过
  applyFilters = true
): Promise<{ files: MediaFile[]; savedCount: number }> {
```

---

### 改动点 B：缓存目录跳过（第 966 行）

用 `applyFilters &&` 短路守卫。

**修改前：**

```ts
// P0修复：跳过缓存子目录（Cache/Temp/Thumbnail/Preview 等），避免缓存图片入库
if (CACHE_DIR_NAMES.has(entry.name.toLowerCase())) continue
```

**修改后：**

```ts
// P0修复：跳过缓存子目录（Cache/Temp/Thumbnail/Preview 等），避免缓存图片入库
// 单目录扫描（applyFilters=false）时不跳过，保留用户自命名的同名子目录
if (applyFilters && CACHE_DIR_NAMES.has(entry.name.toLowerCase())) continue
```

---

### 改动点 C：小图片过滤（第 972-975 行）

用 `applyFilters &&` 短路守卫。

**修改前：**

```ts
// P0修复：过滤过小的图片文件（缓存缩略图通常 < 5KB，游戏照片通常 > 200KB）
if (!VIDEO_EXTENSIONS.has(ext) && stats.size < 5 * 1024) {
  continue
}
```

**修改后：**

```ts
// P0修复：过滤过小的图片文件（缓存缩略图通常 < 5KB，游戏照片通常 > 200KB）
// 单目录扫描（applyFilters=false）时不过滤，保留用户导入的小图片
if (applyFilters && !VIDEO_EXTENSIONS.has(ext) && stats.size < 5 * 1024) {
  continue
}
```

---

### 改动点 D：单目录扫描调用点（第 1396 行）

传入 `false` 关闭两道过滤。

**修改前：**

```ts
const { files, savedCount } = await scanDirectory(targetPath, options?.incremental)
```

**修改后：**

```ts
// 单目录扫描（导入向导）：禁用缓存目录跳过与小图片过滤，避免用户导入的文件被误跳过
const { files, savedCount } = await scanDirectory(targetPath, options?.incremental, false)
```

---

### 不需要改动的地方

- 第 1337 行（全盘扫描调用）：不传第三参 → `applyFilters` 取默认 `true` → 行为不变。
- 第 1372 行（自动发现游戏目录调用）：同上，行为不变。
- `CACHE_DIR_NAMES` 常量定义（第 110-120 行）：不动。
- `ScanOptions` 接口（`worker-protocol.ts` 第 13-21 行）：不动，已有 `path` 字段足够。
- `SYSTEM_DIRS_TO_SKIP`（第 123 行起）：仅用于全盘搜索 `findMediaDirectories`，与单目录扫描无关，不动。

## 4. 验证步骤

### 4.1 类型检查

```bash
npm run typecheck
```

预期：`tsc -b` 无错误退出。（新增的 `applyFilters` 参数有默认值，三个调用点类型均兼容。）

### 4.2 手动测试：单目录扫描（导入向导）

准备一个测试目录，例如 `D:\__scan_test\`，结构如下（刻意包含被过滤名与小图片）：

```
D:\__scan_test\
├─ preview\                 ← 原本会被 CACHE_DIR_NAMES 跳过
│  └─ p1.png                ← 普通尺寸图
├─ thumbnail\               ← 原本会被跳过
│  └─ t1.jpg
├─ small.png                ← 3KB，原本会被小图片过滤跳过
└─ normal.jpg               ← 普通尺寸图，对照组
```

步骤：

1. 启动应用，进入导入向导，选择 `D:\__scan_test\` 作为扫描根目录。
2. 触发 `scanRoot({ path: 'D:\\__scan_test', incremental: true })`。
3. 预期结果：`preview/p1.png`、`thumbnail/t1.jpg`、`small.png`、`normal.jpg` **全部**出现在相册中。
4. 修复前对照：同样目录，`preview\` 与 `thumbnail\` 整个子树消失，`small.png` 消失。

### 4.3 手动测试：全盘扫描回归

1. 触发全盘扫描（`fullScan: true`，不传 `path`）。
2. 预期结果：游戏目录下的 `Temp` / `Thumbnail` 缓存子目录、< 5KB 的缩略图**仍被跳过**，行为与修复前一致。
3. 重点观察：扫描结果中不应突然多出大量 < 5KB 的缓存缩略图。

### 4.4 手动测试：自动发现游戏目录回归

1. 不传 `path`、不传 `fullScan`，触发默认扫描（走第 1372 行）。
2. 预期结果：缓存目录与小图片仍被过滤，与修复前一致。

## 5. 风险评估

| 维度                     | 评估                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **全盘扫描行为**         | 不受影响。第 1337 行调用未传新参，`applyFilters` 默认 `true`，两道过滤照常生效。                                                                                      |
| **自动发现游戏目录行为** | 不受影响。第 1372 行调用未传新参，同上。                                                                                                                              |
| **单目录扫描副作用**     | 用户导入的目录下若有真正的缓存子目录（如游戏 `Temp`），本次会一并入库。但单目录扫描由用户**显式指定**，用户对自己选择的目录内容负责，入库比漏库更符合导入向导的预期。 |
| **数据库体积**           | 单目录扫描若指向含大量小图的目录，索引条目会增多。属用户主动行为，可接受。                                                                                            |
| **类型兼容**             | `applyFilters` 有默认值，现有两个调用点无需改动，TS 编译通过。                                                                                                        |
| **回归面**               | 改动仅 4 处（1 签名 + 2 守卫 + 1 调用点），全部集中在 `scanDirectory` 与 `startScan`，无外部接口变化。                                                                |
| **并发/资源**            | 不引入新 I/O，不改批量写入逻辑，不影响 `flushBatch` / `pendingVideos`。                                                                                               |

**结论**：最小改动方案风险可控，影响面被严格限制在单目录扫描路径，全盘扫描与自动发现扫描的既有行为完全保留。
