# 2026-10-20 收口 CI 自检用例的宿主常量假设 + POSIX 宿主复现装置（第三轮）

> 上一轮：`docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md`（十片全红已收口）。
> 本轮：**不推送、不建 PR、不发版、不改 `.github/workflows/build.yml`、零新增依赖、禁止 `npm install`**。
> 本轮的形态是「上一轮修完之后，CI 从十片全红变成只剩一片红」——剩下这一片，正是上一轮引入的
> 装置自检文件自己带进来的宿主平台假设。

---

## 0. 地面真相：本轮 CI 证据是自己取的，不是等人给的

仓库已重命名为公开仓库 `QianQianLuLu1/MeowStarMap`（API 301 → `repositories/1286062066`，`private: false`）。
机上**没有 `gh`**（`gh` 未安装），故走公开 REST 免鉴权接口取证（与 round2 §0 同一路径）：

| 取证对象                               | 读数                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/actions/runs?per_page=5`             | 最近一次 run `39440507242`，`event=push`，`head_sha=a3d499c3a7a11712c163490cf2b90a656556659c` **等于本机当前 HEAD**，`conclusion=failure`，`created_at=2026-10-20T14:34:46Z`                                                         |
| `/actions/runs/39440507242/jobs`       | `Lint, Typecheck & Security`=success；`Test (shard 1..9/10)`=success；`Test (shard 10/10)`=**failure**（job `118689363399`）；`Coverage Gate`=**failure**（job `118689362995`）；`Storybook Docs`=skipped；`Build & Release`=skipped |
| `/check-runs/118689363399/annotations` | 1 条 failure，见下「红灯原文」                                                                                                                                                                                                       |
| `/check-runs/118689362995/annotations` | 1 条 failure（**与分片是同一条断言**）+ 1 条 Node 20 弃用 warning                                                                                                                                                                    |
| `/check-runs/118688774170/annotations` | 10 条 `Unexpected Unicode BOM` warning（DEBT-030 存量）+ 1 条镜像迁移 notice                                                                                                                                                         |

**红灯原文（两个红 job 逐字一致，行号与冒号后列号都给出）：**

```
path:       src/main/utils/ci-linux-emulation.test.ts
start_line: 138
title:      [node] src/main/utils/ci-linux-emulation.test.ts > CI 宿主模拟装置自检 >
            装置未激活时本文件必须整件跳过（否则 CI 会把自检当成业务回归）
message:    AssertionError: expected '/' to be '\' // Object.is equality
            Expected: "\"
            Received: "/"
            ❯ src/main/utils/ci-linux-emulation.test.ts:138:28
```

**结论先行**：两处红**不是**两处缺陷，是同一条断言在「分片跑」与「覆盖率跑」里各失败一次；
覆盖率闸门红是该断言导致 vitest 退出码 1，**不是阈值不足**（本机实测 All files 69.31/60.57/61.81/70.92，
阈值 66/58/59/68，见 §9）。

---

## 1. 依赖声明

**零新增依赖，且本轮绝不执行 `npm install`。**

- 只用 Node 内置 `fs` / `url`（`fileURLToPath`），测试装置只用仓内既有 `vitest@5.0.3` 与既有
  `tests/mocks/posix-host-path.ts` 工厂，**不写第二份 path mock**。
- 不装新依赖的硬理由（本仓实测）：`npm install` 会 ① 剥掉 `package-lock.json` 里 16 处 `"libc"` 字段
  形成无关 churn，② 把 `node_modules/@nikkisync/*` 四条 junction 清成空目录，导致 `npm run dist:win`
  在 `verify:dist` 响亮失败。
- `package.json` 只新增一条 script：`"test:posix-host"`（开发机本地跑，不进 CI）。
  `dependencies` / `devDependencies` / `package-lock.json` 一律不动。
- 版本/环境前提：本机 Node v26.3.0、npm 11.16.0（仓库 `engines.node >= 22.12.0`，CI 用 `.node-version`）。

---

## 2. 问题定位与根因

### 2.1 失败点

`src/main/utils/ci-linux-emulation.test.ts`（装置自检，142 行）结构：

- 顶部读 `globalThis.__wxnnCiLinuxEmulation` 得 `marker`，`ACTIVE = marker !== undefined`。
- 10 条装置轴用例（轴 1 / 2 / 3 / 4 / 4a / 4b / 4c / 4d / 4f / 4e）**全部**写成 `it.skipIf(!ACTIVE)(...)`
  ⇒ 装置未激活时整件跳过（这正是上一轮想要的「CI 上这个文件不产生业务回归」）。
- 轴 5（`it('轴 5：electron 走惰性替身，单测不依赖二进制安装状态')`，L126-132）与哨兵
  （`it('装置未激活时本文件必须整件跳过（否则 CI 会把自检当成业务回归）')`，L134-141）**故意不加闸门**——
  它们必须在「装置开」与「装置关」两种 profile 下都成立，否则哨兵就没有意义。
- 哨兵在 `!ACTIVE` 分支里的证明手段是（L138）：

```ts
// 真宿主：electron 包在开发机上装好了、path 绑定就是 win32，与装置态判然可分
expect(nodePath.sep).toBe(nodePath.win32.sep) // ← CI 红点
```

- Windows 宿主：`path.sep === '\\'`，`path.win32.sep === '\\'` ⇒ **恒真**，本机 `npm test` 永远看不见
  （§9 基线：本机该文件 12 tests / 10 skipped / 2 passed，退出码 0）。
- CI 宿主（ubuntu-latest）：`path.sep === '/'`，`path.win32.sep === '\\'` ⇒ **恒假**，于是
  「本该静默跳过整件的文件」反而成了必红项。

**根因线索成立**：哨兵为了证明「装置没开 ⇒ 我确实在真宿主上」，把**宿主平台的取值**当成了常量。
它自己是专门用来发现「装置失效」的哨兵，却先把宿主平台写死成了 Windows。

### 2.2 更上游成因的排查（结论：没有需要一并修的同类残留）

对 `process.platform` / `os.EOL` / `path.sep` / `.win32.sep` 全仓扫过一遍测试文件，其余含平台语义的
用例**都自带显式门控**，与本轮同类缺陷不共存：

| 文件                                                                                                                                                                      | 门控形态                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/main/utils/ffmpeg-paths.test.ts`                                                                                                                                     | 局部 `withPlatform('win32'\|'linux', fn)`（L194/206/214/236）                |
| `src/main/sync/identity-service.test.ts`                                                                                                                                  | `it.skipIf(process.platform === 'win32')`（L125/186）                        |
| `src/main/utils/ipc-validate.test.ts`                                                                                                                                     | `describe.skipIf(process.platform !== 'win32')`（L283）                      |
| `src/main/ipc/validator.test.ts`、`resource-allowlist.test.ts`、`game-directory-discovery.test.ts`、`__tests__/{resolve-gameplayphotos,scan-channels.win32-root}.test.ts` | 按 `HARNESS_TESTS` 登记引用 `posix-host-path` 常驻桩（自己钉宿主，不读宿主） |

其余 `path.sep` 出现处（`validator.ts` / `ipc-validate.ts` 已整模块钉 win32；`identity-service.ts`、
`generator.limiter.test.ts`、`scan-incremental-prefix.test.ts` 等）在 CI 上自洽，且本轮注记里没有它们。
⇒ **唯一「未加闸门却拿宿主平台常量当期望值」的断言就是 L138。**

### 2.3 一条决定修复方向的硬事实（为什么不能「换个平台无关的值」来断言真宿主）

1. 本机实测 `require('path').posix.win32 === require('path').win32` → **true**。也就是说「posix 绑定是否
   被装置换掉」无法用 `path.posix.win32` 这种值比较区分（`ci-linux-emulation.test.ts` 轴 1 的 L25
   正是拿它当装置生效的判据，而真宿主下它也成立）。
2. 装置把 `process.platform` 也改成 `'linux'`（`tests/ci-linux.setup.ts:48`）。于是**真 Linux 宿主**
   与**装置态**在 platform / cwd / homedir / tmpdir / fs 上可以一致，也可以不一致，取决于装置开了几轴；
   只有 `marker` 本身是唯一真相源。
3. 结论：在「装置未激活」这一侧，**任何**环境取值都无法证明「我现在在真宿主上」——因为 CI 就是真 Linux 宿主。
   「整件跳过」只能从**文件自身的结构**证明（装置轴用例是否一律挂着 `skipIf(!ACTIVE)` 闸门），
   不能从环境取值证明。这是本轮修复方向的硬约束，也是 §4-N1 判据形态的唯一来源。

---

## 3. 复现方案与等价性论证

### 3.1 本机没有 POSIX 宿主（实测）

- `wsl.exe --status` / `wsl -l -v`：**未安装**（「适用于 Linux 的 Windows 子系统没有已安装的分发」）。
- `docker`：**不存在**。
- `gh`：**未安装**。
  ⇒ 无法在真实 POSIX 宿主上跑，必须构造**判据不依赖本机平台**的等价复现。

### 3.2 注入式等价复现（本轮采用）

CI 红的充分必要条件是两条同时成立：

1. `ACTIVE === false` —— CI 上没有跑 `tests/ci-linux.setup.ts`，`globalThis.__wxnnCiLinuxEmulation` 未被写入；
2. `nodePath.sep !== nodePath.win32.sep` —— CI 宿主是 Linux，`sep === '/'`、`win32.sep === '\\'`。

本机 Windows 上第 2 条天然不成立。本轮新增的 **POSIX 宿主（不带装置）** profile 只做一件事：
把第 2 条的**两个形态用既有 `posixHost` 工厂注入**（`path` / `node:path` 的宿主绑定换成 posix，
`path.sep` 真实变成 `'/'`，而 `path.win32.sep` 仍是 `'\\'`），第 1 条照旧不写 marker。

**为什么这是等价复现而不是自证**：

- 被断言的两个形态（`nodePath.sep` 的 `'/'`、`nodePath.win32.sep` 的 `'\\'`）是**注入进来的值**，
  不是读本机平台 ⇒ 在 Windows 上、在 Linux 上、在 CI 上跑这条命令，得到的输入完全相同；
- 它与 CI 的差别只剩「CI 的 posix 绑定来自真内核，本机来自 mock 工厂」，而这正是本仓既有装置
  （`tests/ci-linux.setup.ts` 轴 1）已在用的同一手法，其保真性由轴 1 / 4b / 4e 三条自检钉住；
- 因此「修复前失败 → 修复后通过」在**任何宿主上**都可判，不依赖本机是 Windows。

对照三条 profile 的用途（三者都必须跑，缺一不可）：

| profile                           | 含义                        | 本轮用途                                       |
| --------------------------------- | --------------------------- | ---------------------------------------------- |
| `npx vitest run`（基座）          | Windows 真宿主 + 装置未激活 | 证明「本机看不见这盏红灯」                     |
| `npm run test:posix-host`（新增） | POSIX 宿主 + 装置未激活     | **CI 的等价替身**：修复前红、修复后绿          |
| `npm run test:ci-linux`（既有）   | CI 宿主 + 装置激活          | 回归：修复没有削弱装置本身（装置轴用例仍全跑） |

---

## 4. 子任务（文件 → 输入/输出 → 可判定验收）

### N1 修哨兵判据（唯一的语义改动）

- **文件**：`src/main/utils/ci-linux-emulation.test.ts`
- **改动面**：只改 L134-141 这一条用例体 + 新增一个常量 + 顶部注释补判据来源。
  **其余 10 条装置轴用例与轴 5 一字不动，禁止删除/加 skip/弱化任何断言。**
- **输入**：本文件自身源码文本（经 `fileURLToPath(import.meta.url)` 读，仅在 `!ACTIVE` 分支里读）。
- **输出**：`{ ungated: string[], gatedCount: number }`——未加闸门的用例标题集合、带闸门的用例数。
- **判据**：
  1. `ungated` 排序后 **必须等于** 双 profile 白名单 `DUAL_PROFILE_TITLES`（轴 5 + 哨兵）
     ⇒ 装置轴用例一律带 `skipIf(!ACTIVE)` 闸门 ⇒ 未激活时一条都不会执行（**即「整件跳过」的实质**）；
  2. `gatedCount > 0` ⇒ 空集保护：防止「文件里根本没有装置轴用例」时第 1 条恒真；
  3. 保留既有 `expect(marker).toBeUndefined()` 与 `expect(ACTIVE).toBe(marker !== undefined)`。
- **验收**：
  - `npm run test:posix-host -- src/main/utils/ci-linux-emulation.test.ts` 由 **1 failed** 转 **通过**（12 tests：10 skipped + 2 passed），退出码 1 → 0；
  - `npm run test:ci-linux -- src/main/utils/ci-linux-emulation.test.ts` 修复前后均 **12 passed**（装置态不受影响）；
  - `npx vitest run src/main/utils/ci-linux-emulation.test.ts` 修复前后均通过；
  - 变异证明（两条都要跑，证明新判据不是恒真）：
    ① 把哨兵改回 `expect(nodePath.sep).toBe(nodePath.win32.sep)` ⇒ posix-host 下立即红；
    ② 把任一装置轴用例的 `it.skipIf(!ACTIVE)` 闸门去掉 ⇒ 结构性断言立即红。

### N2 新增「POSIX 宿主（不带装置）」最小复现装置

- **新增** `tests/posix-host.setup.ts`（约 12 行）：只做一根轴——`vi.mock('path')` 与 `vi.mock('node:path')`
  复用既有 `tests/mocks/posix-host-path.ts` 的 `posixHost` 工厂；**不写** `globalThis.__wxnnCiLinuxEmulation`、
  **不**改 `process.platform` / `cwd` / `homedir` / `tmpdir`、**不** mock `fs` / `fs/promises` / `url`。
- **新增** `vitest.posix-host.config.ts`：照 `vitest.ci-linux.config.ts` 的派生写法（继承基座 `projects`/`alias`，
  只换 `setupFiles`，并同样删除 `coverage` 块——模拟态下的覆盖率读数不代表 CI 读数）。
- **修改** `package.json`：只加一条 script `test:posix-host`（与 `test:ci-linux` 同形）。
- **输入**：无（装置在 setup 期装配）。**输出**：测试进程内 `path` 宿主绑定为 posix、`marker` 未定义。
- **验收**：修复前跑 `npm run test:posix-host -- src/main/utils/ci-linux-emulation.test.ts`，失败行必须是
  **L138**、报错文本必须与 §0 的 CI 注记**逐字一致**（`expected '/' to be '\'`）。

### N3 防复发登记（挂在既有守卫里，不新建守卫文件）

- **文件**：`scripts/__tests__/path-semantics-guard.test.ts`
- **改动**：
  1. 既有「装置与基座配置不得被悄悄拆掉」用例补：`vitest.posix-host.config.ts` / `tests/posix-host.setup.ts`
     存在、config 引用该 setup、`package.json` 有 `test:posix-host`；
  2. 新增一条用例：自检文件 `src/main/utils/ci-linux-emulation.test.ts` 里**不得出现**把 win32 形态常量
     当期望值的比较（源码文本级判据：不得出现 `.win32.sep`）。
     轴 1 里的 `nodePath.posix.win32` / `nodePath.win32` 是**引用**不是 `.sep` 比较，不受影响。
- **输入/输出**：只读源码文本，输出布尔判定；不写任何文件。
- **验收**：**修复前该用例红**（L138 命中 `.win32.sep`），**修复后绿**；守卫整体 14 用例在真宿主与装置态下都绿。

### N4 全量回归

- 命令：`npm test` → `npm run test:posix-host` → `npm run test:ci-linux` → `npm run test:coverage`
  → `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `npm run i18n:guard`
  → `npm run docs:links` → `npm run verify`。
- **验收**：相对 §9 的修复前基线**无新增失败项**（`npm test` 通过数不下降、`test:ci-linux` 失败数不增加、
  覆盖率四项不低于阈值与修复前读数、lint error 仍为 0）。

---

## 5. 启动说明

```bash
# 0) 环境前提（本轮不变）
node -v            # v26.3.0（>= 22.12.0 即可）
# 依赖已装；禁止 npm install（会清掉 @nikkisync junction）
# @nikkisync/* 链接态与本轮任何用例无关（未链接时相关用例按既有口径静默 skip）

# 1) 真宿主对照（证明本机看不见这盏红灯）
npx vitest run src/main/utils/ci-linux-emulation.test.ts

# 2) POSIX 宿主等价复现（CI 的替身：修复前应红）
npm run test:posix-host -- src/main/utils/ci-linux-emulation.test.ts

# 3) 装置态回归（证明没有削弱装置）
npm run test:ci-linux -- src/main/utils/ci-linux-emulation.test.ts

# 4) 守卫
npx vitest run scripts/__tests__/path-semantics-guard.test.ts

# 5) 全量
npm test && npm run test:coverage && npm run typecheck && npm run typecheck:e2e && npm run lint
```

**已知环境坑（本轮实测）**：`npm run test:coverage` 会被本机 Safe-Delete 网关拦截
（`coverage` 目录 523 项 > 阈值 500，报 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`）。
绕法（与 `dist/main`、`release/win-unpacked` 同一类）：先 `Move-Item coverage $env:TEMP\...` 再跑。
本轮已按此执行，读数照常取得。

---

## 6. 错误处理

| 异常分支                                            | 兜底策略                                                                                                                                                                             | 日志/输出                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `!ACTIVE` 分支读自身源码失败（ENOENT / 装置态误入） | 不吞异常：读失败即红。该分支只在真 fs 与真 `url` 下执行（posix-host profile 不 mock `fs`/`url`；装置态 `ACTIVE=true` 根本不进此分支），故它同时也是「装置没有越界改写 fs/url」的旁证 | vitest 报出真实 `ENOENT` 栈，不做兜底改写                   |
| 正则未命中任何 `it(` 调用点                         | 第 2 条判据 `gatedCount > 0` 立即红 ⇒ 不会被「空文件」静默放过                                                                                                                       | 断言消息写明「装置轴用例数为 0，判据失去意义」              |
| 新增装置轴用例时忘了加 `skipIf(!ACTIVE)`            | 结构性断言把它算进 `ungated` ⇒ 与白名单不等 ⇒ 红                                                                                                                                     | 断言 diff 直接列出该标题                                    |
| 有人把宿主常量比较塞回哨兵                          | N3 守卫命中 `.win32.sep` ⇒ 红；且变异证明①会在 posix-host 下同步红                                                                                                                   | 守卫用例消息写明「自检文件不得拿 win32 形态常量当期望值」   |
| posix-host profile 跑出**预期外**的红（非 L138）    | 逐条按轴归因（本机宿主仍是 Windows：真 fs、真 platform、真 cwd），写进 §9；**不得**通过改阈值、加 skip、删用例让它变绿                                                               | 在 §9 表格里留真实文件名与失败数                            |
| 修复后 `test:ci-linux` 失败数增加                   | 判定为装置被削弱，回滚 N1 重做（装置轴用例必须仍全跑）                                                                                                                               | 与基线 53 failed / 10 files 逐字对照                        |
| `npm run test:coverage` 撞 Safe-Delete 网关         | `Move-Item coverage $env:TEMP\...` 后重跑（见 §5）                                                                                                                                   | 网关原文 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` |

---

## 7. 参数校验

| 入参 / 边界                                                      | 处理                                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 哨兵解析的「用例标题」字符串含全角括号、冒号、中文               | 正则按单引号字面量整体捕获（`it(` / `it.skipIf(…)(` 之后紧跟的 `'...'`），不做字符集白名单                                     |
| 标题里出现单引号（转义）                                         | 本文件用例标题不含单引号；一旦出现，正则会截断 ⇒ `ungated` 与白名单不等 ⇒ **判红**（失焦即红，不放过）                         |
| 注释或白名单常量里出现形似 `it('…')` 的文本                      | 正则要求 `it(` 或 `it.skipIf(…)(` 的**调用点**形态；`DUAL_PROFILE_TITLES` 里的两个字符串是数组元素，不匹配 ⇒ 不误判            |
| `skipIf(...)` 内联出现嵌套括号（如 `skipIf(!ACTIVE && x)`）      | `[^)]*` 只能匹配一层；若将来写成嵌套，`gated` 判据会漏 ⇒ `ungated` 变多 ⇒ **判红**（同样是失焦即红）                           |
| 装置轴用例数 = 0                                                 | 第 2 条判据 `gatedCount > 0` 判红（空集保护）                                                                                  |
| 双 profile 白名单与真实用例标题不同步（改了轴 5 标题却没改常量） | `ungated` 与白名单不等 ⇒ 判红，提示「改标题要同步 `DUAL_PROFILE_TITLES`」                                                      |
| `test:posix-host` 不传路径过滤（跑全量）                         | 允许，但不是本轮目标：全量下会有大量与装置无关的既有红（本机真 fs + posix 绑定混合），本轮只用它跑自检文件；文档已写明用途边界 |

---

## 8. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                                                                          | 落点                                                                    | 预期                                       |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| 正常 | 装置未激活（真宿主 / posix 宿主）⇒ 装置轴 10 条全 skip，仅轴 5 + 哨兵执行                     | `npx vitest run <自检文件>`、`npm run test:posix-host -- <自检文件>`    | 12 tests / 10 skipped / 2 passed，退出码 0 |
| 正常 | 装置激活 ⇒ 12 条全部真实执行（装置轴 10 + 轴 5 + 哨兵）                                       | `npm run test:ci-linux -- <自检文件>`                                   | 12 passed，退出码 0                        |
| 正常 | 哨兵在 `!ACTIVE` 下：未加闸门者恰为双 profile 白名单，且 gatedCount > 0                       | 哨兵用例体                                                              | 通过                                       |
| 异常 | **修复前**：posix 宿主下哨兵断言 `sep === win32.sep`                                          | `npm run test:posix-host -- <自检文件>`                                 | **1 failed @L138**，文本与 CI 注记逐字一致 |
| 异常 | 变异①：把宿主常量比较塞回哨兵                                                                 | 同上                                                                    | 立即红 ⇒ 新判据未失去判别力                |
| 异常 | 变异②：去掉某装置轴用例的 `skipIf(!ACTIVE)` 闸门                                              | 真宿主 + posix 宿主                                                     | 结构性断言立即红                           |
| 异常 | 守卫：自检文件出现 `.win32.sep`                                                               | `scripts/__tests__/path-semantics-guard.test.ts`                        | 修复前红 / 修复后绿                        |
| 边界 | 装置轴用例数为 0（人为清空）                                                                  | 哨兵 `gatedCount > 0`                                                   | 判红（不放过空集恒真）                     |
| 边界 | 标题改了不同步白名单                                                                          | 哨兵 `ungated === DUAL_PROFILE_TITLES`                                  | 判红                                       |
| 边界 | posix-host profile 下 `nodePath.win32.dirname('D:\\a\\b')` 仍走真 win32（钉过的位置不受影响） | 复用既有 `posix-host-path` 工厂语义                                     | 与装置态一致，非本轮新断言                 |
| 边界 | 全量回归无新增失败                                                                            | `npm test` / `test:ci-linux` / `test:coverage` / typecheck / lint（§9） | 与修复前基线逐项对照不劣化                 |

---

## 9. 执行记录（红→绿真实读数）

### 9.1 修复前基线（本机实测，2026-10-20，改动前 HEAD = `a3d499c`）

| 检查               | 命令                                                       | 读数                                                                                        | 退出码 |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| 自检文件（真宿主） | `npx vitest run src/main/utils/ci-linux-emulation.test.ts` | 1 file / **12 tests：10 skipped + 2 passed**                                                | 0      |
| 全量（真宿主）     | `npm test`                                                 | **426 files / 6535 passed / 12 skipped**，0 失败                                            | 0      |
| 装置态（CI 语义）  | `npm run test:ci-linux`                                    | **10 files failed / 53 failed / 6487 passed / 7 skipped**                                   | 1      |
| 覆盖率门控         | `npm run test:coverage`                                    | 426 files / 6535 passed / 12 skipped；**69.31 / 60.57 / 61.81 / 70.92**（阈值 66/58/59/68） | 0      |
| 类型               | `npm run typecheck`、`npm run typecheck:e2e`               | 0 错误 / 0 错误                                                                             | 0 / 0  |
| 静态               | `npm run lint`                                             | **0 error / 11 warning**（全为 DEBT-030 存量 BOM）                                          | 0      |

> 装置态的 10 files / 53 failed 与 round2 §8.3 的读数**逐字一致**，是既有基线（round2 §8.4 已逐文件归因，
> 全部落在装置硬限制，非 CI 真红），本轮不重开归因，只要求它**不增加**。
> 覆盖率首次跑撞 Safe-Delete 网关（`coverage` 523 项 > 500），`Move-Item` 移走后重跑取得上表读数。

### 9.2 逐节点红→绿（全部为本机实测，2026-10-20）

| 节点                                      | 命令                                                                   | 修复前读数                                                                                                                                                                        | 修复后读数                                                                                           | 退出码                     |
| ----------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| 真宿主对照（看不见红灯）                  | `npx vitest run src/main/utils/ci-linux-emulation.test.ts`             | 12 tests：10 skipped + **2 passed**（绿）                                                                                                                                         | 12 tests：10 skipped + **2 passed**（绿）                                                            | 0 → 0                      |
| **N2 复现装置（CI 等价替身）**            | `npm run test:posix-host -- src/main/utils/ci-linux-emulation.test.ts` | **1 failed**：`AssertionError: expected '/' to be '\'`，失败点 `ci-linux-emulation.test.ts > CI 宿主模拟装置自检 > 装置未激活时本文件必须整件跳过…`，与 §0 的 CI 注记**逐字一致** | **1 passed**：2 passed / 10 skipped                                                                  | **1 → 0**                  |
| N1 装置态回归（没有削弱装置）             | `npm run test:ci-linux -- src/main/utils/ci-linux-emulation.test.ts`   | 12 passed                                                                                                                                                                         | **12 passed**（装置轴 10 条仍真实执行）                                                              | 0 → 0                      |
| N3 守卫                                   | `npx vitest run scripts/__tests__/path-semantics-guard.test.ts`        | **1 failed / 13 passed**（修复前自检文件含 `.win32.sep`）                                                                                                                         | **14 passed**                                                                                        | **1 → 0**                  |
| 变异①：把宿主常量比较塞回哨兵             | 同 N2 命令                                                             | —                                                                                                                                                                                 | **1 failed**：`expected '/' to be '\'`                                                               | **1** ⇒ 新判据未失去判别力 |
| 变异②：去掉轴 1 的 `skipIf(!ACTIVE)` 闸门 | 同 N2 命令                                                             | —                                                                                                                                                                                 | **1 failed**：`expected [ …(3) ] to deeply equal [ …(2) ]`，diff 里点名 `轴 1：path 绑定已是 posix…` | **1** ⇒ 结构性断言不是恒真 |
| 变异回退核验                              | `git diff --stat`                                                      | —                                                                                                                                                                                 | `package.json +1`、`ci-linux-emulation.test.ts +30/-2`，无变异残留                                   | 0                          |

### 9.3 修复后全量回归（与 §9.1 基线逐项对照）

| 检查              | 命令                                          | 修复前基线                                     | 修复后读数                                                          | 判定                                          |
| ----------------- | --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| 全量（真宿主）    | `npm test`                                    | 426 files / 6535 passed / 12 skipped           | **426 files / 6536 passed / 12 skipped**（+1 = 新增守卫用例）       | ✅ 无新增失败                                 |
| 装置态（CI 语义） | `npm run test:ci-linux`                       | 10 files / 53 failed / 6487 passed / 7 skipped | **10 files / 53 failed / 6488 passed / 7 skipped**                  | ✅ 失败数未增加（+1 passed 同为新增守卫用例） |
| 覆盖率门控        | `npm run test:coverage`                       | 69.31 / 60.57 / 61.81 / 70.92                  | **69.32 / 60.57 / 61.81 / 70.93**（阈值 66/58/59/68）               | ✅ 未下降且高于阈值                           |
| 类型              | `npm run typecheck` / `npm run typecheck:e2e` | 0 / 0                                          | **0 / 0**                                                           | ✅                                            |
| 静态              | `npm run lint`                                | 0 error / 11 warning                           | **0 error / 11 warning**                                            | ✅ 未新增                                     |
| i18n              | `npm run i18n:guard`                          | 通过                                           | **通过**                                                            | ✅                                            |
| 文档链接          | `npm run docs:links`                          | 无死引用（148 处提醒）                         | **无死引用（149 处提醒）**                                          | ✅                                            |
| 只读闸门          | `npm run verify`                              | —                                              | **5 项 0 失败**（typecheck / lint / core-gate / format / 相关单测） | ✅                                            |

> 执行中的一个真实坑：`npm run verify` 首轮 `format` 判红（我写的多行 `expect` 不合 prettier 口径），
> 已用 `npx prettier --write --end-of-line auto` 就地修好并重跑，读数取重跑后的通过值。

### 9.4 一条必须如实登记的读数：`test:posix-host` 全量跑并不绿

`npm run test:posix-host`（不传路径过滤，跑全量 426 files）：**55 files / 147 failed / 368 passed / 3 skipped**，退出码 1。

这不是缺陷，是**设计如此**：该 profile 只开一根轴（posix 的 `path` 绑定）而保留本机真 fs、真
`process.platform`（win32）、真 `cwd`，于是「posix 串 + Windows 真 IO」这个组合在**本机与 CI 上都不存在**，
大量真 IO 用例必然互相打架。它的用途边界在 §5 / §7 已写明：**只用于跑判据落在 path 绑定上的用例**
（当前即装置自检文件）；要模拟完整的 CI 宿主，用的是 `npm run test:ci-linux`（七轴齐开）。
本轮对该 profile 的验收判据是**定向跑自检文件**（§9.2 第二行），不是全量。

---

## 10. 遗留项清单（判定为「不属于本次问题」，登记而不强改）

| #   | 项                                                                                                                                    | 归属                                                                                                                       | 影响                                                                                                                 | 处置建议                                                                                                                                                                                                                     | 本轮是否改 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | `actions/upload-artifact@v4` 的 Node 20 弃用 warning（CI 注记原文：「Node.js 20 is deprecated … being forced to run on Node.js 24」） | GitHub 官方 action 自身的运行时版本，**非本仓代码缺陷**，当前不导致任何 job 失败（平台强制升版兜底）                       | 平台停止兜底后该 step 会直接失败；涉及 `.github/workflows/build.yml` 三处（coverage / perf / installer / storybook） | 单独一次改动把 `actions/upload-artifact@v4` 升到 **v7**（实测该 action 最新 release `v7.0.2`，2026-10-07），并验证 v4→v7 的破坏性变更（artifact 命名唯一性 / 不可变性 / 输入项）。需真实跑一次流水线验证，**不能在本地判绿** | **否**     |
| 2   | `ubuntu-latest` → Ubuntu 26 镜像迁移 notice                                                                                           | GitHub 平台侧通知                                                                                                          | 镜像切到 26 后 glibc/系统库变化可能影响原生模块（better-sqlite3 / sharp / koffi）与 Playwright 冒烟                  | 登记观察；若要消除不确定性，确认后再决定是否把 `runs-on` 从 `ubuntu-latest` 钉到具体版本（当前 `label` 由平台维护，改动会波及 10 个分片 job）                                                                                | **否**     |
| 3   | `Storybook Docs` job = skipped                                                                                                        | **按设计跳过**：`build.yml` 该 job 的 `if` 只在 `workflow_dispatch` 或 tag push 时为真，本次是普通 push                    | 无                                                                                                                   | 不处置，仅登记说明（避免下次误判为「被连坐」）                                                                                                                                                                               | 否         |
| 4   | `Build & Release` job = skipped                                                                                                       | 被 `needs: [lint-typecheck, test, coverage]` **连坐**（分片 10 与 coverage 红）                                            | 修完 N1 后应自动恢复                                                                                                 | **本轮不推送 ⇒ 无法在远端 CI 上验证其恢复**，不得声称「CI 已转绿」，只能声称「红点判据已在本机等价复现中由红转绿」                                                                                                           | 否         |
| 5   | lint 的 10 条 `Unexpected Unicode BOM` warning                                                                                        | DEBT-030 存量技术债（`src/renderer/components/common/*.test.tsx`）                                                         | 无功能影响                                                                                                           | 不处置，沿用既有债务登记                                                                                                                                                                                                     | 否         |
| 6   | `npm run test:ci-linux` 的 10 files / 53 failed                                                                                       | round2 §8.4 已逐文件按轴归因的**装置硬限制**（原生库绕过被 mock 的 JS fs、NTFS vs ext4 命名/权限、本机 @nikkisync 链接态） | 不在 CI 面上，不阻断发布                                                                                             | 不重开归因；已有归因表的，本轮只要求失败数不增加                                                                                                                                                                             | 否         |
| 7   | 本机无 WSL / 无 docker / 无 `gh`                                                                                                      | 环境限制                                                                                                                   | 无法在真实 POSIX 宿主上复现、无法用 `gh` 取 CI 记录                                                                  | 已用 §3.2 的**注入式等价复现**与公开 REST 免鉴权取证两条路径替代，**不是「跑不了就跳过」**                                                                                                                                   | 否         |
