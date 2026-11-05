# 2026-11-05 预提交审查·全量验证·2.5.6 重打包 实施计划

> 状态：执行中（读数回写见 §9）
> 前置调查：工作区 39 项未提交改动（round 6 文档治理 + 衣橱 CDN 外链图功能）；`f2ec28f..HEAD` 13 笔提交（4 笔代码）经预审无阻塞问题；版本四处声明位已全部为 2.5.6。
> 关联：`docs/plans/2026-11-05-audit-verify-2.5.6-repack-实施计划.md`（上轮配方）、`docs/plans/2026-11-05-markdown-inventory-round6-清理与订正.md`（round 6 治理本体）。

## 1. 依赖声明

**无新增依赖。** 全程使用仓库既有 devDependencies（electron-vite / vitest / playwright / tsx / electron-builder）与既有 npm scripts。不执行 `npm ci`；`npm install` 仅用于满足任务清单要求，且每次安装后必须补跑 `npm run link:nikkisync`（npm 会剪断 `node_modules/@nikkisync` 四条 junction，导致 44 个链接门控用例静默 skip 且 `npm test` 仍 exit 0）。

## 2. 环境与启动/运行说明

- 本机：Windows x64，Git Bash，Node v26.3.0，四条 @nikkisync junction 预期在位（开工前用 `link:nikkisync:check` 复核）。
- 验证命令全部来自根 `package.json`（真实存在）：`build` / `test` / `typecheck` / `e2e:smoke` / `test:ci-linux` / `verify` / `dist:win` / `pre-dist-check` / `link:nikkisync(:check)`。
- 打包链：`dist:win` = `build:recycle-helper` → `build` → `pre-dist-check`（27 项，含 `check-doc-versions.ts` + `check-changelog-release.ts` 双闸）→ `electron-builder --win --publish never` → `verify:dist`（原生二进制 + 管理员清单 + 32 条禁串字节扫描，fail-closed）。

## 3. 审查范围与已知发现

**范围**：① 全部未提交改动（15 个计划文档 rename + 台账 + 根目录/docs 文档订正 + 衣橱 CDN 外链图功能代码 + 2 个未跟踪新文件）；② `f2ec28f..HEAD` 的 4 笔代码提交（daaa49d / c9bfcd3 / 229d6bb / df8ab01）。

**已知发现（本轮处理）**：

| 编号  | 级别             | 内容                                                                                                                                                                                                                                                                    | 处置                                                                                        |
| ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| F1    | 必修（文档）     | `CHANGELOG.md` `2026-11-01 账号同步作用域` 条目的计划路径被写成反斜杠转义形式 `2026\-10\-31\-review\-nikkisync\-scope\-fixes\-repack\.md`，与其余 5 处同批改写的未转义写法不一致，复制路径失效                                                                          | 统一为未转义 archive 路径                                                                   |
| F2    | 加固（1 行测试） | `src/main/app/__tests__/window-manager.test.ts:244` CSP 断言只查 `script-src 'self'`，未钉 `img-src` 的 `https://cdn.gongeo.us`；误删放行会导致衣橱/搭配码图静默全破且无测试变红                                                                                        | 既有断言旁补 img-src 包含断言（纯加固，非 Bug 修复，无红灯阶段；测试文件豁免 @core-change） |
| O1–O3 | 记录不修         | ① `missingUnpackCoverage` 子串包含判定的理论漏报方向（有单测提醒）；② `nikkisync-unpacked-external-deps.test.ts` 两例在 CI 无链接时早退平凡通过（打包态由 `pre-dist-check --verify-asar` 兜底）；③ ShareCodeDecoderDialog img 缺 `referrerPolicy`（先例不一致，非缺陷） | 遵循最小改动，不动代码                                                                      |

**已排除的疑点**：CSP 双写位（`window-manager.ts:22-24` + `index.html:12`）均已放行 `https://cdn.gongeo.us`（img-src），衣橱外链图无运行时拦截风险；衣橱 `<img>` 全部经 `cdnImageUrl()` 构造、onError 有界（失败集合 + 目录重载清空，非循环）、lazy + no-referrer 齐全；offline-guard 批准主机机制（精确 host + 仅 https + 拒伪冒/子域/混合）自洽。

## 4. 子任务三要素

### T0 落盘本计划文档

- 涉及文件：`docs/plans/2026-11-05-precommit-audit-fix-repack-2.5.6-实施计划.md`（本文件）。
- 输入/输出：无代码影响；输出为可执行计划文档并单独提交（C0，`docs(plans)`）。
- 验收标准：commitlint 通过；`git status --porcelain` 中仅剩既有的未提交改动集。

### T1 修复 F1（CHANGELOG 转义路径统一）

- 涉及文件：`CHANGELOG.md`（1 行）。
- 输入/输出：转义串 → 未转义 `docs/plans/archive/2026-Q4/2026-10-31-review-nikkisync-scope-fixes-repack.md`；不新增/删除任何条目行。
- 验收标准：`grep -c '\\-' CHANGELOG.md` 中该条不再含转义连字符；`npx tsx scripts/check-changelog-release.ts` exit 0（[2.5.6] 节在、[Unreleased] 无条目）；`npm run verify` 全绿。

### T2 修复 F2（CSP img-src 断言加固）

- 涉及文件：`src/main/app/__tests__/window-manager.test.ts`（既有 CSP 断言处补 1 条断言）。
- 输入/输出：无生产代码改动；断言 `img-src` 指令包含 `https://cdn.gongeo.us`。
- 验收标准：`npx vitest run src/main/app/__tests__/window-manager.test.ts` 单文件全绿；`npm run verify` 全绿。

### T3 六项验证（用户指定顺序，逐项记录读数）

| #   | 命令                    | 验收标准                                                                                                                                                  | 风险预案                                                                              |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `npm install`           | exit 0；随后 `npm run link:nikkisync` + `:check` four links in place；`git diff --stat package-lock.json` 零扰动（否则 `git checkout package-lock.json`） | lock 若被规范化先还原再继续                                                           |
| 2   | `npm run build`         | exit 0，`dist/main/main/app/index.js` 在位                                                                                                                | —                                                                                     |
| 3   | `npm test`              | exit 0；文件数 ≈470（基线 469 + 新增 cdnImageUrl.test）；3 个链接门控文件 passed 非 skipped（无静默 skip 增长）                                           | 链接丢失 → 补链重跑                                                                   |
| 4   | `npm run typecheck`     | tsc -b + tsconfig.scripts.json 零错误                                                                                                                     | —                                                                                     |
| 5   | `npm run e2e:smoke`     | ≥19 passed（真机根优先；不弱化断言、不带 skip 掩盖）                                                                                                      | 合成 exe 被杀软隔离 → 真机根/env 口径处置                                             |
| 6   | `npm run test:ci-linux` | ≈7530+ passed / 3 skipped                                                                                                                                 | `sync-server.linked.test.ts` ECONNRESET → 三步判噪（单文件重跑→整链重跑），不弱化测试 |

### T4 分批提交

- C1 `docs(plans): markdown 盘点 round 6 归档治理与全仓引用订正`：15 个 rename（含 RM 内容订正）+ `docs/plans/archive/README.md` 台账 + 根目录 6 文档 + `docs/CODING_CONVENTIONS.md` / `docs/PLUGIN_API.md` / `docs/debt-registry.json` / 教程 + round6 计划文档 + `recycle-helper.cs` 与 2 个 gallery 测试的注释路径 + CHANGELOG 路径改写（含 F1）。
- C2 `feat(resonance): 衣橱六类实体图片走 cdn.gongeo.us 热链并失败回退`：**必须含两个未跟踪新文件** `src/renderer/utils/resonance/cdnImageUrl.ts` / `.test.ts` + `WardrobeView.tsx` / `.test.tsx` + `offline-guard.test.ts` + `window-manager.test.ts`（F2）+ CHANGELOG `[2.5.6]` 节台账追加一行（`> 2026-11-05 追加：…`；**[Unreleased] 必须保持空壳**，否则打包闸门红）。
- C3（打包后）`docs(plans): 回写预提交审查与 2.5.6 重打包读数`：本文件 §9。
- 每笔提交后 `git status --porcelain` 复核钩子未留意外改动；subject ≤72 字符、body 每行 ≤120。

### T5 定版 2.5.6 确认（不改动版本）

- 涉及文件：无（四处声明位已是 2.5.6）。
- 输入/输出：运行 `npx tsx scripts/check-doc-versions.ts` 与 `npx tsx scripts/check-changelog-release.ts`，双闸显式确认 exit 0。
- 验收标准：双闸 exit 0；`package.json` / `package-lock.json`(×2) / `database-mock.ts` / CHANGELOG `[2.5.6]` 节 grep 复核一致。

### T6 重新打包

1. **先备份四件**（备份必须先于清树，否则拿到的是新包）：`release/MeowStarMap-Setup-2.5.6.exe` + `.blockmap` + `latest.yml` + `win-unpacked/resources/app.asar` → `release/build-20261105-precommit/`。
2. 解锁探针：`rm -rf release/win-unpacked.tmp` 能动 → 走标准路径；随后 `rm -rf release/win-unpacked*`。
3. `npm run link:nikkisync:check` → `npm run dist:win`。
4. 记录新包 size/sha512 双轴（对比旧包 184,896,290 B）。
5. 打包后再跑 `npm run e2e:smoke`（S4 断言包内 `app.getVersion()` === 2.5.6）。

## 5. 错误处理与兜底

- 任一验证命令失败：当场修复后重跑该项，不累积到下一步；禁止跳过/注释测试/弱化断言。
- `verify` 与 pre-commit 口径差异：verify 更严（可自动修复项也判失败）→ 先 `npm run verify` 全绿再 commit，钩子改写后用 `git status --porcelain` 复核。
- 打包树被杀软句柄锁死：等待释放重试（上轮已自愈），不上旁路打包树凑成功。
- e2e 合成根被实时隔离：优先真机根（env 口径同 `runtime.e2e` 的 resolveGameRoot），合成兜底带环境自检。

## 6. 参数校验要点

- 本任务无新增业务入参面；T1/T2 的改动均为字面量级，无边界值处理新增。
- 复用既有校验闸门作为参数面守卫：`pre-dist-check` 27 项、`check-changelog-release.ts`（版本节存在/唯一/Unreleased 空）、`check-md-links.test.ts`（引用不断链）。

## 7. 基础测试用例（三分类覆盖）

- **正常路径**：`npm test` 全量（≈7550+ 用例）+ `e2e:smoke` ≥19 例 + `test:ci-linux` 全量，全部 exit 0。
- **异常路径**：F2 断言的守护对象（误删 img-src 放行 → window-manager 测试红）；offline-guard 伪冒主机反向用例（既有）；ECONNRESET 判噪流程演练。
- **边界条件**：链接门控文件在装/未装两种形态下的 skip 行为；打包态 S4 版本断言（`app.getVersion()` === 2.5.6）；`check-changelog-release` 对 [Unreleased] 空壳的放行。

## 8. 变更文件清单汇总

代码：`WardrobeView.tsx`、`WardrobeView.test.tsx`、`offline-guard.test.ts`、`cdnImageUrl.ts`(新)、`cdnImageUrl.test.ts`(新)、`window-manager.test.ts`、`recycle-helper.cs`、`FullscreenViewer.topbarFix.test.tsx`、`SlideshowPlayer.topbarNoDrag.test.tsx`（后两者仅注释路径）。
文档：根目录 6 份 + `docs/` 3 份 + `docs/plans/` 活跃 4 份订正 + 15 个 rename + archive 台账 + 本文件。
CHANGELOG：F1 去转义 + `[2.5.6]` 台账追加 1 行（[Unreleased] 不动）。

## 9. 读数回写

### 9.1 审查与修复（T0–T2）

- 预审结论与范围见 §3；执行期逐文件复读未发现新缺陷，仅落地 F1 + F2。
- C0 `ae941fd`（计划落盘 + 15 份归档 rename 随批）、C1 `4fb2e4f`（round 6 治理 28 文件 +367/−127）、C2 `7575082`（衣橱功能 7 文件 +639/−25）；每笔提交后 `git status --porcelain` 干净，commitlint 通过（各 1 条 body 行长 ⚠ 非阻断）。
- 提交后全量回归：`npm test` **471 文件 / 7544 passed / 20 skipped**（md-links 闸门在全部入库后绿）。

### 9.2 六项验证（T3，2026-11-05 08:18–08:27）

| #   | 命令                    | 读数                                                                                                                                                                | 判定 |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | `npm install`           | exit 0；lock 零扰动（仅行尾规范化，已 checkout 还原）；四条 @nikkisync junction 照例被剪、`link:nikkisync` 复原、`:check` OK；better-sqlite3 装载探针 OK            | ✅   |
| 2   | `npm run build`         | exit 0，5.22s，`dist/main/main/app/index.js` 在位                                                                                                                   | ✅   |
| 3   | `npm test`              | **471 文件 / 7544 passed / 20 skipped / 0 failed**（跳过数与 11-04 基线 20 持平，无静默 skip 增长；首轮 1 例 md-links 红为闸门强制同批入库，提前 `git add` 后转绿） | ✅   |
| 4   | `npm run typecheck`     | exit 0（tsc -b + tsconfig.scripts.json 零错误）                                                                                                                     | ✅   |
| 5   | `npm run e2e:smoke`     | **19 passed**（41.3s，S1–S8 含 S4 版本断言）                                                                                                                        | ✅   |
| 6   | `npm run test:ci-linux` | **471 文件 / 7561 passed / 3 skipped / 0 failed**（ECONNRESET 未复现）                                                                                              | ✅   |

### 9.3 定版 2.5.6 确认（T5）

- 四处声明位 grep 终确认：`package.json:3`、`package-lock.json:3` 与 `:9`、`database-mock.ts:664`（`getVersion: async () => '2.5.6'`）、`CHANGELOG.md:24`（`## [2.5.6] - 2026-11-01`）。
- 双闸 exit 0：`check-doc-versions.ts`（README Electron 版本 41.10 与 package.json 一致）、`check-changelog-release.ts`（15 个版本节、[2.5.6] 存在且唯一、[Unreleased] 已收口）。

### 9.4 重打包（T6）

- 旧包双轴（备份于 `release/build-20261105-precommit/`）：exe 184,896,290 B，sha512 `3lA6wUM3Xo0ply59qcnN6gS4LlaY/8qbHAVcozLBZTyQoTLWRY43b2l9GNBI5DwWsTu2ZPC3bs8HxviQCSY2NQ==`（releaseDate 2026-11-04T12:23Z）；app.asar 73,080,397 B。
- 清树探针：`rm -rf release/win-unpacked*` 直接成功（杀软句柄未锁），走标准路径；`link:nikkisync:check` four links in place。
- `npm run dist:win`：**exit 0**（build:recycle-helper → build 989 模块 → pre-dist-check 全部校验通过（含 changelog/doc-versions 双闸）→ electron-builder NSIS x64 → verify:dist 解包产物校验通过；日志 `.cache/dist-win-20261105-precommit.log`）。
- 新包双轴：**184,896,162 B / sha512 `VonbOeWxWKln+5u6UKZEmiEpdlXL3mHDlL6iwLiPEq1AuieGt7LV/A0reNk3NzWBwrCCozvNg5Yz5b5lG3fvVg==`**（旧包 184,896,290 B / `3lA6wUM3…`，size/sha512 双轴均变 ⇒ 非空重跑判定成立）；releaseDate 2026-11-05T00:38Z。
- 打包后 `npm run e2e:smoke`：**19 passed**（40.3s，S4 断言包内 `app.getVersion()` === 2.5.6）。
