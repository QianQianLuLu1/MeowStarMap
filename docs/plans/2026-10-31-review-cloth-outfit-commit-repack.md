# 搭配码面板收尾审查 → 修复 → 六门全绿 → 提交 → 2.5.6-beta 重打包

> 生成日期：2026-10-31 · 本仓 `main` @ `9d25c73`（`meow-star-map 2.5.6-beta`）
> 状态：已批准，按本文执行；执行读数回写 §9
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

## 9. 执行记录

（待回写）

## 10. 风险与回滚

- `npm install` 拆 @nikkisync 链：立即 relink；若上游 `../NikkiSync` 缺失，停在打包前并如实报告，不伪造。
- 打包锁：先归档旧包；标准配方失败即走文档化旁路，不改配置文件；旁路树清理不彻底会让 `findAsarUnpacked` 假绿，必须确认 `release/` 只剩标准树。
- `index.html` 只回排版，不回滚 CSP host；若两处 CSP 不一致即回退。
- 文档改动均可逆；`CHANGELOG` 只动既有 `[2.5.6-beta]` 节，保持 `[Unreleased]` 为空。
