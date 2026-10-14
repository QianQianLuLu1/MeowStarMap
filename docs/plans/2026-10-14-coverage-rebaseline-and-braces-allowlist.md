# 2026-10-14 · 覆盖率门控重新基线（DEBT-032）与 braces 豁免（DEBT-034）

> 本轮为**闸门配置轮**：不改任何 `src/**` 生产代码，不新增/升级/删除依赖。
> 目标：让 CI 的 `lint-typecheck`（Security audit 步）与 `coverage` 两个 job 由红转绿，且**不弱化任何闸门**。

## 1. 背景与实测取证

| 项                 | 实测证据                                                                                                                                                                                                                                                                                                                                                                       | 结论                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| braces 通告        | `npx audit-ci --config ./audit-ci.jsonc > /tmp/audit-red.log 2>&1; echo $?` → **exit=1**；唯一未豁免高危 `GHSA-vfj7-8cjw-p6xm`，7 条路径全为 dev 工具链（`@babel/cli>chokidar`、`tailwindcss>chokidar`、`fast-glob>micromatch`、`lint-staged>micromatch`、`micromatch`、`vite-plugin-singlefile>micromatch`、`cz-conventional-changelog>commitizen>…>findup-sync>micromatch`） | 门禁红由这一项单独造成，清掉它即可转绿                                                                                                      |
| 上游是否有修复版   | `npm view braces dist-tags` → `latest: 3.0.3`；`npm view braces versions` 最大即 `3.0.3`；`npm view micromatch@latest dependencies.braces` → `^3.0.3`                                                                                                                                                                                                                          | **依赖覆盖（`overrides`）无可行目标**：pin 到不存在版本会让安装失败，pin 到 3.0.3 等于没改，pin 到更旧是降级 ⇒ "依赖手术"这一路在本例不成立 |
| 覆盖率读数         | `coverage/coverage-summary.json`（2026-10-14 19:49 生成，新于 `vitest.config.ts`）：statements 66.69（19361/29028）、branches 58.19（10179/17490）、functions 59.22（3486/5886）、lines 68.27（17996/26357）；阈值 `vitest.config.ts:91-96` 为 `69/80/68/69`                                                                                                                   | 四项全部低于阈值 ⇒ `npm run test:coverage` 失败 ⇒ CI `coverage` job（`build.yml:134-153`）红 ⇒ needs 阻断 `build`（`:168`）                 |
| 读数下移成因       | 见 DEBT-032 与 `docs/plans/2026-10-09-fix-thumbnail-loading-performance-round2.md` §15：旧 v8 provider 把「从未被调用的箭头函数体」计入所在语句并判为已覆盖，Vitest 5 拆为独立语句如实计未覆盖。文件级对照 `src/main/preload/api/app.ts` 旧 `100\|100\|0\|100`（函数 0% 却语句全绿，自相矛盾）→ 新 `12.5\|100\|0\|12.5`                                                        | **是测量口径被修正，不是测试变差**                                                                                                          |
| CHANGELOG 落点约束 | `scripts/check-changelog-release.ts:52`（`ENTRY_LINE_RE = /^\s*[-*]\s+\S/`）+ `:113-129`：`[Unreleased]` 内任何条目即 error → exit 1；CI 第 193 行在 PR/preview 上也跑 `npm run dist:win`                                                                                                                                                                                      | 写 `[Unreleased]` 会**新增**一个 CI build job 红灯 ⇒ 按本仓既定惯例（`76d7fee`、`e9047a0`）补录进 `[2.5.5]` 节，`[Unreleased]` 保持空       |
| 契约测试形态       | `scripts/__tests__/audit-config.test.ts:221-227` 对 28 项迁移基线是**子集**断言（`toContain`）+ `validateAllowlist`（无重复/格式合法）                                                                                                                                                                                                                                         | 新增豁免无需改测试；**清退**基线内 18 个失效豁免则必须同步改该数组，属独立一轮                                                              |

## 2. 本轮决策（已与用户确认）

| 议题          | 决策                                                                                        | 理由                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| braces        | 按既有 dev 工具链口径加入 `audit-ci.jsonc` 的 `allowlist`，并在注释块续写理由/跟踪/撤销条件 | overrides 无修复版可 pin；DEBT-034 原文即把这条列为合法修法                                                            |
| 覆盖率        | 按新口径**重新基线阈值**为 `66/58/59/68`（实测整数下取整）                                  | DEBT-032 明令「禁止为凑数换回 istanbul 或扩大 exclude」，只允许重新基线或补真实测试；补测试需多覆盖 3800+ 分支，非本轮 |
| 阈值取档      | 整数下取整，余量 0.69/1.19/1.22/0.27 pt                                                     | 两次独立实测读数差 ≤0.03 pt，余量足够；不再额外退档以免闸门偏松                                                        |
| 18 个失效豁免 | 不清退                                                                                      | 属收紧闸门，且会连带改 `MIGRATION_BASELINE`；DEBT-020 原文亦要求与 braces 项分开单独一轮                               |
| CHANGELOG     | 补录 `[2.5.5]` 节                                                                           | 见上表约束行                                                                                                           |

**明确不改**：`package.json`（含 `overrides`）、`package-lock.json`、`node_modules`、`vitest.config.ts` 的
`provider`/`include`/`exclude`/`projects`/`all`、`.github/workflows/*`、任何 `src/**`。

## 3. 改动清单（文件 / 输入 / 输出 / 验收）

| #   | 文件                      | 改动                                                                  | 验收（可判定）                                                                                                                |
| --- | ------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | `audit-ci.jsonc`          | 注释块续写 1 段；`allowlist` +1 条 `GHSA-vfj7-8cjw-p6xm`              | `npx audit-ci --config ./audit-ci.jsonc > log 2>&1; echo $?` → **0**；探针删掉该 id → **1**；还原 → **0**                     |
| 2   | `vitest.config.ts`        | `thresholds` 69/80/68/69 → 66/58/59/68；改写 :89-90 基线注释          | `npm run test:coverage > log 2>&1; echo $?` → **0**；`coverage-summary.json` 四项 pct ≥ 阈值                                  |
| 3   | `docs/debt-registry.json` | DEBT-032/034 `status` → `done` + 关闭证据；`updatedAt` → `2026-10-14` | `node -e "JSON.parse(...)"` 无异常；`npm run debt:check` exit 0                                                               |
| 4   | `docs/技术债清单.md`      | 索引 60/62 行加 `（已完成）`；详情 238/240 行加收口句                 | 两行形态与 48/54 行一致；历史快照文件不动                                                                                     |
| 5   | `CHANGELOG.md`            | `[2.5.5]` 节补录 Changed + Security 两条                              | `npx tsx scripts/check-changelog-release.ts` → **0** 且打印「[Unreleased] 已收口」；探针加 `- 探针` 到 `[Unreleased]` → **1** |

## 4. 验证流程

取证纪律（本机 git-bash 陷阱）：`cmd | tail; echo $?` 的 `$?` 是**尾命令**状态，会造成闸门假绿；
所有退出码必须 `cmd > /tmp/x.log 2>&1; echo "exit=$?"`，日志原文保留。

1. 节点 1：红灯取证 → 改 `audit-ci.jsonc` → 绿灯 → `npx vitest run scripts/__tests__/audit-config.test.ts` 绿 → 可逆探针。
2. 节点 2：`npm run test:coverage` 红灯取证（同时复核读数）→ 改 `vitest.config.ts` → 绿灯 → `typecheck`/`lint`/`prettier --check`。
3. 节点 3：文档收口 → `JSON.parse` + `debt:check` + `check-changelog-release` 三项 exit 0。
4. 全局校验：`npm test` → `npm run typecheck` → `npm run lint` → `npm run format:check` → `npm run audit` → `npm run test:coverage` → `npm run verify`。
5. `git status --porcelain` 只应列出上述 5 个文件 + 本计划文件。

**禁止执行**：`npm run dist:win`、`npm run build`、`npm run reset`、`npm run e2e:*`、`npm run audit:fix`
（需完整打包环境 / 会清理产物 / 会改写 lock；本轮以 `check-changelog-release.ts` 单独证明变更日志收口未被破坏）。

## 5. 异常与兜底

| 分支                                    | 处置                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| 转绿后又冒出**其他**未豁免高危          | 立即停止，不扩大豁免，原样回报                                       |
| 审计因网络/registry 404 失败            | 判「未验证」，不当作通过；退回 `audit-config.test.ts` 做离线形状校验 |
| 覆盖读数与 66.69/58.19/59.22/68.27 不符 | 以本轮实测重新整数下取整（阈值必须 ≤ 实测）；读数上移**不追高**阈值  |
| `test:coverage` 因 forks/OOM 中断       | 如实标未验证，不改 `pool`/`testTimeout` 掩盖，不删用例               |
| 探针未还原                              | `git status --porcelain` 比对预期清单，未还原不得进入下一节点        |

## 6. 参数校验（本轮无代码逻辑，故校验配置值）

- 豁免 id 必须匹配 `GHSA_PATTERN = /^GHSA(-[a-z0-9]{4}){3}$/`、非空、不与既有 28 项重复。
- `thresholds` 四值必须是 **0–100 整数**、**> 0**（置 0 等于关闸门，禁止）、且各自 **≤ 本轮实测 pct**。
- `debt-registry.json` 必须可 `JSON.parse`；`status ∈ {open, done, wont_fix}`（执行期实测该注册表本就存在 `wont_fix` 取值，计划初稿写的二值枚举不完整）；`updatedAt` 形如 `YYYY-MM-DD`。
- `CHANGELOG.md` 的 `[Unreleased]` 节内 `-` 条目数必须为 **0**。

## 7. 测试用例（正常 / 异常 / 边界）

- **正常**：`npx vitest run scripts/__tests__/audit-config.test.ts`（既有契约测试：allowlist 形状/无重复/含迁移基线、`package.json` 的 audit 脚本串、`build.yml` 无内联 `--allowlist`）。不新增「配置复读配置」的恒真单测——本仓守护测试的取向是跨文件一致性（`core-path-gate.test.ts`、`verify-format-scope.test.ts`）。
- **异常**：① 临时删掉 allowlist 里的 braces id → `audit-ci` 必须回到 exit 1（还原后 exit 0）；② 用 `--coverage.thresholds.statements=99` 的窄范围覆盖跑，必须报 `does not meet global threshold` 并非零退出（证明阈值机制仍然咬人、未被置 0）。
- **边界**：① 临时往 `[Unreleased]` 加一行 `- 探针` → `check-changelog-release.ts` exit 1，还原后 exit 0；② 全量绿灯后 `lines` 实测与阈值差仅 0.27 pt 这一紧边界必须仍判绿；③ 既有 2 例 skip 保持 skip（不新增、不解除）。

## 8. 实测记录

退出码一律 `cmd > /tmp/x.log 2>&1; echo "NAME=$?"` 取，不用管道（`cmd | tail; echo $?` 的 `$?` 是尾命令状态，会造成闸门假绿——本机 git-bash 实测陷阱）。

### 节点 1 — braces 豁免（DEBT-034）

| 阶段           | 命令                                                    | 实测                                                                                                                                         |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 红灯（改动前） | `npx audit-ci --config ./audit-ci.jsonc`                | **exit=1**，`Failed security audit due to high vulnerabilities` + `https://github.com/advisories/GHSA-vfj7-8cjw-p6xm`，7 条 vulnerable paths |
| 绿灯（改动后） | 同上                                                    | **exit=0**，`Passed npm security audit.`；该通告由「Failed …」移入「Found vulnerable allowlisted advisories」（10 项 → 11 项）               |
| 局部回归       | `npx vitest run scripts/__tests__/audit-config.test.ts` | **exit=0**，`19 tests passed`（子集断言，未改 `MIGRATION_BASELINE`）                                                                         |
| 异常探针       | 见「红灯」行                                            | 改动前的 `exit=1` 即「删掉豁免 id」的等价形态，无需再花两次联网跑                                                                            |

`overrides` 排除依据（`npm view` 直连官方 registry 实测）：`dist-tags.latest = 3.0.3`、`versions` 最大 `3.0.3`、`micromatch@latest` 的 `dependencies.braces = ^3.0.3`。

### 节点 2 — 覆盖率重新基线（DEBT-032）

| 阶段                             | 命令                                                                                                      | 实测                                                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 红灯（改动前，阈值 69/80/68/69） | `npm run test:coverage`                                                                                   | **exit=1**；`Test Files 373 passed (373)`；四条 `ERROR: Coverage for lines (68.27%) / functions (59.22%) / statements (66.69%) / branches (58.2%) does not meet global threshold (69/68/69/80)` |
| 绿灯（改动后，阈值 66/58/59/68） | 同上                                                                                                      | **exit=0**；`does not meet global threshold` 命中数 **0**；`Test Files 373 passed (373)`；`All files 66.69 \| 58.19 \| 59.22 \| 68.27`                                                          |
| 读数一致性                       | 同上两次                                                                                                  | 四项读数逐项相同 ⇒ 转绿完全由阈值变更造成，非测量面被动过                                                                                                                                       |
| 局部静态                         | `npx prettier --check --end-of-line auto vitest.config.ts` / `npx eslint vitest.config.ts` / `npx tsc -b` | 三项 **exit=0**                                                                                                                                                                                 |

`coverage/coverage-summary.json` 复核（绿灯跑后）：statements 66.69 / branches 58.19 / functions 59.22 / lines 68.27，均 ≥ 新阈值。

### 节点 3 — 文档收口

| 验证                                                       | 实测                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `node -e "JSON.parse(...)"` 解析 `docs/debt-registry.json` | OK，`updatedAt=2026-10-14`，`items=34`，DEBT-032 与 DEBT-034 均 `status=done`     |
| `npx tsx scripts/check-changelog-release.ts`               | **exit=0**，`✔ [2.5.5] 版本节存在且唯一`、`✔ [Unreleased] 已收口（无待发布条目）` |
| `npx prettier --check --end-of-line auto CHANGELOG.md`     | **exit=0**                                                                        |
| `git diff -- CHANGELOG.md` 删除行                          | **0 行**（纯新增 9 行；小节顺序 Added → Changed → Fixed → Security 合规）         |

### 探针（闸门仍生效）

| 探针                  | 命令                                                                                                         | 期望                                       | 实测                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 阈值仍咬人            | `npx vitest run scripts/__tests__/find-related-tests.test.ts --coverage --coverage.thresholds.statements=99` | 非 0 且报 `does not meet global threshold` | **exit=1**，四条 ERROR 同时引用新阈值 `68% / 59% / 58%` 与被覆盖的 `99%` ⇒ 阈值是活的、未被置 0 |
| Unreleased 收口仍咬人 | 临时在 `[Unreleased]` 插一条 `- 探针…` 后跑 `check-changelog-release.ts`                                     | exit=1                                     | **exit=1**，`✖ [Unreleased] 含 1 条待发布条目`；随后从备份还原，`git diff` 回到 9 增 0 删       |

> 探针期间被覆盖的 `coverage/` 为窄范围产物，随后由全量 `npm run test:coverage` 重新生成并复核（见上表）。

### 全局校验

| 命令                    | 退出码 | 关键输出                                                                                                                                                                                                  |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`     | 0      | `tsc -b` + `tsc -p tsconfig.scripts.json`                                                                                                                                                                 |
| `npm run lint`          | 0      | `11 problems (0 errors, 11 warnings)` — 与既有基线逐项一致（存量 `unicode-bom`）                                                                                                                          |
| `npm run format:check`  | 0      | `All matched files use Prettier code style!`                                                                                                                                                              |
| `npm run debt:check`    | 0      | 技术债提醒步骤（设计上始终 0）                                                                                                                                                                            |
| `npm run audit`         | 0      | `Passed npm security audit.`                                                                                                                                                                              |
| `npm test`              | 0      | `Test Files 373 passed (373)`；`Tests 5882 passed \| 2 skipped (5884)` — 与既有基线逐项一致，skip 数未变（未新增/解除 skip）                                                                              |
| `npm run test:coverage` | 0      | `373 passed`，`All files 66.69 \| 58.2 \| 59.22 \| 68.27`，`does not meet global threshold` 命中 0                                                                                                        |
| `npm run verify`        | 0      | `✓ typecheck / ✓ lint / ✓ core-gate / ✓ format（2 个文件）/ ✓ 全部通过 — 可以安全提交`；一条 `⚠ vitest.config.ts 未命中任何测试` 为非阻断提示（改根配置固有的现象，该文件本无同名套件，非本轮引入的失败） |

`npm test` 日志里的 `[native-load-guard] koffi failed (abi-mismatch)` / `better-sqlite3 failed (missing-vc-runtime)` 是纯 Node 环境下原生模块探测的既有降级日志，不影响用例结果（373 文件全通过）。

### 改动面终检

`git status --porcelain`：`CHANGELOG.md`、`audit-ci.jsonc`、`docs/debt-registry.json`、`docs/技术债清单.md`、`vitest.config.ts` 五个已跟踪文件被改，加本计划文件一个新文件。**`package.json`、`package-lock.json`、`src/**`、`.github/workflows/*` 零变化**；`git diff --stat` = 36 增 / 16 删，逐文件核对删除行均为「同一行就地改写」，无内容丢失。

## 9. 结论与遗留

- 两道红灯闸门（`Security audit`、`Coverage Gate`）由红转绿，CI 的 `lint-typecheck` 与 `coverage` job 不再 needs 阻断 `build`。
- 未放宽的项：`audit-ci` 的 `high: true` 判定、`--production` 未加、既有 28 项豁免一个没删、覆盖率 `provider`/`include`/`exclude`/`all`/`projects` 未动、未跳过或删改任何用例。
- 遗留（已在债务登记留痕，均不属本轮范围）：
  1. `audit-ci.jsonc` 残留 18 个不再命中的失效豁免，清退须与 `audit-config.test.ts` 的 `MIGRATION_BASELINE` 同轮处理（DEBT-020 原文口径）。
  2. 上游若出 `braces` 修复版，按注释里的撤销条件删除该豁免并 `npm update`。
  3. 覆盖率读数回升（目标 80%）须靠给薄封装模块补真实调用测试，即 DEBT-032 的修法②，属独立工作量。
