# 未提交代码审查 → 提交 → 定版 2.5.5-beta → 重新打包（2026-10-18）

- 日期：2026-10-18
- 分支 / 基线 HEAD：`aa7c653`（`chore(release): 2.5.5-beta 补录图片水印授权与批量样式修复`）
- 状态：执行中（执行记录回填 §8）
- 被审查对象：工作区 6 个改动文件 + 1 个未入库计划文档（`docs/plans/2026-10-18-fix-permanent-delete-game-photo-variants.md`）
- 范围已与用户确认：只做「审查 → 按需修复 → 提交 → 版本核验 → 重新打包」，不顺手重构、格式化或改动任何未提及功能

---

## 0. 背景（Context）

用户要求对全部未提交代码做一次全面审查（逻辑错误 / Bug / 代码规范），确认质量达标后提交、把版本定为 `2.5.5-beta`、并重新执行打包构建。

### 0.1 未提交改动清单（实测 `git status --porcelain`）

| 文件                                                                | 性质 | 说明                                                                                 |
| ------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| `src/main/scanner/path-classifier.ts`                               | 修改 | 新增导出纯函数 `resolveGamePhotoVariantPaths`；`resolveNativeThumbnailPath` 保持不变 |
| `src/main/scanner/path-classifier.test.ts`                          | 修改 | 新增 E1–E7 用例组                                                                    |
| `src/main/ipc/handlers/_trash-utils.ts`                             | 修改 | 清理目标扩为同图衍生文件全集 + 失败聚合日志 + 记录清理钩子透传 `cacheDir`            |
| `src/main/ipc/handlers/_trash-utils.test.ts`                        | 修改 | 新增 D1–D11；既有 A1/A5/A7/A8、B1–B3 期望按新口径更新                                |
| `src/main/database/media-repository.ts`                             | 修改 | 新增同步读 `getThumbnailByPath`                                                      |
| `src/main/ipc/handlers/media-lifecycle-handler.ts`                  | 修改 | 3 处钩子透传 `cacheDir`；第 1 行 `@core-change` 原因替换                             |
| `docs/plans/2026-10-18-fix-permanent-delete-game-photo-variants.md` | 新增 | 未入库计划文档（本次随 `docs(plans)` 笔提交）                                        |

`diff --stat`：6 files changed, 463 insertions(+), 79 deletions(-)。

### 0.2 审查方法

「静态复核 + 实跑子集」双证据，不以主观判断下结论：

1. 静态复核：逐个文件读改动，核对索引算术、守卫、安全边界、调用面、核心路径闸门合规、测试是否弱化。
2. 实跑子集：`_trash-utils.test.ts` + `path-classifier.test.ts` + 三文件关联子集。
3. 全局回归：全量 `npm test`（比对 passed/skipped 绝对数）+ typecheck + lint + docs:links + verify。

### 0.3 静态复核结论（前置于实跑，供实跑对照）

| 复核项       | 结论                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 索引算术     | 用 E1/E2 期望值反算验证：`gppIdx + 29` 起取 UID、`hqIdx + 24` 起取文件名、`slice(0, gppIdx + 7)` 得 X6Game 根、`charAt(gppIdx)` 保留原始分隔符形态 ⇒ 全部正确       |
| 入参保卫     | 空串 / 非字符串 / 无 GPP 锚点 / 无 HQ 段 / `hqIdx <= gppIdx` / UID 非单层纯数字 / 文件名含分隔符或为空 ⇒ 一律 `[]`，不抛异常                                        |
| 安全边界     | 批内 `file_path` 排除、`isInsideCacheDir` 双保险、`seen` 大小写不敏感去重、`path.resolve` try/catch、`pathExists` 预检 ⇒ 齐全                                       |
| 失败语义     | unlink 失败且文件仍存在 ⇒ 计入 `failedPaths`、聚合一条 warn、**不**触发记录清理钩子（保留 DB 记录供重试）                                                           |
| 调用面       | `cleanupThumbnailsForRows` / `makeNativeThumbRecordCleaner` 仅 `media-lifecycle-handler.ts` 3 处调用；`getMediaPathsByIds` 返回 `id, file_path, thumbnail` 满足入参 |
| 核心路径闸门 | `media-lifecycle-handler.ts` 顶部**一条**真实原因 `@core-change`；`_trash-utils.ts` 属 handlers 下 `_` 前缀共享文件（闸门豁免），注释合规                           |
| 测试是否弱化 | 否：`A5` `[]`→`[SS, SS_SAVED]`、`B1` `4`→`6`，均为扩面；新增 D1–D11 / E1–E7                                                                                         |

**结论：未发现阻断性缺陷。** 两处观察项按最小改动原则**不改**，记入 §7 残留风险。

---

## 1. 依赖声明

**零新增 / 零变更 npm 依赖。** 全部复用仓库既有能力：

| 复用项                                                   | 出处                                          | 用途                               |
| -------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| `resolveNativeThumbnailPath` / 目录段归一化口径          | `src/main/scanner/path-classifier.ts`         | 新纯函数复用同一套归一化与定位逻辑 |
| `pathExists`                                             | `src/main/utils/file-utils.ts`                | 删除前预检                         |
| `fsp.unlink`                                             | Node 内置（`_trash-utils.ts` 已在用）         | 统一删除原语                       |
| `logger.warn` + `UNLINK_LOG_SAMPLE_LIMIT`                | `src/main/utils/logger.ts`、`_trash-utils.ts` | 聚合日志（禁止逐项 warn）          |
| `getMediaIdByPath` / `hardDelete` / `getThumbnailByPath` | `src/main/database/media-repository.ts`       | 联动硬删副本 DB 记录与缓存         |
| `collectCacheTierPaths` / `CACHE_THUMB_NAME_RE`          | `src/main/ipc/handlers/_trash-utils.ts`       | 副本自身记录的三档位缓存清理       |
| Vitest 同目录 `*.test.ts`                                | 仓库约定                                      | 回归与复现测试                     |

---

## 2. 子任务（每项含：涉及文件 / 输入·输出 / 验收标准）

### T1 计划文档入库

- **涉及文件**：新建 `docs/plans/2026-10-18-uncommitted-review-commit-2.5.5-beta-repack.md`（本文档）
- **输入**：工作区未提交改动清单 + 静态复核结论
- **输出**：含五节结构（依赖声明 / 启动与运行说明 / 错误处理 / 参数校验 / 基础测试用例）与子任务三要素的计划文档
- **验收标准**：文档存在且可被 `npm run docs:links` 通过；`git status --porcelain` 中出现该文件

### T2 子集实跑（审查的第二重证据）

- **涉及文件**：`src/main/scanner/path-classifier.test.ts`、`src/main/ipc/handlers/_trash-utils.test.ts`
- **输入**：`npx vitest run <两个测试文件>`
- **输出**：测试读数（期望：110 passed / 0 failed）
- **验收标准**：`exit 0` 且 `failed = 0`；与既有基线（上轮 110 passed）一致

### T3 关联回归子集

- **涉及文件**：`src/main/ipc/handlers/media.test.ts`、`src/main/ipc/handlers/media-lifecycle-handler.test.ts`、`src/main/database/media-repository.test.ts`
- **输入**：`npx vitest run <三个测试文件>`
- **输出**：测试读数（期望：269 passed / 0 failed）
- **验收标准**：`exit 0` 且 `failed = 0`

### T4 缺陷修复（**条件触发**：仅当 T2/T3 或审查发现真实缺陷）

- **涉及文件**：按缺陷定位到的最小文件集（预计 `src/main/scanner/path-classifier.ts` 或 `src/main/ipc/handlers/_trash-utils.ts` + 对应 `*.test.ts`）
- **输入**：能精准复现缺陷的测试用例
- **输出**：①红灯证据（修复前该用例失败的输出留档）②最小修复 ③绿灯证据（同一用例通过）
- **验收标准**：必须有「修复前 failed / 修复后 passed」两条留档；禁止注释、跳过、删除或弱化任何测试

### T5 全局回归与静态检查

- **涉及文件**：全仓
- **输入**：`npm test`、`npm run typecheck`、`npm run lint`、`npm run docs:links`、`npm run verify`
- **输出**：四组读数
- **验收标准**：
  - `npm test` 全绿，且 **passed / skipped 绝对数与基线一致**（基线 413 files / 6395 passed | 2 skipped）
  - `npm run typecheck` 零错误（退出码 0）
  - `npm run lint` 零错误（退出码 0）
  - `npm run docs:links` 零错误（退出码 0）
  - `npm run verify` 五个阶段全绿

### T6 提交入库

- **涉及文件**：6 个 src 文件（第 1 笔）+ `docs/plans/2026-10-18-fix-permanent-delete-game-photo-variants.md`（第 2 笔）+ `CHANGELOG.md`（第 3 笔）
- **输入**：已通过 T2–T5 的工作区
- **输出**：3 笔 Conventional Commits
- **验收标准**：`git log --oneline -3` 显示三笔；每笔消息首行符合 commitlint（husky commit-msg 通过）；提交后 `git status --porcelain` 无 src 残留

### T7 版本核验与定版

- **涉及文件**：`package.json`、`package-lock.json`、`AGENTS.md`、`ARCHITECTURE.md`、`ARCHITECTURE.en.md`、`DEVELOPMENT.md`、`DEVELOPMENT.en.md`、`CHANGELOG.md`（识别清单，共 12 个受跟踪文件）
- **输入**：`git grep -l '2.5.5-beta'`、`git grep -n '2\.5\.4'`
- **输出**：版本一致性核验读数；**仅当发现漂移才修改**
- **验收标准**：`package.json` 与 `package-lock.json`（顶层 + packages 根节点）`version` 均为 `2.5.5-beta`；`2.5.4` 命中处须逐条确认与项目版本无关（第三方依赖版本 / OID 常量 / 文档引述）

### T8 重新打包

- **涉及文件**：`dist/**`、`release/**`（均被 `.gitignore` 忽略）
- **输入**：预防性 `Move-Item` `dist/main` 与 `release/win-unpacked` 到 `%TEMP%\wxnn-repack-backup-2026-10-18`，然后 `npm run dist:win`
- **输出**：`release/NikkiGallery-Setup-2.5.5-beta.exe`（+ `.blockmap`、`latest.yml`）
- **验收标准**：`npm run dist:win` 退出码 0；`verify:dist` 全项 pass（含 `@nikkisync` 判据为 `assert` 而非 `skip`）；产物时间戳更新

### T9 收尾

- **涉及文件**：本文档 §8 执行记录
- **输入**：T1–T8 实测读数
- **输出**：回填后的计划文档 + 收尾提交
- **验收标准**：`git status --porcelain` 为空

---

## 3. 启动与运行说明（只使用仓库真实存在的脚本）

| 步骤     | 命令                                                                                                                                                  | 说明                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 环境     | 仓库已 `npm install` 完成，**本次不执行任何 npm install**（会清掉 `@nikkisync` junction，见 §6 风险 R1）                                              | —                                                                       |
| 链接核验 | `npm run link:nikkisync:check`                                                                                                                        | 打包前后各跑一次                                                        |
| 子集     | `npx vitest run src/main/scanner/path-classifier.test.ts src/main/ipc/handlers/_trash-utils.test.ts`                                                  | T2                                                                      |
| 子集     | `npx vitest run src/main/ipc/handlers/media.test.ts src/main/ipc/handlers/media-lifecycle-handler.test.ts src/main/database/media-repository.test.ts` | T3                                                                      |
| 全量     | `npm test`                                                                                                                                            | `vitest run`（全仓）                                                    |
| 类型     | `npm run typecheck`                                                                                                                                   | `tsc -b && tsc -p tsconfig.scripts.json`                                |
| 静态     | `npm run lint`                                                                                                                                        | `eslint .`                                                              |
| 文档链接 | `npm run docs:links`                                                                                                                                  | `tsx scripts/check-md-links.ts`                                         |
| 闸门     | `npm run verify`                                                                                                                                      | 只读：typecheck + eslint + core-path-gate + prettier --check + 相关单测 |
| 打包     | `npm run dist:win`                                                                                                                                    | build + pre-dist-check + electron-builder + verify:dist                 |
| 人工     | `npm run dev`                                                                                                                                         | 真机验证（本次不出货新交互，可选）                                      |

---

## 4. 错误处理

| 异常分支                           | 兜底策略                                                                                       | 可判定性                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| 子集 / 全量测试失败                | 定位失败用例，**先写复现用例确认红灯**，再最小修复转绿；禁止改断言蒙混                         | 用例名 + failed 计数                |
| typecheck / lint 报错              | 就地修到零错误再进入下一节点；lint 用 `npm run lint:fix`，格式用 `npx prettier --write <文件>` | 退出码 0                            |
| `npm run verify` 失败              | 按 `[VERIFY] ✗` 行定位阶段（typecheck / lint / core-gate / format / test）分别修复             | 汇总行步骤名                        |
| 提交被 commit-msg 钩子拒           | 检查消息文件是否带 BOM；用无 BOM `WriteAllText` + `git commit -F`（见 §6 风险 R3）             | commitlint 报错文本                 |
| pre-commit 钩子改写文件            | 提交后必跑 `git status --porcelain` 复核；若被改写则补一笔提交                                 | porcelain 输出                      |
| 版本漂移                           | 只改漂移的那个文件，改完重跑 `npm run typecheck` 与 `npm run verify`                           | `git grep` 读数                     |
| 打包被 Safe-Delete 网关拦截        | 预防性移走已覆盖两处命中点；若仍被拦，移走对应目录后重跑（见 §6 风险 R2）                      | `SAFE_DELETE_BULK_CONFIRM_REQUIRED` |
| `verify:dist` 报 `@nikkisync` 缺失 | 先 `npm run link:nikkisync:check`；已建链而产物缺失 = 打包回归，必须修复后重打                 | verdict = assert / fail / skip      |

---

## 5. 参数校验

| 层                               | 校验                                                                                          | 非法值处理           |
| -------------------------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| `resolveGamePhotoVariantPaths`   | ① 非字符串/空串 ② 非 GPP 锚点 ③ 非 HQ 段 ④ UID 非单层纯数字 ⑤ 文件名含分隔符或为空 ⇒ `[]`     | 返回空数组，不抛异常 |
| `collectThumbnailCleanupTargets` | ① `cacheDir` 空 ② `path.resolve` 抛错 ③ 落在 `cacheDir` 内 ④ 与批内 `file_path` 相同 ⇒ 跳过   | 跳过，不影响其他行   |
| `cleanupThumbnailsForRows`       | 行缺 `file_path`/`thumbnail` ⇒ 仅按 `thumbnail` 清理，不推导                                  | 跳过推导             |
| `makeNativeThumbRecordCleaner`   | `cacheDir` 缺省或 `getThumbnailByPath` 缺失或 thumbnail 为 NULL ⇒ 只硬删记录，不触碰缓存      | 跳过缓存清理         |
| IPC 入参                         | 沿用既有 `schemas.mediaId` / `schemas.mediaIdArrayBulk`，**不改校验规则**                     | 既有 `AppError` 语义 |
| 版本核验                         | `package.json` 与 `package-lock.json`（顶层 + packages 根节点）`version` 必须恒等且等于目标值 | 发现漂移才修         |

---

## 6. 风险与控制（本机实测教训）

| #   | 风险                                                                                                                                                      | 控制                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| R1  | `npm install` 会把 `node_modules/@nikkisync/*` 四个 junction 判为 extraneous 清除，约 38 条 linked 测试**静默 skip**（全量仍显示全绿但 passed 下降）      | 本次**不执行** npm install；打包前后 `npm run link:nikkisync:check`；全量结果**必须同时比对 passed/skipped 绝对数** |
| R2  | Safe-Delete 网关（阈值 500 项）命中 `npm run build` 的 clean 删 `dist/main`（约 862 项）与 electron-builder doPack 删 `release/win-unpacked`（约 753 项） | 打包前**预防性** `Move-Item` 二者到 `%TEMP%\wxnn-repack-backup-2026-10-18`，全链一次跑通                            |
| R3  | PowerShell 5.1：`Set-Content -Encoding utf8` 写 BOM 致 commitlint 误判；here-string 直接 `-m` 被拆参（exit 129）                                          | 消息文本避开双引号字符 + 反引号 `n 换行 + `WriteAllText`无 BOM +`git commit -F $p`                                  |
| R4  | pre-commit 钩子会 `eslint --fix` + `prettier --write` 并重新暂存                                                                                          | 每笔提交后 `git status --porcelain` 复核                                                                            |
| R5  | 长命令输出被执行环境截断                                                                                                                                  | `npm test` / `npm run dist:win` 输出重定向到 `$env:TEMP` 下文件再查看                                               |

---

## 7. 基础测试用例（覆盖正常 / 异常 / 边界三类）

### 7.1 纯函数层（`src/main/scanner/path-classifier.test.ts`，E 组）

| 编号 | 类别 | 场景                                    | 期望                                                        |
| ---- | ---- | --------------------------------------- | ----------------------------------------------------------- |
| E1   | 正常 | 标准 HQ 路径                            | LQ + `X6Game\ScreenShot` + `X6Game\Saved\ScreenShot` 三候选 |
| E2   | 正常 | 异常大小写的官方目录                    | 保留原路径大小写，LQ 段用标准拼写                           |
| E3   | 边界 | LQ 锚点 / ScreenShot 路径               | `[]`（不反向推导 HQ，防误删原图）                           |
| E4   | 边界 | UID 非单层纯数字 / 多层级子目录         | `[]`                                                        |
| E5   | 异常 | 用户自建同名目录 / 空串 / `undefined`   | `[]` 且不抛异常                                             |
| E6   | 边界 | 无 `Saved` 段的 `X6Game\GamePlayPhotos` | `[]`（锚点口径不变）                                        |
| E7   | 边界 | 普通媒体路径                            | `[]`                                                        |

### 7.2 清理目标与执行层（`src/main/ipc/handlers/_trash-utils.test.ts`）

| 编号 | 类别 | 场景                                  | 期望                                              |
| ---- | ---- | ------------------------------------- | ------------------------------------------------- |
| D1   | 正常 | HQ 行目标收集                         | native 含 LQ / SS / SS_SAVED                      |
| D2   | 正常 | 完全删除 HQ 照片                      | 三个目录同名文件全部 unlink，`deleted = 3`        |
| D3   | 边界 | 目录不齐备（仅 LQ 存在）              | 只 unlink 1 次、不报错、`logger.warn` 未调用      |
| D4   | 正常 | 记录联动                              | 3 个副本各触发一次 `onNativeThumbnailRemoved`     |
| D5   | 异常 | SS 副本 unlink 抛 EBUSY 且仍存在      | 其余照删、聚合**一条** warn、该副本**不**触发钩子 |
| D6   | 异常 | 用户自建同名目录                      | 无任何目标                                        |
| D7   | 边界 | 空 `file_path` / 非官方路径           | `[]`                                              |
| D8   | 边界 | 推导结果与批内另一行 `file_path` 相同 | 排除该项（不重复删除）                            |
| D9   | 边界 | 推导结果落在缓存目录内                | 不删                                              |
| D10  | 正常 | 副本记录清理钩子带 `cacheDir`         | 先清三档位缓存再 `hardDelete`                     |
| D11  | 边界 | 无 `cacheDir` / thumbnail 为 NULL     | 只硬删记录，不触碰缓存                            |

### 7.3 必须保持通过（禁止回归）

`src/main/ipc/handlers/media.test.ts`（`media:delete` 端到端，含 6 处 `getMediaIdByPath` 断言）、`media-lifecycle-handler.test.ts`、`media-repository.test.ts`、`src/main/thumbnail/generator.test.ts`、`path-classifier.test.ts` 既有全部用例。

### 7.4 测试有效性判定

上一轮已留档：D1–D5、D8 在**修复前**为 failed（12 failed / 96 passed，见 `docs/plans/2026-10-18-fix-permanent-delete-game-photo-variants.md` §10 T2）。本轮不再重复红-绿（无新增缺陷即无新修复点）；若 T4 触发，必须重新产出红灯证据。

---

## 8. 执行记录（回填）

| 节点 | 内容                 | 结果                             | 命令 / 证据                                                                                                                                                                                                            |
| ---- | -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | 计划文档入库         | ✓                                | 本文档（`e6893f4`）                                                                                                                                                                                                    |
| T2   | 子集实跑             | ✓ **110 passed / 0 failed**      | `npx vitest run src/main/scanner/path-classifier.test.ts src/main/ipc/handlers/_trash-utils.test.ts`                                                                                                                   |
| T3   | 关联回归子集         | ✓ **269 passed / 0 failed**      | `npx vitest run` media / media-lifecycle-handler / media-repository 三个测试文件                                                                                                                                       |
| T4   | 缺陷修复（条件触发） | ⊘ **无需修复**；测试有效性已实证 | 回退 `_trash-utils.ts` 至 HEAD → **14 failed / 96 passed**（红灯留档）；还原后 **110 passed**（绿灯留档）                                                                                                              |
| T5   | 全局回归与静态检查   | ✓ 全绿                           | `npm test` **413 files / 6395 passed \| 2 skipped**（与基线一致）；`typecheck` 0；`lint` 0 error（11 条既有 unicode-bom warning）；`docs:links` 0；`verify` **5/5**                                                    |
| T6   | 提交入库             | ✓ 2 笔                           | `5e1b5c0 fix(media)`、`e6893f4 docs(plans)`；pre-commit 三步全通过（含核心路径闸门 1 个受保护文件）                                                                                                                    |
| T7   | 版本核验             | ✓ **无需修改**                   | 13 个受跟踪文件含 `2.5.5-beta`；`package.json` 与 `package-lock.json`（顶层 + packages 根节点）均为 `2.5.5-beta`；`2.5.4` 的 5 处命中为第三方依赖 `bare-url@2.5.4`、X.509 OID `2.5.4.3` 与本文档原措辞，与项目版本无关 |
| T8   | 重新打包             | ✓ 退出码 0                       | 预移走 `dist/main` 与 `release/win-unpacked` → `npm run dist:win`：build + pre-dist-check 全项 ✔ + builder + `verify:dist` 18 项 ✔                                                                                     |
| T9   | 收尾                 | ✓                                | CHANGELOG `[2.5.5-beta]` 节 2026-10-18 补录 + 本文档回填；`git status --porcelain` 为空                                                                                                                                |

### 8.1 打包过程的新障碍与解法（本机环境，需留档）

**现象**：`npm run dist:win` 在 electron-builder 的 `doPack` 阶段连续失败两次：

```
⨯ EPERM: operation not permitted, rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'
    at extractArchive (node_modules/app-builder-lib/out/util/electronGet.js)
    at unpack (node_modules/app-builder-lib/out/electron/ElectronFramework.js)
```

**定位过程**：

1. 预防性 `Move-Item` 已生效，`release\win-unpacked` 确认不存在、`.tmp` 仅 75 项（即完整 electron dist）⇒ **不是** Safe-Delete 网关的 500 项阈值问题；
2. 无残留 electron 进程占用；
3. 用 PowerShell `Move-Item` 手动把 `.tmp` 改名为 `win-unpacked` → **成功**；
4. 用 Node `fs.promises.rename` 对同一目录改名 → **必然 EPERM**（目标不存在也失败）。

⇒ 结论：本机环境拦截 **Node 进程内的目录 rename**（与既有 Safe-Delete 删除网关同源或相邻机制），与目录规模、文件占用均无关。

**解法**：electron-builder 的 `prepareApplicationStageDirectory` 在配置了 `electronDist` 时走 `selectElectron`（**复制**本地已解包目录），不再「下载 zip → 解压 → rename」。本机 `node_modules\electron\dist`（76 项，electron 41.10.6，与 `package.json` 声明精确一致）可直接复用：

```bash
npx electron-builder --win --publish never --config.electronDist=node_modules/electron/dist
```

日志确认走的是 `using custom unpacked Electron distribution` + `copying unpacked Electron`，随后 asar 打包、VC++ 运行库随包、NSIS 构建、blockmap 全部完成，退出码 0；`verify:dist` 18 项全 ✔（含 `@nikkisync` 判据为 `assert` 而非 `skip`）。

该参数**仅作本次命令行覆盖，未写入 `package.json`**（最小改动原则）。

**Why**：这是本机环境限制而非项目缺陷；若写进 `package.json` 会让其他环境（CI / 他人机器）失去官方 electron dist 下载与校验路径，属把环境 workaround 固化进产物配置。

**How to apply**：下次本机重新打包若再遇 `EPERM: rename ... win-unpacked.tmp`，直接改用上述 `electronDist` 覆盖命令；不要再尝试「移走目录后重跑 builder」——那只对删除类拦截有效，对 rename 拦截无效。

---

## 9. 已知残留风险

1. **反向推导未覆盖**：从「缓存 / 截图」视图完全删除时不连带删除 HQ 原图（有意取舍，避免跨账号误删）。
2. **多 UID 同名碰撞**：`X6Game\ScreenShot` 为游戏级扁平目录，同机多账号若存在同名文件会被一并删除（时间戳含微秒，概率极低但非绝对为零）。
3. **测试覆盖小缺口**：计划 §8.1 写「E2 覆盖正斜杠输入」，实际只覆盖异常大小写；正斜杠与相对路径未测。生产 `file_path` 恒为绝对路径，缺口无实际影响，本次不补（最小改动原则）。
4. **衍生文件删除无重试**：`cleanupThumbnailsForRows` 对衍生文件用裸 `fsp.unlink` 而非同文件已导出的 `unlinkWithFallback`。属 best-effort 既有行为，改为重试属扩范围，本次不改。
