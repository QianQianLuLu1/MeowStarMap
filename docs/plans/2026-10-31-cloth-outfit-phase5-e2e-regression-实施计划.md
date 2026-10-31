# 搭配码面板 · 阶段 5：端到端集成与回归 实施计划

> 日期：2026-10-31
> 性质：**纯回归**——不新增功能、不顺手优化、本次不提交（提交由用户后续处理）。
> 前置：阶段 0–4 已完成且工作区含全部未提交改动（src/ 功能 + `docs/IPC_CONTRACT.md` + 本目录 6 份计划/契约文档）。

## 0. 前置事实（探索已确认）

- 冒烟输入直接取自 [`cloth-outfit-data-contract.md`](cloth-outfit-data-contract.md) §3.5 的 **2026-10-31 当天实采码**：
  - A/B 场景：`1aOKp3A5MdA#`（最简形态，9 件、DIY 空对象）
  - C 场景：`zzzz#`（构造无效码，本地校验即拒、不发网络请求）
- 缓存观测锚点：`src/main/services/cloth-diy-cache.ts:66`（debug 级 `[clothDiy] 搭配码缓存命中 hash=…，跳过网络解码`）与 `:86`（`搭配码缓存已写入`）；主进程 stdout 与 `%APPDATA%\meow-star-map\logs\main-YYYY-MM-DD.log` 双路可观测（每日文件含 debug 级）；缓存文件位于 `%APPDATA%\meow-star-map\cloth-diy-cache\<sha256(code)>.txt`。
- 故障观测锚点：`%APPDATA%\meow-star-map\logs\faults-YYYY-MM-DD.jsonl` 无新增行、dev 终端无未捕获异常。
- 6 个受保护文件 `// @core-change:` 注释已就位（decrypt-handler / decryption-service / cloth-data-service / cloth-data-config / cloth-diy-cache / preload/api/decrypt），原因真实（阶段 2/3 口径）。
- `npm run format --check` 不是有效命令（`format` script 本体为 `prettier --write`）；格式检查一律经 `npm run verify` 内置步骤（`prettier --check --end-of-line auto`）。
- 解码 DLL（目标域 `x6cn-clothdiydata.nuanpaper.com`，DLL 自带 DNS）与 gongeo 查询（主进程全局 `fetch`）均无配置覆盖手段，实机断网只能从系统网络层入手。

## 1. 依赖声明

无新增/变更依赖（纯回归阶段）。仅使用仓库既有工具链：vitest、tsx（verify/guard 脚本）、electron-vite dev、eslint/prettier/tsc。实机操作使用宿主侧屏幕自动化能力（非 npm 依赖）。

## 2. 启动说明

- 环境准备：Windows 本机、联网（gongeo 名称映射依赖 `raw.githubusercontent.com`，境内不可达时名称列回退 `#id` 属预期降级，不算缺陷）。
- 启动命令：`npm run dev`（electron-vite dev；renderer 固定 5173；主进程 stdout 直出终端）。
- 验证方式：静态与单测经 `npm run verify` / `npm test`；实机经界面粘贴搭配码 + 日志/缓存目录比对；日志文件在 `%APPDATA%\meow-star-map\logs\`，缓存目录 `%APPDATA%\meow-star-map\cloth-diy-cache\`。

## 3. 错误处理

- 冒烟失败先二分「环境因素 vs 代码缺陷」：网络可达性（nuanpaper.com / gongeo / raw.githubusercontent.com）、dev 档数据缺失、日志落盘位置；以日志 grep 与代码定位佐证。
- 确认为缺陷时执行「红灯→修复→绿灯」闭环（见 §6），环境因素如实记录、不硬凑绿。
- 冒烟期间应用崩溃/白屏：查 `文档\喵星图\Diagnostics\startup-errors.log`、`diag.log` 与 faults jsonl；未恢复前不继续后续场景。

## 4. 参数校验

- 冒烟入参：合法码取契约 §3.5 实采表（7 个），无效码 `zzzz#`；不使用臆造码。
- IPC 入参校验（zod）由既有单测覆盖（`decrypt-handler.lookupCloth.test.ts`、`decrypt-handler.clearClothCache.test.ts`），本阶段不新增校验代码。

## 5. 基础测试用例（回归矩阵）

| 类别 | 场景                             | 输入                 | 预期                                                                                   | 证据                 |
| ---- | -------------------------------- | -------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| 正常 | A 有效码 → 结构化列表            | `1aOKp3A5MdA#`       | clothDiy tab 渲染服饰列表；日志出现「搭配码缓存已写入」                                | 截图 + 当日日志      |
| 边界 | B 二次粘贴缓存命中               | 同码再次粘贴         | 日志出现「搭配码缓存命中…跳过网络解码」；缓存目录文件数不增                            | 日志 grep + 目录对比 |
| 异常 | C 无效码                         | `zzzz#`              | 红点 + invalidClothDiyCode 文案，无崩溃                                                | 截图 + faults 无新增 |
| 异常 | D 断网降级（实机跳过，单测证据） | fetch/网络失败 mock  | success:true + error=networkUnavailable + timestamp 保留；失败不写缓存；渲染层降级文案 | 4 个测试文件全绿     |
| 正常 | E 照片参数解密                   | dev 档带参数照片详情 | decodeFileParams 路径正常（阶段 1 抽 `decomposeClothId` 的最大回归风险点）             | 截图 + 既有单测全绿  |

## 6. 子任务与验收标准

| #   | 任务             | 需修改文件                                                                     | 输入 / 输出            | 验收标准（可判定）                                                                                                                            |
| --- | ---------------- | ------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | 本计划落仓       | `docs/plans/2026-10-31-cloth-outfit-phase5-e2e-regression-实施计划.md`（新建） | 已批准计划 → 文档      | 文件存在；`git status --porcelain` 仅新增该文件                                                                                               |
| T2  | 静态回归         | 无（只读）                                                                     | 命令 → 退出码          | `npm run verify` 5 步全 ✓（含 core-gate）；`npm run typecheck:e2e`、`npm run i18n:guard` 退出码 0                                             |
| T3  | 全量单测         | 无（只读）                                                                     | `npm test`             | 0 failed、无新增 skip（基线 7197 passed / 20 skipped）                                                                                        |
| T4  | D 场景单测证据   | 无（只读）                                                                     | 4 个测试文件           | `decryption-service.test.ts`、`cloth-diy-cache.test.ts`、`cloth-data-service.test.ts`、`ShareCodeDecoderDialog.test.tsx` 全绿，报告摘录用例名 |
| T5  | 实机冒烟 A/B/C/E | 无（只读）                                                                     | npm run dev + 界面操作 | 四场景逐项通过；控制台无未捕获错误；faults 无新增                                                                                             |
| T6  | 汇总收尾         | 本文档（回写 §7 执行记录）；记忆文件                                           | 全部证据 → 报告        | 验收清单逐项结论；`git status --porcelain` 终态 = 工作区原状 + 本文档                                                                         |

## 7. 执行记录（已回写，2026-10-31）

### T1 计划落仓

文档创建后 `git status --porcelain` 40 行 = 原有 39 行 + 本文档。✅

### T2 静态回归

- `npm run verify`：typecheck 8795ms / lint 2573ms / **core-gate 594ms** / format 1279ms / 相关单测（4 文件 131 用例）2663ms —— **5 项全 ✓**。非阻断 ⚠：3 个纯类型/桥文件无匹配套件（`preload/api/decrypt.ts`、`types/decryption.ts`、`shared/types/electron-api.ts`），与阶段 2–4 记录一致。
- `npm run typecheck:e2e` 退出码 0；`npm run i18n:guard`：「白名单只减不增、清零必移除、key 已同步，守卫通过」。✅

### T3 全量单测

`npm test`：**459 文件 / 7197 passed / 20 skipped / 0 failed**，与阶段 4 基线逐位一致，无新增失败与 skip。✅

### T4 场景 D 单测证据（按用户选择实机跳过 D）

4 文件 112 用例全绿。关键用例名：

- `decryption-service.test.ts > decodeClothDiyShareCode > FIX(组17-1) 桥未注入：本地字段照常返回 + 网络解码降级提示`
- `> FIX(组17-1) 桥失败语义：timeout→超时文案，crashed/not-ready→不可用文案`
- `> timestamp 为 0 时返回 undefined，网络 status≠0 时 error 带状态名`
- `> 阶段 3 缓存：网络失败不写缓存，随后成功才写入`
- `> 阶段 3 缓存：命中时即使桥未注入也返回 networkData（离线复用）`
- `cloth-data-service.test.ts > 数据源不可达（fetch reject）→ resolve 空对象而非 reject，且不缓存`
- `ShareCodeDecoderDialog.test.tsx > structured 缺省（离线降级）时保持网络不可用提示，不渲染列表`
- `> lookupCloth 整体失败时列表照常渲染，名称回退 #id`

### T5 实机冒烟（npm run dev + CDP 驱动；A/B/C/E 实机、D 单测证据）

驱动方式说明：computer-use 物理点击在本机环境未送达网页内容，改经 CDP（`--remote-debugging-port=9222`）以 DOM 事件与可信输入驱动；解码→IPC→主进程→DLL→网络→缓存→渲染全链路均为真实路径。

| 场景                    | 结果                                                                                                                                           | 证据                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 有效码 `1aOKp3A5MdA#` | ✅ 结构化列表 9 件渲染（部位/状态/系列/款型齐全；名称列因名称映射源 raw.githubusercontent.com 不可达降级 `#id`，2 个 ID 404 负缓存，均属预期） | 日志 `搭配码缓存已写入 hash=938011ce bytes=164`、`networkData structured: {"clothesCount":9}`；缓存文件落盘；截图 `.cache/phase5-scenario-A.png`                     |
| B 同码再次解码          | ✅ 缓存命中、零网络请求                                                                                                                        | 日志 `搭配码缓存命中 hash=938011ce，跳过网络解码`；gongeo 零新日志（LRU 命中）；缓存目录保持 1 文件                                                                  |
| C 无效码 `zzzz#`        | ✅ 红点 + 「操作失败 / 无效的染色分享码」，无崩溃                                                                                              | 主进程无 clothDiy 网络日志（本地即拒）；faults 无 rendererError                                                                                                      |
| D 断网降级              | ✅（单测证据，实机未验证）                                                                                                                     | 见 T4 用例清单                                                                                                                                                       |
| E 照片参数解密          | ✅ 全屏查看器 + 图片信息面板渲染完整解密参数（光圈 F1/光晕 800%/柔光 36%/亮度 48%/对比度 128%/饱和度 -55% 等）                                 | 主进程日志 `Step 3 status: 0 Success`、参数数组与面板数值逐一对应；`SocialPhoto JSON parse failed → camera-only` 为既有降级分支；截图 `.cache/phase5-scenario-E.png` |

过程偏差记录：

1. dev 实例三次被外部关闭（退出链 `window-all-closed` → `app.exit(0)`，faults 均有 exitDiagnosis 记录）；其中一次经用户确认配合保持窗口后完成场景 E。
2. computer-use 物理点击未送达网页内容（原因未深究，可能与远程桌面/遮挡检测相关），切换 CDP 驱动后全程顺畅；期间出现的 `InvalidStateError: Transition was aborted` 为 View Transition 动画层被中止（窗口非交互前台所致），状态更新照常生效，非应用缺陷，且与本批改动无关（改动不含图库/全屏路径）。
3. 冒烟期间 faults 新增 2 条均为进程退出诊断（exitDiagnosis / stale-evidence，由重启与强杀引发），无任何 rendererError / 未捕获异常。

### 验收清单核对

- [x] `npm run verify` 全绿（含 core-gate）
- [x] `npm test` 全量无新增失败（7197/20 逐位持平基线）
- [x] 冒烟 A/B/C/E 通过、D 以单测证据落档，控制台无未捕获错误
- [x] 6 个受保护文件 `// @core-change:` 注释核对通过（decrypt-handler / decryption-service / cloth-data-service / cloth-data-config / cloth-diy-cache / preload/api/decrypt）
- [x] `git status --porcelain` 终态 = 工作区原状 + 本文档（本次不提交，改动留存待用户处理）

## 附：发现 bug 的修复流程

1. 先在同目录 `*.test.ts` 写能复现的失败测试，确认红灯；
2. 最小修复（用编辑工具直改，受保护文件同步更新 `// @core-change:` 原因为本次真实原因）；
3. 重跑该测试确认绿灯；
4. 立即跑相关测试子集；
5. 全部节点完成后跑全量 `npm test` + `npm run verify`。
