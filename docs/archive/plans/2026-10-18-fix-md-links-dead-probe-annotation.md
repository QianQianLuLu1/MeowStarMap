# 修复 check-md-links 唯一死引用：打包态探针路径未同行交代去向（2026-10-18）

> 范围：只订正 1 处文档叙述，不改脚本、不改测试、不改源码、不动版本号与 CHANGELOG。
> 本轮不是发版轮，与 `dist:win` 无关。

## 0. Context：为什么会有这个红灯

全量 `npm test` 失败 1 / 6453：

```
FAIL  node  scripts/__tests__/check-md-links.test.ts > 真实仓库契约：被跟踪文档不留死引用 > runCheck() 的死引用数为 0
AssertionError: 发现 1 处死引用：
  docs/plans/2026-10-18-fix-editor-preview-realtime.md:355 inline-path `e2e/preview-worker-probe.e2e.ts`
```

`npm run docs:links` 实测读数：**扫描 64 个被跟踪 markdown，1 处死引用，其余全为提醒**。

三条取证结论：

1. **该探针文件从未入仓**。`git ls-files e2e/` 无 `preview-worker-probe.e2e.ts`，目录实测也没有。它是本轮 §11 记录的打包态探针——本仓约定是复用仓内 `e2e/helpers.ts` 的 `launchBuiltApp()` 起 dist 产物跑一次真实链路，**验证后已删除、不入仓**，只把读数写进计划文档。所以文档叙述是真的，不是笔误。
2. **闸门按物理行判定**。`scripts/check-md-links.ts` 的 `classifyRef()` 在路径不被跟踪时，只有引用所在**整行**命中 `GONE_MARKERS` 才降级为 `annotated-gone`。原文里「临时」不是 marker，去向「验证后删除」被分行写到了 356 行；且 `GONE_MARKERS` 只收「已删除」，不收裸「删除」。两条都不满足 → 判 `dead`。
3. **提交时本地零闸门**。只改 `docs/**` 时：`scripts/find-related-tests.ts` 只接受 `.ts/.tsx`，所以 `scripts/verify-changes.ts` 的 test 步骤拿到空集；`package.json` 的 `lint-staged` 无 `docs` 键；`format` / `format:check` 的 glob 也不含 `docs/**`。因此 `e9b48cd` 补录 §11 时 `npm run verify` 全绿，死引用到下一次全量 `npm test` 才暴露。

结论：这是**文档没按既有约定写去向**，不是机制缺陷。修文档即可，闸门工作正常——它正是靠这条断言把「被跟踪文档不留死引用」钉进 CI 的。

## 1. 依赖声明

**无新增、无变更、无删除依赖**，无需 `npm install`。用到的全部是仓内既有资产：

| 能力                        | 出处                                                                     | 说明                                          |
| --------------------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| `npm run docs:links`        | `package.json` scripts → `tsx scripts/check-md-links.ts`                 | 只读死引用闸门，死引用时退出码 1              |
| `npx vitest run <file>`     | 既有 devDependency `vitest`                                              | 跑 `scripts/__tests__/check-md-links.test.ts` |
| 全量测试 / lint / typecheck | `npm test` / `npm run lint` / `npm run typecheck` / `npm run i18n:guard` | 均为仓内真实存在的脚本，无需新建              |

## 2. 启动说明

- **环境**：Windows x64，仓库根目录，Node 24.x。无需 `npm run dev`、无需 Electron、无需数据库——本轮全是只读静态检查。
- **执行顺序**：N1 复现红灯 → N0 计划落仓 → N2 改文档 → 验证转绿 → N3 临时变异证明判别力 → N4 全量回归。
- **验证方式**：以 `npm run docs:links` 退出码 0，与 `npm test` 汇总行 `0 failed` 为准。
- **必须记住的分工**：`npm run verify` 对纯 md 改动**不跑任何测试**（见 0.3），所以「verify 绿」不能当作本轮已修复的证据；只有 `docs:links` 与 `npm test` 算数。

## 3. 错误处理

| 异常分支 | 判定与兜底 |
| ------------------------------ ---------------------------------------------------------------------------- |
| 改后仍报同一条 | marker 没与路径落在同一物理行。`sed -n '355p'` 打印确认，再重跑；不放宽脚本。 |
| 改后冒出第 2 条死引用 | 通常是本计划文档写了未入仓路径。同样补同行去向，**不**动 `GONE_MARKERS`、**不**加「路径作用域」声明。 |
| `npm test` 有无关失败 | 先取证是否既有失败（`git status --porcelain`、`git cat-file -e HEAD:<path>`），如实报告并保留，不顺手修、不弱化。 |
| prettier / eslint 报格式 | `docs/**` 不在任何格式闸门内；若单文件 `npx prettier --check` 失败则按其结论调整，不动其它文件。 |
| 闸门读不到 git | `execFileSync('git', ...)` 抛错即非 0 退出，属环境问题，不绕过，停下报告。 |

**日志输出**：判定只依据 `[check-md-links]` 前缀行（✖ 死引用 / ⚠ 提醒 / ✅ 通过）与 vitest 汇总行。

## 4. 参数校验

本轮「输入」是文档文本，校验即闸门的判定链（`scripts/check-md-links.ts`）：

- **被判为路径引用的条件**：token 以 `PATH_LIKE_ROOTS`（`docs/`、`src/`、`scripts/`、`e2e/`、`plugins-samples/`、`.github/`、`tests/`）开头，且以 `KNOWN_EXTENSIONS` 结尾或以 `/` 结尾。`e2e/smoke.e2e.ts` 命中 `.ts`，`plugins-samples/` 命中目录形态。
- **会被跳过的形态**：含空白与 `*?<>|{}$'"` 反引号反斜杠、含 `...` 或 `://`、以 `#` / `/` / 盘符开头、以及 `^[\w./-]+:` 形态（通道名或带行号的引用）。因此同一行里的 `e2e/helpers.ts:146` **不会被抽取**，加字不会新增引用。
- **边界：围栏代码块内的路径是示例，不产生引用**。所以订正必须留在正文列表项内，把 token 挪进代码块「绕过」判定属于伪修，禁止。
- **边界：行首两空格是列表延续，不是 fence**（判定只认行首 ` ` ``` / `~~~`），现有缩进保持不变。
- **本次编辑的三条硬约束**：① marker 与路径 token 同一物理行；② token 拼写不变、仍用反引号包裹（历史可追溯）；③ 不引入新的 root-anchored 反引号 token 而不交代去向。
- **禁止放宽判定**：不改 `GONE_MARKERS`、不改 `isPathLike`、不把测试的 `toBe(0)` 改小。

## 5. 基础测试用例

本轮不改测试代码——闸门测试就是回归用例，且当前已红。三类用例登记如下：

| 类别 | 用例                                   | 命令                                                        | 期望                                            |
| ---- | -------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| 正常 | 被跟踪文档死引用数为 0                 | `npm run docs:links`                                        | `✅ 无死引用`，退出码 0                         |
| 正常 | 闸门未空转（确实扫到 markdown）        | `npx vitest run scripts/__tests__/check-md-links.test.ts`   | 24 passed（含 `totals.docs > 50`）              |
| 异常 | 路径未同行交代去向 → 必须判死          | N3 临时把 marker 移回下一行                                 | **只有**该契约用例变红，报同一行号              |
| 边界 | 带行号的 `e2e/helpers.ts:146` 不被抽取 | `npm run docs:links` 前后对比                               | 该行始终只产 1 条引用：改前 dead、改后 advisory |
| 边界 | 静态/类型/安全闸门无新增失败           | `npm run lint` / `npm run typecheck` / `npm run i18n:guard` | 0 error（存量 BOM warning 不变）；无输出；通过  |

## 6. 子任务与验收标准

| 节点 | 文件（完整路径）                                                  | 输入 / 输出                                                                      | 验收标准                                                                                 |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| N1   | 无（只跑命令）                                                    | 输入：HEAD `e9b48cd`；输出：红灯读数                                             | `docs:links` 退出码 1 且只报 355 行；vitest `1 failed`                                   |
| N0   | `docs/plans/2026-10-18-fix-md-links-dead-probe-annotation.md`     | 输入：本文件；输出：计划落仓                                                     | 写完立刻 `npm run docs:links`，死引用数仍为 1（本文档自身 0）                            |
| N2   | `docs/plans/2026-10-18-fix-editor-preview-realtime.md` 355–356 行 | 输入：把「验证后已删除、不入仓」提到路径同行，删掉 356 行重复去向；输出：+2 / −2 | `npm run docs:links` 退出码 0；`git diff --stat` 只含该文件                              |
| N3   | 同上（临时变异，随后逐字还原）                                    | 输入：还原成 marker 在下一行的旧写法；输出：红灯 + 还原                          | 变异期只有该用例红；还原后 `grep -c "验证后删除" <该文件>` 为 0，diff 仍是 +2 / −2       |
| N4   | 无（只跑命令）                                                    | 输入：最终工作区；输出：全量读数                                                 | `npm test` 0 failed；lint 0 error；typecheck 无输出；i18n:guard 通过；verify 全项 ✓ 或 ⊘ |

## 7. 明确不做（附证据，避免下轮重议）

| 候选做法                             | 结论     | 证据                                                                                                                                                                                                               |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 给 `GONE_MARKERS` 加裸「删除」       | 不做     | marker 在 356 行、ref 在 355 行，加了也修不好本次；该集合是脚本文件头声明的唯一真相源，改动须同步测试                                                                                                              |
| 给 `GONE_MARKERS` 加「临时」         | 不做     | 「临时」不交代去向，违反脚本自身约定；全仓有大量「临时 / 删除 + 现存路径」的行，加进去等于放弃这些行未来的保护                                                                                                     |
| 把探针文件保留进 `e2e/`              | 不做     | `e2e/playwright.config.ts` 的 `testMatch: '*.e2e.ts'` 会让 `npm run e2e:smoke` 自动跑它（需要先装好的安装包），`e2e/tsconfig.json` strict 与 `typecheck:e2e` 也得维护；更会让文档「临时…验证后删除」的叙述变成假的 |
| 给计划文档加「路径作用域」声明       | 不做     | 会把该文档内所有不可解析路径永久降级为提醒，等于给自己关闸门。`docs/sync-integration/01-dependency-link-plan.md` 那批上游文档适用，本仓实施记录不适用                                                              |
| 顺手补「md-only 改动本地零闸门」缺口 | 本轮不做 | 属闸门/钩子改动，与本次红灯无直接关系，按最小化改动先登记待议：若要补，落点是 `scripts/find-related-tests.ts` 或 `.husky/pre-commit` 增一条「暂存含 `docs/**` 时跑 `npm run docs:links`」，需另起一轮              |

## 8. 本轮实测读数（执行时回填）

- N1 红灯基线：`npm run docs:links` → 扫描 64 篇、1 处死引用（`docs/plans/2026-10-18-fix-editor-preview-realtime.md:355`）、退出码 1；`npx vitest run scripts/__tests__/check-md-links.test.ts` → `1 failed | 23 passed (24)`。
- N2 转绿：`npm run docs:links` → `✅ 无死引用`、退出码 0（扫描 64 篇被跟踪 markdown）；`npx vitest run scripts/__tests__/check-md-links.test.ts` → `24 passed (24)`；`git diff --numstat` = 2/2，仅 `docs/plans/2026-10-18-fix-editor-preview-realtime.md` 一个文件。
- N3 判别力：把文件改回 HEAD 原文（`git diff --numstat` 为空 = 逐字一致）后跑 `npx vitest run scripts/` → **只有** `runCheck() 的死引用数为 0` 变红，`1 failed | 214 passed (215)`；`docs:links` 同时报 dead=1 / advisory=132、退出码 1。还原后 `docs:links` 退出码 0、advisory=133（= 132 + 本轮新增的 1 条 `annotated-gone`），`git diff --numstat` 回到 2/2。判别力判据用「整份文件与 HEAD 逐字节一致」，不用关键词计数——「验证后删除」在本文档 §9 的 B0/B4 两行里另有 2 处既存出处，计数无法区分。
- N4 全量：`npm test` → **415 passed | 3 skipped (418 files)，6412 passed | 41 skipped (6453 tests)，0 failed**，36.68s；`npm run lint` → **0 error**（11 条 warning 全是 DEBT-030 登记的 `components/common/*.test.tsx` 存量 BOM，本轮未触碰）；`npm run typecheck`（含 `tsconfig.scripts.json`）无输出；`npm run i18n:guard` ✅；`npm run verify` 六步（typecheck / lint / core-gate / format / test）**全 ✓**。
- 本轮实际改动只有 2 个文件：`docs/plans/2026-10-18-fix-editor-preview-realtime.md`（+2 / −2）与本文档（新增）。工作区另有 20:14 及更早的 sync-gallery 工具栏与 locale 未提交改动（mtime 实测），非本轮所动。

## 9. 下一轮（2.5.5-beta 发布轮）独立复验

同一条判据在 `docs/plans/2026-10-18-sync-gallery-toolbar-about-nikkisync.md` 的红-绿取证表里被再次执行一遍，以免「文档自称已验」当成事实：把 `docs/plans/2026-10-18-fix-editor-preview-realtime.md` 用 `git checkout HEAD -- <该文件>` 退回带缺陷的写法（去向不与路径 token 同行），`npm run docs:links` 退出码 1 并指名 355 行，`npx vitest run scripts/__tests__/check-md-links.test.ts` 为 **1 failed / 23 passed** 且只有 `runCheck() 的死引用数为 0` 红；从仓库外备份还原后 `git diff | sha256sum` 与变异前逐字相等（`66f84269…`），`docs:links` 回到退出码 0。

另有一处需后续轮次注意：本文档与上一轮那份计划都写进了 `docs/plans/`，提交后即进入 `check-md-links.ts` 的扫描集（它读 `git ls-files`，未跟踪时不判）。后续再往这些文档里写探针路径时，同行去向的约定同样生效。
