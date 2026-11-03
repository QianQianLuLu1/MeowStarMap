# 2026-11-04 清偿轮审查-验证-2.5.6 重打包实施计划

> 轮次目标：对 2.5.6 重打包（2026-11-02）之后落仓的清偿轮 10 笔提交（`ba82445..468c652`，DEBT-053~059 收口）做全面审查，确认无缺陷后按用户指定顺序跑满六项验证（npm install / build / test / typecheck / e2e:smoke / test:ci-linux）全绿，提交计划与执行记录，复核版本位（2.5.6），按既有配方重打包并取证。
>
> 计划期静态审查结论（已完成）：**未发现需要修复的逻辑错误或规范违规**。审查范围 = `git diff e6af85d..HEAD` 全量（14 文件，+1065/-187），逐文件结论：
>
> | 提交                                         | 内容                                                                                                      | 结论                                                                                                  |
> | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
> | `d384043` fix(hook)                          | DEBT-053：弃权语义落契约访问器 `getMediaRefreshAbortKind`，被取代不再重试 3 次                            | ✅ 语义分离正确；hook 在 `await fetchOnce()` 返回后同步读访问器，JS 单线程下无竞态窗口                |
> | `2ce0396` fix(scripts)                       | DEBT-054：`scripts/verify-asar-target.ts` 单一事实源；`packedMigrationsReadable` 弃递归扫描改 fail-closed | ✅ 纯函数搬迁 + re-export 维持 import 面；T1–T4 钉住 fail-closed 与对照路径                           |
> | `65ea691` perf(db)                           | DEBT-055：`idx_media_files_deleted_dup_type(is_deleted, is_duplicate, file_type)`                         | ✅ `IF NOT EXISTS` 幂等；键序（is_duplicate 居中）有实测读数依据（§10 引用）                          |
> | `8a889d6` fix(store)                         | DEBT-056：整刷收尾不复位 `loadingMore`，复位责任归触底自己的 finally                                      | ✅ 触底各路径（失败/弃权/正常）finally 无条件覆盖，无挂死路径                                         |
> | `e73b8d0` fix(store)                         | DEBT-057：触底弃权判据改按 `mediaCursorWriteSeq`（游标落地代次）                                          | ✅ 四个写入点（setSource / nikkisync 首屏 / 整刷收尾 / 续页推进）闭环；真修掉「弃权式整刷白弃合法页」 |
> | `b2c9a58` test(db)                           | DEBT-059 地基：钉住 countMedia 与 media_count 缓存两条 WHERE 口径分叉                                     | ✅ 明示「修复前亦绿」的证据钉定位，防口径静默漂移                                                     |
> | `ba82445`/`a1515d3`/`ba7c1ac`/`468c652` docs | 计划落仓 / debt-registry 收口 / CHANGELOG 2.5.6 节追加 / 读数回写                                         | ✅ 与代码一致，引用路径均可解析                                                                       |
>
> 工作区状态：干净（无未提交代码）。

## 一、依赖声明

**零新增依赖**。本轮为审查-验证-重打包轮，不改 `package.json` 依赖面。

- `npm install` 按用户要求照跑（既有 lock 满足安装），但按红线配方：install 后必须复核 `package-lock.json` 是否被扰动，并恢复被清空的 `node_modules/@nikkisync` 四条 junction（`npm run link:nikkisync`），再以 `npm run link:nikkisync:check` 确认。

## 二、启动与运行说明

无新增启动面。验证链六项按用户指定顺序执行，逐项记录 EXIT 码与读数：

| #   | 命令                                                                      | 前置                           | 基线（2026-11-01 定版轮）      | 通过判据                                                  |
| --- | ------------------------------------------------------------------------- | ------------------------------ | ------------------------------ | --------------------------------------------------------- |
| 1   | `npm install` → `npm run link:nikkisync` → `npm run link:nikkisync:check` | —                              | four links in place            | EXIT=0 且 `git status --porcelain package-lock.json` 为空 |
| 2   | `npm run build`                                                           | #1                             | —                              | EXIT=0，`dist/` 产物齐                                    |
| 3   | `npm run test`                                                            | #2                             | 463 文件 / 7276 通过 / 20 跳过 | 全绿（本轮新增用例后通过数应略增）                        |
| 4   | `npm run typecheck`                                                       | #1                             | —                              | EXIT=0                                                    |
| 5   | `npm run e2e:smoke`                                                       | #2（dist-guard 需 build 产物） | 16 passed                      | 全绿，含 S4 打包版本断言                                  |
| 6   | `npm run test:ci-linux`                                                   | #1                             | 7293 通过 / 3 跳过             | 全绿                                                      |

任一项红：按输出定位；若涉及代码缺陷，严格 TDD 红-绿闭环（先写复现测试确认红，再最小修复转绿），修复后重跑该项及其下游全部验证。

## 三、错误处理

- **install 剪链兜底**：`@nikkisync` 四条 junction 被清 ⇒ `npm run link:nikkisync` 恢复；lock 被扰动 ⇒ `git checkout package-lock.json` 后重恢复（本机 node 26/npm 11 已知行为，近两轮 lock 零扰动）。
- **dist:win 前解锁判据**：先测 `rm -rf release/win-unpacked.tmp` 能动（=杀软句柄已释放）→ 走标准路径；不能动则等待重测，不启用旁路打包树凑成功。
- **备份时序**：`MeowStarMap-Setup-2.5.6.exe` / `.blockmap` / `latest.yml` / `release/win-unpacked/resources/app.asar` 四件备份必须在 `dist:win` 启动**前**完成（electron-builder 重建 win-unpacked 早于 build 段结束，晚备份拿到的是新包）。
- **verify:dist fail-closed**：27 项 pre-dist-check 与 32 条禁串字节扫描任一失败即整链失败，不做绕过；按失败项定位修复后整链重跑。
- **e2e 真机根**：e2e:smoke 若涉 NikkiSync 用例按既有口径真机根优先（env `NIKKISYNC_GAME_ROOT` 上游 discovery / `NIKKI_NIKKISYNC_GAME_ROOT` 本仓压过设置键，两 env 分工不得设错）。

## 四、参数校验（版本位五处核对清单）

| 声明位                                                                                            | 期望值                                | 计划期实测 |
| ------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------- |
| `package.json:3`                                                                                  | `2.5.6`                               | ✅         |
| `package-lock.json:3` 与 `:9`                                                                     | `2.5.6`                               | ✅         |
| `src/renderer/preview/mock/database-mock.ts:664` `getVersion`                                     | `'2.5.6'`                             | ✅         |
| `release/latest.yml` `version`                                                                    | `2.5.6`（打包自动生成，重打包后复核） | ✅         |
| 文档句：README 徽章 / AGENTS.md / ARCHITECTURE(.en).md / DEVELOPMENT(.en).md / docs/PLUGIN_API.md | `2.5.6`                               | ✅         |

结论：版本号已全部就位为 2.5.6，本轮**只核不改**；重打包后复核 `latest.yml` 双轴。

## 五、基础测试用例

不新造测试——本轮审查未发现缺陷，无 TDD 修复项；验证面即既有测试套件：

- **正常路径**：全量 `npm test`（含清偿轮新增：DEBT-056 整刷收尾不清在途触底 loadingMore、DEBT-057 弃权整刷不白弃合法页、DEBT-053 访问器契约钉 superseded/failed/none 三态、DEBT-059 双 WHERE 口径分叉证据钉、DEBT-054 T1–T4）。
- **异常路径**：同套件内既有失败/弃权/超时/损坏文件用例；`test:ci-linux` 覆盖 CI 宿主语义（path 绑定/平台/cwd/electron 未装等）。
- **边界条件**：e2e:smoke S4 打包版本断言（`app.getVersion()` === package.json 版本）作为「代码改动真的进包」的端到端判据。

## 子任务三要素

### S1 六项验证链

- 涉及文件：无代码改动（只跑命令）；`package-lock.json` / `node_modules/@nikkisync` 允许按兜底恢复。
- 输入/输出：命令 EXIT 码与读数 → 本文档 §10 执行记录。
- 验收标准：六项全 EXIT=0 且读数不低于基线；控制台无新增 Error 级未捕获日志。

### S2 提交

- 涉及文件：本文档（`docs/plans/2026-11-04-clearing-review-verify-2.5.6-repack-实施计划.md`）；如有修复则含对应代码与测试。
- 输入/输出：暂存区 → commit（类型 `docs(plans)`，Conventional Commits，subject ≤72 字符）。
- 验收标准：commit 通过 commitlint 与 pre-commit 钩子；提交后 `git status --porcelain` 无未预期残留。

### S3 版本核对

- 涉及文件：无（只读核对，见 §四）。
- 验收标准：五处声明位逐项 2.5.6。

### S4 重打包

- 涉及文件：`release/` 产物（gitignore 范围）+ 备份目录 `release/build-20261104-clearing-backup/`；本文档回写。
- 输入/输出：`npm run dist:win` 四段链 → 新 `MeowStarMap-Setup-2.5.6.exe`。
- 验收标准：EXIT=0；`latest.yml` version=2.5.6 且 size/sha512 双轴相对备份件均变化；打包态 `npm run e2e:smoke` 全绿（S4 断言过）；`release/win-unpacked/喵星图.exe` 在位。

## §10 执行记录（回写位）

- 待执行后回写：六项验证读数、备份件与新包双轴、遇到的问题与处置。
