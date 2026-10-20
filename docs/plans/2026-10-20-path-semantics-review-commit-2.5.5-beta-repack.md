# 未提交代码审查、Linux CI 路径语义收口定档与 2.5.5-beta 重新打包（2026-10-20）

> 本轮不推送、不建 PR、不改 `.github/workflows/build.yml`、零新增依赖、绝不执行 `npm install`。
> 被审查的两轮修复计划：`docs/plans/2026-10-20-fix-ci-linux-path-semantics.md`（第一轮）与
> `docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md`（第二轮收口）。本文只写「审查结论 + 定档 + 发布」，
> 不复述技术论证。

## 0. 背景（Context）

工作区里有 33 个已改文件 + 12 个未跟踪新文件，内容是同一条主线：本仓 CI 的 `test`（10 分片）与 `coverage`
job 跑在 ubuntu-latest，而产品只发布 Windows x64——凡用**宿主** `path` 绑定去解释「Windows 形态路径串」的地方，
结论随宿主漂移（`posix.isAbsolute('D:\\x')` 为 false、`posix.dirname('D:\\a\\b')` 为 `'.'`、
`posix.join('C:\\a','b')` 造出混合分隔符、`posix.sep` 让 `startsWith(root + sep)` 永不命中）。
修复口径已写成 `docs/CODING_CONVENTIONS.md` §6 的三分法：比较层钉 `path.win32`、真 IO 保宿主绑定、
混合形态输入走新方言助手 `src/main/utils/path-dialect.ts`，并由 `scripts/__tests__/path-semantics-guard.test.ts`
的登记表机械化守卫、由 `npm run test:ci-linux` 装置在开发机复现 CI 语义。

这批工作写完但没提交，因此带出两处**必须在提交前处理**的真问题：文档里 6 处（另有 1 处本地镜像）
「本轮新增 / 尚未提交 / untracked」的表述在提交即成假话；`CHANGELOG.md` 缺本轮补录会使
`scripts/check-changelog-release.ts` 阻断 `npm run dist:win`。版本号四处声明位实测**已全是 `2.5.5-beta`**，
定版动作的正确形态是「一处不改」。

## 1. 审查结论（逐条给证据）

### 1.1 通过项（不需要改动，附实测证据）

| 判据                                 | 结论         | 证据                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 媒体授权缓存读写同形                 | 一致         | `src/main/app/media-protocol.ts:289` 判定侧与 `:389` 写键同为 `pathOf(filePath).resolve(filePath)`，`:453` 失效侧同形；`:330/:333` 的 LRU 命中用同一 `normalizedRequest`                                                                                                                                             |
| 前缀比较两侧同方言                   | 一致         | `media-protocol.ts:147/:342/:371` 一律传**原值**，归一与折叠交给 `src/main/utils/ipc-validate.ts:170-172` 的 win32 单点（`win32.resolve` 幂等，二次 resolve 无害）                                                                                                                                                   |
| 大小写折叠是否放宽授权               | 未放宽       | `src/main/nikkisync/resource-allowlist.ts:51-52` 归一、`:91` `Map.has` 判**确切键**，全表无 `startsWith`；折叠只把同一文件的不同写法并成一个键                                                                                                                                                                       |
| `pathOf` 的 posix 侧会否改产物行为   | 不会         | `media-protocol.ts:111` 的 `normalizedPath` 只用于缓存键/`extname`/前缀比较；真正交给 `fs` 的是 realpath 解引用后的 `realPath`，Windows 宿主上恒为反斜杠形态 ⇒ `pathOf` 恒取 win32                                                                                                                                   |
| GPP 候选拼接与通道前缀比较是否锁步   | 锁步到位     | `src/main/scanner/gameplayphotos-root.ts:36`（`joinUnder(gameRoot, ...GPP_SEGMENTS)`）与 `src/main/scanner/scan-channels.ts:116`（`sepOf(root)`）同批改；新用例 `src/main/scanner/__tests__/scan-channels.win32-root.test.ts` 正对这一对组合                                                                         |
| 全局 `electron` 别名是否打掉既有测试 | 没有         | `vitest.config.ts:118` 把裸 specifier 别名到 `tests/mocks/electron-inert.ts`；全仓无 `vi.mock('electron', importOriginal)` 透传写法，`e2e/__tests__/dist-guard.test.ts` 只做产物文本匹配                                                                                                                             |
| 守卫登记表是否漏项                   | 不漏         | `src/main` 下含 win32 钉或方言引用的非测试文件恰为 11 个，与 `scripts/__tests__/path-semantics-guard.test.ts:31-47`（5 PINNED + 5 DIALECT + 方言助手）逐字对齐；装置 fs 翻译对 rename/copyFile/link/symlink 已登记 `[0,1]` 双路径参数（`tests/mocks/ci-linux-fs.ts:147-156`），fd 型 `read/write` 在 `:213` 有意跳过 |
| 契约面                               | 无破坏       | 未新增/改名任何通道、未改 `IpcResponse`/`IpcError`；口径订正已登记于 `docs/IPC_CONTRACT.md` §11；零新增 i18n key                                                                                                                                                                                                     |
| 核心路径闸门                         | 无需授权注释 | `src/main/ipc/handlers/_trash-utils.ts` 是 handlers 下 `_` 前缀共享文件、其余改动文件不在 `PROTECTED_GLOBS` 内（`scripts/core-path-gate.ts:103`）                                                                                                                                                                    |

### 1.2 本轮修的两项（都是文档事实层，改前可判定为假）

- **R1｜6 处「尚未提交 / untracked」表述**：`AGENTS.md:99/:177`、`docs/CODING_CONVENTIONS.md:149/:151/:152`、
  `scripts/AGENTS.md:92`、`src/main/utils/AGENTS.md:105`（另同步本地镜像 `.qoder/rules/project-conventions.md`，不入仓）。
  红灯判据：这些限定语断言「文件未被跟踪」，而 `git add` 之后 `git ls-files` 立即含之 ⇒ 陈述与仓库状态矛盾。
  处置：删去限定语、保留技术叙述与原意。安全性依据：`scripts/check-md-links.ts:302` 先判 tracked 命中、
  `:305` 才判 `GONE_MARKERS`，故先暂存再删注解不会造出死引用；`vitest.ci-linux.config.ts` 这类
  不以 `docs/ src/ scripts/ e2e/ tests/ .github/ plugins-samples/` 开头的 token 根本不被当作引用（`:175`）。
- **R2｜CHANGELOG 缺本轮补录**：`[Unreleased]` 保持为空，新条目以 `> 2026-10-20 追加：…` 引用块
  进入既有 `## [2.5.5-beta] - 2026-10-16` 节；写成列表项会被 `scripts/check-changelog-release.ts:119`
  的 `ENTRY_LINE_RE` 判为待发布条目并阻断打包。

### 1.3 登记但不修（不顺手扩大范围）

- `src/main/ipc/handlers/_trash-utils.ts:34` 与 `src/main/scanner/path-classifier.ts:77-78` 登记为 PINNED，
  而前者的 `:317`（`path.join(dir, name)`）推导出的缓存衍生文件名最终会交给真 `fsp.unlink`（`:227/:438`），
  落在三分法第 2 档的边上。**判据**：产品宿主本就是 win32 ⇒ 固化对产物零行为变化；配套测试
  `_trash-utils.test.ts:17` 把期望值同样钉 win32 且 fs 全量 mock ⇒ 没有真 IO 套件被打死；若改判 DIALECT，
  Linux 侧会拼出正斜杠衍生名、与库内 Windows 形态键不同形。保持现状，理由已在 `:29-33` 注释内。
- `media-protocol.ts` 的 `invalidateMediaPathCache` 以逻辑路径为键，而缓存写入侧可能含 realpath 解引用结果——
  仅在缩略图目录上存在 junction 时显现，属本轮之前既有窄口子，与方言改动正交。
- `resource-allowlist.ts:33-40` 残留的独立 `/** … */` 说明块（原 `CASE_INSENSITIVE_FILESYSTEM` 常量的位置）
  是无挂点的解释性注释，非缺陷。
- `e2e/smoke.e2e.ts` 的 S6「静置 5s 进程仍存活」为本机既有失败（会级联 S7 与 userData 隔离两条），
  与产物无关，本轮只如实记录读数。

## 2. 依赖声明

零新增依赖、零删除依赖，`package-lock.json` 不动。只用 Node 内置 `path.win32` / `path.posix` 与仓内既有 `vitest`。

`package.json` 在本批里只多一条开发期脚本（已在被审查批次内，本轮不新增）：

```json
"test:ci-linux": "vitest run --config vitest.ci-linux.config.ts"
```

**禁止 `npm install`**（本仓实测两条副作用：剥掉 `package-lock.json` 的 16 处 `"libc"` 字段形成无关 churn；
把 `node_modules/@nikkisync/*` 四条 junction 清成空目录，使 `npm run dist:win` 在 `verify:dist` 响亮失败）。
本机当前链接态已实测在位：`npm run link:nikkisync:check` 四包全 ok、`npm run verify:nikkisync` blocking failures 0。

## 3. 启动与运行说明

环境前提：Windows x64、Node 24（本机 v24.18.0）、`release/win-unpacked` 为待替换的旧产物。

```bash
# 3.1 基线复验（不采信历史读数）
npm test                  # 全量单测
npm run test:ci-linux     # CI（ubuntu-latest）宿主语义装置；只读诊断，不进 CI
npm run typecheck && npm run typecheck:e2e
npm run lint && npm run i18n:guard && npm run docs:links
npm run test:coverage     # 阈值 66/58/59/68

# 3.2 暂存后才有效的只读闸门（未跟踪文件永远进不了 verify 的目标集）
git add <逐个点名>  &&  npm run verify:staged  &&  npm run docs:links

# 3.3 重新打包（必须在所有 tsc -b 步骤之后）
npm run dist:win

# 3.4 发布后闸门（必须晚于重打包，否则测的是改前产物）
npm run e2e:smoke && npm run e2e:perf
```

验证方式：§11 逐项回填真实读数与退出码。

## 4. 错误处理

- 本批不改任何错误形态：`assertFileReadPath` / `assertFileWritePath` 仍抛 `AppError.forbidden`（`IPC_PATH_FORBIDDEN`）
  且 `details.path` 经 `maskPath` 脱敏；`classifyFsError`、E001–E005 埋点、`resolveGamePlayPhotosScanRoots`
  的 fail-open（返回 `null` / `continue`）语义不动。
- 方言助手对非字符串入参不做防御（调用点已先判 `typeof === 'string'`），保持叶子层零分支。
- 打包若撞 `EPERM: rename release\win-unpacked.tmp → win-unpacked`，只用仓内留档的
  `npx electron-builder --win --publish never --config.electronDist=node_modules/electron/dist`
  （见 `docs/plans/2026-10-18-uncommitted-review-commit-2.5.5-beta-repack.md` §8.1），**绝不递归删** 该临时目录
  （会变成 delete-pending，连 PowerShell `Rename-Item` 都被拒）。该覆盖参数只用于当次命令行，不写进 `package.json`。
  现状核查：`release/win-unpacked.tmp/resources` 只含 `default_app.asar`，不含 `app.asar.unpacked`，
  故 `scripts/pre-dist-check.ts:345-367` 的字典序首个命中仍是 `release/win-unpacked`，不会校验错树。
- 装置剩余红灯必须逐文件点名「是哪一根宿主轴」让装置与 CI 分叉；点名不出来的按 CI 真红处理并修生产侧，
  不接受整桶定性。

## 5. 参数校验

- `pathOf(p)`：判据是**串的形态**（`/^[A-Za-z]:[\\/]|\\/`）而不是 `process.platform`。已知判据域：这三类调用方的
  路径只有「库内/注册表/游戏配置里的 Windows 形态串」与「`os.tmpdir()` 遍历出的 POSIX 串」两种来源；
  POSIX 文件名内含裸反斜杠不在本仓该域内，已在 `src/main/utils/path-dialect.ts` 头注释写明。
- `joinUnder(base, ...segments)`：`base` 决定语义，片段一律为不带分隔符的纯名（`'X6Game'`、`'Saved'`），
  杜绝「反斜杠片段 + POSIX 根」混拼。
- 非法入参结论不变：空串、非字符串、`relative/a.jpg` 仍判 false / 拒绝；本轮不放宽任何 `isAbsolute` 结论。
- 登记表硬约束：`HOST_IO` 每条理由须 ≥12 字符且不得为占位文案（`path-semantics-guard.test.ts:159-167`）；
  新文件引入 win32 钉或方言引用而未登记 ⇒ 守卫红（`:169-178`）。

## 6. 基础测试用例（正常 / 异常 / 边界三类齐备）

| 类别 | 用例                                                                                                         | 落点                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 正常 | `joinUnder('/tmp/x','A','B')==='/tmp/x/A/B'`、`joinUnder('C:\\x','A','B')==='C:\\x\\A\\B'`、`sepOf` 随方言   | `src/main/utils/path-dialect.test.ts`                         |
| 正常 | Windows 根经 `resolveScanChannels` 解析出 `\X6Game\Saved\GamePlayPhotos` 且不记 E002；次级通道无混合分隔符   | `src/main/scanner/__tests__/scan-channels.win32-root.test.ts` |
| 正常 | 登记 `D:\Game\X6Game\A.PNG` 后 `d:\game\x6game\a.png` 命中（折叠无条件）                                     | `src/main/nikkisync/resource-allowlist.test.ts`               |
| 正常 | 装置五轴逐条自检（path/platform/落点/fs 翻译与双路径/url）                                                   | `src/main/utils/ci-linux-emulation.test.ts`                   |
| 异常 | 同目录未登记兄弟、前缀相似名、`a.pngx`、非字符串一律拒绝                                                     | `src/main/nikkisync/resource-allowlist.test.ts`               |
| 异常 | 容器 `/` 不可写 ⇒ 假绝对路径 mkdir 抛 EACCES；异步与 promises 侧同样拒绝                                     | `src/main/utils/ci-linux-emulation.test.ts` 轴 4c/4d          |
| 异常 | 撤掉 win32 钉 / 撤掉方言分流 / 撤掉 `electron` 别名 ⇒ 守卫与复现桩立即红（合成源码自检，不把缺陷种进真文件） | `scripts/__tests__/path-semantics-guard.test.ts` 自检块       |
| 边界 | 盘符根、UNC 根、`C:x` 盘符相对名、空串、相对路径的方言归属                                                   | `src/main/utils/path-dialect.test.ts`                         |
| 边界 | `media://` 大小写两写法同命中 + 未登记确切路径仍 403；反斜杠形态与正斜杠形态同身份                           | `src/main/app/__tests__/media-protocol.test.ts` 用例 31/37/44 |
| 边界 | 登记表缺项 / HOST_IO 空理由 / 装置任一轴被拆 ⇒ 守卫红                                                        | `scripts/__tests__/path-semantics-guard.test.ts`              |

## 7. 子任务拆分（涉及文件 / 输入输出 / 验收标准）

| #                  | 涉及文件                                                                                                                          | 输入 → 输出                                     | 验收标准                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| N1 基线复验        | 无（只读）                                                                                                                        | 命令 → 读数                                     | §3.1 八条命令逐条与两份计划文档 §8.3 记录一致或更好；装置新增红逐条点名到轴                      |
| N2 文档订正        | `AGENTS.md`、`docs/CODING_CONVENTIONS.md`、`scripts/AGENTS.md`、`src/main/utils/AGENTS.md`、`.qoder/rules/project-conventions.md` | 删去失效限定语 → 语义不变                       | 被跟踪文档内指向本轮新文件的「尚未提交/untracked」表述清零；`npm run docs:links` 退出码 0        |
| N3 CHANGELOG       | `CHANGELOG.md`                                                                                                                    | 在 `[2.5.5-beta]` 节追加 `> 2026-10-20 追加：…` | `[Unreleased]` 仍无列表项；`npx tsx scripts/check-changelog-release.ts` 通过                     |
| N4 暂存 + 只读闸门 | 33 改 + 12 新 + N2/N3/本文                                                                                                        | 工作区 → 索引                                   | `npm run verify:staged` 五项 0 失败；`git status --porcelain` 无意外条目                         |
| N5 提交 1          | 全部代码与文档                                                                                                                    | 索引 → `fix(ci): …`                             | `git log -1 --stat` 含 12 个新文件；提交后 `git status --porcelain` 干净（钩子未改写则应无残留） |
| N6 重新打包        | `release/`、`dist/`                                                                                                               | `npm run dist:win` → 安装包                     | `verify:dist` 全 ✔；`latest.yml` 时间戳晚于提交 1；真实退出码 0 写在 `.cache/review-logs/*.exit` |
| N7 发布后闸门      | `e2e/smoke.e2e.ts`、`e2e/perf.*`                                                                                                  | 起 `release/win-unpacked` 的 exe                | stdout 含 `[e2e-nikkisync] linkGate=run`；S6 既有失败按原样记录不弱化                            |
| N8 打包态探针      | 临时 `e2e/media-allowlist-probe.e2e.ts`，验证后已删除、不入仓                                                                     | `launchBuiltApp()` → `media://` 三档判定        | 已登记 200 / 大小写异写 200 / 未登记兄弟 403；探针文件已删除、`git status` 无残留                |
| N9 提交 2          | 仅 `.md`                                                                                                                          | 索引 → `chore(release): …`                      | 提交只含文档；不推送                                                                             |

## 8. 验证与自测顺序

严格 §3.1 → §7 的 N1→N9；所有 `tsc -b` 类步骤必须排在 `npm run dist:win` **之前**（`dist/main` 内无
`.tsbuildinfo`，一次 `tsc -b` 会把 vite 的 `preload.js` / `app/index.js` 覆写成 per-file CJS，
使 `launchBuiltApp()` 类 e2e 以 `window.electronAPI` undefined 假失败）。后台命令一律先把真实 `$?`
写入文件再落盘，不经 `tee` 管道判定成败。

## 9. 交付说明要点

- 受影响 IPC 通道：**无新增、无改名、无签名变化**；仅 `assertFileReadPath` / `assertFileWritePath` /
  `isUserPicked` / `isUserPickedDir` 的归一口径固化 win32，`docs/IPC_CONTRACT.md` §11 已登记，错误码不变。
- i18n：零新增 key（`npm run i18n:guard` 复验）。
- 版本号：`package.json` / `package-lock.json`（根与 `packages[""]`）/ `src/renderer/preview/mock/database-mock.ts` /
  `release/latest.yml` 四处声明位实测均已是 `2.5.5-beta`，**一处未改**。
- 产物**含真实行为变化**（路径白名单/授权表/`media://` 归一与大小写折叠口径），与 2026-10-19 那轮
  「运行内容等价、只有时间戳与哈希变化」不同。旧安装包直接覆盖、不备份。

## 10. 未纳入本轮的既有事实（避免误读为已处理）

- S6 既有失败未定位（怀疑与 GPU 自愈/自重启或窗口关闭路径相关），userData 目录被 `closeApp` 清掉后日志无从回看。
- `src/shared/**` 不引入 `node:path`，方言判据只留在主进程（§6 硬性禁止项）。
- 装置的 `child_process` cwd 轴曾试过、因「为 1 个假红造出 2 个新假红」而回退，本轮不重试。
- `npm run test:ci-linux` 是开发机诊断，不进 CI；CI 侧不新增步骤。

## 11. 执行记录（逐项回填实测读数）

### 11.1 N1｜基线复验

日志与退出码留档在 `.cache/review-logs/`（该目录由 `.gitignore:26` 排除，不入仓）。

| 检查                                | 命令                                                          | 本机实测读数                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全量单测（第 1 次）                 | `npm test`                                                    | **1 failed \| 425 passed (426 files)**，`Tests 1 failed \| 6534 passed \| 12 skipped`，`REAL_EXIT=1`；失败点 `src/main/thumbnail/generator.limiter.test.ts:223` `AssertionError: expected null to be truthy`                                                                                                                                                                                         |
| 该文件隔离复跑                      | `npx vitest run src/main/thumbnail/generator.limiter.test.ts` | **1 passed (68ms)** ⇒ 单文件必绿                                                                                                                                                                                                                                                                                                                                                                     |
| 全量单测（第 2 次，串行无并发负载） | `npm test`                                                    | **426 files / 6535 passed / 12 skipped，0 失败**，`REAL_EXIT=0`                                                                                                                                                                                                                                                                                                                                      |
| CI 语义装置                         | `npm run test:ci-linux`                                       | **10 failed \| 416 passed (426 files)**，`Tests 53 failed \| 6487 passed \| 7 skipped`；逐文件计数 `find-related-tests 14 / sync-server.linked 12 / runtime-facade.linked 8 / video-frame 6 / media-worker.worker-entry 5 / scan-traverse-timeout 3 / identity-service 2 / check-md-links 2 / generator.limiter 1 / metadata-resolver.linked 1`，与 round2 §8.4 的按轴归因表**逐条一致**，无新增红点 |
| 类型（src + scripts）               | `npm run typecheck`                                           | 退出码 0                                                                                                                                                                                                                                                                                                                                                                                             |
| 类型（e2e）                         | `npm run typecheck:e2e`                                       | 退出码 0                                                                                                                                                                                                                                                                                                                                                                                             |
| 静态                                | `npm run lint`                                                | **0 error / 11 warning**，11 条全为 DEBT-030 登记的存量 BOM（`src/renderer/components/common/*.test.tsx`），本轮未新增                                                                                                                                                                                                                                                                               |
| i18n                                | `npm run i18n:guard`                                          | ✅ 白名单只减不增、清零必移除、key 已同步                                                                                                                                                                                                                                                                                                                                                            |
| 变更日志收口                        | `npx tsx scripts/check-changelog-release.ts`                  | ✅ 12 个版本节，`[2.5.5-beta]` 唯一，`[Unreleased]` 已收口                                                                                                                                                                                                                                                                                                                                           |
| 覆盖率门控                          | `npm run test:coverage`                                       | **426 files / 6535 passed / 12 skipped**，`All files 69.32 / 60.57 / 61.81 / 70.93`（阈值 66/58/59/68），退出码 0                                                                                                                                                                                                                                                                                    |

**关于 `generator.limiter.test.ts` 的定性（不弱化、不跳过，如实登记）**：该文件不在本批 45 个改动文件内，本批也未触碰 `src/main/thumbnail/**`；隔离跑必绿、第 2 次全量必绿、第 1 次全量（与后续装置并行负载并存时）红一次；它在装置下恒 1 红，round2 §8.4 已把原因点名到「NTFS 命名限制」这一根轴。综合判定为**既有的时间敏感脆弱用例**（用例第 3 步给图片生成 800ms 预算、第 1 步用 `vi.waitFor` 等 `videoRunCount===2`），与本轮路径语义改动无因果关系。按最小化改动原则不在本轮修：它需要改的是该用例的预算与等待策略，属另一轮测试质量问题（同族记录见 `docs/CODING_CONVENTIONS.md` §5 的 DEBT-030 与 `docs/plans/2026-10-18-sync-gallery-toolbar-about-nikkisync.md` 里那 5 个恒绿断言文件）。

### 11.2 N2/N3｜审查实际抓出的两处真缺陷（都已修，各附可判定证据）

| #   | 缺陷                                                                                                                                                                                                                                                                                                                      | 判据（修前必红）                                                                                                                                                                                                              | 修法                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `docs/plans/2026-10-20-fix-ci-linux-path-semantics.md` 里 3 处指向**从未落地**的计划期文件名：`:63` 的 `tests/linux-sim.setup.ts`、`:103` 与 `:156` 的 `src/main/ipc/__tests__/win32-path-pin.test.ts`                                                                                                                    | `npm run docs:links` 报 `❌ 3 处死引用`、退出码 1；同一事实由 `scripts/__tests__/check-md-links.test.ts > 真实仓库契约：被跟踪文档不留死引用` 在全量测试里判红（第 1 次 `npm run test:coverage` 即 `REAL_EXIT=1` 落在这一条） | 按仓内约定在同行写明去向：`:63` 改为落定名 `tests/ci-linux.setup.ts` 并注明「计划阶段本节写作 … 该计划期名称未入仓」；`:103` 同步改为 `scripts/__tests__/path-semantics-guard.test.ts` 并保留计划期名；`:156` 的表格落点直接换成实际守卫文件。修后 `npm run docs:links` 退出码 0（`✅ 无死引用（另有 147 处提醒）`） |
| D2  | 6 个新文件不符合 prettier：闸门作用域内 4 个（`scripts/__tests__/path-semantics-guard.test.ts`、`src/main/scanner/__tests__/scan-channels.win32-root.test.ts`、`src/main/utils/ci-linux-emulation.test.ts`、`vitest.ci-linux.config.ts`）＋ `lint-staged` 键之外的 `tests/mocks/{ci-linux-fs.ts,posix-host-path.ts}` 2 个 | `npm run verify:staged` 的 format 步骤 `✗ 格式检查 (prettier --check, 36 个文件)`、退出码 1；`npx prettier --check` 对 `tests/mocks/**` 亦点名 2 个文件                                                                       | 对这 6 个文件逐个 `npx prettier --write`（不跑 `npm run format`，避免牵出无关文件），随后 `git add` 重新暂存。修后 `npm run verify:staged` **5 项 0 失败**                                                                                                                                                           |

**这两条正是「未跟踪文件进不了 `npm run verify` 目标集」盲区的实物证据**：round2 §8.3 记录的「verify 5 项 0 失败」对这 6 个文件是空跑，而该节自己写下过同一结论（`AGENTS.md` 表格里「未提交（untracked）」的写法也源自那次空跑）。本轮先 `git add` 再跑只读闸门，才把它们暴露出来。

另需如实记录一次**由本轮改动自己造出的中间红灯**：先在 `AGENTS.md:177` 删掉「尚未提交，untracked」注解、后暂存，导致 `scripts/__tests__/path-semantics-guard.test.ts` 在该刻仍是未跟踪状态 ⇒ `npm run docs:links` 报 1 处死引用（`AGENTS.md:177`）。这不是缺陷而是顺序错误，处置是把「先暂存、后删注解」固化为本文 §7 的 N4→N2 顺序；终态 `docs:links` 退出码 0 已复验。

### 11.3 N4｜暂存后的只读闸门

`npm run verify:staged` 终态读数（全部 45 个文件入索引后）：

```
[VERIFY] ✓ TypeScript 类型检查 (tsc -b) — 通过
[VERIFY] ✓ ESLint 代码规范检查（只读，不自动修复） — 通过
[VERIFY] ✓ 核心路径授权闸门 (@core-change diff 判定) — 通过
[VERIFY] ✓ 格式检查 (prettier --check, 36 个文件) — 通过
[VERIFY] ✓ 相关单元测试 (22 个文件) — 通过
[VERIFY] 总计: 5 项, 0 失败
```

7 条 `⚠` 为「源文件缺同名套件」提示（`vitest.config.ts` 等配置文件本就无测试；`path-dialect.ts` 有配套测试、`ci-linux-fs.ts` / `posix-host-path.ts` 在 `tests/**` 下不参与配对匹配），属存量口径，不阻断。

### 11.4 N5｜提交 1

待回填。

### 11.5 N6｜打包读数

待回填。

### 11.6 N7｜打包后闸门

待回填。

### 11.7 N8｜打包态探针

待回填。临时 `e2e/media-allowlist-probe.e2e.ts`，验证后已删除、不入仓。
