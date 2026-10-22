# 收口 CI 全部红灯与告警（2026-10-21 · 修订版 R2：先取远端数据，再定修法）

> 落点（批准后执行第一步）：复制为 `docs/plans/2026-10-21-fix-ci-smoke-timeout-and-clear-warnings.md`。
> 本版**取代**上一版计划。变更点：① 节点 A 的证据基从「读码推断」升级为「远端逐步耗时 + 产物指纹 + 本机同形复现装置」；② 新增节点 E「让 CI 自证」，因为日志本体已证实需鉴权；③ 正面订正外部报告里「探针断言恒真 ⇒ 不判红」这一条推论。

---

## 0. 远端数据：已取到的、取不到的、以及它改变了什么

### 0.1 取数通道与结论（本机实测，含被拒的读数）

本机 TLS 侧一个真实障碍：路径上有拦截式代理，leaf 证书 Windows 根库能验、Node 内置 CA 不能验。绕法两条，后续所有远端取数都走它们：`curl --ssl-no-revoke`、`node --use-system-ca`。（不加这些参数时表现为 `curl (35) CRYPT_E_NO_REVOCATION_CHECK` 与 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，会被误判成「网络不通」。）

| 通道                                                       | 结果                                                             | 判定                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /repos/…/actions/jobs/119169546004/logs`              | **403**                                                          | 日志本体需鉴权（仓库 admin）                                                                             |
| `GET /repos/…/actions/artifacts/12339373158/zip`           | **401**                                                          | 产物需 token；但 `…/artifacts` 列表 200，元数据可读                                                      |
| `GET /repos/…/check-runs/119169546004`                     | 200                                                              | `output.summary`/`output.text` 为 **null**，`annotations_count: 2` ⇒ **该 job 的注解是完整集，未被截断** |
| `GET /repos/…/actions/runs/39583778122/jobs`               | 200                                                              | 逐步 `conclusion` + **startedAt/completedAt** ⇒ 逐步耗时（关键新数据）                                   |
| `GET /repos/…/check-runs/{id}/annotations`                 | 200                                                              | 免鉴权可读（节点 E 正是利用这条）                                                                        |
| `GET github.com/…/actions/runs/…/job/…`（HTML）            | **200**                                                          | 免鉴权渲染，`<check-step>` 里带 `data-log-url`、`data-external-id`、`data-expand="true"`                 |
| `GET github.com/…/commit/{sha}/checks/119169546004/logs/9` | **404**（含 `?attempt=1`、`Accept: application/json`、5 种变体） | 匿名拿不到日志体                                                                                         |
| 应用内浏览器实测两页                                       | 404「Page not found」/ 页头含 Sign in                            | **该浏览器未登录 GitHub**；日志体需用户登录态                                                            |

⇒ **结论：日志本体（Playwright 打印的失败用例名与报错原文）在本机现有凭据下拿不到。** 我按你的授权操作了电脑（浏览器导航 + 脚本读取），卡点是 GitHub 登录态，不是能力。要么你在应用内浏览器登录一次，我 2 分钟内取到逐字日志；要么走节点 E 让下一次运行自己把失败用例名写进免鉴权可读的注解里。两者都不阻塞下面的修法，因为远端已给出一个足以判定的量——**耗时**。

### 0.2 新数据：失败作业的逐步耗时（远端实测）

```
1  Set up job                                   success    2s
2  Run actions/checkout@v5                      success   12s
3  Run actions/setup-node@v5                    success   14s
4  Install dependencies                         success   66s
5  Verify clean clone compiles main-process…    success   13s
6  Build & publish (release tag)                skipped    0s   ← 设计性跳过（非 tag）
7  Build only (preview / PR)                    success  102s
8  NikkiSync link diagnostics (warn-only)        success    1s   ← 1 秒完成：未建链，N 套件整件 skip
9  E2E smoke test on win-unpacked               FAILURE  134s   ← 10:28:15Z → 10:30:29Z
10 Performance baseline regression              skipped    0s   ← 连坐
11 Upload perf results                          success    0s
12 Upload smoke failure artifacts               success    2s   ← 产物 1,868,144 B，sha256 5baf59ef…f76e
13 Upload installer artifact                    skipped    0s   ← 连坐（其 if 在非 tag push 下本为真）
14/15 Prepare release body / Publish GH Release skipped   0s   ← 设计性跳过（tag 守卫）
29 Post Run actions/setup-node@v5               skipped    0s   ← 连坐
```

产物侧另两条事实：`e2e-smoke-failure` 生成于 10:30:30Z（步骤结束后 1 秒）、2026-10-28 过期；配置为 `screenshot/video/trace = only-on-failure|retain-on-failure`。**1.78 MB 的失败产物意味着失败时有真实渲染窗口被录制**（启动即崩、窗口从未 attach 的形态只会留下极薄的 trace，且 `collectDiagLogs` 可能拿到空 logs），故 S1/S2（启动 + 非白屏）在 CI 上判为通过。

### 0.3 134s 这个数，怎么把候选假设分开

本机 `.cache/e2e-smoke-final.log` 的**全套绿值读数 = 21.1s**（探针 7.0s + N 套件 6 例 2.7s + smoke 8 例 8.1s）。CI 的 `retries: 1` 会把**失败用例的时间再计一次**。据此：

| 假设                                    | 预期耗时构成                                                                                                             | 与 134s           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **探针 90s 等待被 60s 用例超时杀掉 ×2** | 60（首杀）+ ~10（smoke 全过，含启动）+ 60（重试再杀）+ ~4（playwright 启动/teardown）≈ **134s**                          | ✅ 逐秒吻合       |
| S7 的 90s poll 跑满后失败               | 探针若需通过就必须有网格（⇒ 有媒体，与「CI 无游戏」矛盾）；退一步就算探针 7s：7 + 8 + 90（首失败）+ 90（重试）≈ **195s** | ❌ 超 134s 约 60s |
| 探针与 S7 同时失败                      | ≈ **285s**                                                                                                               | ❌                |
| S6 静置 5s 间歇失败 ×2                  | ≈ **31s**                                                                                                                | ❌                |
| 打包产物起不来（launch 30s 超时 ×2）    | ≈ **70s**，且产物里不会有 1.78 MB 录屏                                                                                   | ❌ 两项都不符     |

⇒ **134s 只能由「一个 ≈60s 的用例失败恰好发生两次」构成**，而全套里唯一以 60s 为上限的等待就是 `e2e/fullscreen-diagnose.e2e.ts:54`。S7 的上限是 90s（用例上限 120s），一次都嫌多，两次绝无可能塞进 134s。

### 0.4 订正外部报告里的一条推论（重要）

报告写：「B 的两条 expect 都是 `|| …` 恒真，该文件打印 `[DIAG]` 但不判红 ⇒ **失败点应在 A 的强断言用例中**」。

前半是对的，后半不成立，漏了一层机制：`e2e/fullscreen-diagnose.e2e.ts:54` 的 `waitForSelector(..., { timeout: 90_000 })` 比 `playwright.config.ts:15` 的单用例预算 `timeout: 60_000` 长 30s。**用例会在这条 await 里被 Playwright 直接判 timeout 失败，`await` 之后的任何代码——包括 `:56` 的 `catch` 兜底和 `:103-104` 那两条恒真断言——根本不会执行。** 恒真断言只能保证「不因为断言判红」，不能保证「不因为超时判红」。

这不是抠字眼：它决定了修法方向（补预算 vs 改断言），也决定了为什么 A 的强断言用例其实**不可能**是红点——它们全部跑满也不会贡献 134s 里的两个 60s。

顺带把报告里那条弱线索也一并核掉：「若 S7 跑满 90s 后失败，前序约 44s，与 134s 吻合」——44s 这一段在 CI 上无法成立（本机前序实测 8.1s，CI 无媒体时 S7 只会更快：0 目录时 `runScanChannels` 返回假值走 `makeScanCompleteResult(false, …)`（`worker-entry.ts:1434-1437`），`startScan` 仍正常 resolve ⇒ `[Startup] 扫描完成` 仍打印（`startup-tasks.ts:98`），discovery 结论行不论命中数都发（`worker-entry.ts:617`）并经 `scanner-worker-bridge.ts:217-230` 落文件日志），而重试再计一次 90s 就把总数推到 195s。

### 0.5 其余既有读数（未变，仍成立）

- 环境：Windows 10.0.26300 x64 / Git Bash；Node v26.3.0、npm 11.16.0；CI 用 `.node-version` = 22；`gh` 不存在；无 `GH_TOKEN`/`GITHUB_TOKEN`/`~/.git-credentials`/`.netrc`；credential.helper 是失效的 PortableGit GCM 路径。
- 上游全绿：`Lint, Typecheck & Security`、`Coverage Gate`、`Test (shard 1..10/10)` 十片。
- 注解：`warning .github:2` Node.js 20 弃用点名 `actions/upload-artifact@v4`；`failure .github:97` 退出码 1；lint job 10 条 BOM warning + 1 条 `notice` ubuntu-26 迁移横幅（本地实测 BOM 是 **11** 个文件，第 11 个 `SliderControl.test.tsx` 因每 check run 注解截断而未出现在 CI）。
- 已证伪：`@nikkisync` 未建链不是红因（`e2e/nikkisync-guard.ts:34-48` + `nikkisync-runtime.e2e.ts:310` 的 `test.skip` 只判 skip，退出码恒 0）。
- 本机游戏根来自 `HKCU\Software\InfinityNikki Launcher` → `H:\InfinityNikki Launcher\InfinityNikki`（`game-directory-discovery.ts:80-83`，且 `:254-266` 还有一条「常见安装路径枚举」优先于注册表）。**这两条通道都不可非侵入式屏蔽**（改注册表/藏盘符会伤及你的真实安装），所以本机复现「无媒体」必须走 §6.A 的应用内手段，而不是伪装机器状态。

### 0.6 你授权「操作本机 Edge 取远端数据」后的实测结果（R3 新增）

已按授权用 Computer Use（`@ali/qoder-cu-sdk` + `node_repl`）真实驱动了 Edge，逐动作读数：

| 动作                                                                                 | 读数                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_apps({include_all:true})`                                                      | 236 项，浏览器只有 `apps-folder:MSEdge`（未运行）、`UCBrowser`、`VPN Proxy Browser`                                                                                               |
| `launch_app(MSEdge)` → `list_windows()`                                              | 命中窗口 id 591704，`process:C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，标题「新建标签页 - 个人 - Microsoft Edge」                                            |
| 地址栏（元素 16「地址和搜索栏」）导航 `…/commit/18b484a…/checks/119169546004/logs/9` | 标题 **「Page not found · GitHub」**                                                                                                                                              |
| 导航 `https://github.com/settings/profile` 验登录态                                  | 标题 **「Sign in to GitHub」** ⇒ 该 profile 无有效会话                                                                                                                            |
| 截图 + 无障碍树                                                                      | 落在 **`https://github.com/sessions/two-factor/webauthn`**，页面文案「Two-factor authentication / Authenticate using your passkey」，按钮 `Use passkey`(128)、`More options`(129) |

⇒ **卡点是两步验证（passkey），不是能力，也不是 URL 写错**：账号凭据这一关已经过了（否则会停在用户名/密码页），但会话未完成 2FA。**我不会代你操作认证对话框、不会点 `Use passkey`、不会碰任何凭据类 UI**（Computer Use 硬性禁止项，且批准也不覆盖禁止）。

三条可选路径，任选其一即可拿到逐字日志：

1. **你在已打开的 Edge 窗口里完成 2FA**（点 Use passkey 或 More options 里你惯用的方式），然后说一声；我接着导航 `…/actions/runs/39583778122/job/119169546004#step:9:` 与 `data-log-url` 读步骤 9 的日志原文，必要时下载 `e2e-smoke-failure`（下载属免确认动作）后用本地工具解出 `test-results/**` 里的失败用例名、报错原文与 `collectDiagLogs` 采到的主进程日志。
2. **给一个只读 PAT**（fine-grained：Actions `read`；或 classic：`repo`），我用 `curl --ssl-no-revoke` 直取 `/actions/jobs/119169546004/logs` 与产物 zip，完全不碰浏览器。
3. **不等远端逐字日志**，按 §6.A 的同形装置先在本机跑出「完全同形红灯」再改（你上一轮已选过这条的判据），同时用节点 E 让下一次运行把失败用例名写进免鉴权可读的注解里。

### 0.7 节点 0 已闭环：远端日志逐字取证成功（路径 1 达成）

你在 Edge 完成登录后，我用 Computer Use 导航到 `…/commit/18b484a…/checks/119169546004/logs/9`，浏览器 302 到签名 blob URL（`productionresultssa19.blob.core.windows.net/…/step-logs-7a42e469-….txt`），我用 `curl --ssl-no-revoke` 取到**完整步骤日志原文**（HTTP 200，11 375 字节，97 行，已存 `.cache/ci-step9.log`，gitignored）。逐字关键读数：

```
> playwright test --config e2e/playwright.config.ts --grep-invert @perf
[e2e-nikkisync] gameRoot=<none: 预期 degraded>          ← CI 上确实找不到游戏根（环境前提得证）
Running 15 tests using 1 worker
[e2e] executable: D:/a/MeowStarMap/MeowStarMap/release/win-unpacked/无限暖暖相册管理工具.exe
[e2e] userData:   D:\a\MeowStarMap\MeowStarMap\.cache\e2e-smoke-1792578497837
[DIAG] gridReady=false gridcellCount=0                  ← 网格从未出现（EmptyState 分支）
[DIAG] dialogAppeared=false / fullscreenImgSrc=null / mediaResponses(count=0) / consoleErrors=[] / pageErrors=[]
  x  1 e2e\fullscreen-diagnose.e2e.ts:27:1 › 图库全屏预览诊断… (1.0m)     ← 第 1 次：60s 超时杀
[DIAG] gridReady=false gridcellCount=0
  x  2 e2e\fullscreen-diagnose.e2e.ts:27:1 › … (retry #1) (1.0m)          ← 重试：同样 60s 超时杀
  -  3..8 e2e\nikkisync-runtime.e2e.ts … N1/N2/N3/N3b/N3c/N4              ← 6 skipped（未建链，非失败）
  ok  9  S1 启动与主窗口 (1.1s)      ok 10  S2 非白屏 (738ms)    ok 11  S3 preload 注入 (13ms)
  ok 12  S4 版本一致 (8ms)           ok 13  S5 原生模块 (6ms)    ok 14  S6 静置 5s 存活 (5.0s)
  ok 15  S7 首装自动扫描 (2.0s)      ok 16  userData 隔离校验 (7ms)
  1) e2e\fullscreen-diagnose.e2e.ts:27:1 › 图库全屏预览诊断…
       Test timeout of 60000ms exceeded.          ← 唯一失败原因：用例超时，不是断言
       Error Context: …\error-context.md / attachment #2 screenshot / attachment #4 trace.zip
       Retry #1 ─ Test timeout of 60000ms exceeded.（同一条再来一次）
  1 failed / 6 skipped / 8 passed (2.2m)
##[error]Process completed with exit code 1.
```

三条结论，直接改写判定：

1. **根因确认**：红点就是 `e2e/fullscreen-diagnose.e2e.ts:27`，原因逐字是 `Test timeout of 60000ms exceeded.`，与 §0.3/0.4 的推断完全一致。`(1.0m)×2 + 8 passed ≈ 2.2m` 也与 step 9 的 134s 对得上。
2. **外部报告的推论被否**：报告说「探针断言恒真 ⇒ 不判红 ⇒ 红点应在 A 的强断言用例」。日志显示 **S1–S7 与 userData 全部 ok（S7 仅 2.0s）**，唯一失败正是那条「断言恒真」的探针，且失败原因是超时而非断言——恒真断言救不了被 `timeout: 60_000` 杀掉的 await（§0.4 的机制）。
3. **环境前提得证**：`gameRoot=<none: 预期 degraded>` + `gridReady=false gridcellCount=0` 两行，把「CI runner 上没有游戏 ⇒ 图库空态 ⇒ 无 `[role="grid"]`」从推断升级为实测。

⇒ **节点 A 的修法照 §6.A 执行**（`test.setTimeout(150_000)` + 预算守卫）。§6.A.1 的同形装置由「诊断手段」降级为「确认手段」：仍跑一次以留下本机可复现的红/绿对照，但不再承担定位职责。§8 待远端确认清单第 1 条就此关闭。

---

## 1. 依赖声明

**零新增/变更/删除依赖**，无需 `npm install`。全部复用仓内既有资产：`npx eslint --fix`（BOM）、`npx prettier --check --end-of-line auto`、`npm run docs:links`→`scripts/check-md-links.ts`、`@playwright/test` **1.62.1**（已装；内置 `github` reporter 自 1.44 起可用，节点 E 用）、`vitest`（`./e2e/**/*.test.ts` 已在 `vitest.config.ts:50` 的 node project，`scripts/__tests__/**` 在默认集，**落位不需改任何配置**）、`npm run typecheck:e2e`（CI `build.yml:75-76` 已跑，新 e2e 测试免费获得类型闸门）、`yaml`/`js-yaml`（已在 node_modules，本地校验流程定义）。

上游版本事实（读自官方仓库）：`actions/upload-artifact` 最新 v7.0.2；v6.0.0 起 `runs.using: node24` 并要求 Runner ≥ 2.327.1；v7.0.0 转 ESM 并加 `archive`（默认 `true`＝v4 行为）。`softprops/action-gh-release` 最新 v3.0.3，其 v3.0.0 发布说明只讲一件事：runtime Node 20 → Node 24（`@v2` 的 `action.yml` 实测 `using: "node20"`）。本仓 5 处 upload 用到的 `name`/`path` 多行+排除/`if-no-files-found`/`retention-days` 在 v7 全部仍成立 ⇒ **纯版本号升级，零入参改写**。

---

## 2. 启动说明

环境准备：无需 `npm run dev`、无需重新打包（`release/win-unpacked/无限暖暖相册管理工具.exe` 在位）。

**2.2 基线（动手前亲自跑，全部 `; echo "EXIT=$?"` 取真实退出码）**

`npx eslint .`（预期 0 error / **11** warning / exit 0）·`npm run typecheck`·`npm run typecheck:e2e`·`npm run i18n:guard`·`npm run docs:links`·`npm test`（记 `files/passed/failed` 汇总行）·`npm run e2e:smoke`（记逐条 `ok N` 与总耗时，本机绿值参照 21.1s）·`node -e "require('yaml').parse(fs.readFileSync('.github/workflows/build.yml','utf8'))"`。

**2.3 推进顺序**

```
N0 远端逐字取证（§0.6 三条路径之一：你完成 2FA / 你给只读 PAT / 走同形复现）
   ├─ 读数=探针 60s 超时杀 → 按 A 原计划修
   └─ 读数=别的用例      → 先改计划再动码（禁止照旧计划硬推）
→ N0 基线 B-1…B-8 → E CI 自证 reporter（红→绿）→ A1 同形装置跑出 60s 杀（红）
→ A2 补 test.setTimeout(150_000) → A3 装置转绿 → A4 预算守卫（先红后绿）→ A5 npm run e2e:smoke
→ B1 upload-artifact v7 / gh-release v3（守卫先红）→ B2 BOM 清零（守卫先红）
→ D 引用漂移 → C 镜像评估（零改动）→ §7 全量回归 + §9 执行记录
```

E 排在改码之前：它把「下一次运行能否看到失败用例名」这件事先解决掉，后面每个节点的远端结论都可自查。N0 与 E 是同一件事的两端——N0 拿这一次的真相，E 保证以后不必再靠人给日志。

---

## 3. 错误处理

| 分支                                                                 | 兜底                                                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 同形装置（§6.A）跑出**不是** 60s 超时杀，而是别的失败                | 说明根因不止一处 ⇒ **立即停手回到取证**，把装置原文读数写进执行记录，不得继续按计划改码                            |
| 装置无法让网格消失（`input.search-input` 在打包态不可用/搜索未生效） | 退化到第二条已备好的同形路径：用 `GalleryToolbar` 的板块切换到空集合视图；两条都失败则如实报告并改走「PAT 取日志」 |
| `npx eslint .` 基线 ≠ 11 warning                                     | 以实测为准，逐文件核首 3 字节 `EF BB BF`，不照抄本文数字                                                           |
| `eslint --fix` 后除 BOM 外还有别的 diff                              | 逐文件还原并单独处理；`git diff --stat` 必须恰为 11 files / +11 / −11                                              |
| 远端日志/产物始终取不到                                              | 不假装已验证：逐条进 §8，并保证 §7 本地等价读数齐全                                                                |
| 任何为变绿而 skip / 放宽断言 / 删用例 / 降阈值的念头                 | **禁止**（任务书硬约束）。若某用例论证后确实不可能在 CI 成立，停下来单独提请确认                                   |
| 浏览器登录后你希望我取日志                                           | 我用 `mcp__browser-use__*` 导航到 `data-log-url` 逐步读，只读不点任何 rerun/delete                                 |

## 4. 参数校验（三个守卫的入参口径）

**`e2e/__tests__/timeout-budget.test.ts`**：`readConfigTimeouts()` 只接受恰好一条 `^··timeout:`（两空格＝顶层）与 `expect:{timeout:}`，匹配数≠1 ⇒ **抛错**（防止重排版把值藏起来使预算静默放宽）；`parseMs()` 仅收 `[0-9_]+` 字面量，符号量 ⇒ 记 `unresolved` 违例（把数字挪进变量绕不过守卫）；`findOverBudgetWaits(src, budget, marginMs=15_000)` 判 `wait > budget − margin`，`marginMs` 是 launch+firstWindow+一次 domcontentloaded 的最短成本（`helpers.ts:70`、探针 `:30`），必须显式常量；边界：`timeout: 0` ⇒ 违例（Playwright 语义为不限时）；仅对不含 `@perf` 的 `e2e/*.e2e.ts` 生效；覆盖面清单必须逐字等于 `['fullscreen-diagnose.e2e.ts','nikkisync-runtime.e2e.ts','smoke.e2e.ts']`（探针被改名/删除 ⇒ 此条先红）。

**`scripts/__tests__/ci-action-runtime.test.ts`**：`readActionUses()` 从 `uses: owner/repo@ref` 抽 `{owner,repo,ref}`，`ref` 非 `v<数字>`（如 `@main`/`@sha`）⇒ 违规；`MIN_MAJOR = { 'actions/upload-artifact': 6, 'softprops/action-gh-release': 3 }` 必须带注释写明「判据 = 官方 action.yml 的 runs.using 实测 + 官方发布说明，取数日 2026-10-21」；upload 步骤入参键集合必须 ⊆ v7 文档键集；同 job 内 artifact `name` 不得重复。

**`scripts/__tests__/source-encoding.test.ts`**：`hasBom(bytes)` 仅当首 3 字节严格等于 `EF BB BF`；作用域只扫 `git ls-files` 被跟踪集合（与 `check-md-links.ts` 同口径，不用 `existsSync`）；`eslint.config.js` 中 `'unicode-bom': 'warn'` 命中数必须 0，同时 `'unicode-bom': ['error','never']` 必须仍在（不许顺手删全局规则），且豁免块内 `no-restricted-syntax` / `local/core-path-guard` 仍在（用「块仍在、BOM 行不在」两条断言钉住，防顺手删块）。

## 5. 基础测试用例（正常/异常/边界三类，均含红→绿预期）

**E. `scripts/__tests__/ci-reporter-annotations.test.ts`（新）** — 1) 正常：夹具 `reporter: process.env.CI ? [['list'],['github']] : [['list']]` ⇒ 合规。2) 异常：**真实 `e2e/playwright.config.ts` 当前为 `reporter: [['list']]` ⇒ 违规**（红）。3) 边界：`github` 必须与 `CI` 门控同现（本地不加，避免本地终端噪声）。

**A. `e2e/__tests__/timeout-budget.test.ts`（新）** — 1) 正常：`test.setTimeout(150_000)` + 90_000 等待 ⇒ 违例 0。2) 正常：等待 45_000 且无 setTimeout ⇒ 违例 0（证明判据不只认 setTimeout）。3) **异常：HEAD 原样（90_000 且无 setTimeout）⇒ 违例恰好 1 条且 `waitMs === 90_000`（这是节点 A 的红）**。4) 异常：`test.setTimeout(BUDGET_MS)` ⇒ 1 条 `unresolved`。5) 边界：两条顶层 `timeout:` ⇒ 抛错；`timeout: 0` ⇒ 违例。6) 真实契约：3 个非 `@perf` 文件违例集合为 `[]`，且覆盖面清单逐字相等。7) 配置读数以**字面量**写死 `{ testTimeout: 60_000, expectTimeout: 15_000 }`（绝不从被解析文件反推）。

**B. `scripts/__tests__/ci-action-runtime.test.ts`（新）** — 1) 正常：`@v7` + 四入参夹具 ⇒ 0 违规。2) **异常：真实 build.yml ⇒ 命中 5× `upload-artifact@v4` + 1× `action-gh-release@v2`（这是 B1 的红）**。3) 异常：`@main` ⇒ 违规。4) 边界：`archive: false` ⇒ 合规；未知键 `retention-days-2` ⇒ 违规。5) 真实契约：改后 upload 全 `v7`、release 全 `v3`。

**C. `scripts/__tests__/source-encoding.test.ts`（新）** — 1) 正常：`[0x2f,0x2a,0x2a]` ⇒ 无 BOM。2) **异常：真实 tracked 集合 ⇒ 当前 11 个 `.test.tsx` 命中 BOM（这是 B2 的红）**。3) 异常：`[0xEF,0xBB,0xBF,…]` ⇒ 有 BOM。4) 边界：含 `'unicode-bom': 'warn'` ⇒ 违规；含全局 `['error','never']` ⇒ 合规。5) 真实契约：清完命中数 0。

**D. Playwright 同形装置（非 vitest）** — 见 §6.A，红=「`Test timeout of 60000ms exceeded`、退出码 1、该用例耗时 ≈60s」；绿=「同一装置补预算后跑满 90s 并走到 `catch` 兜底、退出码 0」。

---

## 6. 逐节点方案

### 节点 0（新增）：远端逐字取证——拿到「哪条用例红了」的原文

| 项              | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 输入            | 你在 §0.6 三条路径里选的那一条                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 路径 1 动作序列 | 你完成 2FA 后：Computer Use 驱动 Edge 打开 `https://github.com/QianQianLuLu1/MeowStarMap/actions/runs/39583778122/job/119169546004#step:9:` → 读步骤 9 日志（该步 `data-expand="true"`，失败步骤默认展开）→ 若日志过长则滚动到尾部（Playwright 的失败摘要在末尾）→ 需要产物时导航到 `…/actions/runs/39583778122` 的 Artifacts 区下载 `e2e-smoke-failure`（sha256 `5baf59ef…f76e`），本地用 `unzip`/node 解出 `test-results/**` 的 `error-context.md`、`*.trace`、`*.webm` 与 `collectDiagLogs` 拷进去的 `logs/*.log`、`diag.log` |
| 路径 2 动作序列 | 你给我只读 PAT ⇒ 我 `curl --ssl-no-revoke -H "Authorization: Bearer <tok>" https://api.github.com/repos/QianQianLuLu1/MeowStarMap/actions/jobs/119169546004/logs`（302 → 签名 URL → 纯文本日志）与 `…/actions/artifacts/12339373158/zip`。token 只用于当次命令行，不落仓、不写文件                                                                                                                                                                                                                                               |
| 硬边界          | 不代你做认证、不点 passkey、不碰凭据 UI；不点 Re-run / Delete / 任何改远端状态的按钮（只读导航 + 下载）                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 输出            | 失败用例的**逐字名称 + 报错原文 + 文件行号**，以及（若取到产物）主进程日志副本                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 判定门          | ① 若原文是 `Test timeout of 60000ms exceeded` 且落在 `e2e/fullscreen-diagnose.e2e.ts` ⇒ §0.3/0.4 的结论成立，按节点 A 原计划修。② 若原文指向 `smoke.e2e.ts` 的某条 S1–S7（例如 S7 的 poll 超时）⇒ **停手**，把原文写进计划并改节点 A 的修法（届时 S7 的门控要按「两种条件下表达同一意图」重设，而不是照搬 `test.setTimeout`）。③ 若两条都红 ⇒ 分别定性与定序，并按耗时反推是否还有第三条未显现                                                                                                                                   |
| 验收            | 计划文档的执行记录里出现这段日志原文（≥ 失败用例标题 + 报错两行），且节点 A 的修法与该原文一致                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 节点 E（新增，先做）：让下一次 CI 运行自带可查证据

| 项             | 内容                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改动           | `e2e/playwright.config.ts:20` `reporter: [['list']]` → `reporter: process.env.CI ? [['list'], ['github']] : [['list']]`（+ 中文注释：本仓 job 日志需 admin 才可见，注解免鉴权可读，github reporter 会把每条失败用例写成 `::error file=…,line=…::message`） |
| 输入           | 无（纯配置）                                                                                                                                                                                                                                               |
| 输出           | 未来任何一次冒烟失败，`GET /repos/…/check-runs/{jobId}/annotations` 免鉴权即可读到**失败用例名 + 报错原文 + 文件行号**                                                                                                                                     |
| 为什么值得单列 | §0.1 已证：本次我们只有 2 条注解且 `annotations_count: 2` 是完整集——Playwright 一条注解都没发，正是因为 reporter 写死 `list`。这不是绕过问题，是把「本机拿不到日志」这个结构性缺陷收口                                                                     |
| 不改的部分     | 不动 `screenshot/video/trace`、不动 `retries`（CI 重试是本仓既有策略）                                                                                                                                                                                     |
| 验收           | ①§5.E.2 先红、改后全绿；②`npm run typecheck:e2e` exit 0；③`npm run e2e:smoke` 本机行为不变（本地非 CI ⇒ reporter 仍只有 list，终端无新增噪声）；④远端：下一次运行若仍红，注解里应出现用例名（§8 第 2 条）                                                  |

### 节点 A：冒烟红点（同形复现 → 修 → 转绿）

**A.1 先跑同形红灯（不改任何既有代码）**

拟新增一次性装置 `e2e/tmp-ci-budget-repro.e2e.ts`（跑完即删、不入仓；会被 `testMatch: '*.e2e.ts'` 收集、不含 `@perf`），用**真实打包产物 + 真实配置 + 真实代码分支**复现 CI 的状态：

1. `launchApp()` 起 `release/win-unpacked`（全新 userData）。
2. 等 `#root` 渲染完成后，往应用自身的搜索框 `input.search-input`（`GalleryToolbar.tsx:340-345`，类名稳定、不依赖 i18n 文案）填入必然无命中的串 ⇒ `filteredFiles.length === 0` ⇒ `GalleryPage.tsx:695` 走 `<EmptyState>` ⇒ **`[role="grid"]` 从 DOM 消失**。这与 CI「0 媒体」走的是**同一个代码分支**，不是人工挑选的不存在选择器。
3. 断言 `[role="grid"]` 计数为 0（把「CI 上网格不存在」这一前提在本机坐实）。
4. 原样照抄 CI 红点的等待形状：`try { await win.waitForSelector('[role="grid"]', { timeout: 90_000 }) } catch { /* 与探针 :56 同构 */ }`，**且故意不加 `test.setTimeout`** ⇒ 期望 Playwright 在 60s 杀掉该用例。
5. 取读数：`Test timeout of 60000ms exceeded` 原文 + 该用例耗时 + 退出码 ⇒ **同形红灯**。

若第 2 步在打包态不可用，退化路径：切到空集合板块视图（同样使网格缺席）。两条都不通 ⇒ 如实报告并转 §0.1 的「你登录、我取日志」。

**A.2 修法（唯一一行）**

| 项                  | 内容                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改动文件            | `e2e/fullscreen-diagnose.e2e.ts`：在 `:27` 用例体首行插 `test.setTimeout(150_000)` + 中文注释（写明「预算必须严格大于 :54 的 90s 等待：CI runner 无游戏 ⇒ EmptyState ⇒ 选择器永不命中；原 60s 用例预算先杀掉测试，:56 兜底分支永远到不了」）                                                   |
| 复用                | 与 `e2e/smoke.e2e.ts:107` 同一既有写法（S7 已用 `test.setTimeout(120_000)`），不新造机制                                                                                                                                                                                                       |
| 为何 150s 不是 120s | 无媒体路径必烧满 90s，加 launch/`domcontentloaded`/`afterAll` 关闭；150s 留 ~45s 余量                                                                                                                                                                                                          |
| 不缩短 90s          | 那是探针为「有媒体」保留的宽限，缩它＝削弱既有用例语义（你已确认走「补预算、保留 90s 宽限」）                                                                                                                                                                                                  |
| 不竞态空态          | 实测 `EmptyState` 无 `data-testid`/`role`，只能匹配 `galleryPage.emptyTitle` 文案 ⇒ 把超时问题换成对 locale 的新假设                                                                                                                                                                           |
| 已接受的代价        | CI 每次冒烟多花 ~90s（探针在无媒体 runner 上等满后走兜底），远小于 40min job 上限                                                                                                                                                                                                              |
| 不动的部分          | `:103-104` 那两条 `                                                                                                                                                                                                                                                                            |     | `恒真断言本轮**不改**——它们不是红因，改它们属顺手扩大改动面（登记为观察项：恒真断言无判别力，属既有测试质量问题，与`docs/plans/2026-10-18-sync-gallery-toolbar-about-nikkisync.md` 里已登记的同类问题一并处理） |
| 守卫                | §5.A 的 `e2e/__tests__/timeout-budget.test.ts`（HEAD 先红）                                                                                                                                                                                                                                    |
| 收尾                | 装置跑绿后即删除该文件（本仓约定：一次性探针跑完即删、不入仓，读数写进本文档执行记录）                                                                                                                                                                                                         |
| 验收                | ①A.1 红读数（60s 杀）与 A.1→A.2→绿读数（跑满 90s、走兜底、exit 0）两份原文；②§5.A.3 先红改后全绿；③`npm run e2e:smoke` 本机仍全 `ok` / exit 0；④`npm run typecheck:e2e` exit 0；⑤预期 CI 该步耗时由 134s 变为 ~105s（1 次跑满 90s + 无媒体 smoke 全过、不再重试）——这条属远端可自查项，写进 §8 |

**A.3 诚实边界**：同形装置复现的是「0 媒体 ⇒ 网格缺席 ⇒ 90s 等待被 60s 预算杀掉」这条完整因果，本机可证；「CI runner 上确实没有游戏注册表/没有 H 盘」这一环境事实由 `game-directory-discovery.ts:254-266,80-83` 的通道性质 + 134s/1.78MB 两个远端量支撑，仍列 §8 待你 push 后终判。

### 节点 B1：弃用运行时告警

改 `.github/workflows/build.yml`：5 处 `actions/upload-artifact@v4` → `@v7`（`:164` coverage、`:220` perf-results、`:230` smoke-failure、`:239` installer、`:304` storybook-static），1 处 `softprops/action-gh-release@v2` → `@v3`（`:266`）；**入参零改写**。不改 `checkout@v5`/`setup-node@v5`/`dependency-review-action@v4`（CI 告警原文只点名 upload-artifact，说明其余已是 node24 形态；升它们属无关改动）。本地可验：YAML 解析不抛、键集合合法、守卫红→绿。**本地不可验**：真实 runner 是否不再产该告警 ⇒ §8。风险说明：`action-gh-release@v3` 在 push 运行下该步 skipped，本轮不会增减任何注解，收益在下一次 tag 发布。

### 节点 B2：BOM 告警清零（11 个文件）

以仓库文档为准复核：`docs/debt-registry.json` 的 `DEBT-030`（`category: encoding`、`section: 13`、`status: open`、`files` 11 条）+ `docs/技术债清单.md` §13 + `docs/CODING_CONVENTIONS.md:131` 例外条款。两处措辞与实际惯例的偏差先说明再处置：文档写「11 个」而 CI 注解显示 10 ⇒ 截断；§13 写「从 registry 移除」而本仓惯例是**保留条目改 `status: "done"`**（36 条中已有 6 条 done、4 条 wont_fix，且 `scripts/debt/check-debt-fix.ts:181` 正是按 `done`/`wont_fix` 跳过）⇒ 采用 `done`。

步骤：① 新增 §5.C 守卫（先红：11 个 BOM + 降级行存在）②`npx eslint --fix src/renderer/components/common/*.test.tsx` ③删 `eslint.config.js:466` 的 `'unicode-bom': 'warn'` 及 `:459-465` 例外注释（同块其余规则保留）④`docs/debt-registry.json` DEBT-030 → `done` 并追加清偿日期与读数 ⑤`docs/技术债清单.md` §13 标已清偿 ⑥`docs/CODING_CONVENTIONS.md:131` 例外条款改写 + `DEVELOPMENT.md:737`/`DEVELOPMENT.en.md:740` 基线行由「exit 0，11 warning」改为「exit 0，0 problem」并注日期 ⑦同步本地镜像 `.qoder/rules/project-conventions.md` §5（不入仓）⑧重跑守卫 + `npx eslint .` = 0 error / 0 warning。安全边界已实测：11 个全是被跟踪 `.test.tsx` 文本源码；全仓 tracked 首 3 字节扫描的 BOM 命中扩展名直方图只有 `.tsx`；仓库不跟踪任何 `.snap`/`__snapshots__`；`common` 目录唯一碰 `fs`/base64 的 `UpdateDialog.test.tsx` 本就无 BOM ⇒ 无字节校验牵连、无 diff 噪声（每文件仅首行 3 字节）。

### 节点 C：镜像迁移评估（零代码改动，结论性产物）

证据：注解 `notice .github:1`（ubuntu-latest 自 2026-10-19 起迁移 Ubuntu 26，附 runner-images issue 14748）+ `runner-images` releases 实测（`win22/20261020.340`、`win25-vs2026/20261018.275`、`ubuntu22-arm64/20261019.162`）。**必须写明**：本机无 admin ⇒ 未从本次运行日志逐字取到 `ImageOS`/`Current runner version`。

逐处判定：`.node-version`=22 由 setup-node 显式安装 ⇒ 不依赖镜像 Node（**不需改**）；Linux 三 job 全 `npm ci --ignore-scripts` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1` ⇒ better-sqlite3/sharp/koffi 在 Linux job 里根本不编译（**不需改**）；Windows build 的 `afterPack` 从 `%SystemRoot%\System32` 取 4 个 VC++ DLL 且缺即 throw ⇒ 这是对 **windows** 镜像的真实假设，但公告只涉 ubuntu-latest 且本次 step 7 已 success（**观察项**）；`tests/ci-linux.setup.ts:51,55,59,74` 与 `src/main/utils/ci-linux-emulation.test.ts:53-56,128-132` 写死 `/home/runner/work/NikkiGallery/NikkiGallery`（真实已是 `…/MeowStarMap/…`）⇒ 按你的决定 **登记为观察项、不改码**（该常量只在永久装置内部自洽使用、CI 上整件 skip、改动需同步自检断言与 `path-semantics-guard` 登记表，收益仅「更像真宿主」）。验收 = 镜像证据 + 排查命令与输出 + 每条假设的判定与理由，**不得为凑改动制造无关修改**。

### 节点 D：引用漂移

D1 `.github/workflows/build.yml:210`、`e2e/smoke.e2e.ts:2`、`e2e/playwright.config.ts:4`、`DEVELOPMENT.md:151`、`DEVELOPMENT.en.md:151` 指向被 `.gitignore:184` 排除的 `docs/archive/plans/e2e-smoke-playwright.md` ⇒ 改指被跟踪的 `docs/manual-smoke-checklist.md`，同行保留「原方案已归档至 `docs/archive/plans/`、不入仓、git 历史可查」的去向交代（沿用 `check-md-links.ts` 的 `annotated-gone` 约定）。注意该引用现被闸门判为 `ignored-local`（提醒而非死引用），所以 `docs:links` 一直是绿的——这正是「肉眼没事、按引用取不到」。
D2 `package.json:8,10,12` 的 repository/homepage/bugs 三条 URL 由 `…/NikkiGallery` 改 `…/MeowStarMap`；已核无测试钉这三字段。
D3 全仓其余 24 处旧 URL（CHANGELOG 链接定义 12、README 2、`UpdateDialog.tsx:18`、`about-sections.tsx:17,395` 等）实测经 **HTTP 301** 可解析 ⇒ 不构成死引用，**不改**、登记观察项；其中 `UpdateDialog.test.tsx:67`、`SyncGalleryToolbar.test.tsx:147` 被测试逐字钉住，改它们要连带动源码与测试，属独立一轮。
D4 `src/main/media-worker/bktree-js.ts:9` 的 `docs/archive/BKTREE-REPLACE-PLAN.md` 沿用既有登记（`docs/plans/2026-10-10-markdown-inventory-and-corrections.md:211`），不动。

验收：`npm run docs:links` exit 0 且死引用 0；`npx vitest run scripts/__tests__/check-md-links.test.ts` 绿；`grep -rn "docs/archive/plans/e2e-smoke-playwright" .github e2e DEVELOPMENT*.md` 命中 0；`grep -n NikkiGallery package.json` 命中 0；`git ls-files docs/manual-smoke-checklist.md` 有输出。

---

## 7. 回归与全局校验

`npm test`、`npm run lint`（必须 **0 error 且 0 warning**）、`npm run typecheck`、`npm run typecheck:e2e`、`npm run i18n:guard`、`npm run docs:links`、`npm run verify`、`npm run e2e:smoke`、`npm run test:ci-linux`。逐项与 §2.2 基线对比，任何新增失败即回对应节点重来。§5 四个守卫各自留**红/绿两份原文**。只改 `docs/**` 与 JSON 的步骤（B2 ④–⑦、D）本地闸门零测试覆盖，必须手动指名跑 `check-md-links.test.ts` + `source-encoding.test.ts`。

提交拆分（**默认不提交、不 push**，等你指示）：`fix(e2e): 冒烟探针超时预算收口 + CI 注解 reporter` / `fix(ci): upload-artifact v7 与 action-gh-release v3` / `style(src): 清偿 DEBT-030 存量 BOM 并删除 warn 降级` / `docs: 引用漂移与 lint 基线订正`。

## 8. 待远端确认清单

| #   | 待确认什么                                                                                                                      | 怎么验证                                                                                                                                                                                        | 由谁触发                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | 冒烟红点确实是探针的 60s 超时杀（而非别的用例）                                                                                 | 你 push 后看 step 9 是否转绿且耗时降到 ~105s；**或**你在应用内浏览器登录 GitHub，我直接读 `/actions/jobs/119169546004/logs` 与 `e2e-smoke-failure`（sha256 5baf59ef…f76e）逐字确认，无需等 push | 用户登录 / 用户 push          |
| 2   | 节点 E 生效：未来失败用例名免鉴权可读                                                                                           | 下一次运行 `GET /repos/…/check-runs/{jobId}/annotations`；若仍红应出现 Playwright `::error` 注解                                                                                                | 用户 push（我自己就能查）     |
| 3   | `upload-artifact@v7` 确实消除 Node.js 20 弃用告警                                                                               | 下一次运行 lint/coverage/build 三 job 注解里该 warning 消失                                                                                                                                     | 用户 push                     |
| 4   | 真实生效镜像版本（本机取不到日志原文）                                                                                          | 下一次运行日志首行 `Current runner version` / `ImageOS` / `Agent.Version`                                                                                                                       | 用户 push                     |
| 5   | 连坐跳过项随上游转绿自动恢复                                                                                                    | 下一次运行确认 step 10/13/14/15 真的执行                                                                                                                                                        | 用户 push                     |
| 6   | ubuntu 十片 + Coverage Gate 对新守卫仍全绿、阈值不劣化                                                                          | 下一次运行读数                                                                                                                                                                                  | 用户 push                     |
| 7   | `action-gh-release@v3` 无行为回归                                                                                               | **只有 tag 发布运行才执行该步**                                                                                                                                                                 | 用户下次发版                  |
| 8   | 新增的 `source-encoding.test.ts` 在真实 ubuntu 上能通过（本地装置故意让 `git` 不可用 ⇒ `spawnSync git ENOENT`，装置内无法证明） | 下一次 push 的 `Test (shard 1..10/10)` 十片与 `Coverage Gate` 全绿即证；若某片红在该文件，按 §10.10 的可选处置补前置                                                                            | 用户 push（免鉴权注解即可判） |

## 9. 执行记录（推进时逐项回填）

基线 B-1…B-8 读数 · 节点 E 红/绿 · A.1 同形装置红读数原文 + 补预算后绿读数 + 装置删除确认 · A.2 守卫红/绿 · `npm run e2e:smoke` 前后逐条对照 · B1 守卫红/绿与 YAML 解析 · B2 守卫红/绿与 `git diff --stat` · C 命令与输出 · D `docs:links` 前后 · §7 全量回归 · 偏离与自纠（含本轮对报告推论 §0.4 的订正）。
备注：取证在 gitignored 的 `.cache/` 留下抓取件（`jobpage.html`、`ua-readme.md`、`ghrel.json`、`ci-step-*.log` 等），执行结束时一并清掉，不进 diff。

---

# 10. 执行记录（2026-10-21 本轮实测，逐项带真实退出码）

## 10.1 基线（改动前，HEAD `18b484a`，工作区干净）

| #   | 命令                    | 读数                                                                                 | 退出码 |
| --- | ----------------------- | ------------------------------------------------------------------------------------ | ------ |
| B-1 | `npx eslint .`          | `✖ 11 problems (0 errors, 11 warnings)`，11 条全为 `1:1 Unexpected Unicode BOM`      | **0**  |
| B-2 | `npm run typecheck`     | 无输出                                                                               | 0      |
| B-3 | `npm run typecheck:e2e` | 无输出                                                                               | 0      |
| B-4 | `npm run i18n:guard`    | `✅ 白名单只减不增、清零必移除、key 已同步，守卫通过`                                | 0      |
| B-5 | `npm run docs:links`    | `✅ 无死引用（另有 149 处提醒）`                                                     | 0      |
| B-6 | `npm test`              | `Test Files 426 passed (426)` / `Tests 6536 passed \| 12 skipped (6548)`，40.58s     | 0      |
| B-7 | `npm run e2e:smoke`     | `15 passed (25.4s)`；探针 `ok 1 … (10.2s)`、`[DIAG] gridReady=true gridcellCount=20` | 0      |
| B-8 | `yaml.parse(build.yml)` | `jobs: lint-typecheck,test,coverage,build,storybook`                                 | 0      |

## 10.2 节点 0（远端逐字取证）

免鉴权通道全部被拒（API 日志 403、产物 zip 401、5 种 web 日志 URL 变体 404、`output.summary/text` 为 null）；改由用户授权驱动本机 Edge，在用户完成 2FA 后取到签名 blob URL，`curl --ssl-no-revoke` 拿到步骤 9 完整日志（HTTP 200 / 11 375 字节 / 97 行）。逐字结论见 §0.7：唯一失败 = `fullscreen-diagnose.e2e.ts:27`，原因 = `Test timeout of 60000ms exceeded.`，`1 failed / 6 skipped / 8 passed (2.2m)`，S1–S7 与 userData 全 `ok`（S7 仅 2.0s），`gameRoot=<none>` + `gridReady=false gridcellCount=0` 证环境前提。

**对 §0.4 措辞的自纠**：日志与本机复现都显示 `[DIAG] gridReady=false` 有被打印，说明 `catch` **确实执行了**；准确说法是「用例已被超时判负，之后的恒真断言无从翻案」，而非「兜底分支永远到不了」。结论方向不变（红因是超时不是断言），但原句过强，此处订正。

## 10.3 节点 E（CI 自证 reporter）

- 新增 `scripts/__tests__/ci-reporter-annotations.test.ts`；修复前跑该文件：**1 failed \| 3 passed，EXIT=1**，失败项为真实契约，报错原文 `当前 reporter = [['list']]；缺 github reporter ⇒ CI 失败用例名进不了注解`。
- 改 `e2e/playwright.config.ts` 的 reporter 为 `process.env.CI ? [['list'], ['github']] : [['list']]`。
- 修复后：**4 passed，EXIT=0**；`npm run typecheck:e2e` EXIT=0；`npx eslint` 对两文件无输出。
- 自纠一处：`hasCiAnnotatedReporter` 首版只查子串，被夹具 `process.env.CI ? [['github']] : [['list']]` 蒙过（CI 分支丢了 `list`）⇒ 改为按三元两分支分别校验，该边界用例随即转红，修实现后转绿。

## 10.4 节点 A（冒烟超时预算）

**同形复现装置（一次性，跑完即删、未入仓）**：用应用自身搜索框 `input.search-input` 填入无命中串 ⇒ `GalleryPage` 的 `filteredFiles.length === 0` 分支 ⇒ `<EmptyState>` ⇒ `[role="grid"]` 缺席（与 CI 同一代码分支）。

| 阶段                                                  | 读数                                                                                                                                                       | 退出码 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 补预算前                                              | `[REPRO] 空态已就位，耗时=1s` → `[REPRO] 兜底 catch 可达，gridReady=false，总耗时=60s` → `x 1 … (1.0m)` → `Test timeout of 60000ms exceeded.` → `1 failed` | **1**  |
| 补预算后（同装置加同一行 `test.setTimeout(150_000)`） | `[REPRO] 兜底 catch 可达，gridReady=false，总耗时=91s` → `ok 1 … (1.5m)` → `1 passed`                                                                      | **0**  |

- 守卫 `e2e/__tests__/timeout-budget.test.ts`：修复前 **1 failed \| 8 passed，EXIT=1**，失败项原文 `fullscreen-diagnose.e2e.ts: wait=90000 budget=60000`；修复后 **9 passed，EXIT=0**。
- 自纠一处：守卫首版 `readConfigTimeouts` 把未去尾逗号的 `'60_000,'` 交给 `parseMs` ⇒ 返回 null 抛错；改完仍误把**字符串** `topLevel[0]` 当数字返回 ⇒ `Math.max` 得 NaN ⇒ 「真实契约」用例假绿（不报违例）。是「配置读数不得漂移」那条**写死字面量**的用例把它抓出来的（`expected { testTimeout: '60_000' … } to equal { testTimeout: 60000 … }`）。修正返回值后违例如期复现。这条正是本仓「恒真断言无判别力」告诫的现场版。
- 生产改动：`e2e/fullscreen-diagnose.e2e.ts` 用例体首行加 `test.setTimeout(150_000)` + 注释（复用 `smoke.e2e.ts:107` 既有写法）。
- 改后全量冒烟：`15 passed (21.1s)`，EXIT=0，与基线逐条一致（本机有媒体 ⇒ 探针 6.9s，无额外耗时）。

## 10.5 节点 B1（弃用运行时）

- 新增 `scripts/__tests__/ci-action-runtime.test.ts`；修复前 **1 failed \| 5 passed，EXIT=1**，逐条命中：`coverage: upload-artifact@v4 低于 v6`、`build: ×3`、`build: softprops/action-gh-release@v2 低于 v3`、`storybook: ×1` ⇒ 共 6 条，与 CI 告警点名一致。
- 改 `.github/workflows/build.yml`：5 处 `upload-artifact@v4`→`@v7`，1 处 `action-gh-release@v2`→`@v3`，入参零改写。
- 修复后：守卫 **6 passed，EXIT=0**；`yaml.parse` 通过并逐条列出 17 个 `uses`（upload 全 v7、release v3、checkout/setup-node 未动）；既有 `audit-config.test.ts` + `typecheck-emit-isolation.test.ts`（两个直读 build.yml 的契约测试）**27 passed，EXIT=0**。
- **远端交叉核对（本轮新证据）**：lint 与 build 两个 job 的 step 1 日志均打印 `Current runner version: '2.330.0'` ⇒ 满足 upload-artifact v6+ 要求的 **Runner ≥ 2.327.1**，升级不会因 runner 过旧失败。

## 10.6 节点 B2（BOM 清零）

- 新增 `scripts/__tests__/source-encoding.test.ts`；修复前 **2 failed \| 3 passed，EXIT=1**：`仍存在 unicode-bom 降级行（行号 466）` 与 11 个文件的 BOM 清单。
- `npx eslint --fix src/renderer/components/common/*.test.tsx` ⇒ `git diff --numstat` = **11 files / +11 / −11**；逐文件与 HEAD 比对（去首 3 字节 BOM + 工作区 CRLF 归一 LF 后）**11/11 逐字节相同** ⇒ 无行级噪声、无其他改写。
- 删 `eslint.config.js` 的 `'unicode-bom': 'warn'` 行及其 8 行例外注释（同块 `no-restricted-syntax`、`local/core-path-guard` 保留）。
- 修复后：守卫 **5 passed，EXIT=0**；`npx eslint .` **无任何输出 = 0 error / 0 warning，EXIT=0**（基线为 11 warning）；`npx vitest run src/renderer/components/common` **42 files / 539 passed，EXIT=0**。
- 文档同步：`docs/debt-registry.json` DEBT-030 `status: open→done`（保留条目，附清偿日期与读数；`updatedAt` 同步为 2026-10-21）、`docs/技术债清单.md` §13 标已清偿并记录「原文写『移除本条』而实际按仓库惯例改 done」的偏差、`docs/CODING_CONVENTIONS.md` §5 例外条款改为「当前无例外」、`DEVELOPMENT.md` / `DEVELOPMENT.en.md` 的 lint 基线行改为「0 error / 0 warning」并保留历史读数出处、本地镜像 `.qoder/rules/project-conventions.md` 同步。
- 注册表直读方 `npx tsx scripts/debt/check-debt-fix.ts` 仍 EXIT=0；它顺带提醒 DEBT-036 涉及 `eslint.config.js`——本轮改的是 BOM 降级行，与 DEBT-036（rgba/三元 hex 选择器盲区）无关，属文件名重合，未处理。
- 格式闸门：5 个文件（两个根 md + 三个新测试）首跑 `prettier --check` 判红 ⇒ `--write` 后复验 `All matched files use Prettier code style!`，根 md 的 diff 仍各为 1 行。

## 10.7 节点 C（镜像迁移评估，零代码改动）

**实际生效镜像版本（取自本次运行 step 1 日志原文，非公告）**：

| job                                         | Operating System                                              | Runner Image          | Image Version                                           | runner    |
| ------------------------------------------- | ------------------------------------------------------------- | --------------------- | ------------------------------------------------------- | --------- |
| Lint, Typecheck & Security（ubuntu-latest） | `Ubuntu 24.04`                                                | `ubuntu-24.04`        | `20261019.234.1`（release tag `ubuntu24/20261019.234`） | `2.330.0` |
| Build & Release（windows-latest）           | `Microsoft Windows Server 2025` / `10.0.26100` / `Datacenter` | `windows-2025-vs2026` | `20261017.264.1`                                        | `2.330.0` |

⇒ 公告说的「ubuntu-latest 自 2026-10-19 起迁移 Ubuntu 26」在本次运行**尚未生效**（仍是 24.04）；那条注解 `annotation_level=notice` 不是 warning，不属本次绿灯口径的阻塞项。

逐处假设判定（排查手段 = 读工作流与脚本 + `after-pack-vc-runtime.cjs` + `cat .node-version`）：

| 命中点                                                                                                                                                                                                              | 判定                                 | 理由                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.node-version`=22，全部 job 经 `setup-node@v5` + `node-version-file`                                                                                                                                               | **不需改**                           | Node 由 action 显式安装，不取镜像自带                                                                                                                                        |
| 三个 Linux job 用 `npm ci --ignore-scripts` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1`                                                                                                                                     | **不需改**                           | better-sqlite3/sharp/koffi 在 Linux job 里根本不编译，镜像换版打不到原生层                                                                                                   |
| `scripts/after-pack-vc-runtime.cjs` 从 `%SystemRoot%\System32` 取 4 个 VC++ DLL，缺即 throw                                                                                                                         | **观察项**                           | 这是对 windows 镜像形态的真实假设，但迁移公告只涉 ubuntu-latest，且本次 `Build only` 步骤 success；若将来 windows 镜像变更需复看                                             |
| `tests/ci-linux.setup.ts` 与 `src/main/utils/ci-linux-emulation.test.ts` 写死 `/home/runner/work/NikkiGallery/NikkiGallery`（真实工作区已是 `D:\a\MeowStarMap\MeowStarMap` / Linux 侧 `…/MeowStarMap/MeowStarMap`） | **登记观察项，本轮不改**（用户决定） | 常量只在永久复现装置内部自洽使用，CI 上该套件整件 skip、不参与任何判定；改它需同步自检断言与 `path-semantics-guard` 登记表，收益仅「更像真宿主」，风险是打红刚收口两轮的装置 |

## 10.8 节点 D（引用漂移）

- D1：`build.yml`、`e2e/smoke.e2e.ts`、`e2e/playwright.config.ts`、`DEVELOPMENT.md:151`、`DEVELOPMENT.en.md:151` 五处改指被跟踪的 `docs/manual-smoke-checklist.md`，并在同行写明原方案文档「已归档至 `docs/archive/plans/…`、不入仓、git 历史可查」。
- D2：`package.json` 的 `repository.url` / `homepage` / `bugs.url` 三条改为 `…/MeowStarMap`。
- 验证：`npm run docs:links` **EXIT=0、0 死引用**（151 处提醒）；`npx vitest run scripts/__tests__/check-md-links.test.ts` **24 passed**；`git ls-files docs/manual-smoke-checklist.md` 有输出（引用目标确为被跟踪）。
- 过程中闸门真拦到一次：`docs/CODING_CONVENTIONS.md:131` 写了本轮新增的 `scripts/__tests__/source-encoding.test.ts`，该文件当时尚未入仓 ⇒ 判 **死引用，EXIT=1**。按仓库约定在同行补写明「本轮新增，尚未入仓，与本文档同批提交」后转绿。⇒ 提醒：本文档与四个新测试文件必须**同批提交**，否则 `docs:links` 与 `check-md-links.test.ts` 的「真实仓库契约」会在提交后转红。
- **D3 观察项（判定为不改）**：`package.json:276` 仍有 `"artifactName": "NikkiGallery-Setup-${version}.${ext}"`。它是安装包文件名（electron-updater 的 `latest.yml` 与已发布产物按此命名），不是「取不到的仓库地址引用」；改它会连带改产物文件名与更新元数据口径，超出本轮范围。全仓其余旧 URL 出现点实测经 HTTP 301 可解析（§D3），亦不改。

## 10.9 待远端确认清单的更新

- §8 第 **1** 条（红点究竟是哪条用例）：**已关闭**——本轮经登录态取到步骤 9 日志原文，逐字确认为 `fullscreen-diagnose.e2e.ts:27` 的 60s 超时杀。
- §8 第 **4** 条（真实镜像版本）：**已关闭**——见 §10.7 表（ubuntu-24.04 / 20261019.234.1、windows-2025-vs2026 / 20261017.264.1、runner 2.330.0）。
- §8 第 2、3、5、6、7 条仍待用户 push（或下次发版）后由远端判定；其中第 3 条现在多了一条本地旁证：fleet runner 为 2.330.0，已满足 v6+ 的最低要求。
- 新增一条预期读数供 push 后自查：修复后 CI 冒烟步骤耗时应从 134s 变为 **≈105s**（探针在无媒体 runner 上跑满 90s 后走兜底并通过，不再触发重试）。

## 10.10 `npm run test:ci-linux`（Linux 语义装置）的红点归因

装置是**只读诊断**、不进 CI；本仓口径为「装置全绿，或剩余红逐条点名归因」。本轮实测：

| 状态                                                               | 读数                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------- |
| HEAD 原状（把本轮新增的 `source-encoding.test.ts` 临时移出后复跑） | **10 files failed / 53 tests failed / 6507 passed，EXIT=1** |
| 本轮全部改动就位                                                   | **11 files failed / 54 tests failed / 6511 passed，EXIT=1** |

⇒ 差值恰为 **+1 文件 / +1 用例**，即本轮新增的编码守卫；其余 10 个红点与 2026-10-20 那轮登记的装置已知红表逐条一致（`worker-entry`、三个 `*.linked`、`scan-traverse-timeout`、`identity-service`、`find-related-tests`、`generator.limiter`、`video-frame`、`check-md-links`），**A / B1 / E 三个节点的改动没有给装置新增任何红**。

新增这一条的根因是**装置侧限制而非产品缺陷**：装置会把宿主 env 改写为 POSIX 形态，`execFileSync('git', …)` 因此报 `spawnSync git ENOENT`（该文件其余 4 条用例在装置下全绿，说明 BOM 判定本身与宿主无关）。这与已知红表里 `check-md-links.test.ts` 属同一类（同为「子进程在装置下不可用」），且本轮已把两处对 `git ls-files` 的调用收敛到 `scripts/check-md-links.ts` 的 `listTrackedPaths()` 同一实现，不再各写一份。

⇒ 遗留判断：真实 ubuntu CI 上 `/usr/bin/git` 存在，该用例应当通过——但这一条**本地无法证明**（装置正是故意让 git 不可用），已列入 §8 待远端确认第 8 条。若用户认为「装置新增 1 条同类红」不可接受，可选处置是给该用例加「git 不可用时明确报因」的前置，而非静默 skip。

## 10.11 推送后的远端验证（run `39623462678`，head `7c6926f`）

四笔提交已推送（`18b484a..7c6926f`，fast-forward；`git ls-remote` 独立复查远端 sha == 本地 HEAD）。新运行整体仍判 failure，但**本轮四个节点全部逐条转绿**，唯一障碍换成了一个新的首曝点。

### 已闭环的远端确认项

| 判据                      | 基线（run 39583778122）                                | 本轮读数                                                | 结论                                                                                                            |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| step 9 冒烟               | failure，134s                                          | **success，105s**                                       | 节点 A 成立；105s 与「探针跑满 90s 走兜底 + 无媒体 smoke 全过 + 不再重试」的预测吻合                            |
| lint job 注解             | 10 条 BOM warning + 1 notice                           | **1 条 notice，BOM warning 归零**                       | 节点 B2 成立（本地 `npx eslint .` 也从 11 warning 变无输出）                                                    |
| upload-artifact 告警      | lint/coverage/build 各 1 条 `Node.js 20 is deprecated` | **三个 job 均无此告警**                                 | 节点 B1 成立；runner 2.330.0 ≥ v6+ 要求的 2.327.1 也已被 §10.5 的日志读数旁证                                   |
| 十片 Test + Coverage Gate | 全绿                                                   | **全绿**（含本轮新增的 4 个守卫测试）                   | §8 第 6、8 条关闭：`source-encoding.test.ts` 在真实 ubuntu 上通过，装置侧的 `spawnSync git ENOENT` 确属装置限制 |
| 连坐跳过项                | step 10/13/14/15 skipped                               | step 10 **开始执行**（随后自身失败），13/14/15 仍被连坐 | §8 第 5 条部分关闭：恢复机制正常，只是被下一层红挡住                                                            |
| 节点 E 自证               | Playwright 零注解                                      | **失败用例名与报错原文直接出现在免鉴权注解里**          | 本轮新加的 `github` reporter 立即生效，下一轮定位不再需要 token 或人工取日志                                    |

### 新的唯一障碍：step 10 性能基准回归（历史上从未执行过）

注解原文（`e2e\perf.e2e.ts:416`，`Error: 存在性能回归 / 阈值超限`，`Expected length: 0 / Received length: 3`）：

1. 扫描入库（1500 张）实测 1900ms 超出基线容忍区间（基线 414ms × 3 = 1243ms）
2. 重复文件检测（1500 个文件）实测 6906ms 超出基线容忍区间（基线 1010ms × 3 = 3031ms）
3. 重复检测吞吐量 实测 217.2 项/秒 低于基线容忍区间（基线 1484.8 ÷ 3 = 494.9）

**定性：不是产品回归，是基线的环境口径缺陷。** 同一份打包产物在开发机当日复跑 `npm run e2e:perf`，P10 判定「✓ 全部通过」、退出码 0：

| 指标             | 基线（2026-08-23 开发机） | 开发机今日 | 倍数 | CI 今日 | 倍数  |
| ---------------- | ------------------------- | ---------- | ---- | ------- | ----- |
| 扫描入库 1500 张 | 414ms                     | 636ms      | 1.5× | 1900ms  | 4.6×  |
| 重复文件检测     | 1010ms                    | 1122ms     | 1.1× | 6906ms  | 6.8×  |
| 重复检测吞吐量   | 1484.8/s                  | 1336.6/s   | 0.9× | 217.2/s | 0.15× |

且 CI 上**三条绝对硬护栏全部通过**（1900 < `maxMs:30000`、6906 < `maxMs:60000`、217.2 > `minThroughput:100`）——产品性能契约未破，破的是「拿 windows-latest 的读数去比开发机录的基线」。`e2e/perf-baseline.json` 的 `environment` 字段本身已写明「CI windows-latest 硬件更慢，容忍系数已按跨环境放宽」，只是 `regressionFactor: 3` 不足以覆盖这两项 CPU/IO 密集指标。

**下一轮已定方向（用户确认）**：给基线按环境分设 dev / ci 两段，`evaluateSamples` 按运行环境选段，使比较对象与被测环境一致；两个环境各自保留回归发现能力，不放宽任何一方的阈值。CI 段须先采多次样再固化，不用单次读数当基线。

### 本轮收尾状态

- 工作树：四笔提交之外**无未提交改动**；本节的远端验证结果作为文档补录留在工作区，与下一轮的性能门控改动一并提交——避免为一段纯文档补录单独触发一次仍会红在 step 10 的完整 CI 运行。
- 待远端确认清单：§8 第 1、2、3、4、6、8 条已关闭；第 5 条部分关闭（恢复机制已证，仍待 step 10 转绿后看 13/14/15）；第 7 条（`action-gh-release@v3`）仍待下一次 tag 发布。
