# 搭配码面板收尾审查 → 修复 → 六门全绿 → 提交 → 2.5.6-beta 重打包

> 生成日期：2026-10-31 · 本仓 `main` @ `9d25c73`（`meow-star-map 2.5.6-beta`）
> 状态：已批准并执行完成（读数见 §9）；执行中未放宽任何判据
> 性质：审查近期提交 + 未提交的「完整搭配码面板」阶段 0–5 改动 → 修可判定缺陷 → 全量门禁 → 提交 → 版本核对 → 原地重打包

## 1. 背景与目标

工作区含一批未提交的搭配码面板改动：结构化解析（阶段 1）、gongeo 服饰数据查询（阶段 2）、网络结果磁盘缓存（阶段 3）、clothDiy tab 结构化列表（阶段 4）、回归与实机冒烟（阶段 5），另有无引用标注的 6 份计划/契约文档。版本号在 `package.json` / `package-lock.json` 根与 `packages[""]` / preview mock / 文档声明位均已是 `2.5.6-beta`；最后一次出包为 2026-10-30 17:54 的 `MeowStarMap-Setup-2.5.6-beta.exe`（184,634,402 B）。

目标：对 `9d25c73` 及未提交改动做实质审查，修掉可判定缺陷，按用户指定顺序跑完 `npm install` / `build` / `test` / `typecheck` / `e2e:smoke` / `test:ci-linux`，提交，核对版本，重打包含本批代码的 `2.5.6-beta` 安装包，并留下可复核读数。

## 2. 审查结论

近期已提交代码（`9d25c73`、`33cdc58`、`40e5203`、`94a96cf`、`77fddb5`）逐笔读过 diff 与配套测试，未发现新的逻辑错误；其守护用例由全量 `npm test` 覆盖。

未提交代码共发现 6 项需处置：

| 编号 | 严重度 | 位置                                                                             | 问题                                                                                                                                               | 处置                                                                 |
| ---- | ------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| F1   | 中     | `src/main/services/cloth-data-service.ts` 命中分支                               | 正缓存把「缺名」永久锁死：name map 首次失败时 data API 结果被缓存为无 `name`；冷却后同名 ID 直接命中缓存，`lookupName` 不再调用，名称永远补不上    | 命中且 `name === undefined` 时重试 `lookupName` 并回写缓存；先红后绿 |
| F2   | 中     | `src/renderer/components/common/ShareCodeDecoderDialog.tsx` 的 `lookupClothSafe` | `chunks.map((chunk) => api.lookupCloth(chunk))` 在同步抛错时于 `Promise.allSettled` 之前抛出，导致「解码成功」被外层打成「操作失败」，违反降级契约 | 改为 `chunks.map(async (chunk) => api.lookupCloth(chunk))`；先红后绿 |
| F3   | 低     | `docs/IPC_CONTRACT.md` §14/§15                                                   | 仍写「未纳入版本控制、随本批提交入仓」，本批提交后失真                                                                                             | 删除过期标注                                                         |
| F4   | 低     | `docs/IPC_CONTRACT.md`                                                           | `decrypt:decodeClothDiy` 新增 `structured` 但契约未登记                                                                                            | 新增 §16，只登记本次新增可选字段与兼容性                             |
| F5   | 低     | `src/renderer/index.html`                                                        | 为改一行 CSP 触发整文件 prettier 重排                                                                                                              | 恢复原排版，只保留 CSP host 与注释                                   |
| F6   | 低     | `CHANGELOG.md` `[2.5.6-beta]`                                                    | 节内仍声明「不引入新功能」，与本批新增冲突                                                                                                         | 追加 `### Added`，原句加时间限定；不写 `[Unreleased]`                |

已排除的非缺陷：`ok/success` 漂移（阶段 4 已修，`call<T>()` 只透出内层对象，组件读 `res.ok` 正确）、CSP 两处字符串内容一致、`writeFileAtomic` 原子写用法、IdMap 预归一化对实采样本的处理、缓存 hash 路径无穿越面、`lookupCloth` zod 上限 50 与 UI 分块一致。

## 3. 依赖声明

- **零新增 npm 依赖**。
- 复用：zod（既有）、Node `crypto` / `fs/promises` / `path`、`src/main/utils/atomic-file.ts` 的 `writeFileAtomic`、`src/main/utils/logger.ts`、electron `app.getPath('userData')`、既有 Vitest / Playwright / Tailwind / i18next。
- 无新增 i18n key（阶段 4 的 9 个键与 12 locale 已就位）。

## 4. 启动与运行说明

- 环境：Windows x64、Node ≥22.12（本机 v24.18.0）、联网（install 与 gongeo / raw.githubusercontent 查询）。
- 命令链（均已在 `package.json` 确认存在）：
  `npm install` → `npm run link:nikkisync` → `npm run build` → `npm test` → `npm run typecheck` → `npm run e2e:smoke` → `npm run test:ci-linux` → `npm run dist:win`。
- 说明：`npm run e2e:smoke` 的 `launchApp()` 读 `release/win-unpacked`，重打包前跑的是 2026-10-30 的既有包；重打包后再跑一次验证新包。`nikkisync-runtime.e2e.ts` 走 `launchBuiltApp()`（dist），覆盖本批构建产物。
- 开发态手验（可选）：`npm run dev` → 设置 → 工具与插件 → 分享码工具；有效码看列表/图标，重复贴看缓存命中日志，无效码看失败分支。

## 5. 错误处理

| 场景                            | 行为                                                                  |
| ------------------------------- | --------------------------------------------------------------------- |
| name map 拉取失败               | 冷却期内不重试；冷却后重拉，命中缓存的同名 ID 也补名（F1）            |
| `lookupCloth` reject / 同步抛错 | 降级为空映射，列表照常渲染、名称回退 `#id`（F2）                      |
| 数据源 400/404                  | 空对象 + 负缓存；5xx / 超时 / 网络错误空对象且不缓存                  |
| 缓存读/写失败                   | 读视为未命中；写 warn 后返回 false，不阻塞解码                        |
| 缓存目录缺失 / 清理失败         | clear 返回 `{0,0}` 或跳过单文件；readdir 失败上抛由 IPC 转错误        |
| 网络解码失败 / 超时             | 本地字段照常返回 + 降级文案；失败不写缓存                             |
| 解析失败                        | `structured: null`，原始 networkData 保留在折叠区                     |
| `npm install` 拆 @nikkisync 链  | 立即 `npm run link:nikkisync` + `npm run verify:nikkisync`            |
| 打包 EBUSY/EPERM                | electronDist 旁路 + `cp` 建标准名树 + 清旁路 unpacked + `verify:dist` |
| 测试 / 类型 / lint 红灯         | 自己读日志修到真绿；禁止 skip / 删断言 / 放宽阈值 / `--no-verify`     |

## 6. 参数校验

- `decrypt:lookupCloth`：`z.array(schemas.positiveIntId).min(1).max(50)`；service 再去重，非法 ID 过滤。
- `decrypt:clearClothCache`：无参（`wrapHandlerNoArgs`）。
- `decodeClothDiy`：沿用既有 1B–1MB zod。
- 缓存：key = `sha256(code.trim())` hex，文件名 `[0-9a-f]{64}.txt`；空 networkData 不写。
- 解析：双层 `Content` 信封 + `wearingClothes` 数组必需；非有限 / ≤0 ID 跳过；`PoseId` 仅正整数。
- UI：ID 过滤 `Number.isInteger && >0`、去重、50 分块、`allSettled`、空数组不调用。
- CSP：`img-src` 仅追加精确 host `https://cdn.gongeo.us`，`script-src` 仍锁 `'self'`。

## 7. 基础测试用例（正常 / 异常 / 边界）

- **正常**：结构化列表三件渲染 + 名称/图标；缓存 write→read 往返；同码二次命中不触发网络；name map 恢复后同 ID 补名（F1 新增）。
- **异常**：`lookupCloth` reject / **同步抛错**（F2 新增）；name map 500、data API 超时/5xx、网络 reject；缓存写失败；JSON 解析失败；无效码。
- **边界**：51 件分 2 块；`clothes: []`；`structured: null/undefined`；空缓存目录；51 个 ID 校验拒绝；trim 归一化；LRU 淘汰；URL 守卫拒绝环回/私网/非 http(s)。

### 7.1 F1 红灯用例（先红后绿）

首次 name map 500、data API 正常；过冷却后 name map 改 200，再次查询同一 ID，期望 `name === '时光讯号'` 且 data API 仍只调 1 次。修复前该用例必红。

### 7.2 F2 红灯用例（先红后绿）

`lookupCloth: vi.fn(() => { throw new Error('sync boom') })`；期望列表照常渲染、名称为 `#id`、不出现 `operationFailed`。修复前该用例必红。

## 8. 子任务（涉及文件 / 输入输出 / 验收标准）

| #   | 子任务      | 涉及文件                                   | 输入 / 输出                                           | 验收标准                                                                                |
| --- | ----------- | ------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A   | 计划落仓    | 本文件                                     | 已批准计划 → 入仓 Markdown                            | 单独提交 `docs(plans)`；`git status` 仅该文件                                           |
| B1  | F1 修复     | `cloth-data-service.ts` / `.test.ts`       | 缓存命中 → 缺名时补查并回写                           | 新用例先红后绿；该文件全绿                                                              |
| B2  | F2 修复     | `ShareCodeDecoderDialog.tsx` / `.test.tsx` | 同步抛错 → rejected promise → 空映射                  | 新用例先红后绿；该文件全绿                                                              |
| B3  | 契约订正    | `docs/IPC_CONTRACT.md`                     | 过期标注 → 现文；新增 §16                             | `npm run docs:links` 0                                                                  |
| B4  | 排版还原    | `src/renderer/index.html`                  | 整文件重排 → 只留 CSP 两行                            | diff 仅 2 行；CSP 两处逐字一致                                                          |
| B5  | 发布口径    | `CHANGELOG.md`                             | 追加 Added；原句加时间限定                            | `check-changelog-release` 0                                                             |
| C1  | 依赖        | 无                                         | `npm install`                                         | 退出码 0；@nikkisync 链接复原；lock 无本机抖动                                          |
| C2  | 构建        | 无                                         | `npm run build`                                       | 退出码 0；dist 三件齐备且 preload 为 bundle                                             |
| C3  | 全量单测    | 无                                         | `npm test`                                            | 0 failed；skip 不新增                                                                   |
| C4  | 类型        | 无                                         | `npm run typecheck`                                   | 退出码 0                                                                                |
| C5  | 冒烟        | 无                                         | `npm run e2e:smoke`                                   | 0 failed；记录 exe 路径                                                                 |
| C6  | CI 宿主模拟 | 无                                         | `npm run test:ci-linux`                               | 退出码 0                                                                                |
| D   | 补充门禁    | 无                                         | lint / typecheck:e2e / i18n / docs / coverage / audit | 全部通过或如实记 not-run                                                                |
| E   | 提交        | 本批全部源码/测试/文档                     | 工作区 → commit `feat(cloth-outfit)`                  | pre-commit 通过；提交后 `git status` 干净                                               |
| F   | 版本 + 打包 | `release/`（gitignore）                    | 版本核对 → 归档旧包 → `dist:win`                      | 版本 `2.5.6-beta`；新包 size/sha512 两轴均变；`verify:dist` 全 ✔；重打包后冒烟 0 failed |
| G   | 回写        | 本文件 §9                                  | 实测读数 → 文档并提交                                 | 文档与实测一致                                                                          |

## 9. 执行记录（2026-10-31 完成）

### 9.1 审查与修复（TDD 红 → 绿）

| 节点             | 红灯读数                                                                                                    | 绿灯读数                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| F1 name 缓存锁死 | `cloth-data-service.test.ts`：**1 failed / 10 passed**（`expected undefined to be '时光讯号'`）             | **11 passed**                                                                        |
| F2 同步抛错泄漏  | `ShareCodeDecoderDialog.test.tsx`：**1 failed / 32 passed**（失败分支出现 `operationFailed` + `sync boom`） | **33 passed**                                                                        |
| F3/F4 契约订正   | 未造红（文档订正）；去掉「未入仓」标注后先把新文件 `git add` 进 tracked 集，`docs:links` 仍为 0 死引用      | `docs:links` 退出码 0；新增 §16 登记 `decodeClothDiy.structured`                     |
| F5 index.html    | —                                                                                                           | `git diff` 仅注释 1 行 + CSP 1 行；`node` 比对两处 CSP 字符串 `true`                 |
| F6 CHANGELOG     | —                                                                                                           | 14 个版本节、`[2.5.6-beta]` 唯一、`[Unreleased]` 无条目，`check-changelog-release` 0 |

### 9.2 用户指定六道硬门

运行时：Node **v26.3.0** / npm **11.16.0**（Windows x64）。

| #   | 命令                                                                   | 实测读数                                                                                                                                 | 退出码 |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | `npm install`                                                          | `removed 4 packages` 即 4 条 @nikkisync junction；lock 前后 `git diff` 为空（无本机抖动）                                                | 0      |
| —   | `npm run link:nikkisync` / `link:nikkisync:check` / `verify:nikkisync` | 4 条链接 `ok`；诊断 13 项全 ✓、`blocking failures: 0`                                                                                    | 0      |
| 2   | `npm run build`                                                        | `✓ built in 9.89s`；dist 产物齐备                                                                                                        | 0      |
| 3   | `npm test`                                                             | **459 文件 / 7199 passed / 20 skipped / 0 failed**（基线 7197 + 2 条新回归，逐位吻合）                                                   | 0      |
| 4   | `npm run typecheck`                                                    | `tsc -b` + `tsc -p tsconfig.scripts.json` 零输出                                                                                         | 0      |
| 5   | `npm run e2e:smoke`（重打包前）                                        | **16 passed / 30.2s**；`[e2e] executable:` 指向当时既有的 `release/win-unpacked/喵星图.exe`；N1–N4 走 `launchBuiltApp` 验的是本批 `dist` | 0      |
| 6   | `npm run test:ci-linux`                                                | **459 文件 / 7216 passed / 3 skipped / 0 failed / 60.65s**（装置下 linked 套件真跑，skip 由 20 降至 3）                                  | 0      |

### 9.3 补充静态 / 安全门

- `npm run lint`：0；`npm run typecheck:e2e`：0。
- `npm run i18n:check`：12 locale 各 4070 key 对齐；`npm run i18n:guard`：通过。
- `npm run preview:check`：PASS=5 / WARN=5 / FAIL=0（5 条 WARN 为既有页面/CDN 口径，非本批引入）。
- `npm run docs:links`：0 死引用（185 条既有本机留存区提醒）。
- `npm run test:coverage`：All files **70.32 / 61.78 / 63.09 / 71.95**（阈值 66 / 58 / 59 / 68），0 failed。
- `npm run audit`：`Passed npm security audit.`（豁免清单内 8 high / 1 critical，与既有基线一致）。
- `npm run verify`：typecheck / lint / core-gate / format / 相关单测 **5/5**（158 用例）；4 个纯类型/桥文件无同名套件属非阻断提示（`preload/api/decrypt.ts`、`cloth-data-config.ts`、`types/decryption.ts`、`shared/types/electron-api.ts`）。

### 9.4 提交

- `188778f docs(plans): 落盘搭配码面板收尾审查-提交-重打包计划`（本文件单独提交）。
- `200691f feat(cloth-outfit): 完整搭配码面板与本地缓存，并修审查发现的降级缺口`：41 文件、+3992/−98；pre-commit 的 lint-staged、core-gate（**6 个受保护文件**）、`tsc -b` 全过；提交后 `git status --porcelain` 为空。
- 未推送（用户未要求）。

### 9.5 版本核对（零编辑）

`package.json` = `2.5.6-beta`；`package-lock.json` 根与 `packages[""]` 同值；`src/renderer/preview/mock/database-mock.ts:664` 同值；`AGENTS.md` / `ARCHITECTURE(.en).md` / `DEVELOPMENT(.en).md` / `README.md` 同值。未改任何版本声明位；`check-changelog-release` 三条 ✔。

### 9.6 重打包与产物

- 标准 `npm run dist:win`：`pre-dist-check`、`build`、`@electron/rebuild` 均通过，随后在 electron 解压处失败：`EPERM rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'`（本机扫描器对新解压树加锁的既有环境问题，非代码缺陷）。
- 按计划走旁路：从官方缓存 zip 解出 `.cache/electron-dist-clean2`（`unzip -x` 排除 `resources/default_app.asar` 与 `version`，避免落地即被锁），以 `--config.electronDist=... --config.directories.output=release/build-20261031-cloth` 出包，退出码 0；未改任何配置文件。
- 产物回标准位：`release/win-unpacked`（新树）、`release/MeowStarMap-Setup-2.5.6-beta.exe`、`.blockmap`、`latest.yml`。旁路树的 `app.asar.unpacked` 已删除，`find release -name app.asar.unpacked` 只剩标准树；被锁的旁路 `app.asar` 与 `win-unpacked.tmp/resources/default_app.asar` 仅余空壳（gitignored，不影响判据）。
- 新包标识：**184,642,989 B**、sha256 `c76c10a1117691bcad662d71512274376c383e2afd661b38012ffe886aa15fad`、sha512 `ZULydQwdI26axxBUV1sCIjB7W5pqAqMdusdUJjE6AR/TuBB97jmc2laA+JJFTqNwfMRnPzBvTkPHIlZv73NCiQ==`、`releaseDate: 2026-10-31T13:44:18.780Z`。
- 旧包归档：`_safe_backup_20261031-pre-cloth-repack/`，184,634,402 B、sha256 `bfe0ed4e…`、sha512 `eDUpe…` ⇒ 与新版在 **size 与 sha512 两轴均不同**，非空重跑。
- `release/latest.yml`：`version: 2.5.6-beta`、`path: MeowStarMap-Setup-2.5.6-beta.exe`。
- `npm run verify:dist`：21 项全 ✔（原生二进制、VC++ 运行库、@nikkisync 全部产物与闭包、管理员清单、禁串）。
- 重打包后 `npm run e2e:smoke`：**16 passed / 29.7s**，`[e2e] executable:` 为标准名树。
- 包内字节：`app.asar` 内 `dist\main\main\app\index.js` 与盘上 `dist/main/main/app/index.js` **逐字节相等**（41,022 B，sha256 `57a46bb5…`）；包内特征串计数 `lookupCloth=11`、`clearClothCache=3`、`cloth-diy-cache=1`、`gongeo.us=122`，证明本批代码确在包内。

### 9.7 偏差与未覆盖项

- 计划已预告「重打包前的 e2e:smoke 验的是既有 10-30 包」，实测一致；新包已在重打包后二跑。
- 标准打包失败归因环境锁；旁路是绕锁而非改配方，`verify:dist` 裸跑在新树上通过。
- 真实游戏分享码的 GUI 复验本轮未重做；阶段 5 的实机证据保留，本批新增/回归由 33 条组件用例与服务单测覆盖。
- `preview:check` 的 5 条 WARN、`audit` 的豁免清单、4 个无同名套件的源文件均为既有状态，不在本批修复范围。

## 10. 风险与回滚

- `npm install` 拆 @nikkisync 链：立即 relink；若上游 `../NikkiSync` 缺失，停在打包前并如实报告，不伪造。
- 打包锁：先归档旧包；标准配方失败即走文档化旁路，不改配置文件；旁路树清理不彻底会让 `findAsarUnpacked` 假绿，必须确认 `release/` 只剩标准树。
- `index.html` 只回排版，不回滚 CSP host；若两处 CSP 不一致即回退。
- 文档改动均可逆；`CHANGELOG` 只动既有 `[2.5.6-beta]` 节，保持 `[Unreleased]` 为空。
