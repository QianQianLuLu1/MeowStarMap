# 2026-10-20 收口 CI（Ubuntu）路径语义遗留项 + 落地防回归护栏（第二轮）

> 上一轮：`docs/plans/2026-10-20-fix-ci-linux-path-semantics.md`（本轮完成后其 §12 遗留项全部收口）。
> 本轮不推送、不建 PR、不发版、不改 `.github/workflows/build.yml`、零新增依赖。

## 0. 地面真相：本轮的 CI 证据是自己取的，不是等人给的

`origin` 指向 `github.com/QianQianLuLu1/NikkiGallery`，该仓库已重命名为公开仓库 `QianQianLuLu1/MeowStarMap`（API 301 → `repositories/1286062066`，`private: false`）。经公开 REST 接口取证：

- run `39268051028`（`push`，created `2026-10-19T14:20:22Z`）的 `head_sha = 60541b6087d…` **等于本机当前 HEAD**，结论 `failure`。
- job 清单：`Lint, Typecheck & Security` 绿；`Coverage Gate` 红；`Test (shard 1..10/10)` 十片全红；`Build & Release` / `Storybook Docs` 被 `needs` 连坐跳过。
- 日志本体（`/actions/jobs/{id}/logs`）对未认证请求返回 403「Must have admin rights」，但 **`/check-runs/{id}/annotations` 对公开仓库免鉴权可用**，本轮全部失败点即取自此。

一条决定判据有效性的事实：**每个 check run 的注记被 GitHub 截断在 ~10 条**。实测各 job 注记数为 `2 / 3 / 4 / 7 / 8 / 10 / 11 / 11 / 11 / 12`，凡 10+ 的 job 必然有失败点没被列出来。⇒「某套件没出现在注记里」不是绿灯证据。上一轮据此把 `game-directory-discovery` 悬置为「待确认」，本轮改判为真红（见 §2）。

CI 注记原文出现的失败文件（去重 21 个）：

| 分组                   | 文件                                                                                                                                                                                                                                                                                               | 上一轮状态                       | 本轮         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| PathGuard 连带         | `src/main/ipc/validator.test.ts`、`src/main/ipc/media-read-guard.test.ts`、`handlers/editor-metadata-handler.test.ts`、`handlers/resonance-handler.test.ts`、`handlers/file.test.ts`、`handlers/media.test.ts`、`src/main/services/file-service.test.ts`、`src/main/scanner/uid-discovery.test.ts` | 已修（未提交）                   | 复核         |
| 点名遗留               | `src/main/scanner/__tests__/resolve-gameplayphotos.test.ts`、`src/main/utils/ffmpeg-paths.test.ts`、`src/main/nikkisync/resource-allowlist.test.ts`                                                                                                                                                | 未修                             | N3 / N5 / N6 |
| 点名遗留（注记被截断） | `src/main/scanner/game-directory-discovery.test.ts`                                                                                                                                                                                                                                                | 悬置                             | N4           |
| 新发现：electron 未装  | `src/main/scanner/__tests__/{worker-entry.native-thumbnail,scan-chinese-path,scan-traverse-timeout,scan-directory.multi-uid,scan-worker-recovery,scan-batch-write-failure,worker-entry.findMediaDirectories}.test.ts`                                                                              | 未定性（不在上一轮 41 桶口径内） | N7           |
| 新发现：宿主可写性     | `src/main/services/log-service.test.ts`、`src/main/utils/early-crash-guard.test.ts`                                                                                                                                                                                                                | 同上                             | N8           |
| 新发现：fixture 行尾   | `src/renderer/utils/share-card/__tests__/shareCardParity.test.ts`                                                                                                                                                                                                                                  | 同上                             | N9           |

## 1. 依赖声明

**零新增依赖，且本轮绝不执行 `npm install`。**

- 只用 Node 内置 `path.win32` / `Module._load` / `crypto`，测试装置只用仓内既有 `vitest`。
- 不装新依赖的硬理由（本仓实测）：`npm install` 会 ① 剥掉 `package-lock.json` 里 16 处 `"libc"` 字段形成无关 churn，② 把 `node_modules/@nikkisync/*` 四条 junction 清成空目录，导致 `npm run dist:win` 在 `verify:dist` 响亮失败。为一个小工具引入依赖不值得付出这个代价。
- `package.json` 只新增一条 script：`"test:ci-linux": "vitest run --config vitest.ci-linux.config.ts"`（开发机本地跑，不进 CI）。`package-lock.json` 不动。

## 2. 三态结论与判据

判定规则（取代上一轮的「失败文本含真实 Windows 目录即假信号」）：

1. **CI 真红**：该文件出现在 CI 注记里，或被「已校准装置」复现。校准定义见 §3-N2——装置必须能复现注记中的每一处红（装置 ⊇ 地面真相）；做不到就是装置不合格，先修装置。
2. **装置假阳性**：仅当能指出**具体是哪一宿主轴**（`path` 绑定 / `process.platform` / `cwd` / `homedir` / `tmpdir` / 根目录可写性 / electron 未装）让装置与 CI 分叉，且该轴在 CI 上取值与本机真宿主一致时，才可判假阳性。逐文件写轴名与证据，不接受整桶打包。
3. **无法定性**：必须写明缺哪一份证据。本轮不适用——CI 注记与免鉴权 API 已覆盖全部待判面。

逐套件结论：

| 套件                                | 三态                          | 依据（可复核）                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve-gameplayphotos`            | **CI 真红 → 修生产**          | 注记 6 处（41/58/69/73/88/98）。`gameplayphotos-root.ts:13/19` 用宿主 `path.join` 造相对常量、`:33` 宿主 `join` 混出 `...\GamePlayPhotos/X6Game/Saved/GamePlayPhotos`、`:82/:97` 宿主 `basename` 在 POSIX 下返回整串 ⇒ 手动兜底判据失效                                                                                                                                                                                                          |
| `game-directory-discovery`          | **CI 真红 → 修生产**          | 33 处宿主 `path.*`；该套件把 `fs`/`fs/promises`/`child_process` 全量 mock，宿主身份四轴与 CI 一致 ⇒ 装置 29 红即 CI 红；它落在注记被截断的分片里，故上一轮看不到                                                                                                                                                                                                                                                                                 |
| `ffmpeg-paths`                      | **CI 真红 → 修测试**          | 注记 3 处（178/188/220）。SUT `ffmpeg-paths.ts:42` 的 `process.platform === 'win32'` 是**有意门控**（注释写明避免把 Linux ELF 误判为截断 PE），同文件 `:192-203` 已有显式 linux 用例；红是因为另外三个回退用例继承了宿主平台                                                                                                                                                                                                                     |
| `resource-allowlist`                | **CI 真红 → 修生产 + 修测试** | 注记 1 处（54）。SUT `:30` 平台开关决定是否折叠大小写 + `:40` 宿主 `resolve`（隐含 cwd 依赖）——与上一轮黑名单侧同类漏项；测试 `:49-58` 非 Windows 分支的 `..` 回折本身不成立（`/game/x6/../X6Game/a.png ≠ /game/x6/a.png`）                                                                                                                                                                                                                      |
| 7 个 `Module._load` 套件            | **CI 真红 → 修测试**          | 注记原文 `Error: Electron failed to install correctly`，栈在 `node_modules/electron/index.js:17`。CI 安装命令 `npm ci --ignore-scripts` + `ELECTRON_SKIP_BINARY_DOWNLOAD=1`（`build.yml:132-136`）⇒ `path.txt` 不存在；这些文件用 `Module._load` 只拦 `better-sqlite3`，其余透传给真实 loader，`worker-entry.ts:53 → services/xmp-metadata-service.ts:30` 把真 electron 拉进来。本机绿是侥幸（本机 `path.txt` 存在，require 返回字符串而非抛错） |
| `log-service` / `early-crash-guard` | **CI 真红 → 修测试**          | 注记 `EACCES: permission denied, mkdir '/mock/userData/logs'`；`early-crash-guard` 注记显示实际落到了 `/home/runner/...` 与 `/tmp/...`。根因：测试把 POSIX 绝对路径 `/mock/...` 注入依赖注入缝，SUT 用真 `fs.mkdirSync` 试探候选，容器里 `/` 不可写 ⇒ 静默回落到未注入的真实宿主目录；本机 `\mock\...` 是盘符相对路径、可写，于是候选 1 命中                                                                                                     |
| `shareCardParity`                   | **CI 真红 → 修测试**          | 注记给出两侧散列：期望 `6dea2d2a…`（本机 CRLF 工作区字节实测值），收到 `c4f076d9…`（CI checkout 的 LF 字节）。仓库无 `.gitattributes` 且 `core.autocrlf=true`，AGENTS.md §5 明令不新增 `.gitattributes` ⇒ 只能在测试内归一行尾                                                                                                                                                                                                                   |

## 3. 子任务（文件 → 输入/输出 → 验收）

### N1 共享方言助手（新增 `src/main/utils/path-dialect.ts` + `path-dialect.test.ts`）

- 导出 `pathOf(p: string): PlatformPath`（`p.includes('\\')` ⇒ `nodePath.win32`，否则宿主）、`sepOf(p)`、`joinUnder(base, ...segments)`。
- 落 `src/main/utils/` 而不是 `src/shared/utils/`：后者会被 preload 依赖白名单与渲染层 bundle 收到，而它必须 `import node:path` 运行时值。
- 输入：路径字符串。输出：语义自洽的 `PlatformPath` 实例 / 分隔符 / 拼接串。
- 验收：`npx vitest run src/main/utils/path-dialect.test.ts` 先红后绿；`src/main/scanner/uid-discovery.ts` 内联 `pathOf` 改引用本模块，`uid-discovery.test.ts` 两侧仍绿。

### N2 Linux 宿主模拟装置（新增 `vitest.ci-linux.config.ts`、`tests/ci-linux.setup.ts`、`tests/mocks/posix-host-path.ts`）

- 七轴：`path`/`node:path` → posix；`process.platform` → `linux`；`process.cwd()`/`os.homedir()`/`os.tmpdir()` → `/home/runner/work/NikkiGallery/NikkiGallery`、`/home/runner`、`/tmp`；POSIX 绝对路径且首段不属 `/tmp`、`/home/runner` 的 `mkdir` 抛 EACCES；`Module._load('electron')` 抛「未安装」。
- config 逐字照抄 `vitest.config.ts` 两个 project 的 include/exclude（根注释 L28-29 记录过「数组配置是合并不是覆盖」），删 `coverage` 块。
- 验收（校准闸门，先于任何修复）：装置跑全量，① 注记里 13 个未修文件全部为红，② 上一轮 8 个已修文件全部为绿，③ 其余红点逐个写轴名归因。读数进 §7。

### N3 `gameplayphotos-root.ts` + `scan-channels.ts`（锁步，同批）

- `:13/:19` 常量钉 `path.win32.join`；`:33` 改 `joinUnder(gameRoot, 'X6Game','Saved','GamePlayPhotos')` 分段拼；`:82/:97` 改 `pathOf(dir).basename`；`scan-channels.ts:114` 的 `path.sep` 改 `sepOf(root)`，`:132` 改 `joinUnder`。
- 输入：游戏根（Windows 字面量与 POSIX mkdtemp 两类）。输出：GPP 目录串（同时进 `fsp.access` 与 DB `file_path`）。
- 验收：装置下 `resolve-gameplayphotos.test.ts` 6 红转绿；`scan-channels` / `epic-manifests` / `worker-entry.findMediaDirectories` / `scan-error-codes` 在装置与真宿主两侧都绿；新增「Windows 字面量根喂 `resolveScanChannels` 不误记 E002」用例，改前必红。

### N4 `game-directory-discovery.ts`（33 处方言分流）+ 其测试加常驻桩

- 覆盖 `:137-227`、`:300-338`、`:378`、`:446`、`:542-646`、`:668-686`、`:763`、`:795-825`、`:1035-1048`；不改判定逻辑与返回结构；测试保留自身 `process.platform='win32'` 强制（它管 `:248/:659/:742/:856` 早退）。
- 验收：装置下 29 红转绿；真宿主全绿；`npm run typecheck` 通过。

### N5 `ffmpeg-paths.test.ts`（生产不改）

- 把 `:192-203` 已有的平台改写模式抽成本文件局部 `withPlatform(p, fn)`，用于三个 PE 回退用例显式声明 `win32`；linux 门控用例语义不变。
- 验收：装置与真宿主两侧绿；变异证明——删 SUT `:42` 门控 ⇒ `:192-203` 立即红。

### N6 `resource-allowlist.ts` + `.test.ts`

- SUT：`const path = nodePath.win32`，删 `CASE_INSENSITIVE_FILESYSTEM` 开关，`normalizeKey` 恒折叠；注释写明这是 `media://` 第 4 条规则的安全边界、折叠只可能放宽「同一文件的不同写法」，不得放宽到目录前缀。
- 测试：去掉 `IS_WIN`/`P()` 宿主分支，改用 Windows 字面量；修 `..` 回折；保留并强化负例（同目录兄弟、前缀相似名、`a.PNGX`）；引入 `posixHost` 常驻桩。
- 验收：装置与真宿主两侧绿；变异证明——删折叠或删 win32 钉即红。

### N7 7 个 `Module._load` 套件补 electron mock

- 复用 `tests/mocks/electron.ts` 的 `createElectronMock`（`tests/mocks/index.ts` 已导出），模式参照 `resolve-gameplayphotos.test.ts:24-26`。
- 验收：装置（含 electron 未装轴）下 7 文件由「整件装载失败」转为逐用例真实执行并全绿，用例计数不为 0；真宿主通过数不变。

### N8 `log-service.test.ts` / `early-crash-guard.test.ts` 落点改可写临时目录

- 注入值改为每文件 `fs.mkdtempSync(path.join(os.tmpdir(), 'ci-io-'))` 派生；断言由「字面 mock 串」改为「拼接结构 + 候选优先级」；SUT 回落链不改（有意的 fail-open）。
- 验收：装置（EACCES 轴）下转绿；真宿主绿且不再在盘根造出 `\mock` 目录。

### N9 `shareCardParity.test.ts` 散列前归一行尾

- `Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')` 再 sha256；`REFERENCE_SHA256` 改为 `c4f076d9…`（本机计算须与 CI 收到的值逐字相等）。不新增 `.gitattributes`。
- 验收：两侧绿；改 fixture 任一字节即红。

### N10 护栏 + 文档

- 新增 `scripts/__tests__/path-semantics-guard.test.ts`：`pinned` / `dialect` / `io-host` 三张登记表（钉者须含 win32 别名且无裸宿主 `path.(join|resolve|dirname|basename|sep|isAbsolute|relative|normalize)`；方言者须 import `path-dialect`；宿主 IO 者每条须带行内理由）；「喂 Windows 字面量的测试」清单须引用 `posixHost`；自检用例用合成源码文本证明插入裸宿主比较即红。
- 文档：`docs/CODING_CONVENTIONS.md` 增 §6「路径语义三分法」并同步 `.qoder/rules/project-conventions.md` 逐字镜像与 `src/renderer/AGENTS.md:3` 计数；根 `AGENTS.md` 常用命令补 `npm run test:ci-linux`；`scripts/AGENTS.md`、`src/main/utils/AGENTS.md`、`src/main/scanner/AGENTS.md` 补三分法与装置用法。
- 验收：守卫在「临时把某文件挪出登记表」时红；`npm run i18n:guard`、`npm run docs:links` 绿。

### N11 全局回归

`npm test` → `npm run test:ci-linux` → `npm run typecheck` → `npm run typecheck:e2e` → `npm run lint` → `npm run i18n:guard` → `npm run docs:links` → `npm run test:coverage`（≥66/58/59/68）→ `npm run verify`。

## 4. 启动说明

```bash
# 复现（装置 = CI 语义，应先红）
npm run test:ci-linux -- src/main/scanner/__tests__/resolve-gameplayphotos.test.ts
npm run test:ci-linux -- src/main/scanner
npm run test:ci-linux -- src/main/nikkisync src/main/utils src/main/services src/renderer

# 真宿主基线（产品语义，必须始终绿）
npx vitest run src/main/scanner src/main/utils src/main/nikkisync src/main/services src/main/ipc

# 收口
npm test
npm run verify
```

环境前提：Node 24（本机 v24.18.0；CI 用 `.node-version`）、`node_modules/@nikkisync/*` junction 不参与本轮任何用例（链接态用例在未建链时静默 skip，绿灯不等于跑过）。

## 5. 错误处理

- 不改任何错误形态：`assertAllowed` 仍抛 `AppError.forbidden` + `maskPath` 脱敏；`classifyFsError`、E001–E005 埋点、`resolveGamePlayPhotosScanRoots` 的 fail-open（返回 `null` / `continue`）语义不动。
- `pathOf` / `joinUnder` 对非字符串入参不做防御（调用点已先判 `typeof === 'string'`），保持叶子层零分支；文档在 `path-dialect.ts` 注释里写明「判据是数据方言，不是宿主平台」。
- 装置是诊断工具，允许 hack（全局 `fs.mkdirSync` 包装、`Module._load` 包装），但只在 `vitest.ci-linux.config.ts` 生效；`npm test` 与 CI 不受影响。装置的失真清单必须写进 setup 注释。
- 兜底：某处钉 win32 后真宿主 `npm test` 出现新失败 ⇒ 判为 IO 层，改回方言分流并写进 N10 登记表，不带病收尾。

## 6. 参数校验

- `pathOf(p)`：`p` 含 `\` ⇒ win32 语义；不含 ⇒ 宿主语义。已知边界：POSIX 路径本身可以合法含 `\`（文件名里的反斜杠），但本仓这三处的输入域只有两种来源——库内/注册表/游戏配置里的 Windows 形态串，与 `os.tmpdir()`/`__dirname` 遍历出的 POSIX 串，故判据成立；已在注释标注判据域。
- `joinUnder(base, ...segments)`：`base` 决定语义，片段一律视为不带分隔符的纯名（`'X6Game'`、`'Saved'`），杜绝「反斜杠片段 + POSIX 根」混拼。
- 白名单/黑名单判定入参非法（空串、非字符串、`relative/a.jpg`）仍判 false / 拒绝；本轮不放宽任何 `isAbsolute` 结论。
- `REFERENCE_SHA256`、`MAX_ENTRIES` 等常量改动只允许有 CI 实测值作依据，并在文档留读数。

## 7. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                                                                                       | 落点                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 正常 | `joinUnder('/tmp/x','A','B')==='/tmp/x/A/B'`、`joinUnder('C:\\x','A','B')==='C:\\x\\A\\B'`、`sepOf` 随方言 | `src/main/utils/path-dialect.test.ts`                                       |
| 正常 | 游戏根 `C:\Games\X` 解析出 `C:\Games\X\X6Game\Saved\GamePlayPhotos`；POSIX mkdtemp 根解析出正斜杠结果      | `resolve-gameplayphotos.test.ts` + `scan-channels.test.ts`（真 IO，两侧绿） |
| 正常 | Windows 字面量根经 `resolveScanChannels` 不被误记 E002                                                     | 本轮新增用例                                                                |
| 正常 | 注册 `D:\Game\X6Game\a.png` 后 `d:\game\x6game\A.PNG` 命中（折叠大小写）                                   | `resource-allowlist.test.ts`                                                |
| 正常 | 截断 PE 的 `ffmpeg.exe` 回退裸命令并记 2 次诊断日志（显式 win32）                                          | `ffmpeg-paths.test.ts:175-190`                                              |
| 异常 | 同目录未登记兄弟文件、前缀相似名、`a.PNGX` 一律拒绝                                                        | `resource-allowlist.test.ts` 负例                                           |
| 异常 | ELF 命名的二进制（无 `.exe`）在非 win32 平台跳过 PE 预检                                                   | `ffmpeg-paths.test.ts:192-203` 保留                                         |
| 异常 | 7 个 worker 套件在 electron 未装时仍逐用例执行                                                             | 装置（`Module._load` 轴）                                                   |
| 边界 | `..` 与重复分隔符回折同一身份；空串/`'   '`/非字符串被忽略                                                 | `resource-allowlist.test.ts`                                                |
| 边界 | 注入 `/mock/...` 类不可写路径时诊断目录落点可预测                                                          | `early-crash-guard.test.ts`、`log-service.test.ts`（mkdtemp 派生）          |
| 边界 | 登记表缺项 / 裸宿主 `path.join` 重新出现 ⇒ 守卫红（合成源码自检）                                          | `scripts/__tests__/path-semantics-guard.test.ts`                            |

## 8. 执行记录（红→绿实测读数）

基线：本机真宿主 `npx vitest run src/main/scanner src/main/utils src/main/nikkisync src/main/services src/main/ipc`
= **140 files / 2402 tests 全绿**（改动前）；装置校准前后读数见下。

### 8.1 装置校准（先于任何修复）

- 装置首版只补 `path` 绑定 + `process.platform`，全量 423 文件里 **66 红**（上一轮口径）；
  补齐宿主身份四轴后第一轮反而 **185 红** —— 全部是装置自身的缺陷，逐个定位并修：
  1. `tests/ci-linux.setup.ts` 用 `fileURLToPath(import.meta.url)` 取仓库根 ⇒ jsdom project 里
     `import.meta.url` 非 file: scheme，**149 个渲染层文件**整件崩（空错误消息）。改为在改写
     `process.cwd` 之前取 `process.cwd()`。
  2. 就地 `Object.defineProperty(fs, ...)` 被 vitest 的 interop Proxy 绕过 ⇒ 假路径不翻译，
     `favorites-handler` / `settings-card-usage` / 守卫类脚本测试成片 ENOENT。改为 `vi.mock('fs')`。
  3. `fs.promises` 与 `fs/promises` 被装配成两份包装件 ⇒ `vi.spyOn(fs.promises,'unlink')` 失效，
     `file-service` 的 EACCES 分支**假绿**。改为按真实对象记忆包装件（轴 4f 自检钉住）。
  4. `rename/copyFile/symlink` 的第二路径参数没翻译 ⇒ `file-service` 21 红、`dir-manager` 5 红、
     `atomic-file` / `file-utils` ENOENT。加 `PATH_ARG_INDEX` 表（轴 4a 自检钉住）。
  5. `fileURLToPath` 未翻译 ⇒ `path.resolve(dirname(fileURLToPath(import.meta.url)),'..','..')`
     这类仓库根推导造出 CI 上不存在的串（守卫类脚本测试成片假红）。加 `vi.mock('url')` 轴。
  6. 装置里 `expect(fs.existsSync('/mock/userData/logs')).toBe(false)` 被开发机上历史测试残留的
     `D:\mock\...` 干扰 ⇒ 自检改用一次性路径（残留目录属本机既有物，本轮不代删）。
- 校准结果：装置对 CI 注记里 13 个未修文件的红灯**逐条复现**，报错文本与行号与 CI 一致
  （`resolve-gameplayphotos` 装置 6 红 = CI 注记 41/58/69/73/88/98；`ffmpeg-paths` 3 红 = 178/188/220；
  `resource-allowlist` 1 红 = 54；`early-crash-guard` 注记 81/94；`log-service` EACCES 原文）。

### 8.2 逐项红→绿

| 项                           | 修复前（装置 / CI）                                                                              | 修复后（装置 + 真宿主）                                                                                       | 判别力证明                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| electron 装载簇              | 隐藏 `node_modules/electron/path.txt` 复跑真宿主全量：**42 文件红（40 个为此因）**；CI 注记 7 个 | 基座 `vitest.config.ts` 把 `electron` 别名到惰性替身 ⇒ 隐藏 path.txt 复跑 **0 红**，正常跑 **426 files 全绿** | 同一实验两次跑，仅别名有无不同                                                                 |
| N3 GPP + 通道编排            | `resolve-gameplayphotos` 装置 6 红（与 CI 逐字同）                                               | 装置 9/9 绿；真宿主 scanner+thumbnail 47 files 绿                                                             | 把 `joinUnder` 换回宿主 `path.join` ⇒ 装置复红（实测 6 红）                                    |
| N4 游戏目录发现              | 装置 29 红（21+ 断言类）                                                                         | 装置 48/48 绿；真宿主 scanner 42 files / 514 绿                                                               | `sed` 把 35 处 `joinUnder` 还原成 `path.join` ⇒ **装置 27 红**，还原 ⇒ 48 绿                   |
| N5 ffmpeg                    | 装置 3 红 = CI 注记 178/188/220                                                                  | 装置 19/19 绿；真宿主 19/19 绿                                                                                | 撤 SUT 平台门控 ⇒ `linux` 门控用例红                                                           |
| N6 资源授权表                | 装置 1 红 = CI 注记 54                                                                           | 装置 12/12 绿；真宿主 12/12 绿                                                                                | 删 `.toLowerCase()` 折叠 ⇒ 两侧各 1 红；把 win32 钉回宿主 ⇒ 装置 2 红                          |
| N6 连带：media-protocol      | 装置 2 红（403 vs 200，规则 0/4 归一与表不同形）                                                 | 装置 app 25 files / 431 绿；真宿主同绿                                                                        | 表折叠无条件化即是触发源；`allowExact` 夹具改为 win32 后原平台分支被删并加负例                 |
| N7 `isPathUnderDir` 平台开关 | — （同漏项，未红是运气）                                                                         | 装置 + 真宿主绿                                                                                               | 守卫 PINNED 档要求该文件无裸宿主 `path.*`                                                      |
| N8 log-service               | 装置 7 红 = CI 注记 `EACCES mkdir '/mock/userData/logs'`                                         | 装置 40/40 绿；真宿主 40/40 绿，且不再在盘根造 `\mock`                                                        | 注入落点改临时目录后由 EACCES 轴判定                                                           |
| N8 early-crash-guard         | 装置 1 红 = CI 注记 81/94（回落到 `/home/runner`、`/tmp`）                                       | 装置 18/18 绿；真宿主 18/18 绿                                                                                | 新增「documents 被同名文件占位 ⇒ 回落 homedir」可移植用例                                      |
| N9 shareCardParity           | CI 注记 `expected c4f076d9… to be 6dea2d2a…`                                                     | 装置 8/8 绿；真宿主 8/8 绿                                                                                    | 实测 LF 归一散列 == `git show HEAD:<fixture>` blob 散列 == CI 收到值；加「改一个字符即红」负例 |
| 守卫                         | —                                                                                                | `scripts/__tests__/path-semantics-guard.test.ts` 13 用例两侧绿                                                | 把 `resource-allowlist` 的 win32 钉撤掉 ⇒ 守卫「档 1」红；还原 ⇒ 绿                            |

### 8.3 收口读数（全部为本机实测，2026-10-20）

| 检查            | 命令                                                      | 读数                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真宿主全量      | `npx vitest run`                                          | **426 files / 6535 passed / 12 skipped，0 失败**                                                                                                                                                                                                                             |
| CI 语义全量     | `npm run test:ci-linux`                                   | 6487 passed / 53 failed，失败集中在 **10 个文件**，逐条按轴归因见 §8.3；CI 注记里的 22 个文件全部转绿                                                                                                                                                                        |
| 覆盖率门控      | `npm run test:coverage`                                   | 426 files / 6535 tests，**All files 69.31 / 60.56 / 61.81 / 70.92**（阈值 66/58/59/68，且高于 2026-10-14 基线 66.69/58.19/59.22/68.27）                                                                                                                                      |
| 类型            | `npm run typecheck`、`npm run typecheck:e2e`              | 均 0 错误                                                                                                                                                                                                                                                                    |
| 静态            | `npm run lint`                                            | **0 error**，11 warning 全是 DEBT-030 登记的存量 BOM 告警（`src/renderer/components/common/*.test.tsx`），本轮未新增                                                                                                                                                         |
| i18n            | `npm run i18n:guard`                                      | ✅ 白名单只减不增、清零必移除、key 已同步                                                                                                                                                                                                                                    |
| 文档链接        | `npm run docs:links`                                      | ✅ 无死引用（148 处提醒均为本机留存区/已交代去向路径）                                                                                                                                                                                                                       |
| 只读闸门        | `npm run verify`                                          | 5 项 0 失败（typecheck / lint / core-gate / format / test）；2 条 ⚠ 为「缺同名套件」提示：`vitest.config.ts`（配置无测试）与 `src/main/scanner/gameplayphotos-root.ts`（其测试在 `__tests__/` 下按函数命名，属存量口径，本轮另加 `scan-channels.win32-root.test.ts` 覆盖它） |
| electron 未装态 | 隐藏 `node_modules/electron/path.txt` 后 `npx vitest run` | 加别名前 **42 files 红**（40 个同一原因）→ 加别名后 **0 红**；`path.txt` 已原样恢复                                                                                                                                                                                          |

守卫判别力实测：把 `resource-allowlist.ts` 的 `const path = nodePath.win32` 撤成宿主绑定 ⇒
`path-semantics-guard` 的「档 1」立即红；还原 ⇒ 13 用例绿。把 `game-directory-discovery.ts`
的 35 处 `joinUnder` 还原成宿主 `path.join` ⇒ 装置下 27 个用例红、真宿主不受影响（这正是
「开发机看不见 CI 红灯」的原样），还原 ⇒ 48 绿。

CI 地面真相的取得方式（本轮不复述为「拿不到日志」）：`https://api.github.com/repositories/1286062066/actions/runs/39268051028/jobs`
列出 job，再对每个 job `https://api.github.com/repos/QianQianLuLu1/MeowStarMap/check-runs/{jobId}/annotations`
取失败注记（公开仓库免鉴权）。日志本体 `/actions/jobs/{id}/logs` 返回 403，但不影响结论；
注记每 check run 截断在 ~10 条这一事实，正是上一轮把 `game-directory-discovery` 误判为「待确认」的原因。

### 8.4 装置剩余红灯的逐文件归因（不接受整桶定性）

判据：每条必须点名是**哪一根宿主轴**让装置与 CI 分叉，并给出该轴在 CI 上的真实取值；
点名不出来的，一律按 CI 真红处理并修掉。

曾尝试再加一根「`child_process` 的 `options.cwd` 也翻译」的轴来消掉 `check-md-links.test.ts`
这一类假红，实测**净负收益**：它把 `fluent-ffmpeg-shim.test.ts`(4) 与
`generator.eftype.test.ts`(1) 由绿打红（注入的 `EFTYPE` spawn 错误被包装层换成 `ENOENT`），
为 1 个假红造出 2 个新假红 ⇒ 该轴已回退，`check-md-links` 回到下表按轴归因。
教训与仓内既有口径一致：装置的每一根轴都必须「只减假红、不增假红」，否则宁要一个可解释的红。

| 剩余红（装置）                                                                                        | 归因轴（装置 ≠ CI 的具体那条）                                                                                                                                                                                                                        | CI 判定与依据                                                                                              |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/main/utils/video-frame.test.ts`(6)                                                               | 第 4 轴失效：sharp/libvips 是原生库，`toFile()` 直接开真实文件句柄，不经过被 mock 的 JS `fs`，装置的 `/tmp → 沙箱` 映射对它无效                                                                                                                       | 绿：CI 上 `/tmp` 是真目录，原生库与 JS 看到的是同一个文件系统                                              |
| `src/main/media-worker/worker-entry.test.ts`(5)                                                       | 该文件在 `vi.mock('fluent-ffmpeg')` 工厂内用 `require('fs')`/`require('path')` 真实写抽帧文件；`require` 不走 vitest 的 mock 注册表 ⇒ 写的是未翻译的真实 `/tmp/...`，而被测代码经 mock 读到的是沙箱路径，两侧不是同一个文件                           | 绿：CI 上 `require('fs')` 与 `import 'fs'` 是同一实现、同一路径语义                                        |
| `src/main/scanner/__tests__/scan-traverse-timeout.test.ts`(3)                                         | 该文件自带 `vi.mock('fs/promises', importOriginal 透传)`，优先级高于装置的装配 ⇒ 遍历拿到的是未翻译的 `/tmp/...`，真 IO 全部落空，慢遍历告警自然不产生                                                                                                | 绿：同上，CI 上不需要翻译层                                                                                |
| `src/main/sync/identity-service.test.ts`(2)                                                           | NTFS 无 POSIX 权限位：`statSync().mode & 0o777` 在 Windows 上恒为 0o666(438)，写不进 0o600(384)                                                                                                                                                       | 绿：CI 的 ext4 接受 `chmod 0o600`；且这些用例本就带 `it.skipIf(win32)`，只在 Linux 侧跑                    |
| `scripts/__tests__/find-related-tests.test.ts`(14)、`src/main/thumbnail/generator.limiter.test.ts`(1) | NTFS 命名限制：装置里 `mkdir 'D:\<repo>\C:\WINDOWS\temp\…'` 这种**目录名含反斜杠**的路径无法创建；Linux 上反斜杠是合法文件名字符，同一条 mkdir 成功                                                                                                   | 绿：CI 上 `os.tmpdir()`/`process.env.TEMP` 是真 posix 路径，根本不产生这种串                               |
| `scripts/__tests__/check-md-links.test.ts`(2)                                                         | 第 3 轴的下游：`ROOT` 经轴 4e 变成 `/home/runner/work/NikkiGallery/NikkiGallery`，而 `execFileSync('git', …, {cwd: ROOT})` 的 cwd **不经任何翻译**，Windows 上目录不存在 ⇒ `spawnSync git ENOENT`（本机实测：给 `spawnSync` 一个不存在 cwd 即报此错） | 绿：CI 上该 cwd 就是真工作区                                                                               |
| `src/main/nikkisync/{runtime-facade,sync-server,metadata-resolver}.linked.test.ts`                    | 机器状态轴：本机跑过 `npm run link:nikkisync`（junction 存在），CI 没有——`@nikkisync/*` 不是声明依赖，`npm ci` 造不出这些链接；且上游用 better-sqlite3 原生开库，第 4 轴对其无效                                                                      | skip：CI 上 `hasNikkiSyncLink()` 为假 ⇒ 整件 skip（仓内既定口径：未链接是受支持的默认态，skip 不等于跑过） |

**结论**：装置剩余 10 个红灯全部落在「装置无法表达 CI 的那一侧」的三类硬限制上
（原生库与子进程绕过被 mock 的 JS 层、NTFS 与 ext4 的命名/权限差异、本机链接态），
无一是 CI 真红；CI 注记里出现过的 22 个文件在装置下已全绿。
