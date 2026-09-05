# 修复计划：缓存/重复文件板块视频缩略图纯白（thumbnail=NULL 四重门控）

> 状态：已批准（2026-09-05）。本计划按节点推进，每个节点严格「红灯测试 → 修复 → 绿灯」。

## 0. 根因（已用真实 DB + 代码证据确认）

"缓存"页 = `App.tsx:288-290` 复用 GalleryPage（按 `media_source` 过滤），游戏视频位于
`...\X6Game\Saved\GamePlayPhotos\{uid}\Videos\{ts}\{ts}.Mp4`，落入缓存视图；真实数据库中这批视频
`thumbnail` 列全为 NULL → 渲染端显示"底色卡片（--bg-tertiary）+ 播放图标占位"，视觉即纯白。
四道彼此独立的门控导致无任何链路能为它们补上缩略图：

1. **扫描不写**：`src/main/scanner/worker-entry.ts:980-1001` 视频分支不填 thumbnail（设计如此）；
2. **批量补算 SQL 误伤**：`src/main/media-worker/worker-entry.ts:479` 与 `src/main/app/startup-tasks.ts:298`
   的 `NOT LIKE '%/x6game/saved/gameplayphotos/%'` 豁免本意只放过"已有游戏原生低清图"的**照片**，
   把同树下的**视频**也一并排除；
3. **主进程 generate() 硬豁免**：`src/main/thumbnail/generator.ts:319-330` 对 GamePlayPhotos 路径
   "禁用生成是硬性需求"——视频无原生 LQ 可推导，直接返回 null。这正是重复文件页已有按需生成
   （`DuplicatesPage.tsx:1564-1590`）却依然白屏的直接原因（主进程返回 null）；
4. **启动修复路径双重失效**：`rowsToRepair`（`startup-tasks.ts:573-577`）不选"尺寸齐全+thumbnail=NULL"的行；
   即使选中，`processThumbnailForRow` 以 **5 个绑定参数** `run(width,height,thumbnailPath,phash,row.id)`
   执行 **4 占位符**语句（`thumbnail-phash-service.ts:61` vs `startup-tasks.ts:523-525`）→
   better-sqlite3 RangeError 被 try/catch 静默吞掉（真实日志每次启动复现）。

`.cov`（实为 `{ts}_cover.jpeg`，图片类型）走 `thumbnail || file_path` 回退显示原图，所以正常；
dcab16c 的白帧自愈只覆盖 `thumbnail != NULL` 的行，管不到本批 NULL 行。
worker 侧抽帧已带同构 seek 阶梯 [0,1,3s]（`media-worker/worker-entry.ts:237-280`），
修复后不会写入新白帧。

## 1. 依赖声明

**无新增/变更依赖**。全部复用既有：vitest、@testing-library/react、jsdom（均已配置）。
IPC 契约无变化（`thumbnail:generate` 通道与签名不变），无需更新 `docs/IPC_CONTRACT.md`。

## 2. 启动说明与验证方式

- 环境：Node ≥ 18，`npm install`（依赖已锁定），无需额外准备。
- 单测验证：`npx vitest run <文件>`（节点级）→ `npm run test:main` / `npm run test:renderer` → `npm test`（全量）。
- 静态检查：`npm run typecheck`、`npm run lint`。
- 运行时验证（尽力而为）：`npm run dev` 启动后查看日志（`%APPDATA%\wxnn-photo-manager\logs\main-*.log`）——
  不再出现 `[Thumbnail] 处理文件失败`（RangeError），出现 GamePlayPhotos 视频补算记录；
  "缓存/重复文件"页视频缩略图正常显示。注意：dev 运行会写真实 DB（生成缩略图），这正是修复目的。

## 3. 实施节点

### 节点 1：修复 processThumbnailForRow 绑定参数不匹配

- 文件：`src/main/services/thumbnail-phash-service.ts`（唯一调用方 `startup-tasks.ts:581`，语句 4 占位符）。
- 输入/输出：输入 `row{id,file_path,file_type}` + updateStmt；输出 boolean；副作用 UPDATE 4 字段
  （width,height,thumbnail,id）。phash 不在此处写（worker 批量任务统一带 mtime/size 补算，
  避免写出"无 mtime 的 phash"造成 stale 重算）。
- 红灯：改写 `src/main/services/thumbnail-phash-service.test.ts` 的 run 参数断言为 4 参、
  并断言 `calculatePHash` 不再被调用 → 运行确认失败。
- 修复：`updateStmt.run(width, height, thumbnailPath, row.id)`；删除 phash 变量与 `calculatePHash` import；
  同步更新 `startup-tasks.ts:595-596` 注释（隐患已消除）。
- 绿灯/验收：`npx vitest run src/main/services/thumbnail-phash-service.test.ts` 通过；
  `npx vitest run src/main/app/__tests__/startup-tasks.test.ts` 不回归。

### 节点 2：generate() 放行 GamePlayPhotos 下的视频

- 文件：`src/main/thumbnail/generator.ts:313-330`。
- 修复：豁免条件改为 `isGamePlayPhotosPath(filePath) && !isVideoExt(ext)`（ext 提前计算）。
  图片豁免行为不变；视频改走正常 doGenerate（内容 hash 缓存 + seek 阶梯抽帧 + 纯色自愈），
  `quality='high'` 时沿用既有视频降级 standard（:407-409）。
- 红灯：改写 `src/main/thumbnail/generator.test.ts:382` 用例
  （"GamePlayPhotos 视频子目录 → 早退返回 null"改为"→ 走正常抽帧生成返回缓存路径"）→ 运行确认失败。
- 绿灯/验收：`npx vitest run src/main/thumbnail/generator.test.ts` 全部通过
  （含既有图片豁免用例，证明图片行为未变）。

### 节点 3：批量补算 SQL 放行 gameplayphotos 下的视频（进度分母同口径）

- 文件：`src/main/media-worker/worker-entry.ts:477-481`、`src/main/app/startup-tasks.ts:297-298`（THUMB_QUERY）。
- SQL 变更：两个 NOT LIKE 各自包为
  `(NOT LIKE '%/x6game/saved/gameplayphotos/%' OR file_type = 'video')` 与
  `(NOT LIKE '%/x6game/gameplayphotos/%' OR file_type = 'video')`。
  图片豁免与 dimRows（仅图片的尺寸补读）不变。
- 红灯：`src/main/media-worker/worker-entry.test.ts` 新增用例（断言 SELECT 含 `OR file_type = 'video'` 例外、
  视频行被处理且图片行仍被排除）；`startup-tasks.test.ts` 新增 THUMB_QUERY 同口径断言 → 运行确认失败。
- 绿灯/验收：两个测试文件全部通过；既有 SQL 形态断言（NOT LIKE 仍存在）继续通过。

### 节点 4：渲染端网格对无缩略图视频按需生成

- 新文件：`src/renderer/hooks/useVideoThumbGenerate.ts` —— 模块级 `Map<file_path, string|null>` 单次守卫
  （null 不重试，防风暴）；输入 `items: MediaFile[]`，输出 `Map<file_path, thumbPath>`；
  仅对 `file_type==='video' && !thumbnail && file_path 非空` 的项调用
  `window.electronAPI.thumbnail.generate`（Promise<string|null>）；卸载 cancelled 守卫。
  逻辑对齐 `DuplicatesPage.tsx:1564-1590`。
- 修改：`src/renderer/components/gallery/VirtualImageGrid.tsx` —— 组件内调用 hook；`itemContent`
  以 `effectiveThumbnail = file.thumbnail ?? generatedThumbs.get(file.file_path)` 替换三处 `file.thumbnail`；
  **视频分支仍绝不回退 file_path**。
- 红灯：`VirtualImageGrid.thumb.test.tsx` 结构断言更新为新表达式 + 新增"hook 已接入"断言（先失败）；
  新建 `src/renderer/hooks/useVideoThumbGenerate.test.tsx`（renderHook + electronAPI stub，先因模块不存在失败）。
- 绿灯/验收：`npx vitest run src/renderer/hooks/useVideoThumbGenerate.test.tsx
src/renderer/components/gallery/VirtualImageGrid.thumb.test.tsx
src/renderer/pages/DuplicatesPage.videoThumb.test.tsx` 全部通过。

### 节点 5：全量回归与静态检查

- `npm run test:main` → `npm run test:renderer` → `npm test`（全量）→ `npm run typecheck` → `npm run lint`，
  无新增失败项。

### 节点 3b：启动修复路径接管 thumbnail=NULL 的视频存量行（实施中发现的第五道门控）

- 背景（端到端验证时发现）：批量补算被 `runPostScanIndexing` 的 `filesFound > 0` 门控
  （`startup-tasks.ts:223`，与原行为一致的既有设计）——增量扫描 0 新增时批量不跑；
  若用户不再录新视频，节点 3 的批量永远不会执行，仅剩渲染端按需生成（不写库）兜底。
- 修复：`cleanupAndRepairDatabase` 的 `rowsToRepair` 过滤条件追加
  `row.file_type === 'video' && row.thumbnail == null`（图片行为不变）。
  启动必跑的修复路径由此接管存量行：processThumbnailForRow（节点 1 已修复执行能力）
  → thumbnailGen.generate（节点 2 已放行）→ 写库 → 广播 media:updated。
- 红灯：`startup-tasks.test.ts` 用例 20b（视频 NULL 行进入修复、图片 NULL 行不进入）。
- 绿灯：该文件 51/51 通过。
- 端到端验证：真实 DB 中 6 条 `GamePlayPhotos\...\Videos\*.Mp4` 启动一次后 thumbnail 全部落定
  （与旧路径同内容副本命中同一 `{hash}.jpg` 缓存），日志 `[Cleanup] 修复 12 条缩略图记录`
  且不再出现 `[Thumbnail] 处理文件失败`。

## 4. 错误处理与兜底

- generate 失败/返回 null：渲染层保持占位图标（现状语义），模块缓存 null 防止重复请求风暴；
- 修复路径异常仍由 `thumbnail-phash-service.ts:63-66` try/catch 捕获记日志；
- worker 单文件超时兜底沿用 `withFileTimeout`（worker-entry.ts:68）；
- 渲染端 effect 卸载 cancelled 守卫；
- media:// 协议对新生成缩略图（缓存目录内）直接放行，URL 全新无一年强缓存旧字节问题；
  dcab16c 的 clearCache 兜底保持不动。

## 5. 参数校验

- hook：`file_path` 必须为非空 string 才触发；`file_type` 取 DB 枚举；
- 主进程：`thumbnail:generate` 既有 zod `schemas.filePath` + `assertFileReadPath`（PathGuard）不变；
- SQL：仍为参数化语句，绑定参数数量与占位符严格一致。

## 6. 测试用例矩阵（正常/异常/边界）

- 正常：图片/视频经修复路径成功写库（4 参）；GamePlayPhotos 视频生成返回缓存路径；
  批量 SQL 选中 GamePlayPhotos 视频并 UPDATE；hook 生成成功且单次调用。
- 异常：generate 返回 null / reject → 占位、null 缓存不重试；修复路径 generate 失败返回 false 不中断；
  hook 中 electronAPI 缺失 → no-op。
- 边界：GamePlayPhotos 图片（原生 LQ 存在/缺失）行为不变；`quality='low'/'high'` 下视频行为不变
  （high 降级 standard）；视频无 thumbnail 且生成未完成 → 仅占位、绝不回退 .mp4；
  缩略图本就存在的视频不触发 hook 生成；THUMB_QUERY 与 worker 批量 SQL 口径一致。

## 7. 明确不做的事（最小改动边界）

- 不改扫描器（不为视频在扫描时写 `_cover.jpeg`，补算链路统一负责）；
- 不重构 DuplicatesPage 已验证的按需生成（generator 放行后自然恢复）；
- 不动 media:// 一年强缓存策略、不动 dcab16c 白帧自愈链路；
- 不做无关格式化/重构。

## 8. 残留风险（如实告知）

- 三位点全白视频（0/1/3s 都纯色）仍保留白帧——dcab16c 已知边界，本计划不扩大；
- 若运行的是修复前的安装版，需重新打包/重启后批量补算才生效；
- PathGuard 若未注册对应扫描根，generate 会被拒绝（AppError.forbidden）→ 前端占位不崩溃；
  实际场景中扫描根已注册。
