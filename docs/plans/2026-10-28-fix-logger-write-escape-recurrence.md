# 2026-10-28 CI 状态核查与 DEBT-039 复发性逃逸清偿

> 状态：**已执行完毕（本机侧）**——节点 0 至 7 全部落地，锚定计数 28 → 1、守卫 15 例全绿、
> `npm test` 453 文件 / 7063 通过 + 12 跳过。原「计划已落仓，等待用户读过」为节点 0 时的事实，保留在此
> 以供追溯；逐节点读数与**五处与计划的偏差**见文末 §十。剩余未闭环一项只能由 CI 给出证据：
> 慢宿主上的 `EnvironmentTeardownError`（§十 末节）。
> 用户已确认的两项口径：① 收口范围 = 「两处都修 + 防回归守卫」（实测到的 `logger.enforce.test.ts` 与
> `dir-manager.test.ts` 两个真站点全修，并补一条封闭集守卫）；② 交付路径 = 「直推 `main` 触发一次真实 CI 复验」。
> 前置事实：**CI 在 HEAD 已全绿，本轮没有失败可修**，故不虚构红灯（见 §一 开头）。

## 一、诊断结论（全部为实测读数，非推测）

### 1.1 远端流水线现状：绿

远端 `QianQianLuLu1/MeowStarMap` 只有 `build.yml` 一条流水线。本机 HEAD `520588a` 与 `origin/main` 是 `0 ahead / 0 behind`，工作树仅有一个被 `.gitignore:200` 排除的 `release-sync/`，无待提交改动。

| run              | head_sha  | 结论        | 失败点（step 级）                                                | 现状                            |
| ---------------- | --------- | ----------- | ---------------------------------------------------------------- | ------------------------------- |
| 25 `40693379241` | `520588a` | success     | —                                                                | 14 个 job 全绿（= 当前 HEAD）   |
| 24 `40691339965` | `489ffbf` | success     | —                                                                | 14 个 job 全绿                  |
| 23 `40686664787` | `d28564f` | **failure** | `Test (shard 5/10)` 第 5 步 `npm test -- --shard=5/10`           | 已由 `489ffbf` 真因修复并实证   |
| 22 `40535766156` | `df2ab84` | **failure** | `Lint, Typecheck & Security` 第 6 步 `Security audit (audit-ci)` | 已由 `d2ae917` + `9451efd` 修复 |
| 21 `40516757209` | `59b40a4` | **failure** | 同 22、同一步                                                    | 同上                            |

三处失败都已关闭，并被 #24/#25 两次全绿实证；两处修法都带红→绿取证（`127158d` 先落红灯守卫再修 lock 解析、`489ffbf` 的新守卫用例修复前 `1 failed | 121 passed`），**不是遮蔽症状**。`Storybook Docs` 的 skipped 是 `build.yml:292` 的设计（仅 `workflow_dispatch` 或 tag push 才跑），非异常。

因此本轮**不编造假红-绿**：改为清偿上一轮作者自己留在 `docs/debt-registry.json` 的 DEBT-039（open / medium），它是 run 23 那处红的**同类复发风险**。

### 1.2 取证：本机全量 `npm test` 的锚定计数

本机跑全量得 `Test Files 452 passed (452)` / `Tests 7046 passed | 12 skipped (7058)`、54.13s，与 `ARCHITECTURE.md` §C.3 记录的读数**逐字相同** ⇒ 本机计数对这类缺陷是有效取证工具（上一轮同理：本机单文件跑出 207 条，与 CI 整条 shard 的计数相同）。

按「剥 ANSI + 行首锚定 + 最近一条 `stderr | <file>` 头归因」统计，`[Logger]` 三类告警共 **28 行**（我最初只 grep 了「写入失败」一类，得 12，漏掉另两类——这就是 §1.4 要订正判据时踩到的坑）：

| 站点                                    | 条数                                                     | 性质                              |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------- |
| `src/main/utils/logger.enforce.test.ts` | 10 `写入失败` + 10 `故障日志写入失败` + 5 `大小检查失败` | **夹具缺陷**（真缺陷）            |
| `src/main/database/connection.test.ts`  | 1 `大小检查失败`                                         | **上一轮修复的漏项**（第 4 站点） |
| `src/main/utils/dir-manager.test.ts`    | 1 `写入失败`                                             | **跨用例状态泄漏**（真缺陷）      |
| `src/main/utils/logger.test.ts`         | 1 `写入失败`                                             | **故意用例，必须保留**            |

全部 fire-and-forget 源头在 `src/main/utils/logger.ts`：`:222` 是 `fs.promises.appendFile(getMainLogPath(), ...).catch(...)`、`:224` 发 `[Logger] 写入失败:`；同族的 `:361`/`:390` 发「故障日志写入失败」、`:491` 发「大小检查失败」；`:212` 是 `if (!logDir) initLogger()`；`:448` 是 `await fs.promises.readdir(logDir)`。

### 1.3 三处根因

1. **`logger.enforce.test.ts`**：`tmpDir` 是模块级常量（`:15-18`），`beforeAll`（`:35-37`）建目录、`afterEach`（`:42`）`rmSync` 删掉 ⇒ 第二个用例 `throttle:`（`:85`）全程对着**已删除的目录**跑，10 次 `logFault` 的 append 全 ENOENT。它的 `expect(totalScans).toBe(5)`（`:104`）数的是 `readdir` 的**调用次数**、不判成败，所以用例照样绿——注释里写的「真实扫描」从未发生。`burst:` 用例零告警（目录那时还在）。
2. **`dir-manager.test.ts`**（**订正本文初稿的判断**：不是「`rm` 与 append 抢跑」）：`logger.ts:123` 的 `logDir` 是模块态，Vitest 按**文件**而非按用例隔离。首个触发 logger 的用例把 `logDir` 冻结在自己的 `<tmpBase>/userData/logs`，其后用例 `beforeEach` 换了新 tmpBase，logger 仍写那个**早已删除的旧目录**。日志证据：告警目标是 `wxnn-dir-test-phfaZG`，而当时在跑的 `it('非 EXDEV 错误直接记为失败')` 自己的目录是 `wxnn-dir-test-CjphWi`；相邻那条 `electron-log.transports.file: Can't write to ...phfaZG...` 同证此泄漏。机制是**确定性**的，因此适合做红灯基线。
3. **`connection.test.ts`**：上一轮只静默了 `appendFile`，但 `mkdirSync` 也被 mock（`:691`）⇒ `logFault` 走通后首次触发 `enforceMaxSize`，`:448` 对 `/mock/userdata/.../logs` 的 `readdir` ENOENT ⇒ `:491` 的 `console.error` 从**异步续体**发出，与打红 shard 5 的形状完全同类。上一轮只修了 CI 实际点名的那一条，本条是其漏项。

### 1.4 DEBT-039 的撤销判据本身写错了（需订正）

登记的原句是「全量与分片跑的 `npm test` 输出里 `[Logger] 写入失败` 计数为 0」，这条**永远达不到**：`src/main/utils/logger.test.ts:371` 那条 `mockRejectedValueOnce(new Error('disk full'))` 用例正是为断言「写盘失败只告警不抛错」而存在，它本身产出一条该字样。清零只能删该用例、或删 `logger.ts:224` 的告警——两者都违反 `docs/CODING_CONVENTIONS.md` 的「不得为凑绿遮蔽信号」。按仓库口径，这写成对原登记的**订正**（原句保留 + 加时间限定），不静默覆盖。

订正后的判据（三类并集、行首锚定、剥 ANSI），终局必须输出 `1` 且唯一站点归因 `logger.test.ts`：

```bash
npm test 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' \
  | grep -ac "^\[Logger] \(写入失败\|故障日志写入失败\|大小检查失败): "
```

两个必要限定：① **必须锚定并剥 ANSI**——不锚定的 `grep -c "[Logger] 写入失败"` 实测得 **13**，多出的 1 是 `connection.test.ts:1870` 用例标题里含该字样；② 判据是**内容判据**，不是分片判据——分片归属会随任一测试文件的增删整体重排，故本轮**任何验收都不得引用分片号**。

（供解读用、不作闸门：按 vitest 5.0.3 `BaseSequencer.shard()` 的 sha1 排序推出 `logger.test.ts`→shard 1、`logger.enforce.test.ts`→shard 3、`dir-manager.test.ts`→shard 7；该推导已用 run 23「shard 5 恰好 45 个文件」对齐验证。）

## 二、依赖声明

**零新增、零变更。** 不碰 `package.json` / `package-lock.json` / `audit-ci.jsonc` / `.github/workflows/build.yml` / `vitest.config.ts`（含其 `testTimeout: 10000` 与 `:102-107` 的覆盖率阈值）。守卫只用 Node 内置 `fs` 与既有 `vitest`，台账内联在 TS 里——样板是仓内的 `lock-advisory-floor.test.ts`、`old-name-ledger.test.ts`、`path-semantics-guard.test.ts`。

## 三、启动说明（环境、复现与验证方式）

环境：Windows x64 + `.node-version` 指定的 Node，无需额外环境变量。基线取证（只读，输出留存于 `.cache` 下的 `debt039-measure.log`）：

```bash
npm test 2>&1 | tee .cache/debt039-measure.log        # 现值 452 files / 7046 passed + 12 skipped
npx vitest run src/main/utils/logger.enforce.test.ts  # 现值：写入失败 10 / 故障 10 / 大小 5
npx vitest run src/main/database/connection.test.ts   # 现值：大小检查失败 1
npx vitest run src/main/utils/dir-manager.test.ts     # 现值：写入失败 1
```

逐站点计数 = 剥 ANSI + 行首锚定 + 按最近一条 `stderr | <file>` 头归因。每节点提交前跑 `npm run verify`（只读），提交后 `git status --porcelain` 复核钩子是否改写文件。

## 四、错误处理与兜底策略

- **不新增生产代码路径**，因此没有新增异常分支；`logger.ts` 的 `writeLog` / `logFault` / `enforceMaxSize` 现有 fail-open 兜底与四条告警一律保持原样，并由新守卫**反向钉住**它们不得被删或改词。
- 夹具改造的失败面：`fs.mkdtempSync` 失败 ⇒ 用例当场抛红（可接受，与 `logger.test.ts` 现有写法同型）；`afterEach` 的 `rmSync` 在 Windows 可能 EBUSY/ENOTEMPTY ⇒ 保留既有重试，但**改为在钩子内 `await`**（现状是一条未被人持有的 `realSetImmediate` 回调，它本身就是同类逃逸形状；且若与下一用例的建目录撞车，会把确定性缺陷换成间歇性缺陷——按用例唯一目录正为此规避）。
- 红灯不达标时的兜底：**不得** `it.skip`、不得放宽断言、不得改阈值。若 `throttle` 的扫描次数因目录变真实而不再是 5，处置是取证后**如实改写为实测值并在台账写清理由**（判据必须落在真实行为上），而不是把断言调回 5。推导上应保持 5：`:448` 的 `readdir` 是先同步被调用再 await，spy 计数与其成败无关；200 条故障记录约 120 KB，远低于内存估计旁路阈值；fake-time 跨度 ≤36s，远低于 90 天/2 GB 的删除条件。执行时以实跑为准。
- 慢宿主的 `EnvironmentTeardownError` **本机无法确定性复现**（run 23 该 shard 用 24.15s，本机 1.75s）。`npm run test:ci-linux` 会补齐宿主四轴并额外给 fs 路径翻译开销，本轮用它记录同一条锚定计数；但只写「是否观测到该错」，**绝不写成「已验证不出现」**——该类的最终缺席证据只有 CI 的 10 分片。

## 五、参数校验

新守卫（`scripts/__tests__` 下的 `logger-escape-ledger.test.ts`，阶段 B 才创建）的台账行类型：

```ts
interface LedgerRow {
  file: string // 相对仓库根、正斜杠；文件必须存在
  pattern: string // 行内字面量（与 git grep -F 同义）
  count: number // 期望出现次数，「相等」而非「≤」
  reason: string // 中文真实理由，非空、非占位、≥12 字
}
```

非法值一律判红、不静默：`file` 不存在；同一文件同时出现在「静默表」与「真写盘表」（互斥违规）；`reason` 为空 / 占位文案 / 跨文件复制超过 6 份；扫描域为空；台账之外在 `src/**` 出现 `appendFile` 静默。

- 路径语义归位：守卫只读源码文本、经 `import.meta.url` 定位仓库根，不引入 win32 钉也不引用户言引用 ⇒ 按 `path-semantics-guard.test.ts` 的规则无需登记；执行时以该守卫保持绿来确认这一判断。
- 受保护路径：本轮**不触碰** `src/main/preload/api/**`、`src/main/ipc/handlers/**`、`src/main/services/**`、`src/shared/errors/**` ⇒ 无需 `// @core-change:` 授权注释，`docs/IPC_CONTRACT.md` 契约面为零。

## 六、基础测试用例（正常 / 异常 / 边界三类）

守卫侧（静态、与宿主无关）：

- **正常**：`logger.ts` 的 fire-and-forget 站点计数恒为台账值（`fs.promises.appendFile(getMainLogPath()` == 1、`'[Logger] 写入失败:'` == 1、`console.error('[Logger]` == 4、`fs.promises.readdir(logDir)` == 1、`if (!logDir) initLogger()` == 1）；两张台账逐文件逐模式计数与实测**相等**。
- **异常（红灯样本，用来证明守卫自己有效）**：① 合成一份删掉 `[Logger] 写入失败` 告警的源码 ⇒ 必须判违规（这就是「禁止靠遮蔽信号凑绿」的机械锁）；② 合成一份新增第二条无人持有的 `appendFile().catch()` 的源码 ⇒ 必须判违规；③ 合成一份正常样本 ⇒ 零违规。
- **边界**：`tests/setup.ts` 内 `appendFile` / `readdir` 静默计数恒为 0（锁死「不做全局静默」这个决定，逼后来者显式评审）；真写盘名单不得被删短（`logger.test.ts` 与 `logger.enforce.test.ts` 必须在表内）；`logger.enforce.test.ts` 内 `beforeAll(` 计数必须为 0 且出现按用例唯一的 `mkdtempSync` 前缀；扫描域 `src` 下测试文件数 > 400（现 420）且所有静默站点都在台账内；环境卫生探针标记 `// @hygiene-probe` 恰好 3 处。

被改套件各自新增的运行时探针（复用 `connection.test.ts:1870-1886` 的现成写法：spy `console.error` → 触发 logger → 两个 `setImmediate` 排空 → `expect(failures).toEqual([])`）：`logger.enforce.test.ts` +1 例、`dir-manager.test.ts` +1 例。

## 七、节点表（一节点一提交，Conventional Commits 中文）

| 节点                  | 改动文件（完整路径）                                                                                     | 输入 → 输出                                                                                                                                                                                                                                         | 验收（命令 + 期望，可判定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0（本节点，STOP）** | `docs/plans/2026-10-28-fix-logger-write-escape-recurrence.md`（仅此一件）                                | 会话计划 → 落仓计划                                                                                                                                                                                                                                 | `git show --stat HEAD` 只列 1 个文件；`git add` 之后 `npm run docs:links` 死引用 0、`npx vitest run scripts/__tests__/check-md-links.test.ts` 绿；`npx vitest run scripts/__tests__/source-encoding.test.ts` 绿。提交信息：`docs(plans): 记录 DEBT-039 复发性逃逸的取证与清偿计划`                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2                     | `scripts/__tests__` 下新建 `logger-escape-ledger.test.ts`、`scripts/AGENTS.md`（测试表 +1 行，同批）     | 只读仓库源码 → 封闭集台账闸门                                                                                                                                                                                                                       | **必须先真红**：`npx vitest run scripts/__tests__/logger-escape-ledger.test.ts` ⇒ exit 1，失败集恰为 {逐文件逐模式计数, 夹具形状}（逐字记录）；`npm run lint` 与 `npm run typecheck` 为 0；`npx vitest run scripts/__tests__/path-semantics-guard.test.ts` 绿。`test(守卫): 为 logger 落盘逃逸点建立封闭集台账闸门（修复前红灯取证）`                                                                                                                                                                                                                                                                                                                                                                                |
| 3                     | `src/main/utils/logger.enforce.test.ts`                                                                  | `beforeAll` 共享目录 → `beforeEach` 按用例 `mkdtempSync`；`afterEach` 改 async 且 `rmSync` 重试 `await` 在钩子内；`throttle` 增「目录里确有当日 `main-*.log`」断言、`burst` 增目录存在断言、+1 探针。`toBe(5)` 与 `toBeLessThanOrEqual(2)` **不动** | 同一工作树内先把探针与新增断言跑出**红**并记录，再转绿：`npx vitest run src/main/utils/logger.enforce.test.ts` ⇒ exit 0、3 passed、该件 `[Logger]` 锚定计数 **25 → 0**、耗时 < 3s。`fix(test): 为 logger 节流套件按用例重建日志目录，消除 25 条写盘逃逸`                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4                     | `src/main/utils/dir-manager.test.ts`                                                                     | 新增 `silenceLoggerDiskWrite()`（`vi.spyOn(fs.promises, 'appendFile')`）在 `beforeEach` 装、`afterEach` 还原；补 `// @hygiene-probe` 探针；注释写清「`logDir` 跨用例冻结」这一真实成因                                                              | 探针先红后绿：`npx vitest run src/main/utils/dir-manager.test.ts` ⇒ exit 0、用例数 33 → 34、该件锚定计数 **1 → 0**，且 `electron-log.transports.file: Can't write to` 噪声一并消失。`fix(test): 静默 dir-manager 套件的 logger 落盘写，修跨用例的 logDir 冻结`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 5                     | `src/main/database/connection.test.ts`                                                                   | `silenceLoggerDiskWrite()` 扩展为同时桩 `readdir` → `mockResolvedValue([])`（before/afterEach 的装位 `:701`/`:714` 不变）；既有探针补 `// @hygiene-probe` 标记                                                                                      | `npx vitest run src/main/database/connection.test.ts` ⇒ exit 0、122 passed 不变、`大小检查失败` 锚定计数 **1 → 0**。`fix(test): 一并静默 connection 套件的 enforceMaxSize 真实 readdir`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6                     | 无（若实测计数与台账不符，本节点按实测订正台账并补理由）                                                 | → 闸门转绿                                                                                                                                                                                                                                          | `npx vitest run scripts/__tests__/logger-escape-ledger.test.ts` ⇒ exit 0 全通过；`npm test` ⇒ `Test Files 453 passed (453)`（src 420 + scripts 28 + e2e 5）、用例数 `7046 + 13 + 1 + 1 = 7061`、`12 skipped` **不得上升**；§1.4 那条并集锚定计数 **28 → 1** 且唯一站点归因 `logger.test.ts`；`npm run test:ci-linux src/main/utils` ⇒ exit 0 且同一计数为 1。`chore(test): DEBT-039 静默台账转绿，写盘告警逃逸收敛到唯一故意站点`                                                                                                                                                                                                                                                                                    |
| 7                     | `docs/debt-registry.json`、`docs/技术债清单.md`、`CHANGELOG.md`、`ARCHITECTURE.md`、`ARCHITECTURE.en.md` | 清偿读数 + 判据订正 → 文档一致                                                                                                                                                                                                                      | DEBT-039 `status` → `done`，**原句保留 + 追加时间限定的判据订正**（含为何「计数为 0」不可达、新判据命令原文与锚定/剥 ANSI 的坑）；`docs/技术债清单.md` 的 §0 行改「（已完成）」、§16 增设清偿小节（机制、逐节点红→绿读数 25→0 与 1→0、守卫 2 failed→绿、仍属 CI-only 的部分、以及残留未知的遗留行）；CHANGELOG 追加进 `## [2.5.6-beta]` 的 `### Fixed`（**不得写进 `## [Unreleased]`**，否则 `pre-dist-check` 打回）；双语 §C.3 闭合式 `452+1=453`、`7021+19+1+5+13+1+1=7061`、`7061+12=7073`。验收：`npx tsx scripts/check-changelog-release.ts` 为 0、`npm run docs:links` 死引用 0、`npx vitest run scripts/__tests__/verify-format-scope.test.ts` 绿。`docs(architecture): 回写 DEBT-039 清偿读数并订正撤销判据` |
| 8                     | 无                                                                                                       | 全量门 → 推送复验                                                                                                                                                                                                                                   | `npm run lint` / `npm run i18n:guard` / `npm run typecheck` / `npm run typecheck:e2e` / `npm test` / `npm run test:coverage` / `npm run docs:links` / `npm run verify` 全绿后推送 `main`，逐 job 读新 run 结论（10 分片 + Coverage Gate + Windows Build 必须全 success）。这是 `EnvironmentTeardownError` 唯一能给出缺席证据的地方。                                                                                                                                                                                                                                                                                                                                                                                 |

关于红-绿纪实的如实说明：`.husky/pre-commit` 的 `test:precommit` 只由 `src/**/*.{ts,tsx}` 这个 lint-staged 键触发，因此**红的 `scripts/**` 用例可以提交**（上一轮 `127158d` 就是这么留红灯取证的），而**红的 `src/**` 套件会被钩子拦住**。所以节点 2 允许带红提交，节点 3/4/5 的红灯只能在同一工作树内「先量红、记录、再改、再量绿」，不存在带红的 src 提交——本计划如实写明这一点，不含糊。

## 八、明确不做

- **不给 `tests/setup.ts` 装全局 `appendFile` 静默**。理由两条且都可判：`logger.test.ts` 与 `logger.enforce.test.ts` 依赖真实写盘语义（前者 12+ 处 `readFileSync` 断言、后者依赖真实 `readdir`/`stat`/`unlink`）；且 `ci-linux` 装置用 `tests/mocks/ci-linux-fs.ts` 整体替换 `fs`/`fs/promises` 命名空间，凡自带 `vi.mock('fs')` 工厂的文件会让基线静默形同虚设。上一轮遗留的这条建议**机制上不可实现**，本轮以守卫锁死该结论。
- 不引入依赖、不改 CI workflow、不动覆盖率阈值与 `testTimeout`、不 `it.skip`、不弱化任何断言、不以分片号作闸门。
- 不靠加大 fs 负载或更换 `pool` 来在本地逼出 `EnvironmentTeardownError`（`vitest.config.ts:61` 已记录 `forks` 的既有理由）。
- 不把 `appendFileSync` 的消费方（`startup-diagnostic.test.ts`、`early-crash-guard.test.ts`）纳入台账——同步写不可能逃逸，收进来只会模糊台账语义。

## 九、风险与代价

- 节点 3 让 `burst:` 第一次真正落盘（200 次故障 append + 200 次主日志 append + electron-log 的同步写），该件耗时会从亚秒级上升；验收上界定为单件 < 3s、全量增幅 < +2s（现全量 53.60s）。若实测逼近 `testTimeout: 10000`，如实记录并停下重议，**不通过改阈值解决**。
- 守卫的台账计数是按「修复后」的状态写死的；若节点 6 的实测与之不符，以实测为准订正台账并补理由，不得反向改代码凑台账。
- `EnvironmentTeardownError` 是否真的消失，本轮只能由推送后的 CI 给出证据；本机全绿不构成该结论。
- 计划落仓时实测撞到本仓的 `git ls-files` 时序坑：`check-md-links` 判定「路径是否存在」用的是 **tracked 集合**而非 `fs.existsSync`，本文初稿把阶段 B 才创建的那个守卫文件写成整路径反引号，`git add` 本文后被 `check-md-links.test.ts` 打回 1 处死引用（`发现 1 处死引用：...:119 inline-path`）。处置：整路径改为「`scripts/__tests__` 下新建 `logger-escape-ledger.test.ts`」——目录段不以已知扩展名结尾、裸文件名不带根前缀，两者都不落入 `isPathLike`。这与上一轮 `2434ffd` 订正的那处错路径同源，本轮预先按 §七 节点 0 的验收把它跑掉了。

---

## 十、阶段 B 执行读数（2026-10-28，逐项实测）

状态：**已执行完毕（本机侧全部到位）**。提交序列 `61d9825`（节点 0）→ `0bb84a4`（节点 2 红灯取证）→
`fb581a5`（节点 3）→ `23eb77f`（节点 4）→ `37d8a06`（节点 5）→ 节点 7 文档回写提交 → 推送触发 CI 复验。

| 节点 | 关键读数（红 → 绿）                                                                                                                                                            | 命令与结果                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | —（计划落仓）                                                                                                                                                                  | `git show --stat` 仅 1 文件；`npm run docs:links` 死引用 0；check-md-links 24 例 + source-encoding 5 例全绿                                                                                                                                                     |
| 2    | 守卫 `3 failed \| 12 passed (15)`、`VITEST_EXIT=1`，违规四条 = 四处待修站点                                                                                                    | 红的 `scripts/**` 可提交（`test:precommit` 只由 `src/**/*.{ts,tsx}` 键触发）；eslint / `tsc -p tsconfig.scripts.json` 退出 0；path-semantics-guard 14 例仍绿（新件无须登记）                                                                                    |
| 3    | 该件锚定 `[Logger]` 计数 **25 → 0**；先红：`throttle` 报「日志目录在用例内不存在…expected false to be true」、探针报 `expected [ [ '[Logger] 写入失败:', …(1) ] ] to equal []` | 修复后 `3 passed` 176ms；`[throttle] 真实扫描次数 = 5`、`[burst] = 2` **读数未变**（判据只增强未放宽）；单件 176ms，远低于 3s 上界                                                                                                                              |
| 4    | 该件锚定计数 **1 → 0**；先红：探针 `expected [ [ '[Logger] 写入失败:', …(1) ] ] to equal []`                                                                                   | 修复后 `34 passed`（33 → 34）；相邻噪声 `electron-log.transports.file: Can't write to` 由 1 → 0（`setLogDirectory` 从源头消除跨用例泄漏所致，非静默糊过）；首轮 `verify` 的 format ✗，按 `prettier --write` 落地后 5 项全过                                     |
| 5    | 该件锚定计数 **1 → 0**（基线为 `[Logger] 大小检查失败: ... scandir 'D:\\mock\\userdata\\userData\\logs'`，当时 122 例全过、退出码 0，即该告警从未被任何断言看见）              | 修复后 `122 passed` 不变；`npx tsc -b` 退出 0；守卫转 `15 passed`                                                                                                                                                                                               |
| 6    | 锚定三类并集计数 **28 → 1**，且唯一一行归因 `src/main/utils/logger.test.ts`                                                                                                    | `npm test` → `Test Files 453 passed (453)`、`Tests 7063 passed \| 12 skipped (7075)`、54.14s；不锚定的同一 grep 由 13 降为 4（多出的 3 条正是本轮三条探针标题自身，印证 §1.4 的锚定必要性）。本节点无文件改动，按「无问题不造提交」不单独成提交，读数并入节点 7 |
| 7    | —（文档与账目）                                                                                                                                                                | `debt-registry.json` 解析有效、DEBT-039 `status: done`、`files` 6 项；`check-changelog-release.ts` 通过（条目落在 `[2.5.6-beta]`，`[Unreleased]` 保持空）；`docs:links` 死引用 0；verify-format-scope + source-encoding 41 例全绿                               |

### 与计划的偏差（如实记）

1. **节点 6 未单独提交**：计划把它排成一个 `chore(test)` 提交，但台账计数在节点 2 就是按「修复后」状态写死的，
   节点 3-5 落地后守卫自然转绿，节点 6 本身**没有文件可改**——按仓库「确实无问题时不造提交」的口径，
   它退化为一次只读终验，读数写进本节与 `docs/技术债清单.md` §16。
2. **§1.2 的「12 条」是错的，实际 28 条**：初稿只 grep 了「写入失败」一类，漏掉「故障日志写入失败」与
   「大小检查失败」两类；同时漏了 `connection.test.ts` 这个第 4 站点（上一轮只桩 `appendFile` 的必然续集）。
   §1.2 / §1.3 已按实测改写，原判据「计数为 0」的订正见 §1.4。
3. **`dir-manager` 的成因判断错了一次**：初稿写「`afterEach` 的 `rm` 与在途 `appendFile` 抢跑」，
   实为 `logDir` 是模块态、Vitest 只按文件隔离，被首个触发用例冻结到其已删除的 `tmpBase`
   （证据：告警目标目录与当时在跑用例自身目录不同名）。§1.3 已按实测订正，并因此把修法从「排空再删」
   改成「按用例 `setLogDirectory` + 静默桩」——前者只是缩小窗口，不构成证明。
4. **节点 3 的成本担忧未成立**：计划预估真实落盘会让该件从亚秒级上升、需守住 < 3s。实测 `3 passed` 176ms、
   全量 54.13s → 54.14s，无可测劣化。
5. **`test:ci-linux` 报出 2 件与本轮无关的失败**：`phash.test.ts` / `video-frame.test.ts` 在该装置下
   装载 `sharp` 时解析到不存在的 `linuxnull-x64` runtime 而抛错。它是该只读诊断在 Windows 宿主上的既有局限
   （本轮 6 个改动文件不含二者及其依赖；`test:ci-linux` 按 `AGENTS.md` 不进 CI），
   已如实记为装置局限而非本轮回归，未计入判据、也未据此改动任何文件。

### 仍未闭环的一项（不假装完成）

慢宿主上的 `EnvironmentTeardownError` 本身：本机 54.14s 跑完，rejection 排得进环境拆解之前，
**无法确定性复现**，因此本机全绿不等于「已验证不再出现」。该缺席证据只能由推送后的 CI 十个分片给出，
读法见 §七 节点 8。
