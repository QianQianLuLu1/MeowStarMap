# 2026-10-20 修复 CI（Ubuntu）单测全分片 + 覆盖率门控失败：路径语义宿主依赖

## 0. 症状与定位入口

合并到 main 后触发的 CI 在 ubuntu-latest 上失败：

- `Test (shard N/10)` 十个分片全红（`fail-fast: false`，故「全红」不代表「全文件红」，规模须实测）
- `Coverage Gate` 红（上游 `npm run test:coverage` 内失败用例导致）
- `Build & Release (Windows x64)` 与 storybook 文档站被跳过——它们自身未失败，是 `needs` 连坐
- `Lint, Typecheck & Security` 绿（该 job 不跑单测）

两类报错同源：

```
AssertionError: expected false to be true
AssertionError: expected [Function] to not throw an error but 'AppError: 路径不在白名单内，禁止 读取 操作' was thrown
```

## 1. 根因（本机实测取证）

`src/main/ipc/validator.ts:16` 用**宿主** `path` 绑定，`PathGuard` 全部 16 处语义位（187 / 196 / 206 / 221 / 286 / 289 / 294 / 302 / 306 / 320 / 326 / 333 / 369–372）都读它；而测试喂的是产品形态的 Windows 盘符路径。本机对照实测：

| 表达式                                      | `path.posix`（Linux 宿主）                                | `path.win32`（Windows 宿主＝产品真实语义） |
| ------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| `isAbsolute('D:\Program Files\Game\Album')` | **false** → `matchesPicked`/`isAllowed` 首行 return false | true                                       |
| `resolve('D:\…')`                           | `'<cwd>/D:\…'`（整段当相对文件名）                        | `D:\Program Files\Game\Album`              |
| `resolved.startsWith(root + sep)`           | `sep='/'`，永远匹配不到 `\` 路径                          | `sep='\'`，命中                            |
| `dirname('D:\a\b\photo.jpg')`               | `'.'`（→ 相册类型回落「其他」）                           | `D:\a\b`                                   |
| `isAbsolute('relative/a.jpg')`              | false                                                     | **false**（钉 win32 不放宽相对路径）       |

抛错链：`isAllowed` 判 false → `assertAllowed`（`validator.ts:344`）抛 `AppError.forbidden(t('main.validator.pathNotAllowed'))`；文案在 `src/renderer/i18n/locales/zh-CN.json:2910`，主进程经 `src/main/i18n/index.ts:17` 直接引该目录。

`path.posix.win32 === path.win32`、`path.win32.posix === path.posix` 实测为 true ⇒ 显式 `path.win32` 与宿主无关，这既是修复手段，也是「在 Windows 机器上复现 Linux 语义」的装置基础。

## 2. 修复方向的正据（不是新发明）

- 同层黑名单**已经**故意钉死：`src/main/utils/ipc-validate.ts:53-74` 注释「固化 win32 语义（产品仅发布 Windows，测试可跨平台执行）」，57/65/69/108/130 行用 `path.win32.*`。
- `src/main/utils/AGENTS.md`「Windows 特化 —— 路径操作统一 `path.win32`；产品仅发布 Windows x64」。
- 白名单侧（PathGuard）是这套既有约定的漏项。

## 3. 范围裁定：全量对齐，但只对齐「比较层」

实测清点（`git ls-files` + 正则，非测试源文件）：**636 处裸 `path.*` 语义调用分布在 108 个文件，其中 605 处（87 个文件）所在文件会把路径字符串交给真实文件系统/子进程**。

- 产品只跑 Windows ⇒ 宿主路径本就是 win32，钉 win32 对产物**零行为变化**。
- 但在 CI 的 Linux 上 `path.win32.join('/tmp/x','y')` 造出 `\tmp\x\y`，真 IO 用例会当场坏掉。已核实为真 IO 耦合：`thumbnail/generator.ts`、`sync/identity-service.ts`（其 `it.skipIf(win32)` 用例**只在 Linux 跑**，钉了必红）、`scanner/gameplayphotos-root.ts`、`scanner/worker-entry.ts` 的 `findMediaDirectories`、`scanner/scan-channels.ts`（均 `mkdtempSync(os.tmpdir())` + 真 fs）。

规则：

- **钉 win32**：路径字符串用作**键或比较**（Set 成员、`startsWith` 前缀、大小写折叠、DB 查询键、`split(sep)`）之处——比较两侧必须自洽，与宿主无关。
- **保持宿主绑定**：产出字符串**交给 `fs` / `child_process` / `dialog` / 协议 handler 读写**之处。逐条给实测理由，写进守卫用例排除清单。
- 每站取舍由 N0 枚举 + 实测红绿决定，不靠推断。

已排除的伪线索：

- `src/main/app/media-protocol.ts` 不改——`src/main/app/__tests__/media-protocol.test.ts:71` 把 `../../ipc/validator` 整体 mock 成 `tests/mocks/mock-validator`，与真实 PathGuard 零耦合；且其 `path.resolve` 结果直喂 `createReadStream`。平台分支用例 31/37/43/44 两侧自洽，保持原状。
- `src/main/plugins/permission-guard.ts` 不改——`src/main/plugins/` 无测试文件，CI 不执行该代码。

## 4. 子任务（文件 → 输入/输出 → 验收标准）

### N0 Linux 模拟装置（临时，不入仓，N8 删除）

- `tests/ci-linux.setup.ts`：`process.platform` 置 `'linux'` + `vi.mock('path')` / `vi.mock('node:path')`（仓内两种说明符都有：158 处 `'path'`、65 处 `'node:path'`），工厂返回 `{...real.posix, default: real.posix}`（own 属性全可枚举 ⇒ 一次展开即含 `sep/join/resolve/isAbsolute/dirname/basename/…` 命名导出；`win32`/`posix` 因 `posix.win32 === win32` 自动保持真实）。**禁止**就地 `Object.assign` 改真 `path`：Windows 上 `path === path.win32`，会连 win32 一起毁掉，装置失效。（计划阶段本节写作 `tests/linux-sim.setup.ts`，该计划期名称未入仓；收口时装置改为永久件并更名，落点即本行的 `tests/ci-linux.setup.ts`。）
- `vitest.linux-sim.config.ts`：整份复制 `vitest.config.ts`，只在根 `test.setupFiles` 追加装置 setup；`projects` 的 include/exclude 逐字照抄（根注释 L28-29 记录了「数组配置是合并不是覆盖」的坑，改 glob 会让枚举面与 CI 面不一致）；删掉 `coverage` 块（模拟态阈值无意义）。
- 输入：全量测试文件集。输出：真红文件清单 + 归桶（A 比较层可钉 / B IO 层不可钉 / C 仅测试侧编码宿主形态）。
- 验收：装置下 `src/main/ipc/validator.test.ts` 出 `expected false to be true`，且真宿主下同文件全绿；装置下 `--shard=1/10` 可跑。
- 装置已知失真（读结果须保守）：`os.homedir()/tmpdir()/cwd()` 仍是 Windows 值；`fs.realpathSync('D:\…')` 本机可能成功而 CI 必 ENOENT（`validator.ts:253-261` 的 fail-open）⇒ 依赖 realpath 的用例必须显式 spy 抛 ENOENT 才与 CI 等价；真 fs 行为仍是 Windows。

### N1 PathGuard 固化 win32（主修复，安全关键）

- `src/main/ipc/validator.ts`：`import nodePath from 'path'` + `const path = nodePath.win32` + 一行「固化 win32 语义…」注释 ⇒ 16 处调用点一字不动，2 行覆盖全部语义位，且不可能被后来人半应用。
- `src/main/ipc/validator.test.ts`（先写、先看红，永久 CI 复现产物）：顶部加 `vi.mock('path')`/`vi.mock('node:path')`（工厂抽成 `tests/mocks/posix-host-path.ts` 纯函数 `posixHost(real)`，helper 自身不得 import path）+ `process.platform='linux'`；D3/D5 补 `vi.spyOn(fs,'realpathSync')` 抛 ENOENT。
- 输入：Windows 盘符路径 + 注册/挑中动作。输出：`isUserPicked`/`isUserPickedDir`/`isAllowed` 布尔；`assertFileReadPath` 不抛错。
- 验收：装置下 D1–D6 钉前红、钉后 0 失败；真宿主下钉前绿、钉后仍绿；`isAllowed('')` / `isAllowed('relative/a.jpg')` / `isAllowed('D:\Windows\System32\x.exe')` 仍 false。
- 回归子集：`npx vitest run src/main/ipc src/main/app`（真宿主 + 装置各一次）+ `npm run verify`。

### N2 PathGuard 连带测试面（生产不改，验证为主）

- 只读验证：`src/main/ipc/media-read-guard.test.ts`（143-151、259-268、279-286、334-342）、`src/main/ipc/handlers/file.test.ts`、`src/main/ipc/handlers/editor-metadata-handler.test.ts`（A4/A5）、`src/main/ipc/handlers/resonance-handler.test.ts`、`src/main/ipc/handlers/_trash-utils.test.ts`。
- 输入：装置下逐个跑。输出：每文件「失败用例名 + 报错原文」+ 归桶结论（随 N1 自愈 / 转 N4-N5 / 判 IO 层不修）。
- 验收：前四个文件 0 失败；`_trash-utils.test.ts` 仍红则转 N5；关键判据——`media-read-guard` 的「必须抛错」用例（系统敏感目录、未注册盘符、`.ssh`/`.aws` 凭据、junction 指向敏感目录）仍全部抛错，修复不得把拒绝变放行。

### N3 `src/main/scanner/path-classifier.ts:74-77`

- `extractAlbumTypeFromPath` 的裸 `path.dirname`/`path.basename`（同文件其余处已用 `.replace(/\//g,'\\')` 归一）→ 内联 `path.win32.*`（仅 2 站，沿用文件内显式风格）。
- 输入：文件路径字符串（盘符形态 + 既有 unix 形态回归集）。输出：相册类型字符串（不再回落「其他」）与媒体来源标签。
- 验收：装置下 `path-classifier.test.ts`、`scanner/index.test.ts`、`__tests__/path-classifier.album.test.ts` 红→绿；真宿主下 unix 形态既有用例仍绿；`npx vitest run src/main/thumbnail` 无新增失败（`generator.ts` 引用本文件）。

### N4 N0 枚举出的其余比较层站点

- 输入：N0 清单（文件 + 行号 + 该处字符串是否交给 fs 的证据）。输出：每站「钉 / 不钉 + 一句话实测理由」，钉者进 N6 清单、不钉者进排除清单。
- 预计含 `src/main/nikkisync/resource-allowlist.ts:30-42`（`normalizeKey` 作 Map 键，需与 `resource-allowlist.test.ts:24` 的 `IS_WIN`/`P()` 口径同改，不得改成无条件断言而丢掉 Linux 判定力）。
- 验收：每站装置下红→绿、真宿主下始终绿。

### N5 `src/main/ipc/handlers/_trash-utils.ts` + 其测试

- 生产钉比较层（302-340、347、357、379 的 `path.resolve` / `+ path.sep` / `toLowerCase` 前缀比较）；测试期望值同语义改写（`path.join` → `path.win32.join`），否则混合分隔符钉完仍红。
- 输入：缓存目录与缩略图/回收站候选路径。输出：`collectCacheTierPaths` 数组、永久删除/移入回收站的 `success` 布尔。
- 验收：装置 + 真宿主下 `_trash-utils.test.ts`、`media-lifecycle-handler.test.ts` 全绿。`handlers/_*` 前缀豁免 `@core-change`。

### N6 结构性守卫（永久产物）

- 新增 `scripts/__tests__/path-semantics-guard.test.ts`（计划阶段本节写作 `src/main/ipc/__tests__/win32-path-pin.test.ts`，该计划期名称未入仓；守卫最终落在 `scripts/__tests__/` 下并同时覆盖三档而非仅「已钉」一档）：读源码文本（`readFileSync`，不执行被测代码），断言「已钉清单」每文件含 win32 别名或 `path.win32.` 且无裸 `path.resolve|isAbsolute|sep|join|dirname|basename` 残留；断言「排除清单」每条仍附理由。沿用仓内「结构档」写法（参照 `src/main/scanner/__tests__/rescan-restore-sql.test.ts`）。
- 验收：把某文件挪出钉清单（或临时还原别名）→ 守卫红；还原 → 绿。守卫在任何宿主可跑。

### N7 文档

- 本文件回填红绿读数；`docs/IPC_CONTRACT.md` 加一句事实性说明（PathGuard 归一改为固化 win32 语义；通道名/签名/`IpcResponse` 未变）；按需登记 `docs/技术债清单.md` + `docs/debt-registry.json`。
- 验收：`npm run docs:links` 退出码 0 且 `npx vitest run scripts/__tests__/check-md-links.test.ts` 通过（改 `docs/**` 时本地闸门零测试覆盖，必须手动指名跑）。

### N8 全量收敛与清理

装置全量 0 失败 → 删两个临时装置文件并 `git status --porcelain` 确认无残留 → `npm test` → `npm run typecheck` / `typecheck:e2e` / `lint` / `i18n:guard` / `docs:links` / `test:coverage`（四项读数须 ≥66/58/59/68）/ `verify`。提交按 Conventional Commits 分批，不推送、不建 PR、不发版。

## 5. 依赖声明

**零新增依赖。** 复用 Node 内置 `path.win32`，沿用仓库既有 win32 钉法样板 `src/main/utils/ipc-validate.ts`；`package.json` / `package-lock.json` 不动 ⇒ 不跑 `npm install`，因此不会剪掉 `node_modules/@nikkisync/*` junction、不会重建 Electron ABI 原生模块。测试装置用现成 `vitest`。

## 6. 启动说明

```bash
# 复现（应红）
npx vitest run --config vitest.linux-sim.config.ts src/main/ipc/validator.test.ts
# 真宿主基线（应绿）
npm test
npx vitest run src/main/ipc/validator.test.ts
# 修复后全量与闸门：见 N8
```

一句话判据：装置下 `validator.test.ts` D1 在 N1 之前必失败于 `expected false to be true`，N1 之后通过；同时真宿主 `npm test` 前后都绿。

## 7. 错误处理

- 不改任何错误路径形态：`assertAllowed` 仍抛 `AppError.forbidden` + `t('main.validator.pathNotAllowed')` + `maskPath` 脱敏 details；`addUserPicked` 的 `fs.realpathSync` 仍 fail-open（CI 上对 `D:\…` 必 ENOENT ⇒ 只保留原形态登记）；`isMediaPathAllowed` 的 catch-仍-false 不动。
- `maskPath`（`validator.ts:367-376`）在非 Windows 宿主输出 `<...>\a\b` 而非 `<...>/a/b`：仅进错误 details，无测试断言，产品行为不变——记录在案以免日后被「顺手修」。
- 兜底：某站钉完导致真宿主 `npm test` 出现新失败 ⇒ 判为 IO 层，回退并写进 N6 排除清单 + 技术债登记，不带病合并。
- 装置属临时诊断，不落仓库、不新增日志。

## 8. 参数校验

- `schemas` 全量不动（无 zod 变更 ⇒ 通道签名与 IPC 契约不变）。
- `PathGuard` 保留原入参守卫，仅换语义：非字符串/空串 → false；`isAbsolute` 为假 → false（win32 实测 `relative/a.jpg`、`./a.jpg`、`a.jpg`、`C:foo.jpg` 均 false，故不放宽；`\\server\share\a.jpg`、`D:/x`、`D:\x` 判绝对）；`resolve` 抛错 → false；`isSensitivePath` 黑名单先于白名单，命中必拒。
- 非法/越界：`register`/`markPicked` 对无效路径继续静默忽略；`registerRoots([])` 无副作用；长度上限仍由 `schemas.filePath` 的 `MAX_FILE_PATH_LENGTH` 承担。
- 大小写折叠：钉 win32 使折叠**自洽**（NTFS 不区分大小写是产品事实）；不做 `process.platform` 条件折叠——`isPathUnderDir` 那种「只有折叠分支被 gate」正是本次要消灭的反模式。

## 9. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                                                                                              | 落点                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 正常 | 注册 `D:\Program Files\Game\Album` 后其子文件 `d:\…\sub\photo.jpg` 判为已挑中/已允许，`assertFileReadPath` 不抛错 | `validator.test.ts` D1（装置强制 posix 宿主）                     |
| 正常 | `registerUserPickedDir` 后 `${dir}\sub` 命中目录短路                                                              | D6                                                                |
| 正常 | Windows 路径相册类型 `D:\…\MagazinePhotos\photo.jpg` 不再回落「其他」                                             | `path-classifier.test.ts`                                         |
| 异常 | 未注册盘符、`.ssh`/`.aws` 凭据、`D:\Windows\System32\*` 仍抛 `AppError`                                           | `media-read-guard.test.ts` / `editor-metadata-handler.test.ts` A3 |
| 异常 | realpath ENOENT 时登记原形态且不向对话框冒泡                                                                      | D3/D5（`vi.spyOn(fs,'realpathSync')`）                            |
| 边界 | 空串、非字符串、相对路径三形态、UNC、盘符根、大小写混排、`Program Filesabc` 前缀不误命中                          | D2 + 新增用例                                                     |
| 边界 | 已钉清单含 win32 别名且无裸 `path.*` 残留；排除清单条目必须带理由                                                 | `scripts/__tests__/path-semantics-guard.test.ts`                  |

## 10. 风险与 CI 等价性

- **为何本机 Windows 验证对 CI Linux 成立**：修复后判定两侧都经 `path.win32` 归一，不再读宿主绑定；`path.posix.win32 === path.win32` ⇒ 显式 win32 在两种宿主产出逐字相同的字符串。「装置全绿 + 真宿主全绿」是 Linux 全绿的充分证据，不是抽样。
- **覆盖率余量 <1pt**：`vitest.config.ts:97-107` 基线 66.69/58.19/59.22/68.27 对阈值 66/58/59/68。预期钉后 PathGuard 与 `_trash-utils` 走得更深 ⇒ 略升；若 Linux 读数低于 Windows 属既有宿主差异，如实报告，**绝不动阈值/exclude/provider**。
- **假绿风险**：装置用真 Windows fs，`realpathSync` 本机可能成功而 CI 必 ENOENT ⇒ 相关用例显式 spy。
- **范围失控风险**：分片 `fail-fast: false` 的「全分片红」不告诉你红几个文件 ⇒ 规模以 N0 枚举为准。

## 11. 执行记录（红→绿实测读数）

装置 = `npx vitest run --config vitest.linux-sim.config.ts`（宿主 path 绑成 posix + `process.platform='linux'`）。

| 节点                         | 修复前（装置）                                                                                                                                                  | 修复后                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N0 装置有效性                | `validator.test.ts` 装置下 5 failed / 14 passed；真宿主同文件 19 passed                                                                                         | 装置复现 CI 的 `expected false to be true`，判据成立                                                                                                                                                                                                                                                                                                              |
| N0 全量枚举                  | 装置全量 **66 failed / 353 passed / 3 skipped (422)**                                                                                                           | 按失败文本是否含**真实** Windows 目录（`D:\Zcode项目…`、`C:\Users\45001\AppData…`）分流：41 个为装置假信号（这些用例在 CI 上 `__dirname`/`os.tmpdir()` 本就是 posix 形态，宿主绑定自洽），25 个进入真红候选并逐个取证                                                                                                                                             |
| N1 PathGuard                 | `validator.test.ts` 5 failed                                                                                                                                    | **19 passed**（且该文件已内置 posix 宿主 mock ⇒ Windows 与 Linux 跑同一套断言）                                                                                                                                                                                                                                                                                   |
| N1 连带自愈                  | `src/main/ipc` 装置下 8 个文件红                                                                                                                                | 钉 PathGuard 后 `src/main/ipc` + file-service = **3 failed / 38 passed**（media-read-guard、file、editor-metadata-handler、resonance-handler 转绿）                                                                                                                                                                                                               |
| N3 path-classifier           | `path-classifier.test.ts` 10 failed（`expected '.' to be '高质量照片'`）、`path-classifier.album.test.ts` 4 failed                                              | 装置下两文件全绿                                                                                                                                                                                                                                                                                                                                                  |
| N4 uid-discovery             | `uid-discovery.test.ts` 8 failed（`expected null to be 'D:\Game\GamePlayPhotos'`）                                                                              | 装置下全绿；改用「数据方言」判定（串含 `\` 走 win32，否则宿主），因 `findGamePlayPhotosDir` 的 dirname 结果要交给 `fs.readdirSync`，直接钉 win32 会破坏 `gameplayphotos-hidden-traversal` / `scan-error-codes` 的 mkdtemp 真 IO 用例                                                                                                                              |
| N5 _trash-utils              | `_trash-utils.test.ts` 3 failed、`media.test.ts` 4 failed                                                                                                       | 装置下两文件全绿（生产钉 win32 + 测试期望值同语义，见 `_trash-utils.test.ts:14`）                                                                                                                                                                                                                                                                                 |
| 未修（真红候选，机制已定位） | `game-directory-discovery.test.ts` 29 failed、`resolve-gameplayphotos.test.ts` 6 failed、`ffmpeg-paths.test.ts` 3 failed、`resource-allowlist.test.ts` 1 failed | 见 §12：`game-directory-discovery` 与 `resolve-gameplayphotos` 属宿主语义分歧但**不能**简单钉 win32（候选串要喂 `fs.access` / `fs.stat`，钉了会破坏 mkdtemp 真 IO 套件，需按站点分流或测试侧规范比较）；`ffmpeg-paths` / `resource-allowlist` 的失败依赖 `process.cwd()` 形态（本机 `D:\Zcode项目…` vs CI `/home/runner/work/…`），本机无法判定其在 CI 上是否同红 |

## 12. 遗留

> 2026-10-20 第二轮已接手本节全部遗留项，计划、CI 地面真相与逐项读数见
> `docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md`。下面保留当时的原始记录。

1. 上表「未修」四项需在真实 ubuntu runner 上确认（本机无 docker / 无 gh / WSL 未装发行版，装置只能近似）。判定资料已按机制写清，接手者可直接据此分流。
   - 第二轮更正：「拿不到 CI 日志」不成立。`origin` 已是公开仓库，`check-runs/{id}/annotations`
     免鉴权可用，四项里 `resolve-gameplayphotos` / `ffmpeg-paths` / `resource-allowlist`
     直接出现在注记中，`game-directory-discovery` 则是被注记条数上限（每 check run ~10 条）
     遮住——四个都是 CI 真红，不是待确认。
   - 同一批注记还暴露了本轮未覆盖的另一类 CI 真红：CI 以 `npm ci --ignore-scripts` +
     `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 装依赖，`node_modules/electron/path.txt` 不存在，
     凡模块图里真实 `require('electron')` 且未 `vi.mock` 的测试文件全部当场崩。
     隐藏本机 `path.txt` 复跑全量实测 40 个文件倒在同一个原因上。
2. 装置本身是**结构性缺口**的替代品：CI 在 Linux、开发机在 Windows，而仓内路径语义未统一。建议后续把「比较层统一 win32、IO 层保持宿主」写进 `docs/CODING_CONVENTIONS.md`，并补 N6 的源码结构守卫用例（本轮未落地）。
3. `maskPath` 在非 Windows 宿主输出反斜杠形态，仅进错误 details，无断言依赖。
4. 大小写折叠（`toLowerCase`）在 Linux 上是不成立的假设，钉 win32 只是让比较两侧自洽；产品不跑 Linux，故不改。

## 13. 本轮「假信号」判据的更正

§11 用「失败文本里是否出现**真实** Windows 目录」把 41 个装置红灯整桶判为假信号。该判据只证明
「这条失败与 Windows 路径有关」，不能区分「装置造成的假信号」与「该套件本来就无法跨平台」，
因此作废。第二轮的判据改为可复核的两条：

1. 装置必须能复现 CI 注记里的每一处红（装置 ⊇ 地面真相），复现不出来即装置不合格；
2. 剩余红灯逐个点名是哪一宿主轴（`path` 绑定 / `process.platform` / `cwd` / `homedir` /
   `tmpdir` / `__dirname` / 容器根可写性 / electron 安装状态 / NTFS 命名限制）造成的，
   说不出轴名的不算假信号。
