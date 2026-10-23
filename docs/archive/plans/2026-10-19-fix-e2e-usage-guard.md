# 修复 `npm run e2e : smoke` 报 Missing script：为裸 e2e 加误输入守卫（2026-10-19）

> 范围：新增 1 个守卫脚本 + 1 个配套单测 + `package.json` 1 行；同步 3 处文档。
> 不改 `src/**`、不改版本号与 CHANGELOG、不重新打包，因此与 `dist:win` 无关。

## 0. Context：报错从哪来

用户在 PowerShell 执行的是 `npm run e2e : smoke`（冒号两侧带空格）：

```
npm error Missing script: "e2e"
```

npm 按**空格**切词，脚本名被解析成 `e2e`，`:` 与 `smoke` 退化成传给脚本的参数；`package.json` 从来只有带冒号的 `e2e:smoke`（第 74 行起），于是 npm 在进任何项目代码之前就报错退出。

取证（均为实测，非推断）：

| 事实                         | 读数                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `package.json` 有裸 `e2e` 吗 | 无。只有 `e2e:smoke` / `e2e:perf` / `dist:win:smoke` / `dist:win:perf` / `typecheck:e2e`                            |
| 文档命令写法是否正确         | 正确。`AGENTS.md` 与 `DEVELOPMENT.md` §2.8 都写的是 `npm run e2e:smoke`                                             |
| 工作树状态                   | `git status --porcelain` 为空，HEAD `48603b9`（2026-10-19 13:17，含重新打包）                                       |
| 冒烟前置产物                 | `release/win-unpacked/无限暖暖相册管理工具.exe`、`dist/main/main/app/index.js` 均 2026-10-19 12:53 ⇒ **无需重打包** |
| 是否需要 Playwright 浏览器   | 不需要。`e2e/playwright.config.ts` 无 `webServer`/`command`，`e2e/helpers.ts` 用 `_electron.launch` 驱动打包产物    |

根因是输入笔误，仓库无法把带空格的命令"救"成正确命令（曾评估并否决"参数归一化 router"方案：要新写一个 CLI 解析器才能成立，且会把笔误洗成"看起来成功"的假绿）。可落地的改进只有一处：**用裸 `e2e` 这个脚本名占位**，让下一次误输入得到可执行的中文提示而不是 npm 的无信息量报错。

## 1. 依赖声明

**无新增、无变更、无删除依赖**，无需 `npm install`。全部复用仓内既有资产：

| 能力         | 出处                                                                    | 说明                                                                                          |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 直接执行 TS  | `devDependencies` 的 `tsx`                                              | 与其余 `scripts/*.ts` 同口径，无需编译                                                        |
| 单测         | `vitest.config.ts` 的 node project                                      | `include` 已含 `./scripts/**/*.test.ts`；`coverage.include` 只有 `src/**`，故不影响覆盖率阈值 |
| 类型检查     | `tsconfig.scripts.json`                                                 | `include: ["scripts/**/*.ts"]`，新脚本自动纳入 `npm run typecheck`                            |
| 入口守卫写法 | `scripts/link-nikkisync.ts` 的 `invokedDirectly()`                      | 复用其「`import.meta.url` 与 `argv[1]` 小写比较」实现，容忍 Windows 盘符大小写                |
| 契约测试写法 | `scripts/__tests__/audit-config.test.ts` 的 `package.json 审计脚本契约` | 同样读真实 `package.json` 并逐字断言脚本串                                                    |

## 2. 启动说明

```bash
npx vitest run scripts/__tests__/e2e-usage.test.ts   # 只跑本次新增测试
npm run e2e                                          # 触发守卫，退出码 1
npm run e2e : smoke                                  # 原始笔误，同样被守卫拦下
npm run e2e:smoke                                    # 正确的冒烟命令（冒号两侧无空格）
```

## 3. 错误处理

- 守卫不碰文件系统、不 import 项目模块、不抛异常；`buildE2eHint()` 对任意 `string[]` 都返回可用文案。
- **退出码恒为 1**（即便 argv 恰好命中某个真实子命令后缀）：守卫只提示、只追加一行"是否想运行 …"，绝不代为派发命令。
- 顶层 `process.exit(1)` 包在 `invokedDirectly()` 判定里——否则单测 `import` 该模块时会把 vitest 进程直接杀掉。
- 与既有闸门无冲突：仓库不存在 `pree2e`/`poste2e`，npm 的 pre/post 生命周期只针对被调用的脚本名；CI（`.github/workflows/build.yml`）逐字调用 `e2e:smoke`/`e2e:perf`，不枚举脚本表；`lint-staged` 键未动，`scripts/__tests__/verify-format-scope.test.ts` 不受影响。

## 4. 参数校验（`buildE2eHint` 入参契约）

- 类型 `readonly string[]`，必填；调用方为 `process.argv.slice(2)`，因此**空数组是合法且预期的常态**（npm 是否转发多余参数依版本而异，实测 npm 11 会转发）。
- 归一化：逐项 `trim()` → 丢弃空串与裸 `:` token → 转小写。
- 建议行：仅当归一化 token（再剥掉内部冒号，兼容 `:smoke` 粘连写法）命中某条真实命令名的冒号分段时才追加；命中不了返回空串，**不臆造不存在的命令**。
- 非法/未知值（`--`、空串、全角字符等）一律忽略，不抛异常、不产生空建议。

## 5. 基础测试用例与红绿读数

`scripts/__tests__/e2e-usage.test.ts`，8 例，三类齐备：

| 类别 | 用例                                                                     | 判别点                        |
| ---- | ------------------------------------------------------------------------ | ----------------------------- |
| 正常 | 裸 `e2e` 脚本串逐字等于 `tsx scripts/e2e-usage.ts`                       | 真实 `package.json`           |
| 正常 | 清单每条命令都能在 `package.json` 取到、描述非空                         | 防清单漂移、防列假命令        |
| 正常 | 空 argv 仍列出全部命令并含「冒号两侧不能有空格」                         | 正文与 argv 无关              |
| 异常 | `[':', '不存在']` 给全清单但**不含**建议行                               | `not.toContain('是否想运行')` |
| 异常 | `['--', '', '   ']` 不抛异常且无建议                                     | 畸形 token 容错               |
| 边界 | 空 argv 文案是带建议文案的前缀                                           | argv 只能追加，不能改写正文   |
| 边界 | `['smoke']` / `[':', 'SMOKE']` / `[':smoke']` 都建议 `npm run e2e:smoke` | 大小写与粘连冒号              |
| 边界 | `['perf']` 建议 `e2e:perf` 且不串台到 `smoke`                            | 建议行锚定完整命令            |

建议行的断言刻意写成 `是否想运行 npm run e2e:smoke` 全串——正文里本来就含 `npm run e2e:smoke`，只断言命令名会恒绿。

红→绿过程（实测留档）：

1. **红灯一**：只有 package.json 契约断言、尚未加脚本时
   `AssertionError: expected undefined to be 'tsx scripts/e2e-usage.ts'` → `Test Files 1 failed / Tests 1 failed`。
2. 加 `"e2e": "tsx scripts/e2e-usage.ts"` → 转绿。
3. **红灯二**：追加纯函数用例、`scripts/e2e-usage.ts` 尚未创建时
   `Error: Cannot find module '../e2e-usage'` → `Test Files 1 failed / Tests no tests`。
4. 写脚本 → **绿灯** `✓ scripts/__tests__/e2e-usage.test.ts (8 tests) / Tests 8 passed (8)`。
5. 命令行实测：`npm run e2e` 与 `npm run e2e : smoke` 均打印守卫文案且 `exit=1`；后者额外追加「是否想运行 npm run e2e:smoke？」，前者无建议行——证明 argv 转发链路（`tsx scripts/e2e-usage.ts : smoke`）本身可用。

## 6. 改动清单

| 文件                                  | 改动                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `package.json`                        | `"e2e:smoke"` 上方新增 `"e2e": "tsx scripts/e2e-usage.ts"`                                              |
| `scripts/e2e-usage.ts`                | 新增：`E2E_SUBCOMMANDS` + 纯函数 `buildE2eHint()` + `invokedDirectly()` 入口守卫，stderr 输出、退出码 1 |
| `scripts/__tests__/e2e-usage.test.ts` | 新增：上表 8 例                                                                                         |
| `AGENTS.md`                           | 常用命令块补 `npm run e2e` 一行                                                                         |
| `scripts/AGENTS.md`                   | 「诊断与校验」文件表与「npm scripts 速查」表各补一行                                                    |
| `DEVELOPMENT.md`                      | §2.8 补一句误输入会被守卫拦下                                                                           |

## 7. 验证清单

```bash
npx vitest run scripts/__tests__/e2e-usage.test.ts   # 8 passed
npm run verify                                       # 各步骤 [VERIFY] ✓
npm run typecheck && npm run lint && npm run docs:links
npm test                                             # 全量，无新增失败项
npm run e2e:smoke                                    # 本轮未全绿：读数与定性见 §9（S6 属既有缺陷，与本改动无关）
git status --porcelain                               # 提交后无钩子遗留改动
```

## 8. 顺带记录（本轮不改）

`e2e/fullscreen-diagnose.e2e.ts` 文件头自称「临时探针，非回归用例」，但已被跟踪，且 `--grep-invert @perf` 不排除它，因此每次 `npm run e2e:smoke` 都会带它跑一遍。按本仓「探针跑完即删、去向须同行交代」的约定，它应当单独出仓或在文件名上排除出冒烟集合——属独立议题，需用户确认后再动。

## 9. 本轮 `npm run e2e:smoke` 实测读数与两条既有缺陷

守卫本身验证通过：`npm run e2e`（Git Bash 与 PowerShell 直出）均完整打印清单、退出码 1；PowerShell 下先前看到的中文乱码经复测是本机取证时 `| Select-Object -Last 3` 从多字节中间截断所致，非守卫缺陷。

冒烟三轮读数：

| 轮次                     | 结果                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 一（dist 未重建）        | 9 passed / 1 failed：`nikkisync-runtime.e2e.ts` N1 `bridgeType` 期望 `function` 实得 `undefined`；S1–S8 全绿 |
| 二（`npm run build` 后） | 7 passed / 4 failed / 5 did not run：N1 转绿，N2 起失败；`smoke.e2e.ts` S6 失败，S7 与 userData 隔离级联失败 |
| 三（仅 `smoke.e2e.ts`）  | 5 passed / 3 failed：S1–S5 绿，S6 仍失败，后两条仍级联                                                       |

两条与本改动无关的既有缺陷（本改动不含 `src/**`、`e2e/**` 与构建，打包产物 `release/win-unpacked` 始终为 12:53 未变）：

1. **`tsc -b` 会污染 `dist/main/main/preload.js`**。`src/main/app/window-manager.ts:67` 让未打包态从 `dist/main/main/preload.js` 加载 preload；实测 15:10 `npm run build` 产出 28422 字节 vite bundle（含 `getRuntimeStatus`）后，15:14 一次 `npm run typecheck` 就把它覆写回 9513 字节的转译体（首行 `exports.__esModule`、`^import|^export` 计数 0、兄弟模块 require 不到），`e2e/helpers.ts` 的 `launchBuiltApp()` 因此拿不到桥 → N1 假失败。这与既有发版约定「`tsc -b` 排在 `dist:win` 前」同源：跑 `launchBuiltApp` 类 e2e 前必须先 `npm run build`。
2. **S6 启动稳定性在打包产物上会自退**。S6 断言 `app.process().exitCode` 为 `null`，第 2/3 轮在 5s 静置后实得 `0`（干净退出，非崩溃），`launched` 被置空导致 S7（`reading 'userDataDir'`）与 userData 隔离（`reading 'app'`）级联报错；同一产物在第 1 轮通过，故为可复现的环境相关缺陷，需单独立项定位（怀疑与 GPU 自愈/自重启或窗口关闭路径相关）。

取证方法学留档：不要用 `exe --user-data-dir=... &` 起 GUI 探针来判断「应用是否自己退出」——Git Bash 退出会给子进程发 SIGHUP，「进程消失」无法区分自退与被 shell 回收。第 1 轮的 userData 目录也已被 `e2e/helpers.ts` 的 `closeApp` 清理，日志无从回看。
