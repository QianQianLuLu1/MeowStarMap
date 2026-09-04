# 修复「档案管理-档案列表」虚拟 UID 根因实施计划

- 日期：2026-08-26
- 范围：设置 → 档案管理 → 档案列表 显示与实际检测路径不符的虚拟账号 UID
- 状态：已执行（代码修复 + 构建通过 + 单测用例就绪；本机 vitest 环境损坏，单测需正常环境运行）

## 1. 问题背景

档案列表（`character_profiles`）原本把扫描路径中任意 6–12 位数字目录段（时间戳、活动 ID、嵌套数字目录）误注册为账号档案，产生无媒体文件的「虚拟 UID」，导致列表显示与真实检测路径严重不符。

### 根因

- `scanDirectory` 对每张文件调用 `autoRegisterUid(extractUidFromPath(fullPath))`。
  `extractUidFromPath` 用宽松正则 `/[\\/](\d{6,12})[\\/]/`，会命中任意路径段中的数字（如 `ScreenShot\1700000000\a.jpg` 的时间戳），形成虚拟 UID。
- 而 `startScan` 已通过 `discoverUidsFromGameDirs` 注册**真实 UID**（仅识别 `GamePlayPhotos` 一级纯数字子目录 `^\d{6,12}$`，对齐上游 nikki_albums 的 `FindUid.find`）。两条注册路径并存，虚拟 UID 持续产生。

### 与既有「遮盖」修复的关系

2026-08-26 既有修复（profile-virtual-uid-fix.md）仅在 UI 层加「虚拟徽标 + 一键清理」，**未阻止新增**。本次从根因修复——扫描写入链路加 UID 合法性闸门，从源头停止新增虚拟档案。UI 存量清理能力保留。

## 2. 依赖声明

- **零新增依赖**：完全复用现有 `discoverUidsFromGameDirs`（`uid-discovery.ts`，对齐 nikki_albums 上游方案）、`extractUidFromPath`（`path-classifier.ts`）、`autoRegisterUid`（`worker-entry.ts`）。
- 闸门逻辑抽为纯函数 `gateAccountUid`，放入已有的 `path-classifier.ts`（纯函数、无 electron 依赖），不新增模块/文件类型。
- 测试依赖：Vitest 1.6.1（项目既有，未改）。

## 3. 技术实现

### 3.1 新增纯函数 `gateAccountUid`（`src/main/scanner/path-classifier.ts`）

```ts
export function gateAccountUid(rawUid: string, validUids?: Set<string> | null): string {
  if (!validUids) return rawUid // 向后兼容：未传集合时保留旧行为
  if (rawUid === 'default') return 'default' // 默认账号不注册
  return validUids.has(rawUid) ? rawUid : 'default' // 命中真实集合才采用，否则归 default
}
```

### 3.2 `scanDirectory` 增加可选参数（`src/main/scanner/worker-entry.ts`）

- 签名新增第 4 参数：`validUids?: Set<string> | null`（缺省 `undefined` 保留旧行为，保证既有调用方与测试向后兼容）。
- 图片分支与视频分支统一改为：
  ```ts
  const discoveredUid = gateAccountUid(extractUidFromPath(fullPath), validUids)
  if (discoveredUid !== 'default') autoRegisterUid(discoveredUid)
  ```
  `addFile` 的 `account_uid` 使用 `discoveredUid`（已为闸门后值）。

### 3.3 `startScan` 透传真实 UID 集合

- 两处 `scanDirectory(dir, options?.incremental)` 改为：
  `scanDirectory(dir, options?.incremental, true, new Set(discoveredUids))`
  - `discoveredUids` 复用已调用的 `discoverUidsFromGameDirs(scanRoots, workerLog)` 返回值，零新增 IO。
  - `applyFilters` 显式传 `true`（等同默认行为，扫描根目录保留缓存目录跳过/小图过滤）。

### 不改动项（约束）

- 不改动 `extractUidFromPath` 通用契约（解密降级、历史修复、57 处既有 characterization tests 依赖）。
- 不改动图库/媒体分类/无关功能。`profile-sections.tsx` 既有「虚拟徽标 + 一键清理」保留。
- `directScan`（导入向导）不传 `validUids`，保留旧行为（单目录按路径正则识别，符合原意）。

## 4. 启动说明（开发与验证）

```powershell
# 依赖（受限环境仅用 npm install 增量安装；勿用 npm ci / 删 node_modules）
npm install

# 类型检查（确认本次改动文件零类型错误；本机 tsc -b 有无关既有错误，聚焦 worker-entry/path-classifier/uid-gate）
npx tsc -b

# 构建（本机 npm run dist:win 的 clean 步触发 Safe-Delete 网关 EPERM，改用）
npx electron-vite build

# 单元测试（本机 vitest 环境损坏，需在正常环境运行）
npm run test:main
# 或单项
npx vitest run src/main/scanner/uid-gate.test.ts
```

## 5. 错误处理

- `gateAccountUid` 为纯函数，无副作用；`rawUid` 为空串时返回 `'default'`，不抛异常。
- `validUids` 为 `undefined`/`null`/空 `Set` 均安全：`undefined`/`null` 走旧行为，空 `Set` 使所有非 `default` 的 `rawUid` 归 `'default'`（不注册）。
- 注册失败沿用既有 `autoRegisterUid` 的 `workerLog('warn', ...)` 容错，不中断扫描。
- `discoverUidsFromGameDirs` 目录读取失败返回 `[]`，不影响主流程（既有行为）。

## 6. 参数校验

| 输入                      | 约束                                                    | 行为                                             |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `rawUid`                  | `string`（`extractUidFromPath` 返回值，或 `'default'`） | 空串→归 `'default'`                              |
| `validUids`               | `Set<string> \| null \| undefined`                      | `undefined`/`null`→旧行为；非空 Set→仅命中才采用 |
| `scanDirectory.validUids` | 缺省 `undefined`                                        | 未传时完全保留旧行为（向后兼容）                 |

## 7. 基础测试用例（`src/main/scanner/uid-gate.test.ts`）

- **向后兼容**：`validUids` 为 `undefined`/`null` 时原样返回 `rawUid`（含虚拟数字段）。
- **真实 UID**：`validUids` 含 `123456789` 时返回该 UID；真实路径 `GamePlayPhotos/123456789/...` 提取命中集合时采用。
- **虚拟拦截**：时间戳路径 `ScreenShot\1700000000\a.jpg` 提取的 `1700000000` 不在集合内 → 归 `'default'`。
- **默认账号**：`rawUid==='default'` 始终返回 `'default'`（不注册）。
- **边界/错误**：空 Set 下非 default 一律归 default；`rawUid` 空串不抛错返回 `'default'`。

### 验收标准（每段一次审查）

1. ESLint：`src/main/scanner/{worker-entry,path-classifier,uid-gate.test}.ts` 零 error ✅
2. `tsc -b`：本次引入的类型错误（含 `Set<string>` 参数位置、`gateAccountUid` 签名）已全部消除 ✅（剩余 `workerLog`↔`Logger` 不匹配为**修改前既有错误**，未触碰该调用）
3. `npx electron-vite build`：EXIT=0，主/渲染进程均 `✓ built` ✅
4. 单测：正常环境下 `npm run test:main` 全部通过（本机 vitest 损坏无法运行，用例已就绪）⏳

## 8. 子任务与验收（逐条推进）

| #   | 子任务                                                            | 修改文件                            | 输入→输出                     | 验收                     |
| --- | ----------------------------------------------------------------- | ----------------------------------- | ----------------------------- | ------------------------ |
| 1   | `scanDirectory` 加 `validUids` 参数 + 两处闸门改 `gateAccountUid` | worker-entry.ts, path-classifier.ts | 路径→经闸门后的 `account_uid` | ESLint 0 + tsc 无新增错  |
| 2   | `startScan` 两处传 `new Set(discoveredUids)`（第 4 参数）         | worker-entry.ts                     | `discoveredUids`→透传真实集合 | tsc 无 `Set<string>` 错  |
| 3   | tsc + ESLint 验证                                                 | —                                   | —                             | 零错误（既有无关错除外） |
| 4   | `npx electron-vite build`                                         | —                                   | —                             | EXIT=0 三进程 built      |
| 5   | 编写 `uid-gate.test.ts`                                           | uid-gate.test.ts                    | 纯函数入参→期望返回值         | 正常环境单测通过         |

## 9. 执行记录（2026-08-26）

- 完成 1–4：代码修复 + 提取 `gateAccountUid` + build 通过。
- 初次 `Set<string>` 参数位置错误（落在 `applyFilters` 第 3 位）已修正为第 4 参数（显式 `true`）。
- ESLint 三文件零错；`tsc -b` 本次引入错误已清零；`electron-vite build` EXIT=0。
- 完成 5：单测 `uid-gate.test.ts` 就绪，本机 vitest 损坏（setup.ts 第 3 行 TypeError）无法运行，正常环境执行命令见 §4。
- 存量虚拟档案清理仍由 `profile-sections.tsx` 既有「一键清理虚拟档案」能力负责（本次未删除该功能）。
