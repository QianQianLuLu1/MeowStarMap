# 修复「重复文件」板块误判：同一物理文件（硬链接）被报成多份重复/相似（2026-10-27）

- 日期：2026-10-27
- 基线 HEAD：`cde9a49`
- 状态：已完成。§6 为逐节点红/绿实测读数，§8 为最终回归与真机验收读数
- 范围已与用户确认三项决策：① 只修硬链接导致的同一物理文件误报，不处理 HQ/LQ 低清分辨率变体；② 只在检测时去重，不改扫描器入库逻辑、不加 schema 列/迁移；③ 先跑诊断脚本用真实数据确认根因再动手

## 0. 背景（Context）

用户反馈「重复文件」板块存在误判：同一份文件（并未真正重复）被识别成多份重复或相似文件并重复显示。

## 1. 根因（本机真实数据库取证，非推测）

诊断对象：`C:\Users\45001\AppData\Roaming\meow-star-map\database\meow_star_map.db`（只读打开，`node:sqlite`）

| 指标                                           | 实测值                                     |
| ---------------------------------------------- | ------------------------------------------ |
| `media_files` 总行数 / `is_deleted=0`          | 212 / 212                                  |
| `is_missing=1` 幽灵行                          | 53（全部位于 `CloudPhotos\Temp`）          |
| 归一化路径重复行（大小写变体）                 | **0**                                      |
| 「精确重复」候选组（同 `file_size` 且组内 >1） | **29 组，29/29 全部是同一物理文件**        |
| 「相似」候选组（同 `pHash`，组内 >1）          | 27 组，其中 **26/27 组内含有同一物理文件** |

硬链接实证（`dev` + `ino` 完全相同，`nlink=2`）：

```
H:\...\X6Game\Saved\GamePlayPhotos\114077271\Videos\2026_06_18_21_18_02_1976000\...Mp4   dev=2686564740 ino=281474977187906
H:\...\X6Game\Video\2026_06_18_21_18_02_1976000.Mp4                                     dev=2686564740 ino=281474977187906
H:\...\GamePlayPhotos\114077271\NikkiPhotos_HighQuality\2026_06_16_21_17_41_299035.jpeg  (同 inode)
H:\...\X6Game\ScreenShot\2026_06_16_21_17_41_299035.jpeg                                (同 inode)
```

游戏/启动器用 Windows 硬链接把同一个物理文件暴露在 `GamePlayPhotos\<UID>\...` 与 `X6Game\Video\`、`X6Game\ScreenShot\` 两个目录下。扫描器把两条路径各写一条 `media_files` 记录（`file_path` 唯一键不同，拦截不到）。而两条检测链路都隐含假设「**一行 = 一个文件**」：

1. **精确重复** `src/main/ipc/handlers/duplicate-handler.ts:81-177`：`file_size` 分桶 → sha256 分组。同 inode 必然同 size、同 sha256 → 判成「2 份重复」，且 `wastedBytes` 虚报（删任一条都省不出空间）。
2. **相似** `src/main/media-worker/worker-entry.ts:986-1025` + `bktree-index.ts:87-100`：同 inode 必然同 `pHash`（汉明距离 0）→ 配成候选边。分组内的自排除只按行下标 / 媒体 id（`j === i`、`bId <= aId`），**跨记录识别不了「同一物理文件」**，于是 `indices.length >= 2` 的过滤条件反而被满足。
3. **重复标记** `worker-entry.ts:852-977`：同上，会把同一文件标成「自己重复自己」。

## 2. 修复思路

**按物理文件身份（`dev` + `ino`）在检测候选装载处去重**——同一物理文件只保留 `id` 最小的一行参与后续分组。这是唯一能同时覆盖「重复」「相似」「重复标记」三条链路的收敛点，且不需要改 schema、不需要改扫描器、不改变图库可见性。

失败兜底：`statSync` 抛错时返回 `null`，**该行保留**（fail-open，与仓库 `src/main/utils/AGENTS.md` 的既有策略一致），不吞错、不静默丢弃。

## 3. 依赖声明

**无新增 / 变更依赖。** 仅用 Node 内置 `fs.statSync`（`src/main/utils/file-utils.ts:12` 已用同一模块）。不引入任何第三方库，不改动 `package.json` 的 dependencies/devDependencies。

## 4. 启动说明（环境准备 / 启动命令 / 验证方式）

环境准备：仓库依赖已安装（`node_modules` 就绪），无需重建 native 模块。

```bash
npx vitest run src/main/utils/physical-file-key.test.ts        # 新工具单测
npx vitest run src/main/ipc/handlers/media.test.ts             # 精确重复 handler
npx vitest run src/main/media-worker                           # 相似 + 重复标记 worker
npm test                                                       # 全量单测
npm run typecheck                                              # tsc -b && tsc -p tsconfig.scripts.json
npm run lint                                                   # eslint .
npm run verify                                                 # typecheck + lint + core-path-gate + format + 相关单测
```

真机验收：`scripts/diagnose-duplicate-false-positive.ts`（新增，只读），直接 `import` 被测的 `dedupeByPhysicalFile`，喂入从本机真实库读出的 212 行候选，断言 29 组同 inode 重复全部消失并打印前后对比。

> 注：`better-sqlite3` 编译为 Electron ABI（NODE_MODULE_VERSION 145），纯 Node 22/26 下加载即崩，故诊断脚本改用 Node 内置 `node:sqlite`。

## 5. 参数校验与错误处理

### 5.1 参数校验（`src/main/utils/physical-file-key.ts`）

| 入参               | 校验                                                  | 处理                                                                                        |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `filePath`         | `typeof !== 'string'` 或 `=== ''`                     | 直接返回 `null`，不调用 `statSync`                                                          |
| `rows`             | 非数组或 `length < 2`                                 | 原样返回，不进入 Map 逻辑                                                                   |
| `stat`（可选注入） | 默认 `statPhysicalFile`；单测可注入桩，避免 mock `fs` | 编译期由泛型 `T extends { id: number; file_path: string }` 保证字段存在                     |
| 物理身份 `key`     | `isUsableKey`：`key !== null && key.ino !== 0`        | 不可辨 ⇒ 与 stat 失败同等处理（保留该行，不参与去重也不被去重）；`dev === 0` 不作不可用信号 |

### 5.2 错误处理与兜底

| 分支                                                               | 处理                                                                                                   | 输出                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `statSync` 抛错（ENOENT / EACCES / 路径为空 / 非字符串）           | 返回 `null`，**保留该行**                                                                              | 无日志（高频路径，避免刷屏） |
| 文件系统不提供文件索引号（FAT32/exFAT/重定向网络盘，`ino` 恒为 0） | 判为身份不可辨，**保留该行**（否则整卷并成 1 行 → `worker-entry.ts:878` 清空全部 `is_duplicate` 标记） | 无日志，同上                 |
| 候选行数 0 / 1                                                     | 原样返回                                                                                               | —                            |
| 去重后某组只剩 1 项                                                | 由既有 `g.length > 1` / `indices.length >= 2` 过滤掉                                                   | —                            |
| handler 侧                                                         | 去重后记一条 `logger.info`：`候选 N 行 → 去重后 M 行，剔除 K 个硬链接重复项`                           | 主进程日志                   |

## 6. 子任务（逐节点 红灯 → 绿灯）

### 节点 0：诊断脚本立基线

- 需修改文件：`scripts/diagnose-duplicate-false-positive.ts`（新增，只读）
- 输入：本机 `meow_star_map.db`（`node:sqlite` 只读打开）
- 输出：控制台打印「size 重复组数 / 其中同 inode 组数 / phash 组内同 inode 组数」
- 验收标准：退出码 0，且打印 `同 inode 重复组 = 29`、`phash 组内同 inode = 26`

### 节点 1：新增 `physical-file-key.ts` + 单测

- 需修改文件：`src/main/utils/physical-file-key.ts`（新增）、`src/main/utils/physical-file-key.test.ts`（新增）
- 输入 / 输出：`dedupeByPhysicalFile(rows, stat?) → rows`
- 基础测试用例（正常 / 异常 / 边界）：
  - 正常：两个不同 inode → 全部保留
  - 正常：两个同 inode（模拟硬链接）→ 只保留 `id` 较小的一行
  - 异常：stat 抛错 → 该行保留，其余正常去重
  - 边界：空数组 / 单元素 → 原样返回；`file_path` 为 `undefined` / `''` → 保留且不崩
  - 边界：3 行同 inode → 只留 `id` 最小的一行
- 验收标准：先跑**必须失败**（模块不存在）→ 实现后 `npx vitest run src/main/utils/physical-file-key.test.ts` 全绿

### 节点 2：精确重复链路接入

- 需修改文件：`src/main/ipc/handlers/duplicate-handler.ts`（受保护路径，顶部加 `// @core-change:`）、`src/main/ipc/handlers/media.test.ts`（追加用例）
- 输入：`getDuplicateCandidates()` 原始行；输出：去重后的候选行
- 验收标准：新用例修复前失败（`totalGroups === 1`）→ 修复后全绿；该文件既有 4 个 `media:findDuplicates` 用例仍全绿（它们用 `'/a'`、`'/b'` 假路径，stat 必失败 → fail-open 保留，行为不变）

### 节点 3：相似 / 重复标记链路接入

- 需修改文件：`src/main/media-worker/worker-entry.ts`（两处 SQL 加 `file_path` 列 + 装载处去重）、`src/main/media-worker/worker-entry.test.ts`（追加两条）
- 输入：SQL 原始行；输出：去重后参与 BK-tree / Union-Find 的行
- 验收标准：两条新用例修复前失败 → 修复后全绿；既有 FakeDb 匹配器 `sql.includes('is_favorite')` / `sql.includes('file_name')` 不受新增列影响（已核对：`file_path` 不与二者冲突）

### 节点 4：全量回归

- 验收标准：`npm test` / `npm run typecheck` / `npm run lint` / `npm run verify` 全部通过，且与修复前基线相比**无新增失败项**

### 节点 5：真机验收

- 验收标准：诊断脚本用修复后的 `dedupeByPhysicalFile` 处理真实 212 行候选后「29 个 size 重复组」→ **0 组**；且数据库本身未被修改（仍 212 行 / 29 组），证明是代码修复而非数据清理

### 节点 6：二轮审查补漏——退化 inode 身份 fail-open

- 缺陷：首版 `dedupeByPhysicalFile` 无条件采信 `s.ino`。FAT32/exFAT 卷（U 盘、SD 卡，游戏照片的常见落点）与部分重定向网络盘**不提供文件索引号**，同卷所有文件的 `ino` 恒为同一退化值 0；此时 `dev` 相同 + `ino` 相同 ⇒ 整卷被并成 1 行，`worker-entry.ts:878` 命中 `rows.length < 2` 分支**清空全部 `is_duplicate` 标记**，`media:findDuplicates` 报 0 组、相似检索空掉——即本修复在低风险文件系统上把功能反向打死，且与本模块自陈的「宁可少去重，不可误删候选」口径相悖。
- 涉及文件：`src/main/utils/physical-file-key.ts`（新增模块内私有 `isUsableKey`，`keys` 两处遍历的跳过判据统一走它）、`src/main/utils/physical-file-key.test.ts`（追加 1 例）、本文件。
- 输入 / 输出：判据 `key !== null && key.ino !== 0`；不可辨 ⇒ 与 stat 失败同等处理（该行保留、不参与去重也不被去重）。返回类型与顺序语义不变，`statPhysicalFile` 保持原始读值（真实 fs 侧的过滤点收在唯一消费处 `dedupeByPhysicalFile`，注入桩因此可测）。
- 验收标准：新增用例在修复前**必须红**（当前实现把 2 行并成 1 行）、修复后绿；`npx vitest run src/main/utils/physical-file-key.test.ts` 12 例全过；消费侧集成用例 `media.test.ts` / `worker-entry.test.ts` 共 135 例不得转红（NTFS 与 CI 的 ext4/overlayfs 上 `ino` 均非 0）；真库诊断仍为「212 → 183，剔除 29 行」并「验收通过」，证明守卫没有把 NTFS 上的真实硬链接去重一并放行。

## 7. 实测读数（已执行）

### 8.1 逐节点红 → 绿

| 节点                  | 红灯读数                                                                                | 绿灯读数                           |
| --------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| 1 `physical-file-key` | `Cannot find module './physical-file-key'`（1 suite failed）                            | `11 passed`                        |
| 2 精确重复            | `expected 1 to be +0`（totalGroups=1）                                                  | `media.test.ts 91 passed`          |
| 3 相似 / 重复标记     | DUPLICATE_MARK `markedDuplicates: 1, totalGroups: 1`；SIMILAR_FIND `expected 2 to be 1` | `worker-entry.test.ts 44 passed`   |
| 6 退化 inode 兜底     | `Tests 1 failed \| 11 passed (12)`，diff 显示两行被并成 `[{id:1},{…缺失}]`（退出码 1）  | `Tests 12 passed (12)`（退出码 0） |

> 节点 2 的断言在转绿过程中按实际行为修正过一次：去重后 size 桶不足 2 项会直接跳过 sha256，
> 故断言由 `calculateFileHashMock` 被调用 **1 次** 改为 **不被调用**——这是对「去重发生在哈希之前」更强的证明。
> 节点 3 同理：去重后不足 2 行会短路，BK-tree 检索根本不启动，故断言改为 `searchCalled === false`。

### 8.2 全量回归（对照基线）

|            | 测试文件              | 用例                                    |
| ---------- | --------------------- | --------------------------------------- |
| 修复前基线 | 448 passed / 1 failed | 7005 passed / 1 failed / 12 skipped     |
| 修复后     | 449 passed / 1 failed | **7019 passed** / 1 failed / 12 skipped |

新增 14 个用例全部通过，无新增失败项。唯一失败项 `src/main/nikkisync/probe.test.ts:176`
（`expect(node主版本).toBeGreaterThanOrEqual(24)`，本机 Node 22）为**修复前即存在的环境断言失败**，与本次改动无关。

静态检查：`npm run typecheck` ✓、`npm run lint`（改动文件）✓、
`npm run verify` ✓（typecheck / lint / **core-gate** / format / test 五项全过，说明 `duplicate-handler.ts`
的 `@core-change` 授权注释合规）。

> `npm run verify` 有一条既有非阻断告警：`src/main/ipc/handlers/duplicate-handler.ts` 未命中
> `<base>.test.ts`（其用例历史性地寄生在 `media.test.ts` 内）。属既有状态，未在本次顺手改动。

### 8.3 真机验收（`scripts/diagnose-duplicate-false-positive.ts`，真实库 212 行）

```
[DIAG] 候选行(未软删): 212 / 全表 212，其中 is_missing=1: 53
[DIAG] 精确重复候选组(同 size 且组内>1): 29
[DIAG]   其中同一物理文件(硬链接)导致的误报组: 29
[DIAG] 相似候选组(同 phash 且组内>1): 27
[DIAG]   其中含同一物理文件(硬链接)的组: 23
[DIAG] 去重后候选行: 183（剔除 29 行）
[DIAG] 去重后精确重复组: 0          ← 29 → 0
[DIAG] 去重后相似组: 19             ← 27 → 19
[DIAG]   其中含同一物理文件(硬链接)的组: 0   ← 23 → 0
[DIAG] 验收通过：硬链接误报组已全部消除
```

数据库本身未被修改（仍 212 行 / 29 组同 size 对），证明是代码修复而非数据清理。
相似模式剩余的 19 组为 HQ/LQ 分辨率变体（`_Low.jpeg` / `NikkiPhotos_LowQuality`），按决策不处理。

### 8.4 节点 6 转绿后的复验读数（2026-10-27 二轮）

- `npx vitest run src/main/utils/physical-file-key.test.ts` → `12 passed`
- `npx vitest run src/main/ipc/handlers/media.test.ts src/main/media-worker/worker-entry.test.ts` → 2 files / `135 passed`（守卫未影响 NTFS 上的真实硬链接判定）
- `npx tsx scripts/diagnose-duplicate-false-positive.ts` → `去重后候选行: 183（剔除 29 行）`、`验收通过`、退出码 0（与节点 5 读数逐项相同）
- `npm run verify` → `总计: 5 项, 0 失败`（typecheck / lint / core-gate / format / test）

## 8. 改动文件清单

| 文件                                           | 改动                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/main/utils/physical-file-key.ts`          | 新增。`statPhysicalFile()` + `dedupeByPhysicalFile()`；二轮补 `isUsableKey()`（`ino === 0` 判为身份不可辨） |
| `src/main/utils/physical-file-key.test.ts`     | 新增。12 个用例（正常/异常/边界，含退化 inode 一例）                                                        |
| `src/main/ipc/handlers/duplicate-handler.ts`   | 候选装载处去重 + `@core-change` 授权注释 + `logger.info`                                                    |
| `src/main/ipc/handlers/media.test.ts`          | 追加硬链接用例 1 条                                                                                         |
| `src/main/media-worker/worker-entry.ts`        | 相似与重复标记两处 SQL 加 `file_path` 并去重                                                                |
| `src/main/media-worker/worker-entry.test.ts`   | 追加硬链接用例 2 条                                                                                         |
| `scripts/diagnose-duplicate-false-positive.ts` | 新增。只读诊断/验收脚本                                                                                     |

## 9. 明确不做（已与用户确认，避免超范围）

- 不改扫描器入库逻辑（会改变图库可见性）
- 不加 `dev` / `ino` 列与迁移
- 不排除 HQ/LQ 低清分辨率变体（`_Low.jpeg` / `NikkiPhotos_LowQuality`，pHash 相同但确为两份真实文件，且低清版被复用为缩略图）
- 不处理 `is_missing=1` 幽灵行、不清理存量重复行
- 不把 `duplicate-handler.ts:41` 的全表 `statSync` 收敛到「同 size 子集」：改判据需动 `dedupeByPhysicalFile` 签名，本机真实库 212 行实测无感，收益不可证
- 不改 `${dev}:${ino}` 的字符串键为 BigInt：`ino > 2^53` 才可能精度碰撞，NTFS 的 MFT 记录号远达不到该量级
