# 阶段6 未提交代码全流程处理：审查修复 → 提交 → 版本核验 → 重新打包

> 生成日期 2026-10-16 · 仓库 `WXNN XiangCe` · 分支 `feat/gallery-runtime-embed` · 基线 HEAD `f124e28`
> 任务委托方指令：审查修复全部未提交代码 → 提交 → 版本号改为 2.5.5 → 重新打包构建

## 一、概要与关键结论（Phase 1 探索已完成）

**待处理改动**：阶段6「NikkiSync 同步元数据解析能力补充」全部产出，共 34 文件（27 修改 + 7 新增，+1119/−24 行），含配套计划文档 `docs/plans/2026-10-16-nikkisync-metadata-resolver-phase6.md`（其 §11 已记录逐节点 TDD 红绿灯与收口验证：typecheck 0 / lint 0 error 11 既有 warning / 394 files 6151 passed | 2 skipped / 覆盖率四项越线 / i18n:check 3932 键对齐 / i18n:guard 通过）。

**探索确认的事实**：

| 事实                                                                           | 证据                                                   | 对任务的影响                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `package.json` 版本在 HEAD 已是 `"2.5.5"`                                      | `git show HEAD:package.json`                           | 任务③（版本号更新）为**核验性 no-op**：逐字断言已是 2.5.5，不做任何改动 |
| 全仓无 `2.5.0`–`2.5.4` 残留引用                                                | Grep `2\.5\.[0-4]` 于 package.json/README/src → 零命中 | 无需清理旧版本号引用                                                    |
| CHANGELOG 已有 `[2.5.5] - 2026-10-11` 节，`[Unreleased]` 无待发布条目          | CHANGELOG.md L13-19                                    | `check-changelog-release` 收口闸门当前即可通过                          |
| 环境：Node v26.3.0、npm 11.16.0                                                | `node --version`                                       | 满足 engines `>=22.12.0`                                                |
| `node_modules/@nikkisync` 四包（core/database/pc-companion/protocol）在位      | 目录列举                                               | 链接态测试可跑；**禁止 `npm install`**（会剪掉 junction）               |
| `release/NikkiGallery-Setup-2.5.5.exe` 存在（2026-10-15 22:56 上一轮重建产物） | 目录列举                                               | 本次构建将覆盖它                                                        |
| `release/`、`.tmp-*.txt` 均被 gitignore                                        | `.gitignore` L7/L128                                   | 构建产物不污染 git 状态                                                 |

**审查结论（已完成全部 34 文件 diff 审查）**：

- **唯一缺陷（将修复）**：`src/main/nikkisync/metadata-isolation-guards.ts` L20-25，「刻意不含 `app_settings` 与 `schema_migrations`……」注释块**逐字重复出现两次**（编辑残留），无行为影响，属文档级缺陷。最小修复：删除重复的 3 行。
- **审查通过项**（要点）：驱动层「关闭⇒配置键整个缺失 / 绝不下发 intervalMs / 驱动永不 reject」三条不变量成立且有测试钉死；teardown 顺序 `metadataResolver.stop → server.stop → scanner.stop → dispose` 正确；generation 代次作废机制无未捕获 rejection 路径（`driveMetadata` 双层 catch）；`metadataSnapshot()` 的 `deps.defaults.metadataResolverEnabled` 装配链路完整（`buildSessionOptions` → `createManagerDependencies` → manager defaults，`initNikkiSyncRuntime` 实接）；env 逃生阀只认 `'1'/'0'`、脏设置值判关（出站开关不可被脏数据静默打开）；端点 https 构造期校验且与披露文案同源；12 语言包 3 个 metadata 键齐备且 `sync-gallery-keys.test.ts` 钉住「点名 nuan5.pro + 局域网下发披露」；未触及核心路径保护目录（preload/api、ipc/handlers、services、shared/errors）⇒ 无需 `@core-change` 授权注释；无静态 `@nikkisync/*` import（ESLint 双层护栏 + 已有测试守护）。

## 二、提议的变更（子任务分解，每项含文件/输入输出/验收标准）

### P0 计划登记（plan-first 硬性要求，先于一切代码修改）

- **涉及文件**：`docs/plans/2026-10-16-phase6-review-commit-rebuild.md`（新建，即本计划的仓库留存版）
- **输入/输出**：本计划内容 → 落盘为仓库文件并单独提交，确保「先出计划再动手」在版本历史中可验证
- **提交**：`docs(plans): 登记 2026-10-16 阶段6 审查/提交/版本核验/重新打包计划`
- **验收标准**：`git log --oneline -1` 显示该提交；`git status` 中该文件已跟踪
- **位置决策**：用户模板指定 `plans/` 或 `.zcode/plans/`；本仓库既有约定为 `docs/plans/`（已有 4 份已提交计划文档先例，且 `.zcode/` 被 gitignore 排除无法"存入仓库"），沿用 `docs/plans/`

### P1 审查修复（最小改动：1 文件删 3 行）

- **涉及文件**：`src/main/nikkisync/metadata-isolation-guards.ts`（仅 L23-25，删除重复注释）
- **输入/输出**：输入 = 当前含重复注释的文件；输出 = 「刻意不含……」说明只保留一份，其余零改动
- **TDD 适用性说明**：注释级修复无任何行为变更，不存在能先红后绿的测试（隔离护栏的结构档谓词刻意只认 SQL 语句上下文、注释本就豁免），故不适用红绿闭环；以「既有 15 例隔离测试保持绿 + prettier 通过」为等效验收
- **验收标准**：
  1. `npx vitest run src/main/nikkisync/metadata-isolation-guards.test.ts src/main/nikkisync/metadata-resolver.isolation.test.ts` 全绿（8 + 7 passed，语义档在 node:sqlite 下实际执行）
  2. `npx prettier --check --end-of-line auto src/main/nikkisync/metadata-isolation-guards.ts` 通过
  3. 重复注释在文件中只出现一次

### P2 验证与回归（只读闸门，全部通过才可提交）

按顺序执行，任一失败即停止并修复后重跑（不得弱化、不得跳过）：

| #   | 命令                                                       | 验收标准                                                                                               |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| V1  | `npm run link:nikkisync:check && npm run verify:nikkisync` | 四包链接全 ok；诊断 `blocking failures: 0`（含新增的 metadata 深入口产物检查）                         |
| V2  | `npm run verify`                                           | `[VERIFY]` 全步骤通过（typecheck + eslint 只读 + core-gate + prettier --check + 相关单测）             |
| V3  | `npm run typecheck`                                        | 退出码 0（`tsc -b` + `tsc -p tsconfig.scripts.json`）                                                  |
| V4  | `npm run lint`                                             | 退出码 0（允许既有 11 条 DEBT-030 BOM warning，**0 error、0 新增 warning**）                           |
| V5  | `npm run i18n:check && npm run i18n:guard`                 | 3932 键全语言对齐；白名单守卫通过                                                                      |
| V6  | `npm run audit`                                            | 退出码 0（29 项豁免基线内，无新增 high/critical）                                                      |
| V7  | `npm test`（全量）                                         | **394 files / 6151+ passed，0 failed**（2 skipped 为链接态门控基线；本地已建链时 linked 用例实际执行） |

### P3 提交（阶段6 全部产出 + P1 修复）

- **涉及文件**：34 个阶段6 文件（27 修改 + 6 新增源码/测试 + 1 计划文档），加上 P1 的注释修复
- **暂存方式**：`git add` 按明确文件路径逐个添加（`git status --porcelain` 列出的全部 34 项 + P0 计划文档已在 P0 提交），**不用 `git add -A`**
- **提交信息**（符合 commitlint：type-enum / header≤100 / subject≤72 / 中文允许）：

  ```
  feat(nikkisync): 阶段6 同步元数据解析 opt-in 注入与表级隔离护栏

  - 默认关闭的远端元数据解析（设置键 nikkisync.metadataResolverEnabled + env 逃生阀
    NIKKI_NIKKISYNC_METADATA），关闭时连 metadataResolver 配置键都不下发
  - 扫描成功后 fire-and-forget 有界驱动（batchSize 4 / maxPasses 50，绝不下发 intervalMs），
    拆除期 generation 代次作废 + teardown 最前置 metadataResolver.stop
  - 零依赖纯函数驱动层 + 表级隔离护栏（结构档任何 Node 必跑 + node:sqlite 语义档）
  - verify-nikkisync-link 新增 METADATA_REQUIRED_ARTIFACTS 深入口产物闸门
  - 12 语言包 settings.sync.metadata.* 三键 + 常驻隐私披露（点名 nuan5.pro 与局域网下发）
  - runtime-status 新增可选 metadata 段（纯增字段，IPC 契约向后兼容）
  ```

- **pre-commit 钩子预期行为**：husky → lint-staged（eslint --fix + prettier --write + `test:precommit` 相关单测）+ 核心路径闸门 + `tsc -b`。钩子可能改写文件并自动重新暂存（属预期，不跳过钩子）
- **输入/输出**：输入 = 工作区全部阶段6 改动；输出 = 单个 feat 提交，工作区干净
- **验收标准**：
  1. 提交成功（commit-msg 钩子 commitlint 通过）
  2. `git status --porcelain` 为空（钩子改写已自动重新暂存，无遗留）
  3. `git log --oneline -2` 顶部为该 feat 提交、其下为 P0 的 docs(plans) 提交

### P4 版本号核验（任务③，no-op 断言）

- **涉及文件**：`package.json`（**只读核验，零改动**）
- **输入/输出**：读取 `version` 字段 → 断言逐字等于 `"2.5.5"`
- **验收标准**：`node -e "console.log(require('./package.json').version)"` 输出 `2.5.5`；若不相等（预期不会发生）才执行最小修改并单独提交 `release: 版本号更新至 2.5.5`
- **不改动其他配置项**：README 的 Electron 版本一致性由构建期 `check-doc-versions.ts` 闸门复核

### P5 标准打包构建（任务④）

- **命令**：`npm run dist:win`（仓库标准发布流程，后台运行，预计 10–20 分钟）
- **内部链路**：`npm run build`（clean + electron-vite build + dist/main/package.json）→ `npm run pre-dist-check`（pre-dist-check.ts 13+ 项产物闸门 + check-doc-versions.ts + check-changelog-release.ts）→ `electron-builder --win --x64 --publish never`（NSIS，compression maximum）→ `npm run verify:dist`（asar 解包校验 @nikkisync 产物）
- **输入/输出**：输入 = 已提交的工作区（版本 2.5.5）；输出 = `release/NikkiGallery-Setup-2.5.5.exe`（覆盖 2026-10-15 旧产物）+ `release/win-unpacked/`
- **验收标准**：
  1. 命令链退出码 0，全程无 Error 级报错
  2. `release/NikkiGallery-Setup-2.5.5.exe` 存在且 LastWriteTime 为本次构建时间
  3. `verify:dist` 的 @nikkisync 产物断言全 ✔（migrations SQL、四包 dist/src/index.js、row-mappers.js、LocalSyncServer.js、GalleryRuntime.mjs）

### P6 收口（CHANGELOG 补录 + 执行记录回填，构建成功后）

- **涉及文件**：
  1. `CHANGELOG.md` —— 在 `[2.5.5]` 节追加 2026-10-16 重打包补录（沿用 2026-10-14 追加先例）：节首注释区加一行日期追加说明 + Added 区补一条阶段6 条目（opt-in 元数据解析：默认关、nuan5.pro 出站披露、隔离护栏、语言包）。**不写入 `[Unreleased]`**（收口闸门要求其为空）
  2. `docs/plans/2026-10-16-phase6-review-commit-rebuild.md` —— 回填执行记录（各验证命令真实退出码与输出摘要、提交哈希、构建产物时间戳、偏差记录）
- **提交**（两个，沿用仓库模式）：
  1. `docs(changelog): 补录阶段6 元数据解析随 2.5.5 重新打包出货`
  2. `docs(plans): 回填 2026-10-16 审查/提交/版本核验/重新打包执行记录`
- **验收标准**：两提交成功；`git status --porcelain` 为空；`npx tsx scripts/check-changelog-release.ts` 退出码 0（收口闸门复核）

## 三、依赖声明

- **零新增依赖**：本次任务不引入任何新 npm 包、不改 `package.json` 依赖节（阶段6 本身已声明依赖零变更：上游四包经 junction 链接，`self-contained-deps.test.ts` 守护仓库外 `file:` 依赖为零）
- 复用仓库既有工具链（devDependencies 已声明）：vitest 5、tsc 5.9、eslint 9、prettier 3、electron-builder 26、tsx 4、audit-ci 7
- **禁止执行 `npm install`**（`src/main/nikkisync/AGENTS.md` 硬性约定 6：会剪掉 `node_modules/@nikkisync` 四个 junction，使链接态用例集体降级 skip）；junction 完整性由 V1 的 `link:nikkisync:check` 前置确认

## 四、启动与运行说明

- **环境准备**：无需额外准备（Node v26.3.0 / npm 11.16.0 已就绪；依赖已安装；@nikkisync junction 已建）。所有命令在仓库根 `d:\Zcode项目\WXNN YD - 副本\WXNN XiangCe` 执行
- **执行顺序**：P0（计划落盘提交）→ P1（注释修复）→ P2（V1–V7 验证，任一失败即停下修复重跑）→ P3（feat 提交）→ P4（版本核验）→ P5（dist:win 构建）→ P6（CHANGELOG/执行记录收口提交）
- **长任务处理**：`npm test`（全量）与 `npm run dist:win`以后台方式运行并轮询读取输出；git commit 预留充足超时（pre-commit 钩子含相关单测子集 + tsc -b）
- **结果验证方式**：每个子任务的验收标准均为客观可判定命令（退出码 / 输出断言 / 产物存在性与时间戳）

## 五、错误处理

- **验证失败（V1–V7 任一红）**：立即停止流水线，亲自定位并修复（最小改动），修复后**从失败项起重跑至全绿**；禁止弱化断言、跳过用例、注释测试代码
- **pre-commit 钩子失败**：读 `[PRE-COMMIT]` 标记行定位阶段（lint/format/test/core-gate/tsc），自行落地修复后重新提交；**不得使用 `--no-verify` 跳过钩子**；提交后 `git status --porcelain` 复核钩子改写是否全部入提交
- **构建失败**：读取 electron-builder / electron-vite 日志定位（常见面：签名已禁用无签名问题、VC runtime afterPack、asar 打包过滤器）；修复后完整重跑 `dist:win`；不做部分重试
- **兜底原则**：任何步骤失败不进入下一步（错误消灭在当前环节）；全部产物（计划/提交/构建）落盘前不宣称任务完成

## 六、参数校验

本次任务不新增业务入参，校验面为流程判据：

- **版本核验**：`package.json#version` 逐字 === `"2.5.5"`（字符串全等，非前缀匹配）
- **提交信息**：commitlint 规则（type ∈ 枚举含 feat/docs/release；header ≤100 字符；subject ≤72 字符且不以中文句号结尾）
- **构建产物**：安装包文件名含 `2.5.5`（electron-builder `${version}` 注入）；产物时间戳晚于提交时间
- **测试有效性**：全量基线 394 files（相对阶段5 收口 390 files，阶段6 新增 4 个测试文件）；任何用例数缩减即视为异常并排查

## 七、基础测试用例（正常 / 异常 / 边界）

| 类别 | 场景                                      | 判定                                                                                          |
| ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| 正常 | 全量 `npm test`：394 files / 6151+ passed | 0 failed，2 skipped（链接态门控基线；本地已建链则 linked 用例实际执行并计入 passed）          |
| 正常 | `npm run dist:win` 全链                   | 退出码 0，安装包产物存在且时间戳更新，verify:dist 全 ✔                                        |
| 异常 | 若 V1–V7 或钩子失败                       | 流水线停止于失败环节，修复后从该环节重跑（处置流程见 §五；不在计划内人为制造故障）            |
| 边界 | 版本号已等于目标值 2.5.5                  | P4 走 no-op 断言分支，不产生改动、不产生提交                                                  |
| 边界 | P1 注释修复不引入行为变化                 | 15 例隔离护栏测试全绿 + prettier 通过（红绿不适用于零行为变更的注释修复，以全量回归替代证明） |
| 边界 | CHANGELOG 收口闸门                        | `[Unreleased]` 恒为空（阶段6 补录只进 `[2.5.5]` 节），`check-changelog-release` 退出码 0      |

## 八、假设与决策

1. **计划文档位置**：`docs/plans/`（仓库既有约定 + `.zcode/` 被 gitignore），满足「计划存入仓库」要求；偏离用户模板字面路径已在 P0 说明
2. **CHANGELOG 补录**：阶段6 将随 2.5.5 安装包重新出货，按仓库 2026-10-14「追加」先例补入 `[2.5.5]` 节（而非 `[Unreleased]`，收口闸门要求后者为空）；构建成功后才提交（保证「已于 2026-10-16 重新构建」表述真实）
3. **构建命令**：`dist:win` 为仓库标准打包流程（含三重前置闸门与 asar 后置校验）；不跑 `e2e:smoke`（超出本次任务范围，仓库上一轮重打包亦未含）
4. **提交拆分**：4 个提交（docs(plans) → feat(nikkisync) → docs(changelog) → docs(plans)），逐一对应仓库 2026-10-15 同类任务的提交模式
5. **版本任务**：HEAD 已是 2.5.5，P4 为核验 no-op——「准确修改为 2.5.5」在零改动下即满足
6. **审查修复范围**：仅 1 处注释重复缺陷；其余 33.9/34 文件审查通过，不做任何顺手重构或格式化（最小化改动红线）

## 九、最终验收清单（全绿才算完成）

- [ ] P0 计划文档已提交（docs(plans)）
- [ ] P1 注释重复已消除，隔离护栏 15 例全绿
- [ ] P2 七项验证全绿（V1–V7，含全量测试 0 failed）
- [ ] P3 feat(nikkisync) 提交完成，工作区干净
- [ ] P4 package.json version === "2.5.5" 断言通过
- [ ] P5 dist:win 退出码 0，新安装包时间戳为本次构建
- [ ] P6 CHANGELOG 补录 + 执行记录回填两个 docs 提交完成
- [ ] 终态 `git status --porcelain` 为空；`git log --oneline -5` 显示全部 4 个新提交

## 十、执行记录（2026-10-16 回填）

### 10.1 审查与修复

| #   | 发现                                                                                                                                      | 处置                                                                             | 结果                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `metadata-isolation-guards.ts` L20-25 注释块逐字重复 3 行（计划内缺陷）                                                                   | 删除重复行（P1）                                                                 | 15 例隔离护栏测试全绿（8+7，语义档 `node:sqlite` 实际执行）+ prettier 通过；注释级零行为变更，红绿不适用（计划已声明） |
| 2   | `src/main/nikkisync/AGENTS.md` prettier 格式违规（**计划外新发现**）：阶段6 新增长文件名表格行未重排列宽，`src/**/*.{...md}` 格式闸门命中 | `npx prettier --write`（仅表格对齐重排，内容零变化），随后 `npm run verify` 复跑 | 首跑 V2 format ✗ → 修复后 5/5 步骤全 ✓                                                                                 |

### 10.2 验证（V1–V7 真实退出码）

| 步骤 | 命令                                                       | 退出码      | 关键输出                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1   | `npm run link:nikkisync:check && npm run verify:nikkisync` | 0           | 四包 junction 全 ok；诊断 10 项 ✓（含新增 `ships the metadata resolver artifacts: present: dist\src\metadata\Nuan5CompatibleResolver.js, MetadataResolutionDiagnostics.js`），`blocking failures: 0` |
| V2   | `npm run verify`                                           | 0（修复后） | 首跑 format ✗（见 10.1 #2）；复跑 typecheck ✓ / lint ✓ / core-gate ⊘（未触及受保护路径）/ format ✓（26 文件）/ test ✓（6 files, 140 passed）                                                         |
| V3   | `npm run typecheck`                                        | 0           | `tsc -b && tsc -p tsconfig.scripts.json` 无输出                                                                                                                                                      |
| V4   | `npm run lint`                                             | 0           | `0 errors, 11 warnings`（全部为既有 DEBT-030 BOM warning，无新增）                                                                                                                                   |
| V5   | `npm run i18n:check && npm run i18n:guard`                 | 0           | 12 语言包 `key 对齐成功 (3932 keys)`；白名单守卫通过                                                                                                                                                 |
| V6   | `npm run audit`                                            | 0           | `Passed npm security audit.`（11 条命中均在 29 项豁免基线内）                                                                                                                                        |
| V7   | `npm test`                                                 | 0           | `Test Files 394 passed (394)`；`Tests 6151 passed \| 2 skipped (6153)`；Duration 47.83s —— 与阶段6 收口基线逐项一致                                                                                  |

### 10.3 提交（4 个，对应仓库 2026-10-15 同类任务模式）

| 哈希       | 提交                                                                 | 内容                                                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ba0a3e3`  | `docs(plans): 登记 2026-10-16 阶段6 审查/提交/版本核验/重新打包计划` | 本计划文件（pre-commit：prettier --write 后入提交）                                                                                                                                                                                                                                            |
| `8f2e9a8`  | `feat(nikkisync): 阶段6 同步元数据解析 opt-in 注入与表级隔离护栏`    | 34 files changed, 2528 insertions(+), 49 deletions(-)（含 P1 注释修复与 AGENTS.md 表格重排）；pre-commit 三步全过（lint-staged 含 `test:precommit` 17 个 TS/TSX 相关单测、core-gate、`tsc -b`）；commitlint 1 条 warning（body-max-line-length，非阻断）；提交后 `git status --porcelain` 为空 |
| `0427cca`  | `docs(changelog): 补录阶段6 元数据解析随 2.5.5 重新打包出货`         | CHANGELOG `[2.5.5]` 节 2026-10-16 追加注记 + Added 补录 1 条；收口闸门复核 ✔（12 版本节 / [2.5.5] 唯一 / [Unreleased] 空）                                                                                                                                                                     |
| （本提交） | `docs(plans): 回填 2026-10-16 审查/提交/版本核验/重新打包执行记录`   | 本节执行记录                                                                                                                                                                                                                                                                                   |

### 10.4 版本核验（P4）

`node -e "…require('./package.json').version"` ⇒ `VERSION=2.5.5`，退出码 0。HEAD 已是目标版本，零改动满足「准确修改为 2.5.5」，未产生额外提交（与计划 §P4 预期一致）。

### 10.5 构建（P5，`npm run dist:win`）

- 退出码 0；链路：`clean + electron-vite build` ✓ → `pre-dist-check` ✓（`全部校验通过` / README Electron 41.10 一致 ✓ / CHANGELOG 收口 ✓）→ `electron-builder 26.15.3 target=nsis x64` ✓ → `verify:dist` ✓（`解包二进制校验通过`）
- 产物：`release/NikkiGallery-Setup-2.5.5.exe` 重建于 **2026-10-16 17:58:25**（183,274,458 字节；上一版为 2026-10-15 22:56）+ `.blockmap`
- verify:dist 全 ✔：better-sqlite3 / sharp / koffi / VC++ 2015-2022 运行库 / `@nikkisync` migrations SQL + 四包入口 + row-mappers.js + LocalSyncServer.js + GalleryRuntime.mjs
- 额外复核：`app.asar.unpacked\node_modules\@nikkisync\pc-companion\dist\src\metadata\{Nuan5CompatibleResolver.js, MetadataResolutionDiagnostics.js}` 两深入口产物均在包内（True/True）

### 10.6 偏差记录

| #   | 计划写法             | 实际落地                                                             | 原因                                                                                                                                    |
| --- | -------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 审查发现 1 处缺陷    | 实际发现 2 处（注释重复 + AGENTS.md prettier 格式违规）              | 后者由 V2 verify 格式闸门暴露（阶段6 原收口只 prettier 检查了部分改动文件，漏了该 AGENTS.md）；以 `prettier --write` 最小修复并复跑全绿 |
| 2   | P0 一次提交成功      | 首次 `git commit` 退出码 1（无钩子输出可见），立即重试成功且钩子全过 | 瞬态（PowerShell 对 git stderr 的 NativeCommandError 处理干扰判定）；重试后仓库状态正确，无残留影响                                     |
| 3   | 全量测试后台轮询等待 | 后台任务通知机制送达完成事件                                         | 等价，无影响                                                                                                                            |
