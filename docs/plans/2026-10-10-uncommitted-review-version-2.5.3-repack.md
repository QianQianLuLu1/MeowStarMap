# 未提交代码复核 + 版本 2.5.3 核验 + 重新打包（2026-10-10）

## 1. 背景与结论

任务来源：用户要求对项目所有未提交代码做全面审查（逻辑错误 / Bug / 规范），有问题先修复再提交，随后将版本配置文件设定为 2.5.3，最后重新执行打包构建。

**探明事实（计划制定时点，2026-10-10）**：

- 工作区干净：`git status --porcelain=v1`、`git diff HEAD --stat`、`git diff --cached --stat`、`git stash list` 均为空，HEAD 为 `b9b777e fix(renderer): 任务终态进度浮窗延时 3 秒自动平滑关闭`。当前**不存在未提交代码**可审查。
- 版本已全线是 2.5.3：`package.json:3` 与 `package-lock.json:3` 同步；electron-builder 配置内嵌于 package.json，`artifactName: NikkiGallery-Setup-${version}.${ext}`（`package.json:258`）自动注入版本；源码统一经 `app.getVersion()` 动态取版本（`src/main/ipc/handlers/app-handler.ts:36-39` 等），无硬编码漂移；预览 mock `src/renderer/preview/mock/database-mock.ts:664` 亦为 `'2.5.3'`。
- 打包链：`npm run dist:win` = `build` → `pre-dist-check`（13+ 项闸门）→ `electron-builder --win --publish never` → `verify:dist`（`package.json:39`）。

**因此本任务形态**：审查与版本设定均为"核验"而非修改；真正产出为一次全新的 2.5.3 安装包构建 + 全量回归佐证。若执行时点复核发现工作区出现改动，切换到审查分支（见 §4 分支 A）。

## 2. 依赖声明

- **零新增依赖**。全部使用仓库既有 devDependencies 与 npm scripts：`typescript`、`eslint`、`vitest`、`audit-ci`、`electron-vite`、`electron-builder`、`tsx`。
- 无新增环境变量；兜底场景才注入 `ELECTRON_BUILDER_BINARIES_MIRROR`（electron-builder 二进制国内镜像，`DEVELOPMENT.md:574`）。

## 3. 启动与运行说明

无需额外环境准备（node >= 22.12、依赖已安装）。执行命令均为仓库既有脚本：

```bash
git status --porcelain=v1          # 步骤 2：改动复核
npm run typecheck                  # 步骤 4：tsc -b + tsconfig.scripts.json
npm run lint                       # 步骤 4：全量 eslint
npm test                           # 步骤 4：全量 vitest
npm run audit                      # 步骤 4：audit-ci 安全检查
npm run dist:win                   # 步骤 5：四步打包链（后台运行）
```

产物位置：`release/NikkiGallery-Setup-2.5.3.exe`（`${version}` 注入）。

## 4. 子任务与验收标准（三要素）

### 4.1 复核未提交改动（执行时点）

- **涉及文件**：无（只读）；分支 A 下才产生修复文件。
- **输入 / 输出**：输入为 `git status` / `git diff HEAD` / `git diff --cached`；输出为结论记录（分支 B：无改动；分支 A：逐文件审查意见 + 修复）。
- **验收标准**：结论写入本文件 §7；分支 A 下每个修复均有 TDD 红绿记录且 `npm run verify` 通过后独立提交。

### 4.2 版本一致性核验（只读）

- **涉及文件**：无（只读）。核验对象：`package.json`、`package-lock.json`、`src/` 下版本字符串、electron-builder `artifactName`。
- **输入 / 输出**：输入为 grep / 读取结果；输出为核验结论（预期：全部 2.5.3，无漂移）。
- **验收标准**：`package.json` 与 `package-lock.json` 的 version 均为 `2.5.3`；`grep -rn "2\.5\.[0-9]" src/` 命中处均为 mock / 测试桩 / 历史标注，无当前版本漂移。任何不一致才修改并走 TDD。

### 4.3 全局回归与静态 / 安全检查

- **涉及文件**：无（只读检查）。
- **输入 / 输出**：输入为当前代码基线；输出为四项命令退出码与结果记录。
- **验收标准**：`npm run typecheck`、`npm run lint`、`npm test`、`npm run audit` 全部退出码 0。已知 flaky：thumbnail ffmpeg 用例在全量并发下偶发（历史经验），失败先单独重跑甄别，真实失败才修（走 TDD），甄别结论记入 §7。

### 4.4 打包与产物验收

- **涉及文件**：无源码改动；产出 `release/NikkiGallery-Setup-2.5.3.exe` 及 `release/win-unpacked/`。
- **输入 / 输出**：输入为步骤 4 全绿的代码基线；输出为安装包 + `verify:dist` 通过记录。
- **验收标准**：`npm run dist:win` 四步链全部退出码 0；`release/NikkiGallery-Setup-2.5.3.exe` 存在且 mtime 为本次构建时间；`verify:dist`（链内）确认 asar 解包后 better-sqlite3 / sharp / koffi 二进制与 4 个 VC++ DLL 齐备。

### 4.5 计划文件与执行记录提交

- **涉及文件**：本文件（`docs/plans/2026-10-10-uncommitted-review-version-2.5.3-repack.md`）。
- **输入 / 输出**：输入为 §4.1–§4.4 执行结果；输出为含执行记录的本文件入仓提交（`docs(plans): …`）。
- **验收标准**：提交后 `git status --porcelain` 为空；commit-msg 钩子（commitlint）通过。

## 5. 错误处理与兜底

| 异常分支                                                        | 兜底策略                                                                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build 的 clean 步骤 EPERM（本机已知，`DEVELOPMENT.md:120-128`） | 分步执行：`npx electron-vite build`（自动写 dist/main/package.json）→ `npm run pre-dist-check` → `npx electron-builder --win --publish never` → `npm run verify:dist` |
| electron-builder 二进制下载失败                                 | 注入 `ELECTRON_BUILDER_BINARIES_MIRROR` 后重试                                                                                                                        |
| 全量测试偶发失败（thumbnail ffmpeg 并发）                       | 单独重跑该用例甄别 flaky 与真实失败；真实失败走 TDD 修复                                                                                                              |
| pre-dist-check 闸门失败（mtime / ABI / 修复点标记）             | 按其报错项逐项处置（如重跑 build 刷新产物 mtime），不绕过闸门                                                                                                         |
| 打包耗时长（compression: maximum + npmRebuild）                 | 后台运行 + 轮询输出，不设人为超时中断                                                                                                                                 |
| commitlint 拒绝提交信息                                         | 采用 Conventional Commits 标准格式（type(scope): 中文描述），已有 `docs(review)` 等先例                                                                               |

## 6. 参数校验（核验项清单）

本任务无业务入参，"参数校验"落实为核验项的客观判定条件：

- `git status --porcelain=v1` 输出为空 ⇒ 无未提交改动（分支 B）；非空 ⇒ 逐文件走分支 A。
- `package.json` 第 3 行 `"version"` 精确等于 `"2.5.3"`（非 `^2.5.3` / `2.5.x` 等变体）；`package-lock.json` 顶部 version 与其一致。
- 产物文件名精确为 `NikkiGallery-Setup-2.5.3.exe`（版本注入失败的边界情况会体现为旧版本号文件名）。
- 四条检查命令退出码为 0；任何非 0 视为该步骤失败，不得跳过。

## 7. 基础测试用例（正常 / 异常 / 边界）

本任务以"命令级验收"代替新增单测（零源码改动，无需新增测试文件）：

| 场景 | 用例                                            | 期望                                                           |
| ---- | ----------------------------------------------- | -------------------------------------------------------------- |
| 正常 | `npm run typecheck` / `lint` / `test` / `audit` | 全部退出码 0                                                   |
| 正常 | `npm run dist:win` 全链                         | 四步均通过，产物 exe 生成                                      |
| 异常 | 任一检查命令退出码非 0                          | 停在该步骤，处置后重跑，不跳过                                 |
| 异常 | clean 步骤 EPERM                                | 切换 §5 分步兜底，最终仍四步全过                               |
| 边界 | 工作区在执行时点出现新改动                      | 切换分支 A：审查 → TDD 修复 → 独立提交                         |
| 边界 | `grep "2\.5\." src/` 命中                       | 逐条判定：mock/测试桩/历史标注 = 允许；当前版本声明漂移 = 修复 |
| 边界 | 产物文件名版本号 ≠ 2.5.3                        | 说明版本注入异常，回查 package.json 与 build 配置              |

## 8. 执行记录（执行中回填）

- **步骤 1 计划落盘**：完成（本文件）。
- **步骤 2 改动复核（执行时点）**：分支 B 成立。`git status --porcelain=v1` 仅含本计划文件（未跟踪），暂存区与工作区 diff 为空，无 stash，HEAD=`b9b777e`。**无未提交代码可审查，无需修复与提交**。
- **步骤 3 版本核验**：全部通过，未修改任何文件——
  - `package.json:3` = `"2.5.3"`；`package-lock.json:3,9` = `"2.5.3"`，两处同步。
  - electron-builder `artifactName: "NikkiGallery-Setup-${version}.${ext}"`（`package.json:258`），版本经 `${version}` 注入产物名。
  - `grep -rn "2\.5\.[0-9]" src/`（排除测试）：仅 `app-handler.ts:36` 历史注释（"避免渲染层硬编码 v2.5.0"，非版本声明）与 `preview/mock/database-mock.ts:664`（`'2.5.3'`，已同步）。**无当前版本漂移**。
- **步骤 4 全局回归**：
  - `npm run typecheck`：退出码 0。
  - `npm run lint`：退出码 0（0 错误；11 条存量 Unicode BOM 警告，均位于已提交的测试文件，非本轮改动，按最小改动原则不处置）。
  - `npm test`：退出码 0，**337 个测试文件 / 5339 个用例全部通过**（32.09s，本轮无 flaky）。
  - `npm run audit`：**环境受限，无法在本机执行**。取证：本机用户级 registry 为 `registry.npmmirror.com`，其未实现审计端点（`404 [NOT_IMPLEMENTED] /-/npm/v1/security/*`）；按项目文档 `docs/troubleshooting-npm-audit-mirror.md` 方案二直连官方源则被本机 TLS 拦截（`self-signed certificate`，`--use-system-ca` 亦无效）。项目刻意未启用 `--pass-enoaudit`（审计失效必须响亮失败），故本机失败为设计内行为。**补偿控制**：CI `build.yml` Security audit 步骤（同一 `audit-ci.jsonc`，固定官方源）+ PR `dependency-review-action`；本轮零代码、零依赖改动，依赖面与最近 CI 绿灯完全一致，无新增审计面。未采用关闭 `strict-ssl` 的做法（安全反模式）。
- **步骤 5 打包**：`npm run dist:win` 四步链全部通过，退出码 0，未触发 EPERM 兜底——`pre-dist-check` 全部校验通过（"✅ 全部校验通过，可以执行打包"）；`check-doc-versions` 通过（README Electron 41.10 与 41.10.6 一致）；electron-builder NSIS x64 构建完成（afterPack 随包 4 个 VC++ DLL，签名与 block map 完成）；`verify:dist` 通过。
- **步骤 6 产物验收**：`release/NikkiGallery-Setup-2.5.3.exe` 生成，182,337,945 字节，mtime `2026-10-11 00:11:10 +0800`（本次构建，晚于构建前基线 2026-10-10 22:30）；asar 解包后 better-sqlite3 / sharp / libvips / koffi 二进制与 vcruntime140、vcruntime140_1、msvcp140、concrt140 齐备，管理员清单 `asInvoker` 通过。
- **步骤 7 提交**：本文件以 `docs(plans)` 入仓，提交后 `git status --porcelain` 复核为空。
