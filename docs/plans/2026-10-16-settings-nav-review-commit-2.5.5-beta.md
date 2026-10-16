# 未提交变更审查 → 提交 → 版本 2.5.5-beta → 完整打包

> 生成日期 2026-10-16 · 基线 HEAD `a9fb084`（branch `feat/gallery-runtime-embed`，工作树 32 项未提交变更）· 版本 2.5.5 → 2.5.5-beta
> 任务委托方规范：最小化改动 · 先计划后动手 · 分步原子化验证 · TDD 红-绿闭环 · 全局回归一票否决 · 禁止幻觉与测试作弊

## 0. 前提取证（审查结论，执行前已完成）

工作区 32 项未提交变更 = 「设置页导航整合重构（9 组 23 节 → 8 组 17 节）」的完整交付（26 修改 + 6 新增，+674/-307），由 `docs/plans/2026-10-16-settings-nav-consolidation.md` 计划驱动、严格 TDD 完成。逐项只读取证结论：

| 审查项                          | 取证方式                                                                                                                                                       | 结论                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 变更主题与质量                  | 读 consolidation 计划文档 + 逐文件 diff                                                                                                                        | 该轮开发已走完 TDD 红绿闭环（计划文档含逐节点红灯证据与 7 条偏差交代），全量测试 6219 passed / 0 failed；无调试代码残留（console.log/debugger/FIXME 零命中）                                                                                       |
| 缺陷修复 ×2                     | 读 `scan-sections.tsx` / `general-sections.tsx` diff                                                                                                           | scanner.start 返回 `success:false` 按钮永久卡死+跨扫描误报成功；键盘方向键调阈值静默丢弃——两处真实缺陷经红绿闭环修复，测试钉住                                                                                                                     |
| 迁移映射类型安全                | 读 `SettingsPage.tsx`                                                                                                                                          | `LegacySectionId` 闭合联合类型入类型系统，漏配即 tsc 报错；`resolveActiveSection` 在 useState 初值归一化，废弃 id 落默认节且高亮                                                                                                                   |
| i18n 收口                       | 读 12 包 diff + 契约测试                                                                                                                                       | 5 新键 12 包齐、62 处空串填实，`settings-nav-keys.test.ts` 契约测试守卫                                                                                                                                                                            |
| 测试有效性                      | 读 5 个新测试文件 + 既有测试 diff                                                                                                                              | 断言实质（含 `settings-card-usage.test.ts` 反向锁）；既有测试零弱化（合页用壳组件堆叠而非物理搬动节体，既有套件保持绿色）                                                                                                                          |
| 技术债登记                      | 读 `debt-registry.json` / `技术债清单.md`                                                                                                                      | DEBT-035/036 双处同步登记、字段完整                                                                                                                                                                                                                |
| 版本基线                        | 读 `package.json` / `package-lock.json` / `git grep 2\.5\.5`                                                                                                   | 当前 2.5.5；本轮任务第 3 步将其**真实变更为 2.5.5-beta**（非核验）。口径为「抹平」：`2.5.5-beta` 在 semver 上排在已声明的 `2.5.5` 之前，经用户确认按「`2.5.5` 当做从未存在过」处理，CHANGELOG `[2.5.5]` 节整体改名而非新增节                       |
| 独立复审（2026-10-16 二次取证） | 本机实跑全量 `npm test` + typecheck + typecheck:e2e + lint + format:check + i18n:guard + i18n:check + `check-changelog-release` + `verify:nikkisync` + `audit` | **全部 exit 0**：6219 passed / 2 skipped / 0 failed（402 文件），lint 11 warnings 恰为 DEBT-030 BOM 基线无新增，audit「Passed npm security audit」，verify:nikkisync blocking failures 0。审查未发现需修复项，TDD 红绿闭环本轮不触发（不虚构改动） |

**已知遗留（不属本轮范围，挂账）**：10 步人工 UI 自检未执行（无显示环境，consolidation 计划自认）；`settings.plugin.*` 9 包空串待独立轮；DEBT-035/036 仅登记未修。

## 1. 依赖声明

**无。** 不新增、不变更、不删除任何 npm 依赖，不引入第三方库，不新增脚本。全部复用 `package.json` scripts 中既有命令（`npm version` 为 npm 内置命令）。

**禁止项（环境约束，违反即制造假绿）**：

- 禁止 `npm install` / `npm ci` —— 会剪掉 `node_modules/@nikkisync/*` junction，链接态用例降级为 skip；
- 禁止 `npm run sync-i18n-keys` —— 会以 zh-CN 为基线删掉其他 11 包 extra 键；
- 禁止改动 `vitest.config.ts` 覆盖率阈值与 exclude、禁止改动 `CHANGELOG.md` 既有条目、禁止全仓 prettier 格式化（仅允许对本次改动文件 `--write`）。

环境要求：Node ≥ 22.12.0（`package.json engines`，本机 Node v26.3.0 满足）；无需联网装包。

## 2. 启动与运行说明

本任务无服务启动动作；全部验证通过命令行完成。执行目录固定为仓库根 `d:/Zcode项目/WXNN YD - 副本/WXNN XiangCe`。

```bash
# 局部回归（本次变更直接相关，先跑，快；settings/ 目录显式覆盖 find-related-tests 的同名匹配盲区）
npx vitest run src/renderer/pages/SettingsPage.test.tsx src/renderer/pages/settings/ \
               src/renderer/i18n/locales/settings-nav-keys.test.ts \
               src/renderer/components/common/SegmentedControl.test.tsx \
               src/renderer/components/common/SliderControl.test.tsx

# 静态检查链
npm run typecheck          # tsc -b && tsc -p tsconfig.scripts.json
npm run typecheck:e2e      # tsc --noEmit -p e2e（e2e 不在 npm test 内，唯一静态守卫）
npm run lint               # eslint .
npm run format:check       # prettier --check --end-of-line auto
npm run i18n:guard         # CI 守卫（单向 missing）
npm run i18n:check         # 12 包双向对齐（CI 不跑，必须手工）

# 全局回归
npm test                   # vitest 全量（基线 6219+ passed / 2 skipped）

# 版本闸门（版本同步后预检）
npx tsx scripts/check-changelog-release.ts   # [2.5.5-beta] 节存在且唯一 + [Unreleased] 收口
npx tsx scripts/check-doc-versions.ts        # README Electron 版本一致

# 标准打包（第 4 步）
npm run dist:win           # build + pre-dist-check + electron-builder --win --publish never + verify:dist
npm run verify:nikkisync   # 内嵌运行时链接态诊断

# 产物真实启动冒烟（T4b，验证安装包可启动 + 渲染进程/IPC 桥可用）
npm run e2e:smoke          # Playwright _electron.launch 直接吃 release/win-unpacked/*.exe
```

**Safe-Delete 网关兜底（本机实测约束，阈值 500 项）**：`npm run build` 的 clean 步与 electron-builder doPack 解包会被拦截。打包前先 `Move-Item dist/main <临时目录>`、`Move-Item release/win-unpacked <临时目录>`，再跑 `npm run dist:win`；`test:coverage` 前同法处理 `coverage/`（上轮实测 568 项）。成功后删临时目录收尾。

## 3. 错误处理

| 失败点                  | 现象                                                 | 处置（兜底）                                                                                                       |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 局部/全量测试红         | 退出码非 0                                           | 停步进 TDD：先确认失败用例能复现问题（红），再最小修复转绿，复跑相关子集 + 全量；禁止 skip / 注释 / 弱化断言       |
| typecheck 红            | tsc 非 0                                             | 同 TDD 流程；版本号变更若波及 mock 断言则回查（取证已排除此风险）                                                  |
| lint / format 红        | eslint / prettier 非 0                               | 修真实问题；既有 11 条 DEBT-030 警告（BOM）属基线，不新增即可；format 仅对本次改动文件 `--write`                   |
| `npm version` 拒绝      | npm 因脏工作树报错                                   | 手改 `package.json` 根 version + `package-lock.json` 两处版本字段，`node -e` 复验                                  |
| CHANGELOG 闸门红        | check-changelog-release 非 0                         | 按输出行号定位：节标题须字面全等 `## [2.5.5-beta] - 2026-10-16`；[Unreleased] 不得误加条目                         |
| i18n:check 红           | 键集不对齐                                           | 回查是哪一包漏改/多键，按 `settings-nav-keys.test.ts` 契约测试定位                                                 |
| pre-commit 钩子改写文件 | `git status` 出现非本人改动                          | 核对是否仅 eslint --fix / prettier --write 格式层；确认后 `git add -u` 重提；内容性改动即回审查阶段                |
| commitlint 拒收         | commit-msg 钩子非 0                                  | 按规范重写 header（≤100 字符、scope ≤24 小写、subject 不以「。」结尾）                                             |
| Safe-Delete 网关拦截    | SAFE_DELETE_BULK_CONFIRM_REQUIRED                    | §2 的 Move-Item 预移走兜底；绝不递归强制删除                                                                       |
| 打包闸门红              | pre-dist-check / verify:dist / verify:nikkisync 非 0 | 按各脚本输出定位；**提交后暴露代码性问题** → TDD 修复 + 新增 fix commit（禁 amend）+ CHANGELOG 同节补条目 + 重打包 |
| NSIS 缓存损坏           | electron-builder 报缓存错                            | 删 `%LOCALAPPDATA%/electron-builder/Cache/nsis` 重跑                                                               |

日志规范：所有命令输出（退出码、用例计数、校验标记）逐条记入 §7 执行记录，作为一票否决闸门判定依据。

## 4. 参数校验

- **版本号写入范围（10 文件，本轮为真实变更，口径为「抹平」）**：

  **用户确认口径**：完全采用 `2.5.5-beta`，把 `2.5.5` 当做从未存在过。`2.5.5-beta` 在 semver 上排在已声明的 `2.5.5` 之前，且 electron-updater 默认不把预发布版推给正式版用户——本轮 `--publish never` 不发布，该影响限于将来分发，已知并接受。

  1. `package.json` 根 `version` + `package-lock.json` 顶层 `version` / `packages[""].version` —— 统一经 `npm version 2.5.5-beta --no-git-tag-version` 修改，`node -e` 三处复验；
  2. `CHANGELOG.md` **抹平而非新增节** —— `## [2.5.5] - 2026-10-11` 节标题整体改名 `## [2.5.5-beta] - 2026-10-16`（日期取本轮定版日）；节内三处 `NikkiGallery-Setup-2.5.5.exe` 叙述（`:23`、`:25`、`:59`）同步改写版本段，日期与动作保持为历史；本轮「设置页导航整合 + 两处缺陷修复」并入该节的 Added / Changed / Fixed；底部链接区 `[Unreleased]` compare 基线改 `v2.5.5-beta...HEAD`，`[2.5.5]` 链接改 `[2.5.5-beta]` 并指向 `compare/v2.5.3...v2.5.5-beta`；`[Unreleased]` 保持空节（闸门要求，有条目即 error）；
  3. 文档版本引用 —— `README.md:9`（徽章 `version-2.5.5--beta-blue`，shields.io `--` 转义渲染 `2.5.5-beta`）、`ARCHITECTURE.md:5,1656`、`ARCHITECTURE.en.md:5,1629`、`DEVELOPMENT.md:5,784,828,839`、`DEVELOPMENT.en.md:5,788,832,843`、`AGENTS.md:7`；
  4. `src/renderer/preview/mock/database-mock.ts:664` —— 预览 mock 的 `getVersion`，**随上一笔真实发版提交 `0de20d8 chore(release): 发布 v2.5.5 并同步版本号、文档与变更日志` 的先例纳入**（该提交正是 11 文件且含本文件）；
  5. **明确不动**：`SettingsPage.test.tsx:39` 的 `'2.5.5'`（测试桩 `vi.fn` mock，0de20d8 先例未含，改它属于动测试代码）、`scripts/verify-nikkisync-link.ts:236`（注释）、`ARCHITECTURE*.md` 当前版本行括号内的历史叙述「2026-10-11 由用户要求从 2.5.3 升至 2.5.5」（历史记录，保留原文）、`docs/plans/*.md` 全部日期化计划与执行记录、`docs/sync-integration/00-nikkisync-pc-audit-report.md:4` 审查快照、README 的 `Electron 41.10`（框架版本，`check-doc-versions.ts` 单独校验，与应用版本号无关）、`release/` 历史安装包与 `.tmp-phase*.txt` 草稿（均 gitignore）。

- **提交拆分（43 文件 → 3 笔，沿用仓库先例）**：`0de20d8` 把发版元数据单独成笔、`a9fb084`/`5b5ee48` 把计划文档单独成笔，故本轮同样分笔——

  | 笔次 | header                                                                        | 文件数 | 内容                                   |
  | ---- | ----------------------------------------------------------------------------- | ------ | -------------------------------------- |
  | C1   | `refactor(settings): 设置页导航整合为 8 组 17 节并修复扫描与阈值两缺陷`       | 31     | 26 修改 + 5 新增测试                   |
  | C2   | `chore(release): 发布 2.5.5-beta 并抹平 2.5.5 版本记录`                       | 10     | T2 的版本同步全集                      |
  | C3   | `docs(plans): 登记并回填 2026-10-16 设置页导航审查提交与 2.5.5-beta 打包记录` | 2      | consolidation 计划 + 本计划（§7 回填） |

  **提交信息约束**：Conventional Commits；commitlint 实测规则 `type-enum` 含 refactor/chore/docs、`scope-max-length` 24、`scope-case` lower-case、无 `scope-enum` 白名单、`header-max-length` 100、`subject-max-length` 72、`subject-full-stop` 禁「。」结尾；三笔 header 均在限内；正文说明「做了什么 + 为什么」。

- **变更范围约束**：`release/` 旧安装包不清理、不入库、不改名；不夹带任何未列文件。
- **构建产物校验**：`release/NikkiGallery-Setup-2.5.5-beta.exe` 时间戳必须晚于 C2 提交时间；`verify:dist` 的 @nikkisync 产物断言全 ✔；`latest.yml` 的 `version`/`size`/`sha512` 三项与新 exe 逐项一致。

## 5. 基础测试用例（正常 / 异常 / 边界）

**正常路径**：

1. `npx vitest run` 局部测试全绿（SettingsPage.test.tsx + settings/ 目录全套 + settings-nav-keys.test.ts + SegmentedControl/SliderControl.test.tsx）；
2. `npm run typecheck` / `typecheck:e2e` / `lint` / `format:check` / `i18n:guard` / `i18n:check` 退出码 0；
3. `npm test` 全量通过且无新增失败（基线 6219+ passed / 2 skipped，passed 不低于基线）；
4. `npm version 2.5.5-beta` 后三处版本字段均为 `2.5.5-beta`；CHANGELOG/文档闸门双绿；全量复跑 `npm test` 仍绿；
5. `git commit` 被 commitlint 接受，`git log --oneline -1` 可见，工作树干净；
6. `npm run dist:win` 退出码 0，`verify:dist` / `verify:nikkisync` 全 ✔，产物名含 `2.5.5-beta`。

**异常路径**：7. 任一命令非 0 → 按 §3 对应行处置，修复后重跑该命令 + 其下游依赖命令，不允许带着红进下一步；8. Safe-Delete 拦截 → Move-Item 兜底后重跑，记录拦截与兜底双方证据；9. pre-commit 钩子改写 → 人工核对 diff 仅格式层后 `git add -u` 重提。

**边界条件**：10. 审查阶段边界抽查：`normalizePathList` 读取失败 fail-open 返回空数组；`customScanPaths` 满 64 条上限时兜底块追加行为；迁移映射未覆盖的未知旧 id 落默认节且高亮；scanner.start 返回 `undefined`（mock 缺失）不得误报失败；11. 版本同步无第三处误改（`git diff --stat` 审查）；12. 提交后 `git status --porcelain` 为空；13. 覆盖率四指标不低于阈值（66/58/59/68）；14. 产物时间戳晚于 HEAD 提交时间，证明「本次构建」而非复用旧包。

---

## 6. 子任务拆解

### T-0 · 计划文档落盘

- **涉及文件**：`docs/plans/2026-10-16-settings-nav-review-commit-2.5.5-beta.md`（新建，入库镜像）；`.zcode/plans/` 同名文件（本地产物，双落盘对齐上轮惯例）。
- **输入 / 输出**：输入 = §0 审查取证结论；输出 = 含五必备节（依赖声明/启动运行/错误处理/参数校验/测试用例）+ 每子任务三要素的可执行计划文档。
- **验收标准**：两文件存在且内容一致（hash 校验）；文档命名对齐既有 `YYYY-MM-DD-<slug>.md`；§7 执行记录初始为「待回填」占位。

### T1 · 独立复审 + 全量回归基线

- **涉及文件**：无仓库文件改动（只读 + 命令执行）。
- **输入 / 输出**：输入 = 32 项变更；输出 = 重点 diff 复核结论（§5.10 边界抽查）+ 七类校验命令的退出码与计数。
- **验收标准**：审查无 critical/high 新发现；局部 + 静态链 + 全量命令全绿（任一红 → 转 T1b TDD 闭环，修复后重跑全链）。

### T1b · 条件任务：TDD 修复（仅 T1 失败时触发）

- **涉及文件**：最小化的问题文件 + 对应测试文件。
- **输入 / 输出**：输入 = 失败的测试/检查；输出 = 先红后绿的回归用例 + 最小修复 + CHANGELOG Fixed 节与 commit message 补录。
- **验收标准**：新回归用例在修复前实测失败（留证），修复后转绿；局部子集 + 全量复跑通过。

### T2 · 版本号 2.5.5 → 2.5.5-beta 同步（10 文件，抹平口径）

- **涉及文件**：`package.json`、`package-lock.json`、`CHANGELOG.md`、`README.md`、`ARCHITECTURE.md`、`ARCHITECTURE.en.md`、`DEVELOPMENT.md`、`DEVELOPMENT.en.md`、`AGENTS.md`、`src/renderer/preview/mock/database-mock.ts`。
- **输入 / 输出**：输入 = 当前 2.5.5；输出 = 全部版本引用同步为 2.5.5-beta，CHANGELOG `[2.5.5]` 节整体改名为 `[2.5.5-beta]` 并并入本轮变更（README 徽章用 `--` 转义写法）。
- **验收标准**：`node -e` 三处版本字段均为 `2.5.5-beta`；`check-changelog-release.ts` + `check-doc-versions.ts` 双绿；`format:check` 绿；`git grep -n "2\.5\.5" -- . ':!docs/plans' ':!*.tmp-*'` 剩余命中逐条落在 §4 明确不动清单内；CHANGELOG 中 `[2.5.5]` 字面不再存在、`[2.5.5-beta]` 恰出现一次；`git diff --stat` 恰为 10 文件。

### T3 · 分三笔提交全部变更

- **涉及文件**：T1 验证过的 31 项（C1）+ T2 版本同步 10 文件（C2）+ 2 个计划文档（C3）。
- **输入 / 输出**：输入 = 已验证工作树；输出 = §4 拆分表的三笔 commit。
- **验收标准**：`git show --stat` 逐笔等于 31 / 10 / 2 files；commitlint 三笔均通过（husky 链全过）；每笔提交后 `git status --porcelain` 仅剩后续笔次应含文件；末笔后工作树为空。钩子改写须核对仅格式层。

### T4 · 完整打包 `dist:win`

- **涉及文件**：`dist/`（构建输出）、`release/`（安装包产物，新增 2.5.5-beta 产物）。
- **输入 / 输出**：输入 = 已提交代码；输出 = `release/NikkiGallery-Setup-2.5.5-beta.exe`（时间戳晚于 C2 提交）+ `dist:win` 全链退出码 0。
- **验收标准**：`npm run dist:win` 退出码 0；`verify:dist` @nikkisync 产物断言全 ✔；`verify:nikkisync` blocking failures: 0；`latest.yml` 的 version/size/sha512 与新 exe 逐项一致；Safe-Delete 拦截与兜底留证；备份目录清理。**特别观察**：electron-builder 对预发布版本号写入 NSIS EXE VERSIONFILE 的处理（本仓首次使用 `-beta` 后缀），失败时取原始报错再定处置，禁止为此把版本号改回 `2.5.5`。

### T4b · 产物真实启动冒烟 `e2e:smoke`

- **涉及文件**：无仓库文件改动；读取 `release/win-unpacked/*.exe`（`e2e/helpers.ts:19` 定位）。
- **输入 / 输出**：输入 = T4 产物；输出 = Playwright 用产物自带 Electron 启动应用的冒烟结果。
- **验收标准**：`npm run e2e:smoke` 退出码 0。**边界交代**：该冒烟证明安装包可启动、渲染进程与 IPC 桥可用，**不等于**逐屏目测 8 组 17 节的视觉布局——consolidation 计划自认的 10 步人工 UI 自检在本机无显示断言下仍属未闭合缺口，如实留档，不宣称已验证。

### T5 · 全局收口 + 执行记录回填

- **涉及文件**：计划文档 §7 执行记录回填（仅追加）；`.zcode/plans/` 同步镜像更新。
- **输入 / 输出**：输入 = T1–T4 全部证据；输出 = 回填后的计划文档 + 收口提交 `docs(plans): 回填 2026-10-16 设置页导航审查/提交/2.5.5-beta 打包执行记录`。
- **验收标准**：回归清单全绿（test/typecheck/lint/format/i18n:guard/i18n:check/coverage/audit）；`git status --porcelain` 为空；安装包时间戳核验通过；§7 记录每条命令实测输出。

## 7. 执行记录（2026-10-16）

### 7.0 前提取证改道（相对原计划的两处修正）

- **外层目录非 git 仓库，且内层两库只有一个有活**：`find . -maxdepth 3 -name .git` → `./NikkiSync/.git`、`./WXNN XiangCe/.git`。`git -C NikkiSync status --porcelain=v1` 输出为空且 `## main...origin/main` 无 ahead/behind ⇒ NikkiSync 无未提交变更，本任务只作用于 `WXNN XiangCe`（分支 `feat/gallery-runtime-embed`，基线 HEAD `a9fb084`）。
- **T1b 未触发**：本机实跑全部校验均 exit 0（见 7.1），审查无 critical/high 新发现，无需 TDD 修复。按最小化改动原则，未为「交差」虚构任何代码改动。
- **版本号由「核验」改为「真实变更 + 抹平」**：取证确认 `package.json:3` 为 `2.5.5`、CHANGELOG 有 `## [2.5.5] - 2026-10-11` 历史节、`release/` 有 20:29 构建的 `NikkiGallery-Setup-2.5.5.exe`。`2.5.5-beta` 在 semver 上排在 `2.5.5` 之前，就此向用户提了两轮确认，用户定调「完全采用 2.5.5-beta，2.5.5 当做从未存在过」与「[2.5.5] 整体改名 [2.5.5-beta]」，故 §4 的版本写入范围与提交拆分按抹平口径改写（见本次改写）。
- **补充取证**：`git tag -l` 为空，CHANGELOG:401 亦自述「本仓库尚未推送任何 git tag」⇒ 抹平不会破坏任何已存在的 tag 引用；`check-doc-versions.ts` 实读确认其只校验 README 的 Electron 版本（41.10 vs package.json 41.10.6），与应用版本号无关。
- **提交拆分改为三笔**：原 §4 拟「单次提交 42 文件」，但仓库先例 `0de20d8` 把发版元数据单独成笔（11 文件、含 `database-mock.ts`），`a9fb084`/`5b5ee48` 把计划文档单独成笔，故按先例改为 C1/C2/C3 三笔，并把 `database-mock.ts` 从「明确不动」移入写入范围。

### 7.1 T1 · 基线复跑（提交前，本机实测退出码）

| 命令                                         | 退出码 | 实测输出                                                                                 |
| -------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| `npm test`                                   | 0      | `Test Files 402 passed (402)` / `Tests 6219 passed \| 2 skipped (6221)`，Duration 78.98s |
| `npx vitest run`（settings 局部）            | 0      | `13 passed (13)` / `110 passed (110)`                                                    |
| `npm run typecheck`                          | 0      | 静默通过                                                                                 |
| `npm run format:check`                       | 0      | `All matched files use Prettier code style!`                                             |
| `npm run lint`                               | 0      | `11 problems (0 errors, 11 warnings)` — 恰为 DEBT-030 BOM 基线，无新增                   |
| `npm run i18n:check`                         | 0      | 12 包各 `3938 keys` 对齐                                                                 |
| `npm run i18n:guard`                         | 0      | `白名单只减不增、清零必移除、key 已同步，守卫通过`                                       |
| `npx tsx scripts/check-changelog-release.ts` | 0      | `✔ [2.5.5] 版本节存在且唯一`（改号前基线）                                               |
| `npm run verify:nikkisync`                   | 0      | `OK (blocking failures: 0)`，4 条 `@nikkisync/*` junction 齐全                           |
| `npm run audit`                              | 0      | `Passed npm security audit.`（命中项全在 allowlist）                                     |

审查侧独立取证（读 diff + 回查被引用实现）：`useCallback` 已在 `scan-sections.tsx:1` import；主进程 `startScan` 确于 `status === 'running'` 时 `return { success: false }` 且不广播 `scanner:complete`；`normalizePathList` 存在且 `MAX_PATH_ITEMS = 64`；`SliderControl` 的 `onCommit` 确挂 `onPointerUp` + `onKeyUp` 且双击复位优先 `defaultValue`；preload `scanner.start` 走 `call<ScannerStartResult>` 透传 handler 原始对象 ⇒ `result.success` 判定成立；localStorage 仅 `settings-active-section` / `app-language` 两键被持久化，组 id 未持久化 ⇒ `tools`+`plugins` → `tools-plugins` 改名无脏数据风险；5 个新 i18n 键 12/12 齐；`SettingsCard` 定义为 `p-3 rounded-lg` + `var(--bg-tertiary)`，替换行为等价。

### 7.2 T2 · C1 提交

- `npm run verify:staged` → `4 项, 0 失败`（typecheck / lint / core-gate / format / test 5 项全 ✓，其中相关单测 `8 个文件 / 54 passed`）；`⚠` 5 个源文件无同名套件属既有状况（合页壳与 barrel 由 `SettingsPage.test.tsx` + `settings-card-usage.test.ts` 间接覆盖），非阻断。
- `git add` 精确 31 文件 → `git diff --cached --name-only | wc -l` = 31。
- `.husky/pre-commit`：Step 1/3 lint-staged ✓ → Step 2/3 `[CORE-GATE] ⊘ 本次变更不涉及核心路径受保护文件，跳过` ✓ → Step 3/3 `tsc -b` ✓。
- commit-msg（commitlint）通过 ⇒ **C1 = `3f247b3`**，`31 files changed, 1298 insertions(+), 307 deletions(-)`（674 为原 26 项，余为 5 个新测试文件）。
- 提交后 `git status --porcelain` 仅剩 2 个计划文档（`??`），钩子无意外残留。

### 7.3 T3 · 版本号 2.5.5 → 2.5.5-beta

- `npm version 2.5.5-beta --no-git-tag-version` 在脏工作树下**成功**（输出 `v2.5.5-beta`，退出码 0），未触发 §3 预案的手改回退。
- `git diff --stat -- package.json package-lock.json` = `2 files changed, 3 insertions(+), 3 deletions(-)`，逐行 diff 确认**仅**三处 `version` 字段变化，依赖树零扰动。
- `node -e` 三处复验：`package.json` = `2.5.5-beta`、lock 顶层 = `2.5.5-beta`、`lock.packages[""]` = `2.5.5-beta`。
- CHANGELOG 抹平一次改全：节标题 `:19`、节内 exe 叙述 `:23`/`:25`/`:66`、新增本轮 Changed 三条与 Fixed 两条、底部链接 `:403`/`:404`；`[Unreleased]` 保持空节。
- `npx tsx scripts/check-changelog-release.ts` → 退出码 0：`✔ 解析到 12 个版本节（最新：2.5.5-beta，package.json：2.5.5-beta）`、`✔ [2.5.5-beta] 版本节存在且唯一`、`✔ [Unreleased] 已收口`。
- `npx tsx scripts/check-doc-versions.ts` → 退出码 0：`README 中所有 Electron 版本均为 41.10`。
- 残留字面复核 `git grep -n "2\.5\.5" -- . ':!docs/plans' ':!.tmp*'`：除 `2.5.5-beta` 自身的子串命中外，剩余仅 `docs/sync-integration/*.md` 日期化记录、`scripts/verify-nikkisync-link.ts:236` 注释举例、`SettingsPage.test.tsx:39` 测试桩——逐条对照均在 §4「明确不动」清单内，无第三处误改。

### 7.4 T4 · C2 提交 + 版本变更后全量复跑

- 提交前 `npm run format:check` 0、`npm run typecheck` 0、`npx vitest run`（SettingsPage + settings/）`10 文件 / 78 passed` 0。
- `git add` 精确 10 文件；`npm run verify:staged` → `4 项, 0 失败`。
- `.husky/pre-commit` 三步全 ✓（core-gate 同样跳过）；commitlint 通过 ⇒ **C2 = `ba5184a`**，`10 files changed, 31 insertions(+), 24 deletions(-)`。
- 版本变更后全量：`npm test` → `402 passed` / `6219 passed \| 2 skipped`、退出码 0（与改号前逐项一致，版本号未波及任何断言）；`npm run lint` 0（仍 11 warnings）；`npm run i18n:check` 0。
- npm 横幅已显示 `wxnn-photo-manager@2.5.5-beta`。

### 7.5 T5 · 打包与产物冒烟

- Safe-Delete 预案先行：`dist/main` 875 项、`release/win-unpacked` 753 项、`coverage` 516 项均超 500 阈值 ⇒ 同盘 `mv` 至 `../.pack-staging/`，随后 `npm run dist:win` 全程 **0 次 `SAFE_DELETE` 拦截**（未使用任何递归强删）。
- `npm run dist:win` → **退出码 0**。`pre-dist-check` 三连（`pre-dist-check` + `check-doc-versions` + `check-changelog-release`）与 `verify:dist` 解包校验 18 项全 ✔：better-sqlite3 / sharp / libvips / koffi 四二进制 + 4 个 VC++ DLL + `@nikkisync` 迁移 SQL、四包入口、`row-mappers.js`、`LocalSyncServer.js`、`GalleryRuntime.mjs`、`requestedExecutionLevel=asInvoker` 闸门。
- **electron-builder 接受预发布版本号**（本仓首次用 `-beta` 后缀）：无 VERSIONFILE / shortVersion 报错，风险项就此实测关闭，未放宽任何配置。
- 产物 `release/NikkiGallery-Setup-2.5.5-beta.exe`，`latest.yml` 三项与实测逐项一致：`version: 2.5.5-beta`；`size` 声明 183271240 = `stat -c %s` 183271240；`sha512` 声明 `QaD0q76/OHmQW5ua6jkYcawwCz5im4WDNExgrJqxSr7c42zTG/0vYE9IUiVDtHPoTDQ7ZEftvFfRl0U8bNzwng==` = `openssl dgst -sha512 -binary | base64` 实测值。
- 时间戳链：C2 提交 `1792161830`（22:43:50）< 产物 mtime `1792162026`（22:47:06）⇒ 证明本次构建而非复用旧包。
- `npm run e2e:smoke` → **退出码 0，15 passed (25.8s)**，真实产物 `release/win-unpacked/无限暖暖相册管理工具.exe`。关键项：**S4 主进程 IPC 探针「app.getVersion 与 package.json 一致」在打包态通过** ⇒ 独立佐证版本号已正确注入安装包；S2 非白屏、S3 preload 四全局对象齐备、S5 `uiTheme.get` 真实查询 `app_settings` 表（better-sqlite3 原生模块已加载）、S6 静置 5s 存活、S7 首装自动扫描执行并完成；`consoleErrors=[]` / `pageErrors=[]`；`media://` 15 条响应全 200（无流取消竞态复发）。
- 缺口如实留档：e2e 证明的是产物可启动与桥可用，**不等于**逐屏目测 8 组 17 节的视觉排布与文案；consolidation 计划的 10 步人工 UI 自检仍属未闭合项。

### 7.6 T6 · 全局回归一票否决（打包后实测）

| 命令                       | 退出码 | 实测                                                                                                                                                                                                                      |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                 | 0      | `402 passed` / `6219 passed \| 2 skipped (6221)`                                                                                                                                                                          |
| `npm run test:coverage`    | 0      | 阈值门控通过；`coverage-summary.json` total = `statements 68.09 / branches 59.58 / functions 60.84 / lines 69.67`，四项均高于 `vitest.config.ts` 阈值 66/58/59/68，且优于 2026-10-14 重新基线读数 66.69/58.19/59.22/68.27 |
| `npm run typecheck`        | 0      | `tsc -b` + `tsc -p tsconfig.scripts.json`（见 7.4，版本变更后复跑）                                                                                                                                                       |
| `npm run typecheck:e2e`    | 0      | `tsc --noEmit -p e2e`                                                                                                                                                                                                     |
| `npm run lint`             | 0      | 0 errors / 11 warnings（DEBT-030 既有 BOM 基线，无新增）                                                                                                                                                                  |
| `npm run format:check`     | 0      | `All matched files use Prettier code style!`                                                                                                                                                                              |
| `npm run i18n:guard`       | 0      | `白名单只减不增、清零必移除、key 已同步，守卫通过`                                                                                                                                                                        |
| `npm run i18n:check`       | 0      | 12 包各 `3938 keys` 对齐                                                                                                                                                                                                  |
| `npm run audit`            | 0      | `Passed npm security audit.`（命中项全在 `audit-ci.jsonc` allowlist，无新增 high/critical）                                                                                                                               |
| `npm run verify:nikkisync` | 0      | `OK (blocking failures: 0)`（针对新产物复验）                                                                                                                                                                             |
| `npm run dist:win`         | 0      | 见 7.5                                                                                                                                                                                                                    |
| `npm run e2e:smoke`        | 0      | 15 passed / 25.8s，见 7.5                                                                                                                                                                                                 |

**一票否决结论**：全部退出码 0，无新增失败项，任务达成。

### 7.7 入库与善后

- 三笔提交：C1 `3f247b3`（31 文件）· C2 `ba5184a`（10 文件）· C3 `docs(plans)`（本节所在 2 计划文档）。合计 43 文件，与 §4 拆分表一致。
- 工作树：C3 后 `git status --porcelain` 为空。
- `.pack-staging/`（7.5 预移走的 `dist/main` / `release/win-unpacked` / `coverage` 旧产物，均 gitignore 且已由本轮构建重新产出）已清理，未使用任何递归强删。
- 未做（超出本轮范围，需另行确认）：`git push`（`feat/gallery-runtime-embed` 当前无上游分支）；`stash@{0}: phase7-wip-parked` 与 8 条本地分支原样未动；`release/` 旧安装包 `2.5.2`/`2.5.3`/`2.5.5` 未清理未改名；DEBT-030/034/035/036 与 `settings.plugin.*` 9 包空串按挂账留待独立一轮。
- 已知缺口（如实留档，不宣称已验证）：consolidation 计划的 10 步人工 UI 逐屏自检未执行；`2.5.5-beta` 低于原 `2.5.5` 的 semver 排序使 electron-updater 不会把本包推给 2.5.5 用户，分发只能手动投放。
