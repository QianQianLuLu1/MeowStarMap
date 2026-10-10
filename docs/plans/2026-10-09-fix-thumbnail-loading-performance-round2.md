# 缩略图加载缓慢 — 第二轮定位与修复实施计划

> 状态：已确认，执行中（2026-10-09 用户批准）。执行证据逐节点回写到本文末尾「实施记录」。
> 本轮不是泛泛优化，而是打一条**已被本机数据证实的恶性循环**，它正是「缩略图每次启动/切板块都要重新等一遍」的机制性根因。

## 一、Context：问题与取证结论

### 1.1 上一轮已做（`docs/plans/2026-10-09-fix-thumbnail-loading-performance.md`）

> 更正（执行期）：该轮改动**尚未提交**，仍在工作区（H1/H2/H4 涉及的
> `useOnDemandThumbnails.ts`、`VirtualImageGrid.tsx`、`thumbnail-src.ts` 等 25 个渲染层文件与
> electron 41 + vitest 5 升级同批未入库）。本文原写「已合入」不准确，提交时需按关注点拆分。

H1（不再把原图当缩略图解码）、H2（缩略图回写后仅定向失效 `media://` 缓存）、H4（首个可视范围不再等 300ms 防抖）已修复；H3/H5/H6 当时按证据决定不做。

### 1.2 本轮实测证据（全部为本机真实数据，非推断）

| 证据                      | 实测值                                                                          | 取法                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 图片行缩略图列为 NULL     | **62 / 153**（40%）                                                             | `node --experimental-sqlite` 只读打开 `C:/Users/45001/AppData/Roaming/wxnn-photo-manager/database/wxnn_photo_manager.db` |
| 按需生成回写数据库失败    | **138 条**，2026-09-30 ~ 10-09 每天 3~14 次，错误体打印为 `{}`                  | `grep -h "回写数据库失败" logs/*.log`                                                                                    |
| 缩略图缓存文件数          | 1384 个 / 11.0 MB（远大于 165 行应有量，说明长期重复生成）                      | `du -sh` + `ls \| wc -l`                                                                                                 |
| worker 握手/超时/崩溃告警 | **0 条**（`handshakeFailed`/`workerCallFailed`/30s 超时全为 0）                 | `grep -rh` 同上                                                                                                          |
| `thumbnail` 列约束        | 普通索引 `idx_media_files_thumbnail`，**非 UNIQUE**（已排除唯一约束导致写失败） | 只读 `sqlite_master` + 库内已存在 6 组重复 thumbnail 值                                                                  |
| 首张图等待的全目录扫描    | 1384 文件串行 stat = **29.6ms**（16 并发 7.5ms）                                | 缓存目录上跑的 node 微基准                                                                                               |

### 1.3 恶性循环（本轮主修目标）

```
渲染层可视区按需生成 thumbnail:generate
  → 生成成功，但 repo.setThumbnailIfNull() 抛错（138 次，原因被 logger.warn 打成 {}）
  → media_files.thumbnail 恒为 NULL
  → 启动修复任务 startup-tasks.ts:584-593 的 rowsToRepair 只覆盖
      「缺尺寸 / 悬空缩略图 / thumbnail 为 NULL 的视频」
      ⇒ thumbnail 为 NULL 但尺寸齐全的图片行被跳过（= 已登记的 DEBT-026 缺口）
  → 启动孤儿清理 startup-tasks.ts:649 cleanupOrphanThumbnails()
      删除所有不在 media_files.thumbnail 引用集内的 ${hash}.jpg
  → 下个会话：无缓存命中 ⇒ 重读 1MB 算 hash + 全解码原图 + 回写再次失败 ⇒ 无限循环
```

后果与用户症状一一对应：每次启动都要重等一遍；DB 里 `thumbnail` 恒 NULL 的板块（重复文件、回收站、套装封面、分类）每次进入都只能显示占位，直到该板块自己触发按需生成。

### 1.4 次要瓶颈（本轮做，但排在循环之后）

- **渲染层通知风暴**：`useOnDemandThumbnails.ts:34-37` 每个结果一次 `setRevision`，而 `VirtualImageGrid.tsx:200` 只在网格级调用一次该 Hook，`itemContent`（`:453-454`）读 `getGeneratedPath/hasFailed` ⇒ **每张缩略图解析完成 = 整个 VirtuosoGrid 重渲染**。62~800 张待生成 = 同量级整网格渲染。另外 `:45-49` 去重命中时仍每次新挂一个 `.then`，监听器随滚动累积。
- **绘制风暴**：`globals.css:1412-1431` 的 `.skeleton` 动画是 `background-position` 位移（非合成属性 ⇒ 每个骨架卡每帧重绘），冷启动时满屏骨架；`.media-card { transition: all }`（`:1239-1245`）在每次整网格重渲染时重新登记过渡。

## 二、依赖声明

- **零新增依赖**，不改 `package.json` / `package-lock.json`。当前锁定版本（本机实测）：`electron 41.10.6`、`sharp ^0.35.5`、`vitest ^5.0.3`、`vite ^6.4.4`、`react ^19.2.7`、`react-virtuoso ^4.18.11`、`masonic ^4.1.0`；`engines.node >= 22.12.0`。
- 复用仓库既有能力，不造轮子：
  - `src/main/utils/concurrency.ts` — `runWithConcurrency` / `createConcurrencyLimiter`
  - `src/main/utils/worker-restart-policy.ts` — `WorkerRestartPolicy`（已确认 API：`canRestart()` / `scheduleRestart(fn)` / `getRestartCount()` / `dispose()`）
  - `src/main/services/thumbnail-phash-service.ts` — `processThumbnailForRow(ctx, row, updateStmt)`
  - `src/main/thumbnail/generator.ts` — `getFileHash()` / `ensureCacheDir()`（私有，新公共方法内部复用）
  - 渲染层 `ThumbReveal`、`MediaThumbPlaceholder`、`useFailedImages`（签名不变）
  - 测试桩 `tests/mocks/parent-port.ts`、`worker-bridge.test.ts` 的 fake timers 模式、`VirtualImageGrid.thumb.test.tsx` 的「读源码文本断言」先例
- 依赖缺失时只允许 `npm install` 增量安装，禁止 `npm ci`。
- 无新增 IPC 通道、无通道签名变化 ⇒ **`docs/IPC_CONTRACT.md` 本轮无需修改**（N2 若因证据需要新通道，先回来补充本节再继续）。

## 三、启动与验证说明（环境准备 / 命令）

```bash
node --version && npm --version          # 需 Node >= 22.12
npm run doctor                            # 5 项环境自检（原生模块/DLL/DB）
npm run dev                               # 开发态启动（会写真实 userData，本轮仅用于人工核对，不作为门禁）

# 单节点测试
npx vitest run src/main/thumbnail/generator.rebind.test.ts
npx vitest run src/main/app/__tests__/startup-tasks.rebind.test.ts
npx vitest run src/renderer/hooks/useOnDemandThumbnails.test.tsx
npx vitest run src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx
npx vitest run src/renderer/styles/globals.test.ts
npm run test:main && npm run test:renderer

# 增量 / 全量门禁（均为仓库真实存在的脚本）
npm run verify                            # typecheck + eslint 只读 + core-gate + prettier --check + 相关单测
npm test && npm run lint && npm run typecheck && npm run i18n:guard
npm run test:coverage                     # 全局阈值 69/80/68/69

# 打包态真实测量（e2e 用临时 userData，不碰真实库）
npm run dist:win && npm run verify:dist
PERF_DATASET_IMAGES=1500 npm run e2e:perf     # 改前基线
PERF_DATASET_IMAGES=5000 npm run e2e:perf     # 放大到万级边缘，观察 O(N) 项是否致命
npm run e2e:smoke
npm run perf:save-baseline                    # 仅在新指标稳定后固化
```

功能验证方式（人眼可判定的客观口径）：进入图库 → 观察骨架卡数量随时间下降 → 记下首张 `img[src^="media://"]` 的 `load` 时刻；**重启应用再进同一板块，该时刻必须显著小于改前（目标是接近 0，因为不再重生成）**；`SELECT COUNT(*) FROM media_files WHERE thumbnail IS NULL AND file_type='image'` 在两次重启后必须单调不增。

## 四、错误处理机制（异常分支 / 兜底降级 / 日志规范）

- **回写失败不得静默**：`thumbnail-handler.ts` 的 catch 改为输出可判定文本（`error instanceof AppError ? \`${error.code}: ${error.message}\` : error instanceof Error ? \`${error.name}: ${error.message}: ${String((error as {cause?: unknown).cause ?? '')}\` : String(error)`），并 `logger.warn` 保留「不影响本次返回」语义。日志规范：主进程日志可含技术上下文，**禁止**含 token/敏感目录全路径之外的敏感数据；`details` 不进 IPC。
- **启动重绑定（N3）容错**：单行失败仅 `logger.warn`，不得中断整个启动任务；缓存文件不存在时**不触发生成**（重绑定只做「已有缓存 → 写回引用」，绝不制造启动期解码风暴）；源文件缺失/不可挂载行跳过；`runWithConcurrency` 限并发为 `THUMBNAIL_CONCURRENCY`。
- **孤儿清理安全边界不变**：仍豁免 `CACHE_METADATA_FILENAME` 与 `_low/_high` 变体归并规则；`media_files.thumbnail` 引用集仍是唯一放行依据（语义不放宽）。
- **渲染层合并（N4）正确性**：先同步写结果 Map，再排队一次帧级 bump；卸载时必须取消未执行的回调，禁止 setState-after-unmount；去重命中且结果已 settled 时**必须幂等回填**（否则卡片会永久卡在骨架）。`ensureThumbnail` / `getGeneratedPath` / `hasFailed` 三个签名与语义不变 ⇒ 7 个消费方零改动。
- **worker 链路保留既有保护**：`REQUEST_TIMEOUT_MS=30_000`、`READY_TIMEOUT_MS=10_000`、`failReadyHandshake` 必 reject、崩溃不无脑自动重启、损坏文件标记、视频 0/1/3s 白帧自愈、内联 sharp 降级、`_low/_high` 命名契约 —— 全部不得弱化。
- 降级链兜底：任何新埋点/测量失败只记日志，不参与功能判定。

## 五、参数校验规则（入参类型 / 必填 / 边界 / 非法值）

- `resolveExistingThumbnail(filePath: string): Promise<string | null>`（generator.ts 新增公共方法）：`filePath` 必须为非空字符串，否则直接返回 `null`；内部 `path.resolve` 后校验源文件存在（不存在返回 `null`）；仅做 `hash → 缓存文件存在性` 判定，**无生成副作用**。
- 启动重绑定行筛选：`file_type === 'image'` 且 `thumbnail IS NULL` 且 `width/height 均非 null`（避免与既有 `needsDimensions` 分支重复处理）；单次处理行数上限 `MAX_REBIND_ROWS = 2000`（超出则本轮只绑定前 2000 条并 `logger.info` 提示，防止极端库把启动拖长）。
- `thumbnail:generate` 参数校验保持 `z.tuple([schemas.filePath, schemas.thumbnailQuality])` + `assertFileReadPath` 不变。
- 渲染层帧合并回调：`requestAnimationFrame` 缺失（jsdom/异常环境）时回退 `setTimeout(16ms)`；被合并的 key 必须是 `string`；空字符串路径直接短路返回 `null`，不发 IPC（与现有 `:43` 行为一致）。
- CSS 契约测试读文件失败 → 测试直接失败并报路径，不做静默跳过。
- e2e 新场景入参：`PERF_DATASET_IMAGES` 必须是有限正整数，非法值回退 1500；阈值对象沿用现有 `{ scenario, metrics:{durationMs}, threshold:{maxMs} }` 结构。

## 六、基础测试用例设计（正常 / 异常 / 边界三档）

| 编号 | 场景                                                                                | 类型 | 文件                                                                                                       | 断言                                                                                                      | 改前必须为红               |
| ---- | ----------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- |
| T1   | 回写失败日志携带真实错误码与消息                                                    | 异常 | `src/main/ipc/handlers/__tests__/thumbnail-handler.test.ts`（扩展现有）                                    | `logger.warn` 第二参/文本包含 `DATABASE_ERROR` 或注入错误的 `message`，而非 `[object] {}`                 | ✅                         |
| T2   | 缓存已存在 + 图片行 thumbnail=NULL ⇒ 绑定引用                                       | 正常 | `src/main/app/__tests__/startup-tasks.rebind.test.ts`（新）                                                | 写回语句以该缓存路径命中该行；`thumbnailGen.generate` **未被调用**（不产生解码）                          | ✅                         |
| T3   | 缓存不存在 ⇒ 不生成、不解码                                                         | 边界 | 同上                                                                                                       | `resolveExistingThumbnail` 返回 null 时零生成调用、零写库                                                 | ✅（现逻辑根本不选这类行） |
| T4   | 缺尺寸行仍走原 `processThumbnailForRow` 分支                                        | 兼容 | 同上                                                                                                       | 原三类筛选行为不变，现有 `startup-tasks` 相关测试全绿                                                     | 现应绿（守卫用例）         |
| T5   | 视频白帧自愈 / 悬空缩略图重建不回归                                                 | 兼容 | 现有 `startup-tasks` 用例                                                                                  | 全量通过                                                                                                  | 现应绿                     |
| T6   | 50 个并发按需结果只触发 ≤2 次整网格渲染                                             | 正常 | `src/renderer/hooks/useOnDemandThumbnails.test.tsx`（扩展）                                                | 渲染计数组件 + `vi.useFakeTimers()`，`advanceTimersByTime(16)` 后 renderCount ≤ 2                         | ✅                         |
| T7   | 同一路径 20 次 `ensureThumbnail` ⇒ 只挂 1 个通知监听                                | 边界 | 同上                                                                                                       | 以 spy 计数 `.then` 注册或 bump 次数                                                                      | ✅                         |
| T8   | 去重命中且结果已 settled ⇒ 幂等回填、不卡骨架                                       | 异常 | `src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx`（扩展）                                  | 卡片最终显示 `img`，不显示 `data-testid="thumb-reveal-skeleton"`                                          | ✅                         |
| T9   | API 缺失 / 空路径 ⇒ 零 IPC 零抛错                                                   | 边界 | `useOnDemandThumbnails.test.tsx`                                                                           | 不发 IPC、不抛渲染期异常                                                                                  | 现应绿（守卫）             |
| T10  | `.skeleton` 不含 `background-position` 关键帧、`.media-card` 不含 `transition: all` | 正常 | `src/renderer/styles/globals.test.ts`（新，读源码文本断言，仿 `verify-format-scope.test.ts` 契约测试先例） | 正则断言 CSS 规则体                                                                                       | ✅                         |
| T11  | `resolveExistingThumbnail` 对非字符串/不存在文件返回 null                           | 异常 | `src/main/thumbnail/generator.rebind.test.ts`（新）                                                        | 三类非法输入均 null 且无 fs 副作用                                                                        | ✅                         |
| T12  | e2e「冷缓存首图耗时」场景存在且产出指标                                             | 正常 | `e2e/perf.e2e.ts` + `e2e/perf-helpers.ts`                                                                  | 新 `@perf` 用例产出 `{scenario:'first-thumbnail', metrics:{durationMs}, threshold:{maxMs}}`；改前基线入档 | 现不存在该用例（能力缺失） |
| T13  | （N6 条件节点）READY 超时后冷却期可再 fork                                          | 异常 | `src/main/thumbnail/worker-bridge.test.ts`（扩展，fake timers）                                            | 第二次 `processImage` 触发 `utilityProcess.fork` 再次调用                                                 | ✅                         |

## 七、实施节点队列（每节点：目标文件 / 输入输出 / Red→Fix→Green / 验收）

### N-1 计划落盘（仓库惯例，先于一切代码改动）

- 目标文件：`docs/plans/2026-10-09-fix-thumbnail-loading-performance-round2.md`
- 输入/输出：输入为本计划全文；输出为仓库内可审查、可追溯的计划文件（与上一轮 `docs/plans/2026-10-09-fix-thumbnail-loading-performance.md` 同格式同目录）。
- 执行：进入执行阶段的第一步即写入该文件（当前因处于 plan 模式只能落在会话计划文件里），并随 N0 的基线数据补充「修改前基线与诊断结论」小节；后续每个节点的 Red/Green 证据回写到该文件对应小节。
- 验收：文件存在且含依赖声明、启动与验证说明、错误处理、参数校验、基础测试用例五节，每个节点含目标文件/输入输出/客观验收标准；`git status --porcelain` 可见该新增文件。

### N0 建立可复现测量能力（先测量，后动手）

- 目标文件：`e2e/perf.e2e.ts`、`e2e/perf-helpers.ts`、`scripts/perf-test/perf-baseline.ts`、`docs/perf-regression.md`
- 输入/输出：输入为临时 userData + `PERF_DATASET_IMAGES`；输出为首图耗时 P50/P95、骨架卡数、`thumbnail IS NULL` 行数变化，写入 `.cache/perf/latest.json` 并在 `docs/perf-regression.md` 记录改前基线。
- 说明：`perf-baseline.ts` 头注释宣称的「场景 4 缩略图生成耗时」在代码中**并不存在**（已核实），`e2e/perf.e2e.ts` 8 个场景无首图耗时；本节补齐 T12，之后各轮复用。
- 验收：`npm run dist:win && npm run e2e:perf` 真实跑通并产出新指标；未产出指标前不得进入后续节点。

### N1 取证回写失败真实原因（受保护路径，已获用户授权）

- 目标文件：`src/main/ipc/handlers/thumbnail-handler.ts`（受保护 ⇒ 文件顶部替换为本次真实原因的 `// @core-change: 缩略图回写失败日志携带错误码与原因，用于定位每会话重复生成死循环`）
- 输入/输出：输入为注入的失败 `repo.setThumbnailIfNull`；输出为 T1 断言的结构化告警文本；打包 e2e 跑完后从临时 userData 日志取到真实错误码。
- Red：T1（今天打印 `{}`，必失败）。
- 验收：拿到确定的错误签名（如 `SQLITE_BUSY` / `bridgeDisposed` / `RangeError` 参数数目 / `DatabaseError` 具体原因），并把它写进本计划的 N2 前置结论。**未拿到原因不得凭猜测改写入路径。**

### N2 修复回写失败（依 N1 证据落地，最小改动）

- 目标文件：按证据二选一，优先非受保护路径：① `src/main/database/media-repository.ts`（`setThumbnailIfNull` 语义/参数）② `src/main/database/worker/*`（busy 重试与错误转译）③ 仅当确认为 handler 侧调用形态问题时才回到 `thumbnail-handler.ts`。
- 输入/输出：`setThumbnailIfNull(filePath, thumbnailPath) -> Promise<boolean>` 契约不变（返回值语义：实际写入行数 > 0）。
- Red：新增/扩展用例直接复现 N1 定位到的失败条件（例：并发批量写持锁时回写必须成功或明确 busy 重试一次）。
- 验收：连续两次冷启动 `npm run e2e:perf` 期间 `[Thumbnail] 按需生成结果回写数据库失败` 出现次数为 **0**；临时库中 `thumbnail IS NULL AND file_type='image'` 行数在按需生成后下降为 0（除源缺失行）。

### N3 启动重绑定：切断死循环（与 N2 独立生效的保险）

- 目标文件：`src/main/thumbnail/generator.ts`（新增 `resolveExistingThumbnail`）、`src/main/app/startup-tasks.ts`（`rowsToRepair` 扩展 + 新重绑定阶段，位置在 `:649 cleanupOrphanThumbnails(ctx)` **之前**，现有顺序已满足）、`docs/技术债清单.md`（DEBT-026 状态更新）。
- 输入/输出：输入为 `SELECT id, file_path FROM media_files WHERE thumbnail IS NULL AND file_type='image' AND width IS NOT NULL AND height IS NOT NULL`（静态字面量 + 现有筛选合并）；输出为写回 `thumbnail = <已存在缓存路径>` 的行数与 `logger.info` 汇总。
- 关键取舍：**只重绑定、不生成**——避免把启动变成全库解码风暴（这正是 DEBT-026 一直没做的风险面），复用 `runWithConcurrency(…, THUMBNAIL_CONCURRENCY)` 与 `processThumbnailForRow` 不动。
- Red：T2/T3/T11（今天 NULL 图片行既不被选中也无只读判定入口）。
- 验收：T2 通过；两次重启后 `cleanupOrphanThumbnails` 删除数从「≈缓存内全部按需文件」降为 0（e2e 日志 `[Thumbnail Cleanup]` 计数）；`npm run test:main` 无新增失败。

### N4 渲染层按需生成通知合并（不动 7 个消费方）

- 目标文件：`src/renderer/hooks/useOnDemandThumbnails.ts`（帧合并 + 监听器只挂一次 + 已 settled 幂等回填）、`src/renderer/components/gallery/VirtualImageGrid.tsx`（`setThumbRetryNonce` 缓冲到同帧一次写入，`:259-280`）
- 输入/输出：签名与语义不变；新增模块内私有 `scheduleFrame(callback): () => void`（`requestAnimationFrame` → 缺失时 `setTimeout(16)`）。
- Red：T6/T7/T8。
- 验收：T6 renderCount ≤ 2（改前为 50）；现有 `useOnDemandThumbnails.test.tsx` 2 例、`VirtualImageGrid.thumb.test.tsx`、`MasonryView.test.tsx`、`ListView.thumb.test.tsx`、`timeline-views-thumb-src.test.ts`、`RecycleBinPage.thumb.test.tsx`、`OutfitGalleryPage.cover.test.tsx`、`DuplicatesPage.videoThumb.test.tsx` 全绿。
- 明确不做：`useFailedImages` 的 `clearFailed` 缓冲——它对非失败 id 返回同一 Set 引用会被 React 短路，不构成风暴源，属未经证实的改动。

### N5 绘制层：骨架动画改为合成友好 + 卡片过渡精确化（已获用户授权）

- 目标文件：`src/renderer/styles/globals.css`（`.skeleton` `:1412-1431` 由 `background-position` 位移改为 opacity 脉冲，保留 `--skeleton-from/--skeleton-to` 变量与主题覆写链、保留 `html.reduce-motion .skeleton`（`:219`、`:1480`）降级链；`.media-card` `transition: all` → `transition: transform …, box-shadow …`）
- 取舍说明：`::after` 伪元素 + `translateX` 的扫光方案需要给 `.skeleton` 加 `position: relative`，而现有 4 个使用点中 `ThumbReveal.tsx:83`、`MediaThumbnail.tsx:150` 自带 `absolute inset-0`，会被反向破坏定位基准 —— 故本轮选 opacity 脉冲（视觉近似、零布局风险）。用户已确认接受「接近但非逐像素一致」。
- Red：T10。
- 验收：T10 通过；`npm run test:renderer` 无新增失败；打包态 e2e 首图耗时无回归；不改任何 `backdrop-filter`/毛玻璃（本轮未授权）。

### N6 条件节点：worker 降级锁死复位 + 预热（仅当 N0/N1 证据显示需要）

- 触发条件（任一成立才做，否则本节点跳过并在计划内记录「不实施+证据」）：① N0 首图耗时分解显示 fork+READY 占比 > 20%；② N1 或后续日志出现 `handshakeFailed` / `workerCallFailed` / 30s 超时。
- 目标文件：`src/main/thumbnail/worker-bridge.ts`（复用 `WorkerRestartPolicy`，超时/fork 失败时 `scheduleRestart(() => { this.workerFailed = false })` —— **只复位锁存、不主动 fork**，保留「无自动重启、避免崩溃循环」契约；新增 `prewarm()`）、`src/main/app/lifecycle.ts`（紧邻 `:453` 的 `startup-lru-enforce` 以同形写法 `enqueueLow(() => bridge.prewarm(), { id: 'startup-thumbnail-prewarm' })`，`ctx.thumbnailWorkerBridge` 已存在于 `AppContext:30`）
- Red：T13。
- 验收：若实施，T13 通过 + `worker-bridge.test.ts` 既有用例全绿；若不实施，本节写明证据与结论。
- 已排除：`processImage` 在 READY 之前 postMessage 会丢消息这一假设 —— 本机 33 个日志文件中握手/超时/`workerCallFailed` 计数为 0，若真丢消息冷启动批量必然稳定刷 30s 超时；故仅作「消除脆弱耦合」的可选加固，不作为本轮瓶颈。

## 八、明确不做（附证据，防无关重构）

1. **批量 IPC / 请求合并通道**：可视区已按 `generatingLocks` 与渲染层 Promise Map 去重，且改前基线无 IPC 回归证据；新增通道会同时触碰 preload/api 与 handlers 两处受保护路径。
2. **首次 `enforceCacheLimit` 全目录扫描改造**：本机实测 1384 文件串行 stat 仅 29.6ms，且 N3 落地后缓存文件数会回落；对「几百~2000 张」的真实库不构成瓶颈。若 N0 放大到 5000 数据集后指标显示该项 > 500ms，再补做。
3. **套装画廊 `media:getOutfitStats` N+1**（`media-handler.ts:136-157` → `media-repository.ts:1348-1353`）：本机 outfit 去重计数为 0，无法测量收益，且需再动一处受保护 handler；本轮不改，登记为待测项。
4. **每张卡 `backdrop-filter` 毛玻璃移除**：用户本轮未授权，且涉及 `glass-lite` 降级链。
5. **`generationRequests`/`generationResults` 无界增长**（DEBT-023）：2000 量级内存成本可忽略，不属加载慢成因。
6. **视频 seek 阶梯 / `VIDEO_DECODE_CONCURRENCY=2` / 30s 超时**：稳定性保护，无饥饿证据（沿用上一轮 H6 结论）。
7. `media:analyzeSceneTime`（主进程全图 sharp 解码）与 `media:findDuplicates`（整文件串行 sha256）：前者仅由分类页按钮手动触发，后者非缩略图链路，均不在本轮范围。

## 九点五、取证更正（2026-10-09 执行期，推翻本文 1.2/1.3 的机制假设）

详见文末「实施记录」§1。本文 1.2 表中的「回写失败 138 条」与 1.3 的恶性循环机制**已被运行时证据推翻**，
但 1.2 的 NULL 行数、缓存构成、以及 N3 节点本身仍然成立（理由换成了更强的证据）。

## 九、回归与终止条件（一票否决）

每个节点完成即跑该节点相关子集（第六节 Red 列表）+ `npm run verify`；全部节点收尾按序执行：

```bash
npm run verify
npm test
npm run lint
npm run typecheck
npm run i18n:guard
npm run test:coverage
npm run dist:win && npm run verify:dist
npm run e2e:smoke
PERF_DATASET_IMAGES=1500 npm run e2e:perf
git diff --numstat        # 差异必须只含第七节列出的文件
```

- 全部通过才可标记完成；任一门禁失败（含既有失败被本次触发）任务不得完成，也不得通过放宽阈值、跳过测试、新增豁免来消音。
- 客观完成判据（不只是「测试绿」）：① e2e 冷缓存首图耗时 P95 相比 N0 基线下降；② 连续两次重启后 `[Thumbnail] 按需生成结果回写数据库失败` 计数为 0；③ 连续两次重启后 `[Thumbnail Cleanup]` 删除孤儿数不再包含刚生成的按需缩略图；④ `thumbnail IS NULL AND file_type='image'` 行数在生成后归零。
- 本机 `logs/*.log` 与 `AppData` 为真实数据：只读取证，禁止任何脚本清理/改写；e2e 与打包测量使用临时 userData。
- 提交信息按 Conventional Commits 拆分（`fix(thumbnail)` / `perf(renderer)` / `style(globals)` / `docs(plans)`）；受保护路径改动随同一批携带唯一真实 `@core-change` 原因。

## 实施记录

### 1. 取证更正：作废「回写失败 138 条」（本文 1.2 / 1.3 的机制假设不成立）

计划批准时依据的「本机 138 条按需生成回写数据库失败」**不是生产数据**，复核后被推翻：

| 核对项                                                                                             | 结果                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仓库根 `logs/` 是否本机 userData 日志                                                              | 否。`main-2026-08-26.log` 的 mtime 是 2026-09-14，内容与时间戳日期错位                                                                           |
| `logs/main.log` 失败行的堆栈                                                                       | 指向 `D:\Users\Downloads\WXNN XiangCe（jiu)/src/main/ipc/handlers/__tests__/thumbnail-handler.test.ts:35`，错误体是测试桩自抛的 `Error: db down` |
| 真实 userData（`%APPDATA%\wxnn-photo-manager\logs\*.log`）中 `按需生成结果回写数据库失败` 出现次数 | **0**                                                                                                                                            |
| 真实 userData 中 worker 降级/超时/握手相关告警                                                     | **0**（与 1.2 结论一致）                                                                                                                         |

即：那批日志是同仓库**旧检出目录**的单测产物被一并拷贝过来所致。因此 1.3 的「回写抛错 → thumbnail 恒 NULL → 缓存被当孤儿删除 → 每会话重生成」链条不成立，N1「取回写错误签名」与 N2「修回写」按原设计作废（N1 的诊断日志改动仍保留，它本身是有效的可观测性修复，且单测覆盖）。

同批数据里**仍然成立的事实**（这些是后来定位真因的基础）：

- 153 个图片行中 **62 行 `thumbnail` 为 NULL**（视频 12 行全部有引用）。
- 62 个 NULL 行按「缓存文件是否已在磁盘」复核（只读脚本 `.cache/probe-rebind.mjs`，hash 口径与 `getFileHash` 一致：sha256(前 1MB) 前 16 hex）：**17 行源文件已不存在 / 2 行命中现行缓存 / 33 行只命中搬迁前的默认目录 / 10 行两处都无缓存**。
  原文初版把这里记成「33 行可直接命中」，是因为当时只查了 `%APPDATA%\wxnn-photo-manager\thumbnails`；而本机 `app_settings.thumbnailCacheDir` 早已迁到独立盘，generator 只认迁后的目录，**N3 重绑定真实可命中的只有 2 行**（与 §7 副本库 81→79 的实测下降量吻合）。
- 顺带查明的迁移遗留：`applyCustomDir` 对 `thumbnailCacheDir` 用的迁移模式是 `/metadata\.json$/i`（`src/main/app/custom-dirs.ts:43`），只搬 LRU 元数据、**不搬 1384 个 `.jpg` 缓存文件**。所以缓存目录一旦换盘，历史缓存全部留在旧目录，等价于「全库缓存清零」——这是该机器上「进入板块要重新等一遍」的第二个放大器，本轮不改（改迁移策略属另一决策面，已登记待测）。
- 103 个非空 `thumbnail` 引用中 **0 个悬空**；`[Thumbnail Cleanup]` 与 `[Cleanup] 修复 N 条` 自 2026-10-02 起未再触发。
- NULL 行分布高度集中在**重复文件（30）/ 启动器缓存 Temp（17）/ 云照片（13）**三个板块，只有 ~15 行落在图库默认视图。

### 2. 真根因：按需生成的读取守卫与 media:// 展示口径不一致（运行时对照实验）

打包态、真实 userData 副本、同一批 `thumbnail IS NULL` 的已入库路径，两个通道各调一次：

| 通道                 | 使用的守卫                                                     | 实测结果（4/4 一致）                                        |
| -------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `file:getExif`       | `assertMediaReadPath` / `isMediaPathAllowed`（媒体白名单优先） | **通过**                                                    |
| `thumbnail:generate` | 裸 `assertFileReadPath`                                        | **`Error: 路径不在白名单内，禁止 读取 操作`**，0~1ms 即失败 |

成因：`pathGuard.roots` 只覆盖 userHome、userData 与 `refreshPathGuardRoots` 注册的媒体根；游戏装在未注册的独立盘（本机为 `H:\InfinityNikki Launcher\InfinityNikki\X6Game\Saved\GamePlayPhotos`）时，`media://` 用 DB 已索引媒体口径放行（所以图片能显示），而按需生成用裸 PathGuard 判定（所以必然被拒）。`src/main/ipc/media-read-guard.ts` 的头注释早已把这类误拦截记录为已知缺陷（「图库右键属性 → 信息解析失败」），本仓库其余 7 个媒体读取 handler 也统一走媒体守卫——`thumbnail:generate` 是唯一漏改的一个。

后果链（与用户症状逐条对上）：

```
thumbnail:generate 对已入库媒体恒被拒（0~1ms）
  → 渲染层 ensureThumbnail 的 catch(() => null) 拿到 null → hasFailed 命中
  → DB thumbnail 恒 NULL（62/153 行永不修复）
  → 卡片停在骨架：重复板块 20 张、启动器缓存板块 40 张、图库 16 张，10s 沉降后仍不归零
  → 每次进入该板块重新走一遍必然失败的请求 = 「每次启动/切板块都要重新等一遍」
```

生成侧本身不是瓶颈，实测排除了「解码慢」这一类猜测：真实 3311×1485 / 3840×2160 原图（0.1~~0.4MB）逐张测得 **读 1MB 0~~1ms + hash 0~~1ms + sharp 解码缩放编码 12~~25ms**；缓存目录 1384 个文件串行 stat 仅 29.6ms。

### 3. N0 测量能力：合成数据集测不出该症状，新增真实数据副本套件

`PERF_DATASET_IMAGES=1500 npm run e2e:perf` 的 P8/P9（1×1 占位 JPEG）给出的是「缩略图按需生成 P50 1ms / P95 3ms、首图 121ms、NULL 行 3s 内自愈、回写失败 0」——全部达标，**因为占位图与引用健康的空库都无法复现症状**。故补 `e2e/perf-real.e2e.ts`（tag `@perf-real`，默认 `test.skip`，需显式 `PERF_REAL_USERDATA`）：

- 克隆真实 userData 的 `database/wxnn_photo_manager.db*` + `thumbnails/` + `search-index/` 到 `.cache/perf-real/user-data-<ts>`，**刻意不克隆 `Cache/`**，使首启为冷 HTTP 缓存、二次启动为热缓存；
- R1 克隆校验 → R2 首启（首图显影 / 骨架沉降 / 默认视图 NULL 行数 / 日志副作用计数）→ R3 逐板块切换（以 click 时刻的已显影数为基线，避免上一板块残留图片造成 0ms 假快）→ R3b 直调 `thumbnail:generate` 与 `file:getExif` 对照取证 → R4 二次启动对照 → R4b 副本日志摘录 → R5 结果落盘 `.cache/perf-real/latest-real.json`；
- `helpers.ts` 增加 `launchApp({userDataDir})` 与 `closeApp(_, {keepUserData})` 两个可选参数（默认行为不变），`PERF_REAL_KEEP=1` 时保留副本以便翻日志。

运行方式：

```bash
npm run dist:win
PERF_REAL_USERDATA="C:/Users/<你>/AppData/Roaming/wxnn-photo-manager" \
  npx playwright test --config e2e/playwright.config.ts --grep @perf-real
```

### 4. 改前基线（真实数据副本，2026-10-09 实测）

| 场景                   | 指标                              | 改前值                                                                 |
| ---------------------- | --------------------------------- | ---------------------------------------------------------------------- |
| R2 首启（冷缓存）      | 首图显影                          | 4ms                                                                    |
| R2 首启（冷缓存）      | 骨架沉降 / 残余                   | 4ms / 0（首屏 18 张全部有引用）                                        |
| R2 首启（冷缓存）      | 默认视图 NULL 引用行              | 15 / 94                                                                |
| R3 切板块 重复文件     | 首图显影                          | **1761ms**                                                             |
| R3 切板块 重复文件     | click 时骨架 → 10s 后骨架         | 20 → **20（永不归零）**，仅 6/26 显影                                  |
| R3 切板块 启动器缓存   | 首图显影                          | null（15s 内无新显影）；骨架 40 → **40**                               |
| R3 切板块 图库（返回） | 首图显影                          | null；骨架 16 → **16**                                                 |
| R3b 直调 generate      | 结果                              | 4/4 `路径不在白名单内，禁止 读取 操作`（同路径 `file:getExif` 全通过） |
| R4 二次启动（热缓存）  | 首图显影 / NULL 行                | 14ms / 15（未被补齐）                                                  |
| 全程日志               | 回写失败 / 孤儿清理 / worker 降级 | **0 / 0 / 0**                                                          |

### 5. 节点执行与 Red→Green

| 节点                       | 改动                                                                                                                                                                                                                                                                                                                                                                                                    | Red（改前必失败）                                                                                                               | Green                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| N1                         | `thumbnail-handler.ts` 回写失败告警展开错误链（`describeWriteFailure`，最多下钻两层 cause）                                                                                                                                                                                                                                                                                                             | `__tests__/thumbnail-handler.test.ts` 新增 5 例：改前告警文本为 `{}`                                                            | 该文件 13/13 通过                                                                                                                     |
| **N2（重定义）**           | `thumbnail:generate` 读取守卫 `assertFileReadPath` → `assertMediaAccessPath(ctx, filePath)`，与 media:// 展示、`file:delete`、导出通道同口径；同步替换 `@core-change` 原因                                                                                                                                                                                                                              | 新增 2 例：①「已入库但不在 PathGuard 根内的媒体路径必须放行」改前 `success=false`；②「必须调用媒体守卫」改前 0 次调用           | 13/13；另一处既有契约 `handlers/thumbnail-handler.test.ts` 同步改为断言媒体守卫（旧断言正是被证伪的口径）                             |
| **N3**                     | `generator.ts` 新增公共方法 `resolveExistingThumbnail`（纯存在性判定，不调 `ensureCacheDir`、不进 sharp 链路）；`startup-tasks.ts` 在 `cleanupOrphanThumbnails` 之前增加「重绑定」阶段：`image + thumbnail IS NULL + 尺寸齐全`，专用语句 `UPDATE media_files SET thumbnail = COALESCE(?, thumbnail) WHERE id = ? AND thumbnail IS NULL`，并发 `THUMBNAIL_CONCURRENCY`，单次上限 2000 行，单行异常仅告警 | 新增 5 例中 T2/T3 改前失败（`resolveExistingThumbnail` 不存在 / 无写回）；T4/T5 与「非法入参」例为兼容性守卫，改前即绿          | `generator.rebind.test.ts` 5/5；`startup-tasks.test.ts` 57/57                                                                         |
| N0                         | `e2e/perf-real.e2e.ts`（新增）+ `e2e/perf.e2e.ts` P8/P9 假绿防护（`pageRows>0`、`sampled===25`）+ `helpers.ts` 可选参数                                                                                                                                                                                                                                                                                 | —                                                                                                                               | `npm run typecheck:e2e` 通过；R1~R5 全绿                                                                                              |
| **N5（重新定位，见 §12）** | `VirtualImageGrid.tsx`：`items` 变化时重排一次防抖按需生成（4 行，复用既有 `scheduleOnDemandGeneration` 与卸载清理，7 个消费方签名不变）；`perf-real.e2e.ts`：骨架计数先过滤 `rect.width > 0` + R4c 三桶取证 + 自定义目录真隔离；`perf-helpers.ts`：`logLineKey()` 去重 electron-log 双写                                                                                                               | 新增 3 例（items 替换后必须发满 6 次 / 不越界只发 6 次 / 同路径复切不重复发），改前实测 `to be called 6 times, but got 0 times` | 该测试文件 11/11；`src/renderer` 相关 17 文件 172 例全绿；打包态 `@perf-real` 8/8：缓存板块首图 184ms、已布局骨架 20→0、缓存增量 0→+8 |

`npm run verify` 五项（typecheck / lint / core-gate / format / test）全通过；core-gate 识别 1 个受保护文件并放行（携带真实原因注释）。

### 6. 改后复测

（见 §7、§8）

### 7. 改后复测（同一套 `@perf-real`，同一台机器，同一份真实 userData 克隆）

| 场景                                              | 指标                              | 改前                                   | 改后                             | 判读                                                           |
| ------------------------------------------------- | --------------------------------- | -------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| R3b 直调 `thumbnail:generate`（CloudPhotos 4 行） | 结果                              | 4/4 `路径不在白名单内，禁止 读取 操作` | `error=null`、`result=null`、0ms | **守卫误拦已消除**，但生成仍返回 null ⇒ 暴露第二个拦截点（§8） |
| R2 首启（冷缓存）                                 | 首图显影 / 骨架沉降               | 4ms / 4ms                              | 4ms / 15ms                       | 首屏本就是健康视图（18 张全部有引用）                          |
| R2 首启                                           | 默认视图 NULL 引用行              | 15 / 94                                | 15 / 94                          | 重绑定在首启后才完成，R2 采样时点未覆盖                        |
| R4 二次启动                                       | 首图显影 / NULL 行                | 14ms / 15                              | 3ms / **13**                     | 重绑定 + 回写共同把默认视图 NULL 行往下压                      |
| 副本库                                            | `thumbnail IS NULL` 图片行        | 81（克隆快照基线）                     | **79**                           | 只下降 2：余量全部被 §8 的结构性豁免挡住                       |
| R3 切板块 重复文件                                | 首图显影 / 10s 后骨架             | 1761ms / 20                            | 1708ms / **20**                  | **未改善**——原因不在守卫，也不在渲染层风暴                     |
| R3 切板块 启动器缓存 / 分类 / 回收站              | 10s 后骨架                        | 40 / 40 / 40                           | 40 / 40 / 40                     | 同上                                                           |
| 全程日志                                          | 回写失败 / 孤儿清理 / worker 降级 | 0 / 0 / 0                              | 0 / 0 / 0                        | 再次确证本文 1.2 的循环假设不成立                              |

N2（守卫）+ N3（重绑定）都是必要但不充分：它们让「本该能生成的行」不再被误拦，也把「缓存已在磁盘、只差引用」的 2 行绑上了；但 79−2 行的缩略图**在代码里根本没有生成的入口**。

### 8. 第二个拦截点：GamePlayPhotos 图片豁免只认「HQ → LQ」一个方向

`src/main/thumbnail/generator.ts` 的 `generateLocked()` 开头：

```ts
const ext = path.extname(filePath).toLowerCase()
if (isGamePlayPhotosPath(filePath) && !isVideoExt(ext)) {
  const native = resolveNativeThumbnailPath(filePath) // 只识别 \NikkiPhotos_HighQuality\ 段
  if (native) {
    try {
      await fsp.access(native, R_OK)
      return native
    } catch {}
  }
  return null // ← 推导不出即恒 null，禁止生成
}
```

`resolveNativeThumbnailPath()` 的语义是「HQ 目录的原图 → 兄弟目录 `NikkiPhotos_LowQuality` 的同名文件」。因此**凡是本身就不在 `NikkiPhotos_HighQuality` 下的已入库图片**，按需生成一律返回 null，`thumbnail` 列永远补不上。副本库 79 个 NULL 图片行按此归类的实测分布：

| 组                                                      | 行数                                       | 源文件实测形态                                         | 结构性结果                   |
| ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ---------------------------- |
| `GamePlayPhotos/{uid}/CloudPhotos/*_Low.jpeg`           | 13                                         | 3311×1485，275~407KB                                   | 非 HQ 目录 → 恒 null         |
| `GamePlayPhotos/{uid}/NikkiPhotos_LowQuality/*.jpeg`    | 23                                         | 1280×720，338~612KB（且 23/23 的 HQ 同名原图也在库里） | 方向相反，推导不出 → 恒 null |
| `GamePlayPhotos/{uid}/CloudPhotos/Temp/*_low_s128.jpeg` | 36（19 行源仍在、**17 行已被启动器删除**） | 128px 级小图                                           | 恒 null；17 行本就无源       |
| `GamePlayPhotos/{uid}/Videos/*/*_cover.jpeg`            | 6                                          | 3840×2160，1.7MB                                       | 恒 null                      |
| 其他（`PendingUp.jpeg` 等）                             | 1                                          | 3840×2160，661KB                                       | 恒 null                      |

补充事实（用于评估修法成本）：真实原图逐张生成实测 **读 1MB 0~~1ms + hash 0~~1ms + sharp 解码缩放编码 12~25ms**，产出 256px 档缓存文件；渲染层 `resolveThumbnailSrc()` 明确规定「原文件路径仅用于按需生成，不作为展示兜底」，所以这些行既不会退化成加载 1.7MB 原图，也不会显示任何内容——**永久停在占位/骨架**。

结论：本轮已落地的两项改动消除了误拦截与「只差引用」两类问题，但「GamePlayPhotos 下非 HQ 目录的 62 行（另有 17 行源已消失）」需要改变该豁免策略才能出图，属于新的策略决策，已提请用户定夺（选项：解除禁令走正常生成 / 仅对已是小图的行直接引用自身 / 本轮收尾并登记债务）。

### 9. 后续验证入口（复现本记录的命令）

```bash
# 真实数据副本套件（改前/改后对照，含守卫对照取证）
npm run dist:win
PERF_REAL_KEEP=1 PERF_REAL_USERDATA="C:/Users/<你>/AppData/Roaming/wxnn-photo-manager" \
  npx playwright test --config e2e/playwright.config.ts --grep @perf-real

# 本轮改动的单测
npx vitest run src/main/ipc/handlers/__tests__/thumbnail-handler.test.ts \
               src/main/ipc/handlers/thumbnail-handler.test.ts \
               src/main/thumbnail/generator.rebind.test.ts \
               src/main/app/__tests__/startup-tasks.test.ts
npm run verify        # typecheck / lint / core-gate / format / test 五项
```

### 10. N4（重定义）：GamePlayPhotos 图片豁免改为自适应

> 原计划 N4 是「渲染层按需生成通知合并」。复测证明 20~40 张骨架**与渲染层风暴无关**
> （改前改后 R3 指标一模一样），风暴只是症状的放大器而非成因；经用户重新确认，
> 本节点改为处理 §8 定位的结构性拦截点。原 N4（帧合并）与 N5（骨架动画/transition）
> 因失去证据支撑，一并降级为「待测项」，不在本轮实施。

**策略（用户选定「自适应：小图直接引用自身，大图才生成」）**

`generateLocked()` 的豁免分支中，原 `return null` 替换为：

1. 能推导并读到原生 LQ（`NikkiPhotos_HighQuality → NikkiPhotos_LowQuality`）→ 返回原生路径（既有短路，不变，避免与游戏原生缩略图重复存储）；
2. 否则探测源图 header 尺寸（`sharp(...).metadata()`，不做整图解码）：长边 ≤ `SELF_THUMBNAIL_MAX_EDGE_PX = 512` → **返回自身路径**（该文件本身就是低清变体，如 `CloudPhotos\Temp\*_low_s128.jpeg`）；
3. 否则（3311×1485 云照片、3840×2160 视频封面等）→ **放行走正常生成**，产出 256px 缓存，由既有回写把 `thumbnail` 落库。

必须按尺寸判定而非文件名：`CloudPhotos\*_Low.jpeg` 名字带 Low，实测是 3311×1485 / 275~407KB。

**目标文件**：`src/main/thumbnail/generator.ts`（常量 `SELF_THUMBNAIL_MAX_EDGE_PX`、私有 `isSelfUsableThumbnail`、豁免分支改写）

**Red→Green**

- 新增 `src/main/thumbnail/generator.gameplayphotos.test.ts`（6 例）：改前 5 红 1 绿（大图恒 null、小图不引用自身、原生 LQ 缺失不再生成、非豁免路径 null 等），改后 6/6 绿。
- 存量契约更新 `generator.test.ts:407`「HQ 路径但原生 LQ 缺失」：旧断言「零 sharp 调用 + null」编码的正是被本轮放宽的硬性需求；改为「允许一次 header 探测，但源文件不存在时生成阶段仍被 `pathExists` 拦下 → null 且 `toFileTargets` 为空（零落盘）」。
- `npx vitest run src/main/thumbnail` → 6 文件 41 例全绿；`npm run verify` 五项全通过。

**兼容性核对**（`thumbnail` 允许等于 `file_path` 后逐条查过）：`cleanupOrphanThumbnails` 只扫缓存目录，不受影响；`isMediaPathAllowed` 认 DB 已索引 `file_path`，`media://` 可直接取该文件；LRU `enforceCacheLimit` 只统计缓存目录；重复检测/XMP/导出不读 `thumbnail` 列。

**明确不做（本轮排除，附理由）**

- `isGamePlayPhotosPath` 未覆盖 `gameplayphotos-root.ts` 提到的「无 `Saved` 兼容变体」——放宽豁免只会多一次原生 LQ 短路尝试，与本机症状无关（真实库 79 行全部命中 `Saved` 特征），且会牵动 `worker-entry.test.ts` 既有断言，属另一轮的事。

### 11. 测量有效性更正（第二次）：骨架计数含「未布局卡片」，把预期懒加载读成了永久卡死

§7 里「R3 各板块骨架 20→20 / 40→40 永不归零」这组数字**不成立**，是测量口径错误。逐张取证（打包态、真实副本、重复文件板块）：

```json
{
  "srcTail": "…%E7%BC%93%E5%AD%98%2F0b03f8487491743f.jpg",
  "currentSrcEmpty": true,
  "complete": false,
  "naturalWidth": 0,
  "loadingAttr": "lazy",
  "inViewport": false,
  "hasTimingEntry": false
}
```

长挂骨架的 `<img>` 全部满足：`currentSrc` 为空、**resource timing 里根本没有该 URL**、`getBoundingClientRect()` 宽为 0。即 Chromium 对 `loading="lazy"` 且未参与布局的图片**从未发起请求**——这是预期行为，不是卡死。据此把 `@perf-real` 的所有计数改成先过滤 `rect.width > 0`（`waitFirstThumb` / `waitRevealedBeyond` / `waitSkeletonClear` / `thumbInventory`），并新增 R4c 按「视口内 / 视口外已布局 / 未布局」三桶统计。

同轮还修掉两个测量缺陷：

1. **克隆不是真隔离**。`app_settings` 里 `logDir`/`crashDir`/`backupDir`/`thumbnailCacheDir` 存的是绝对路径，`applyCustomDirectories` 会把它们指回真实目录，`--user-data-dir` 形同虚设——早轮副本运行因此把日志追加进 `%APPDATA%\wxnn-photo-manager\logs`、并 touch 了 `D:\NikkiGallery缓存\cache-metadata.json`（逐文件核对：该目录**没有**新增或删除任何 `.jpg`，用户数据未被破坏）。现在 `beforeAll` 用 `node:sqlite` 把四个设置改写到副本内部并把真实缓存内容复制进来（`better-sqlite3` 按 Electron ABI 编译，在 Playwright 的普通 Node 进程里 `dlopen` 直接报 `NODE_MODULE_VERSION` 不匹配）。
2. **日志计数翻倍**。electron-log 把同一事件同时写进 `main.log` 与 `main-<日期>.log`，两份时间戳格式还不同，按行数直接数会把 1 次孤儿清理记成 2 次。新增 `logLineKey()`（epoch 毫秒 + 去掉级别前缀的正文）做去重键。

修完口径后重测的**改前**基线（同一副本、同一份真实 userData）：`R3 启动器缓存` 首图显影 `null`（15s 内零新显影）、已布局骨架 20 张 10s 后仍 20 张、该板块全程缓存目录增量 **0**。

### 12. N5（重新定位的渲染层真缺陷）：切板块不再触发按需生成

口径修正后暴露出的才是真瓶颈，且与 §1.3、原 N4 的猜测都不同：

`VirtualImageGrid` 里 `generateVisibleRange()` 的**唯一调用点是 `rangeChanged`**（`VirtualImageGrid.tsx:438-443`）。图库 → 启动器缓存/重复文件 切换时网格组件不卸载，两个板块的可视区间编号一致（0..N），react-virtuoso 因此不再回调 `rangeChanged`——按需生成**一次都不发**，`showSkeleton` 条件（`:476-477`，`!showThumb && !hasError && !generateFailed && !!file_path`）恒成立，卡片永久停在「生成中」骨架。主进程侧完全干净（无告警、无 IPC 效果），所以此前只读代码与看日志都定位不到。

决定性证据（副本缓存目录文件数增量）：整轮板块切换增量 **0**，而 R3b 手工直调 `thumbnail:generate` 4 次立刻 **+4**（每张 16~19ms，返回真实缓存路径）——生成能力正常，缺的是触发。

**Red→Green**（`src/renderer/components/gallery/VirtualImageGrid.grid-cycle.test.tsx` 复用既有「记录型 VirtuosoGrid 探针」）：

| 用例                                                                                 | 改前                                               | 改后 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- | ---- |
| ① 正常：可视区间定为 0..5 后 items 由空数组换成 6 条 NULL 缩略图 → 必须发满 6 次生成 | `expected … to be called 6 times, but got 0 times` | 通过 |
| ② 边界：可视区间 0..5 而 items 有 10 条 → 只发 6 次，不越界扫描                      | 0 次（同因失败）                                   | 通过 |
| ③ 异常：切走再切回同一路径 → 模块级请求去重仍生效，不重复发 IPC                      | 首轮 0 次                                          | 通过 |

**修法**（`VirtualImageGrid.tsx`，4 行）：`items` 变化时重排一次防抖生成，复用既有 `scheduleOnDemandGeneration(false)` 与 `scrollTimerRef`（300ms 防抖 + 卸载清理都已存在，不新增机制、不改 7 个消费方签名）。

**副作用核查**：`markFailed`/`clearFailed` 都是 `useCallback(…, [])`（`useFailedImages.ts:28/34`），`ensureOnDemandThumbnail → generateVisibleRange → scheduleOnDemandGeneration` 的依赖只在 `items` 变化时换代，故该 effect 每次数据装载只跑一遍，不会随 `setRevision` 的重渲染反复重挂定时器。

**打包态复测（同一副本、同一口径）**

| 指标                           | 改前                 | 改后                                                     |
| ------------------------------ | -------------------- | -------------------------------------------------------- |
| R3 启动器缓存：首图显影        | null（15s 无新显影） | **184ms**                                                |
| R3 启动器缓存：已布局骨架      | 20 → 20              | 20 → **0**，4/4 显影                                     |
| R3 启动器缓存：缓存目录增量    | **0**                | **+8**                                                   |
| R3 重复文件：首图 / 已布局骨架 | 1761ms / 20→20       | 1525ms / **0**（6/6 显影）                               |
| R4c 视口内未出图卡片           | —                    | `pending 0`、`stuckOnScreen []`，滚动一屏后出图延迟 11ms |
| R2 → R4 默认视图 NULL 引用行   | 15 / 15（未被补齐）  | 13 → **7**                                               |
| R4 首图显影                    | 14ms                 | 3ms                                                      |

一处必须记下的读数 caveat：R3 重复文件那次采到 `onDemandGeneratedFiles: -144`——启动孤儿清理（`[Thumbnail Cleanup] 清理 144 个孤儿缩略图`，去重后 1 次事件）与 R3 同窗口执行，删掉了副本里 144 个未被 DB 引用的缓存文件（克隆自真实缓存目录，而真实库的引用指向绝对路径 `D:\NikkiGallery缓存`）。这是**本文 1.3 那条循环的真实形态**：缓存目录迁盘后引用与文件分居两处，现行目录里的无引用文件每次启动被清扫（迁盘遗留问题已登记 DEBT-031）。

**N3 的定位随之更正**：副本日志实测 `[Cleanup] … 重绑定 0 条已有缓存引用`。逐行核对原因——62 个 NULL 图片行里只有 2 行命中现行缓存目录（另 33 行只命中迁盘前的旧目录，generator 不读那里），而这 2 行在启动批量任务收尾时已被绑上引用；重绑定阶段的 `AND thumbnail IS NULL` 因此正确报告 0 次写入。它是**补位**（覆盖批量不选的 GamePlayPhotos 豁免行等），不是本机主路径。同时该语句改为与 `updateStmt` 同形的 `SET thumbnail = COALESCE(?, thumbnail)`，以兼容 `thumbnail-phash-service.test.ts` 对本文件「不得出现裸 `thumbnail = ?`」的源码文本契约（原写法被该契约测出红灯，收紧语句而不是放宽契约）。

### 13. 门禁执行结果（本轮收尾）

最终一轮 `@perf-real` 读数（真隔离 + 已布局口径 + 日志去重后）：

| 场景                        | 读数                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| R2 首启                     | 首图 3ms，骨架沉降 3ms / 残余 0，20/20 显影，默认视图 NULL 13/94，日志 0/0/0                      |
| R3 重复文件                 | 首图 1525ms，沉降 5ms / 残余 0，6/6 显影，缓存增量 −144（启动孤儿清理落在同窗口）                 |
| R3 启动器缓存               | 首图 **184ms**，沉降 3ms / 残余 **0**（进入时 20 张已布局骨架），4/4 显影，缓存增量 **+8**        |
| R3 分类 / 回收站 / 图库返回 | 无新增显影需求（首图 null），骨架 0 / 0 / 0，图库 20/20                                           |
| R3b 直调 generate           | CloudPhotos 4 行全部 `error=null` + 真实缓存路径，13~20ms/张                                      |
| R4 二次启动                 | 首图 3ms，20/20 显影，默认视图 NULL **7**/93（R2 时 13），日志：回写失败 0、孤儿清理 1            |
| R4c 视口分桶                | 视口内 6/6 显影、`pending 0`、`stuckOnScreen []`；滚一屏出新卡 11ms；未布局 20 张（懒加载，不计） |

`npm run test:coverage` **未通过**，且原因不在本轮改动：全局实测 lines 66.07% / statements 64.53% / branches 55.68% / functions 57.04%，阈值 69/69/80/68。按文件归因（`coverage-summary.json` × `git status`）：**全部未覆盖语句的 94.9% 落在工作区未改动的 390 个文件**里，缺口最大的分别是 `EditorPage.tsx`(333)、`CategoriesPage.tsx`(267)、`VideoEditor.tsx`(201)、`settings/*-sections.tsx`(各 ~190)、`pluginStore.ts`、`VideoPlayer.tsx` 等，50 个文件零覆盖共 2911 条语句。为凑齐全局阈值需要给编辑页/分类页/插件栈补测试，与「缩略图加载缓慢」无关，属另一件事，因此本轮**不**以降低阈值、排除目录或跳过用例的方式消音，任务在覆盖率门禁上按未通过处理并如实登记于此。

**门禁执行结果（2026-10-10 收尾，逐条实测退出码）**

| 门禁                                        | 结果         | 实测明细                                                                                                                                        |
| ------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`                            | ✓ exit 0     | 收尾复跑五项全绿（typecheck / lint / core-gate / format / test）；此前有 1 次 test 步骤红灯未捕获用例名，之后 4 次连续通过，记为未复现观察      |
| `npm test`                                  | ✓ exit 0     | `Test Files 333 passed` / `Tests 5263 passed`                                                                                                   |
| `npm run lint`                              | ✓ exit 0     | 0 error / 11 warning（DEBT-030 存量 BOM，约定允许）                                                                                             |
| `npm run typecheck`                         | ✓ exit 0     | `tsc -b` + `tsc -p tsconfig.scripts.json`                                                                                                       |
| `npm run typecheck:e2e`                     | ✓ exit 0     | 本轮新增/改写的 e2e 全部在内                                                                                                                    |
| `npm run i18n:guard`                        | ✓ exit 0     | 白名单只减不增、key 已同步                                                                                                                      |
| `npm run dist:win`                          | ✓ exit 0     | 含 pre-dist-check 与 VC++ 运行库闸门                                                                                                            |
| `npm run verify:dist`                       | ✓ exit 0     | 产物校验                                                                                                                                        |
| `npm run e2e:smoke`                         | ✓ exit 0     | Playwright 冒烟                                                                                                                                 |
| `PERF_DATASET_IMAGES=1500 npm run e2e:perf` | ✓ exit 0     | 含本轮新增的 `thumbnail-generate-p95` / `first-thumbnail-visible` 硬阈值                                                                        |
| `npx playwright test --grep @perf-real`     | ✓ exit 0     | 8/8；含新断言「切板块后已布局卡片的缩略图骨架必须归零」                                                                                         |
| `npm run test:coverage`                     | **✗ exit 1** | 全部用例通过（333 files / 5263 tests），但全局阈值未达标：lines 66.07 / statements 64.53 / branches 55.68 / functions 57.04（阈值 69/69/80/68） |

**覆盖率门禁未过的归因（不是消音，是如实登记）**：按 `coverage/coverage-summary.json` × `git status` 交叉统计，**全部未覆盖语句的 94.9% 落在工作区未改动的 390 个文件**里；缺口最集中的是 `EditorPage.tsx`(333 条)、`CategoriesPage.tsx`(267)、`VideoEditor.tsx`(201)、`settings/{data,diagnostics,profile,general,plugin}-sections.tsx`(各 ~190)、`pluginStore.ts`、`VideoPlayer.tsx`，另有 50 个零覆盖文件合计 2911 条语句（其中 `src/renderer/preview/mock/*` 两个 mock 文件属"本不该计入分母"的配置卫生问题）。补齐这些需要给编辑页/分类页/插件栈写测试，与「缩略图加载缓慢」无因果关系。

因此本轮**不**以降低阈值、扩大 exclude、跳过用例或忽略失败的方式让该门禁变绿，也据此判定任务未完成——按第五节「未通过全部回归测试与检查，任务绝对不可标记完成」执行。需要接手的人注意：本节末句「这是仓库既有状态，不是本轮引入」**已被 §15 推翻**——门控恰恰是本批依赖升级由「过」转「不过」的，且成因是测量口径被修正。

**为使覆盖率门禁可运行而做的唯一改动**：`media-repository.test.ts`（2000 行分片 SQL 用例）与 `imageProcessor.canvas.test.ts`（6000×4000 fullSize 用例）在 v8 插桩 + 全库并发下超出默认 10s 被判超时；两文件单独运行（带 `--coverage`）均稳定通过，证明是插桩时间开销而非断言失败，故只给这两个用例各自加 `30_000` 时间预算（与 `staticData.test.ts` 既有的 `}, 30_000)` 同形），断言一字未改。

### 14. 本轮结论与遗留

**已修的因**（每项都有 Red→Green 与打包态数值）：

1. `thumbnail:generate` 的读取守卫口径（`assertMediaAccessPath`）——装在未注册盘的游戏目录不再被误拦；
2. GamePlayPhotos 图片豁免自适应（小图引用自身 / 大图放行生成）——62 行里原本"代码上根本没有生成入口"的一批现在能出图；
3. 启动重绑定只绑不生成（DEBT-026 关闭，实测定位为补位）；
4. **切板块不再触发按需生成**（本轮真正的用户症状成因，§12）——`items` 变化时重排一次防抖生成；
5. 可观测性：回写失败告警展开真实错误链（`describeWriteFailure`）、e2e 日志计数去重、真实副本真隔离。

**未过的门禁**：`npm run test:coverage`——归因见 §15（本小节原写「缺口 94.9% 在未改动文件、属仓库既有状态」，该结论已被推翻）。

**遗留（已登记，不阻塞）**：DEBT-031（缓存迁盘遗留旧目录文件，本轮实测暴露的最大存量放大器）；§7/§11 提到的 R3 重复文件 1525ms 首图延迟（现象是进入板块时前 15s 只显影 6 张，成因未取证，属下一轮）；原计划 N4（帧合并）/ N5（骨架动画与 `transition: all`）仍缺证据支撑，保持待测；`media:getOutfitStats` N+1 未测。

### 15. 覆盖率门控归因更正（2026-10-10 审查轮，实测取证）

本文 §13 把 `npm run test:coverage` 未过记作「仓库既有状态、不是本轮引入」。**该归因不成立**——门控正是本批依赖升级把它从「过」翻成「不过」的，且成因是测量口径被修正，不是测试质量下降。

| 侧                 | 命令                                                               | statements | branches | functions | lines | 阈值 69/80/68/69  |
| ------------------ | ------------------------------------------------------------------ | ---------- | -------- | --------- | ----- | ----------------- |
| HEAD（Vitest 1.6） | `.coverage-final-run.log`（2026-10-03 全量运行，319 files）        | **69.94**  | 81.43    | 68.55     | 69.94 | ✓ 过（余量 <1pp） |
| 工作区（Vitest 5） | `npm run test:coverage`（2026-10-10 复跑，334 files / 5268 tests） | **64.65**  | 55.67    | 57.12     | 66.21 | ✗ 四项全不达标    |

两侧报表的**目录分组同为 39 个**（无新增/消失文件计入分母），且用例数与测试文件数均为增、零 `skip`/`todo`（`git diff` 对 `*.test.ts(x)` 的 `.skip|.todo|.fails` 增删为 0）。所以差异全部来自同一批代码被换了测量口径。

机制证据（文件级对照，`src/main/preload/api/app.ts`——一个导出 8 个从未被调用的箭头函数的薄封装模块）：

```text
HEAD  Vitest 1.6：  app.ts | Stmts 100 | Branch 100 | Funcs 0 | Lines 100 | 未覆盖列：空
工作区 Vitest 5  ：  app.ts | Stmts 12.5| Branch 100 | Funcs 0 | Lines 12.5| 未覆盖列：7-19
```

旧 provider 报出「函数一个都没被调用（Funcs 0）却语句/行 100% 且无任何未覆盖行」——自相矛盾：它把未被调用的箭头体计入其所在语句并判为已覆盖。新 provider 把每个函数体拆成独立语句，如实记为未覆盖（7-19 正是这些箭头体）。同目录 `main/preload/api` 的 Funcs 两侧同为 0.54，只有 Stmts 从 73.9 降到 14.62，可见丢失的是**语句归因口径**而非测试。下降最集中的目录：`main/preload/api` −59.28、`renderer/i18n` −46.26、`main/i18n` −45.85、`main/scheduler` −31.51、`renderer/stores` −22.65、`main/preload` −18.00。

影响与结论：

1. `vitest.config.ts` 的 `thresholds: 69/80/68/69` 是按**被高估的** 69.94 基线取整设的，工具链修正口径后该数字不可能再被产出；CI `build.yml` 的 `coverage` job 失败会经 `needs` 阻断 `build` 与发布 job——**发布流水线当前被这一项卡住**。
2. 本轮仍**不**降阈值、不扩大 `exclude`、不换 provider、不跳用例（§13 的处置方式不变），但把登记项从「存量债务」更正为本批引入的口径变更，登记为 **DEBT-032**（见 `docs/debt-registry.json`），并把待决策写清：① 按新口径重新取基线并更新 `thresholds`；或 ② 给这批薄封装模块补真实调用测试把数字做上去。二者都需单独一轮并由产品/工程同意，本轮未擅自选择。
3. §13 中「94.9% 未覆盖语句落在未改动文件」的文件级统计本身没错，但它只能说明「谁没被覆盖」，不能说明「门控为什么翻红」；把它当门控归因是本轮的方法论错误，记此以免下一轮重复误判。

### 16. 审查轮（2026-10-10）：对本批未提交改动的全面复核与修复

对 62 改 + 7 新的未提交改动逐文件复核后查出 6 项缺陷并修复。每项都先写**改前实测失败**的测试再改代码；Red 列为实测读数，非推断。

| #   | 缺陷与位置                                                                                                                                                                                                                                                            | Red（改前实测）                                                                                                          | Green（改后）                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 定向失效缓存是死代码：`application.ts:156` 以零参箭头 `() => invalidateMediaPathCacheFn()` 装配 ctx，丢掉 `thumbnail-handler.ts:73` 传入的 `[result]`；TS 不报（少参函数可赋值给多参签名），生产仍整表全清                                                            | 新增 `src/main/app/__tests__/application.test.ts`（经 `initialize()` 捕获真实 ctx）：断言收到 `[[path]]`，实收 `[]` → 红 | 改为直接引用 `invalidateMediaPathCache: invalidateMediaPathCacheFn`；该文件 3/3 通过                                                                           |
| B2  | `.node-version` 与 CI 5 个 job 仍钉 Node 20，而 `engines.node` 已 `>=22.12.0`、`node_modules/vitest` 自身 engines 为 `^22.12.0 \|\| ^24 \|\| >=26` → `test`/`coverage`/`build` 跑在不受支持的运行时上                                                                 | 文件实测：`.node-version` = `20`；build.yml 48/122/146/177/280 = `node-version: '20'`                                    | `.node-version` → `22`，5 处改 `node-version-file: '.node-version'`（消除双真源，正是本缺陷成因）                                                              |
| B3  | `e2e/perf-real.e2e.ts:27` 顶层 `import { DatabaseSync } from 'node:sqlite'`；`playwright.config.ts:13` 的 `testMatch: '*.e2e.ts'` 在**收集阶段**就 import 本文件（`--grep-invert` 不过滤收集）→ 低版本 Node 上 `e2e:smoke` 整册崩                                     | 机制级验证：`--list` 收集到 4 文件（含 perf-real）证明收集期即 import；同型缺陷已由 `CHANGELOG.md:41` 记录并修过         | 改 `beforeAll` 内惰性 `await import('node:sqlite')` + 不可用时给可执行提示；`typecheck:e2e` 与 `--list` 通过                                                   |
| B4  | `generator.ts` 自适应分支使 `thumbnail` 可等于 `file_path`，而 `toLowQualityUrl` 只豁免 `nikkiphotos_lowquality/highquality`（`VirtualImageGrid.tsx:26-42`）→ `.jpg` 命名的低清自引用被推导成不存在的 `_low.jpg`，DetailPage/DuplicatesPage fallback 必 404           | `VirtualImageGrid.thumb.test.tsx` 新增 2 例：实测返回 `…1654626739_high.jpg` / `_low.jpg` → 红                           | 守卫扩为与主进程 `path-classifier.ts:isGamePlayPhotosPath` 同形的目录特征判定；gallery 15 文件 153 例全绿                                                      |
| B5  | `startup-tasks.ts:632` 的 `typeof ctx.thumbnailGen.resolveExistingThumbnail === 'function'` 生产恒真（`handler-context.ts:23` 标注具体类），方法改名即静默禁用整个启动阶段；存在只因 11 处测试 stub 缺该键                                                            | 静态判定 + `src/main/tsconfig.json` 排除 `**/*.test.ts`（`npm run typecheck` 抓不到漏写，故兜底只会掩盖问题）            | 删除守卫；`_test-helpers.ts` 该键改必填、`MakeCtxOpts.thumbnailGen` 收为 `Partial<>` 并由 makeCtx 统一补默认，11 处调用点零改动即全绿（main 171 文件 3221 例） |
| B6  | **本批未改动、由本轮暴露**：`generator.ts` 的 ffmpeg `'error'` 与 30s 超时分支用 `void removeTempFileQuietly(tmpOutputPath)` 发后不理 → `generate` 返回时半截 `.jpg.tmp-<pid>-<rand>` 仍在缓存目录（`npm run verify` 间歇红灯的真因，§13 记的「1 次未复现观察」即此） | 新增契约用例（推迟「真实删除」本身而非删除完成后）：`expected [ Array(1) ] to have a length of +0 but got 3` → 红        | 两处 `void` → `await`；`src/main/thumbnail` 6 文件 42 例全绿，原 `partialThenFail` 用例的间歇性一并消除                                                        |

同轮更正的记录性错误：§13 的覆盖率归因（见 §15）；`generator.rebind.test.ts` 与 `startup-tasks.test.ts` 头注释里「33 行缓存已在磁盘」的作废读数（更正为「仅 2 行命中现行目录，33 行只命中迁盘前旧目录」）；`perf-real.e2e.ts` 中仍称 `thumbnail:generate` 走「裸 `assertFileReadPath`」的注释（本批已替换为 `assertMediaAccessPath`）。

**审查后判定「不改」并给出理由的三项**

1. `assertMediaAccessPath` 的选择成立。`assertMediaReadPath` 带 `isSensitivePath` 前置闸门（`media-read-guard.ts:66`），而官方启动器默认装在 `C:\Program Files`（`scanner/game-directory-discovery.ts` 候选目录），换读守卫会把 N2 的修复打回原形；残留面（已索引媒体目录内符号链接指向非敏感文件）与本仓库 `assertMediaDeletePath`/导出通道既有取舍同型，不新增暴露类别。
2. `useOnDemandThumbnails` 每结果一次 `setRevision` 的渲染风暴与去重命中仍新挂 `.then`：§10/§12 已按复测证据降级为待测项，本轮不重启。但必须记下一处**新增的行为变化**：`generationResults` 提到模块级后，一次瞬时失败会让该路径在本会话**所有视图**停在占位，且 `force` 也会命中 `generationRequests` 去重而拿不到重生成机会（旧实现为组件态，随重挂载清空）。属可用性权衡，留待下一轮定夺。
3. `media-worker/worker-entry.ts:362/400` 与 B6 完全同形的 `void removeTempFileQuietly`（批量路径泄漏量级更大）。该文件不在本轮任务面内且无失败信号，按最小改动原则不顺手改，登记为 DEBT-033 交接。

**债务变更**：新增 DEBT-032（覆盖率口径，见 §15）、DEBT-033（worker-entry 同形缺陷）、DEBT-034（`braces` 新披露 `GHSA-vfj7-8cjw-p6xm` 无修复版本致 `npm run audit` 红；HEAD 与工作区同为 `braces@3.0.3`，`npm view braces dist-tags` 显示 latest 即 3.0.3，非本批引入，未擅自加豁免）；DEBT-020（Electron 40 EOL）按升级事实关闭。

**审查轮门禁结果（2026-10-10，逐项实测退出码）**

| 门禁                    | 结果         | 明细                                                                                   |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `npm run verify`        | ✓ exit 0     | typecheck / lint / core-gate / format / test 五项全绿                                  |
| `npm test`              | ✓ exit 0     | 5269 passed（较 §13 +1：新增 generator 契约用例）                                      |
| `npm run lint`          | ✓ exit 0     | 0 error / 11 warning（DEBT-030 存量 BOM，约定允许）                                    |
| `npm run typecheck`     | ✓ exit 0     | `tsc -b` + `tsconfig.scripts.json`                                                     |
| `npm run typecheck:e2e` | ✓ exit 0     | 含惰性 import 后的 perf-real                                                           |
| `npm run i18n:guard`    | ✓ exit 0     | 白名单只减不增                                                                         |
| `npm run debt:check`    | ✓ exit 0     | 8 条提醒，「文档已同步 ✓」                                                             |
| `npm run audit`         | **✗ exit 1** | 唯一未豁免 high = `braces` GHSA-vfj7-8cjw-p6xm（DEBT-034，非本批引入，上游无修复版本） |
| `npm run test:coverage` | **✗ exit 1** | 用例全过但四项阈值未达（口径修正所致，DEBT-032 / §15）                                 |

两项红一律**如实登记、不消音**：不降阈值、不加 exclude、不加安全豁免、不跳用例。按第五节一票否决，本轮任务在这两项门禁上判定为未完成。
