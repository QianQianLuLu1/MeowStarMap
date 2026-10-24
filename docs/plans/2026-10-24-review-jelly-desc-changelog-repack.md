# 审查收口 + 果冻描述/CHANGELOG 对齐 + 2.5.5 重打包

> 日期：2026-10-24 ｜ 状态：执行中（执行记录见文末）
> 背景：对全部近期提交与未提交代码做全面审查、修复问题、确认版本 2.5.5、重新打包。

## 一、审查结论（已完成，证据在案）

**范围**：工作区干净（`git status --porcelain` 空）；上轮审查 2026-10-24 收口于 `38c746e`（19:00）后仅一个新提交 **`610521a`**（果冻动效，19:35）。

**`610521a` 深审通过**：

- CSS 变量（`--ease-spring` / `--ease-standard` / `--success` / `--success-deep`）均已定义（`globals.css` L77/80/103/106）；类名与 `Switch.tsx:38,40` 挂载点一致。
- keyframes 双名重触发手法正确（`aria-checked` 翻转即 `animation-name` 变化，动画必然重触发）；位移（`left`）走 transition 与途中拉伸（`transform`）走 keyframes 分属两个属性，避免级联竞争。
- 两条 reduce-motion 路径（手动 `html.reduce-motion` L195-202 + 系统 `prefers-reduced-motion` L1543-1551）均有全局时长归零兜底，新动画自动降级。
- scaleX 峰值 1.35 ≤ 1.4 边界（18px 滑块不溢出 44px 轨道）；挂载脉冲副作用已在原计划文档 §八.1 明示接受。
- 该提交自带红绿证据（Node1 5/5 红→绿、Node2 3/3 红→绿）与全量回归（441 文件 / 6794 通过 / 12 跳过）；未触碰受保护路径（`src/main/preload/api/**`、`src/main/ipc/handlers/**`、`src/main/services/**`、`src/shared/errors/**`）。

**发现的 3 处问题（均为 `610521a` 改行为但未同步的轻量漂移，需修复）**：

1. `src/renderer/components/common/Switch.tsx:20` — JSDoc 仍写旧行为「按下拉伸、松开过冲回弹」（新实现已无 `:active` 按压，改为点击触发的果冻动画）。
2. `src/renderer/components/common/Switch.stories.tsx:13-14` — Storybook 组件描述同样残留旧文案。
3. `CHANGELOG.md` 补录台账（`[2.5.5-beta]` 节引用块，GPU 条目第 57 行为最新一条）无果冻动效条目（全文件无「果冻」）。仓库惯例：定版后合入、随重打包出货的改动必须逐条补录（上轮 GPU 优化即此模式）。即将重打包出货，日志必须先补齐。

**版本号**：四处声明位（`package.json:3`、`package-lock.json:3,9`、`database-mock.ts:664`、`release/latest.yml` 自动生成）及 README 徽章、AGENTS.md、ARCHITECTURE(.en).md、DEVELOPMENT(.en).md 文档位实测均已是 2.5.5 —— **「设定 2.5.5」为验证确认，零改动**（Node 4 以两道闸门证明）。

**重打包必要性**：`release/MeowStarMap-Setup-2.5.5.exe` 构建于 2026-10-24 17:48（内容含到 `c8112ff` 17:46），果冻动效 `610521a` 19:35 才合入 —— 当前安装包**不含**最新提交，重打包真实必要。

## 二、依赖声明

**零新增、零变更依赖。** 全程**禁止 `npm install` / `npm ci`**——本机 node 26 / npm 11 会剥离 `package-lock.json` 的 `libc` 字段（不入仓）并清掉 `node_modules/@nikkisync` 四条 junction（打包闸门校验其在位）。误跑后用 `git checkout package-lock.json` + `npm run link:nikkisync` 恢复。复用令牌与守卫：`--ease-spring`、`--success`、`--success-deep`（已存在）、`settings-elastic-switch.test.ts`（`610521a` 新增）。

## 三、启动与运行说明

- 环境：现有 `node_modules` 即可，无需安装。
- 命令链：`npx vitest run <子集>` → `npm run verify` → `npm test` → `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `git commit` → `npx tsx scripts/check-changelog-release.ts && npx tsx scripts/check-doc-versions.ts` → `npm run link:nikkisync:check` → `rm -rf release/win-unpacked*` → `npm run dist:win` → `npm run e2e:smoke`。
- 改动 `src/**` 一律用 Write/Edit 工具（Mimosa 钩子拦截 Bash 直写源码）；commit 信息措辞避开「动词：路径」形态。

## 四、子任务定义（三要素）

### Node 1：修复三处漂移

- **涉及文件**：`src/renderer/components/common/Switch.tsx`（L20 注释一句）、`src/renderer/components/common/Switch.stories.tsx`（L13-14 描述）、`CHANGELOG.md`（GPU 条目后追加一条 `> 2026-10-24 追加：` 补录）。
- **输入/输出**：注释与文档文本；不改任何行为代码、不动 `[Unreleased]`、不改 `[2.5.5]` 节正文。
- **验收标准**：注释级改动无行为路径、无红绿可写（守卫测试已存在且继续通过即证明未破坏）：`npx vitest run src/renderer/styles/settings-elastic-switch.test.ts src/renderer/components/common/Switch.test.tsx src/renderer/pages/settings/shared.test.tsx scripts/__tests__/check-changelog-release.test.ts` 全绿。

### Node 2：全量回归（一票否决闸门）

- **涉及文件**：无新改动，纯验证。
- **输入/输出**：读全仓；零写入（verify 系列只读）。
- **验收标准**：`npm test`（基线 441 文件 / 6794 通过 / 12 跳过）→ `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `npm run verify` 按序全绿，无新增失败。

### Node 3：提交修复

- **涉及文件**：Node 1 三文件 + 本计划文档。
- **输入/输出**：`git add` + 单笔提交，Conventional Commits `docs(ui)` 类型、subject ≤72 字符。
- **验收标准**：提交成功；提交后 `git status --porcelain` 干净（pre-commit 钩子无残留改写）。

### Node 4：版本一致性闸门（2.5.5 零改动证明）

- **涉及文件**：无改动，跑既有闸门。
- **输入/输出**：读 `package.json` / `CHANGELOG.md` / README 徽章。
- **验收标准**：`npx tsx scripts/check-changelog-release.ts` 与 `npx tsx scripts/check-doc-versions.ts` 双绿——证明 2.5.5 全声明位一致（闸门绑定的既有绿灯，不自造测试）。

### Node 5：重打包（四段链）

- **涉及文件**：`release/` 产物树（`win-unpacked*` 清理重建，exe/blockmap/latest.yml 再生成）。
- **输入/输出**：`npm run link:nikkisync:check`（四链接在位）→ `rm -rf release/win-unpacked*` → `npm run dist:win`（build → pre-dist-check → electron-builder NSIS → verify:dist 禁串扫描 fail-closed）→ `npm run e2e:smoke`（S4 断言打包产物 `app.getVersion()` === 2.5.5）。
- **验收标准**：`release/MeowStarMap-Setup-2.5.5.exe` 修改时间晚于 `610521a` 提交时间（19:35）；`latest.yml` 版本 2.5.5；冒烟全绿。

### Node 6：执行记录与收尾提交

- **涉及文件**：本计划文档（补 §八 执行记录）。
- **输入/输出**：`docs(plans)` 类型单笔提交。
- **验收标准**：执行记录含各节点结果数字与产物时间戳；最终 `git status` 干净。

## 五、错误处理

- **dist 失败**：按 `[VERIFY]` / pre-dist-check 输出定位失败步骤；`win-unpacked` EBUSY 时重试清理，禁旁路打包树凑成功（过期残壳唯一确定清法是重启系统，不强行绕）。
- **e2e S4 版本断言失败**：比对 `release/latest.yml` 与 `package.json` 的 version 是否漂移。
- **`verify:dist` 禁串命中**：读 `pre-dist-check --verify-asar` 命中清单，属 fail-closed，不得放宽闸门，须回溯源码修正后重建。
- **Mimosa 钩子拦截**：commit 信息改措辞（路径不与冒号相邻）；`src/**` 改动一律走 Write/Edit。

## 六、参数校验

本轮无运行时入参、无新 IPC 契约。校验由既有闸门承载：`check-changelog-release.ts`（版本节唯一性 + `[Unreleased]` 无待发布条目）、`check-doc-versions.ts`（README Electron 徽章一致）、`pre-dist-check.ts` 27 项（含 `--verify-asar` 禁串审查）、`settings-elastic-switch.test.ts`（动效规格：350ms 时长、scaleX 峰值 ∈ (1, 1.4]、双动画名、无 `:active` 回归）。

## 七、基础测试用例

- **正常路径**：Node 1 子集四文件全绿（守卫规格仍被满足）；Node 4 双闸门绿。
- **异常路径**：`settings-elastic-switch.test.ts` 的「异常：不得回归 `:active` 按压拉伸」用例继续通过（防本次注释改动误伤 CSS）；`check-changelog-release` 的 `[Unreleased]` 空检查（确认补录未误写进未发布节）。
- **边界条件**：scaleX 峰值 ≤1.4（滑块不溢出轨道）既有用例；e2e S4 版本一致性断言（打包产物版本 === 声明版本）。

## 八、执行记录

（待各节点完成后回填）
