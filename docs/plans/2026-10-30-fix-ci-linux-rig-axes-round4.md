# 2026-10-30 补齐 CI 宿主模拟装置的缺失轴（第四轮：os / child_process / node:sqlite / sharp 装载时机）

> 本轮不推送、不建 PR、不发版、不改 `.github/workflows/build.yml`、**零新增依赖**、不动 `src/main/**` 产品代码。
> 上一轮：`docs/plans/2026-10-20-fix-ci-selfcheck-host-constant-round3.md`（自检哨兵的宿主常量问题）、`docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md`（路径语义三分法）。

## 0. 地面真相：本轮的读数是自己在开发机上跑出来的

| 命令                                   | 实测读数（2026-10-30 本机）                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `npm test`（真宿主 win32）             | **全绿** 454 files / 7094 passed / 12 skipped                                  |
| `npm run typecheck`                    | **全绿** exit 0                                                                |
| `npm run test:ci-linux`                | **32 files / 59 tests 红**，exit 1（454 files 收集，6926 passed / 61 skipped） |
| `git status --porcelain`               | 空（开工前工作区干净）                                                         |
| `node -e readdirSync('D:/tmp').length` | **190**，其中 `wxnn-media-worker-test-*` 60 个、`nikkisync-*` 23 个            |

`test:ci-linux` 是**只在开发机跑、不进 CI** 的诊断装置：`vitest.ci-linux.config.ts` 从 `vitest.config.ts` 派生（剔掉 coverage 块）并追加 `tests/ci-linux.setup.ts`。真宿主全绿 + 装置红 ⇒ 分歧点要么在产品代码的宿主假设（那 CI 也会红），要么在装置自身的失真。逐簇取证后，本轮 59 盏**全部**属于后者：装置的轴覆盖不全，或测试写法把「宿主取值」当常量。

判据沿用 `docs/CODING_CONVENTIONS.md` §6：**不得用 `it.skip` / 放宽断言 / 调低阈值让装置变绿**；每根新增装置轴必须在 `src/main/utils/ci-linux-emulation.test.ts` 留下可判定自检断言，否则装置退化会变成静默假信号。

## 1. 根因表（红数可加总回 59）

| #    | 红数                         | 现象                                                                                                                | 真实原因（已取证）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 节点 |
| ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| RC-1 | 16                           | `ENOENT mkdir 'D:\…\WXNN XiangCe\C:\WINDOWS\temp\find-related-tests-…\src\main\app'`                                | 轴 3 靠就地改 `os` 对象（`tests/ci-linux.setup.ts:54`），而具名/命名空间导入（`import { tmpdir } from 'node:os'`，见 `scripts/__tests__/find-related-tests.test.ts:2-4,21`、`scripts/__tests__/pre-dist-check.test.ts:3-4,360`）拿到的是 interop 快照，不受改写影响；装置又删了 `TEMP`/`TMP` ⇒ 真 `os.tmpdir()` 回落到字面量 `C:\WINDOWS\temp`。该 Windows 形态串交给 posix 绑定的 `resolve`/`isAbsolute` 后被当相对名拼到模拟仓库根之后，再经 `toReal` 的 CI_ROOT 分支落到真仓库根。反证：自检文件用 default 导入，其 `expect(os.tmpdir()).toBe('/tmp')` 是绿的                                                                       | N1   |
| RC-2 | 6 + 约 13 文件整文件装载失败 | `Could not load the "sharp" module using the linuxnull-x64 runtime`                                                 | `node_modules/sharp/dist/libvips.cjs:40-41` 用 `` `${process.platform}${runtimeLibc()}-${process.arch}` ``；轴 2 把 platform 改成 `linux` ⇒ `detect-libc.isNonGlibcLinuxSync()` 为真，但 `familySync()` 在 Windows 上四个探针全失败返回 **`null`**，模板把 `null` 拼进串 ⇒ `linuxnull-x64`。本机只有 `@img/sharp-win32-x64`。波及 `scripts/__tests__/app-icon.test.ts`（6 处 `await import('../generate-icon.js')`，其 `:3` 静态 `import sharp`）与 `phash / video-frame / bktree-index / ipc/handlers/cache / scanner/__tests__/scan-*`（链：`src/main/scanner/worker-entry.ts:53` → `src/main/services/xmp-metadata-service.ts:28`） | N2   |
| RC-3 | 3                            | `Error: spawnSync git ENOENT`                                                                                       | `scripts/check-md-links.ts:351` `execFileSync('git', …, { cwd: ROOT })`，`ROOT` 是装置形态 `/home/runner/work/…`，`child_process` **不在任何轴覆盖内**，Windows 上该目录不存在。`source-encoding.test.ts` 经同一 `gitLines` 中招                                                                                                                                                                                                                                                                                                                                                                                                       | N3   |
| RC-4 | 2                            | `expected 438 to be 384`                                                                                            | `src/main/sync/identity-service.test.ts:126`、`:188` 拿 `it.skipIf(process.platform === 'win32')` 当门；轴 2 把门打开，而文件真身在 **NTFS**（无 POSIX mode 位）。判据写错了：应是「chmod 落不落得住」                                                                                                                                                                                                                                                                                                                                                                                                                                 | N4   |
| RC-5 | 2                            | `expected 'D:\Win\Microsoft…\csc.exe' to be 'D:\Win/Microsoft…/csc.exe'`                                            | `scripts/__tests__/build-recycle-helper.test.ts:12` 的期望值用被 mock 成 posix 的 `path` 拼；被测 `scripts/build-recycle-helper.cjs:18` 经 `createRequire` 装载，拿的是真 win32 `path`。§6 明文要求期望值与被测代码**同一绑定**                                                                                                                                                                                                                                                                                                                                                                                                        | N5   |
| RC-6 | 25                           | `Error: unable to open database file`                                                                               | 上游 `../NikkiSync/packages/database` 走 `await import('node:sqlite')` + `new SqliteDatabase(filename)`（`runtime-facade.ts:668` 传入），路径是装置形态 `/tmp/nikkisync-sync-…/x/nikkisync.db`。实测 `node:sqlite` 能开 `/tmp/x.db`（按盘相对解析成 `D:\tmp\x.db`），失败在**父目录只存在于沙箱里** ⇒ 原生句柄不吃 `fs` 翻译层。波及 `sync-server.linked`(13) / `runtime-facade.linked`(11) / `metadata-resolver.linked`(1)                                                                                                                                                                                                            | N6   |
| RC-7 | 5                            | `expected 'null' to match /\.jpg$/`、`expected [ +0, 1, 3 ] to deeply equal [ +0, 1 ]`、`expected true to be false` | `src/main/media-worker/worker-entry.test.ts:123-124`：fluent-ffmpeg 的 mock 内部用 `require('fs')`/`require('path')`（原生 require 绕过 `vi.mock`），抽帧临时文件被写到 `D:\tmp\wxnn-media-worker-test-…\thumbs\`；被测代码经 mocked `fs` 校验 ⇒ 沙箱里没有 ⇒ 判失败 ⇒ 多一次 seek ⇒ 最终 `null`。磁盘证据：`D:\tmp` 60 个 `wxnn-media-worker-test-*`，沙箱 `%TEMP%\wxnn-ci-linux\tmp` 里 0 个                                                                                                                                                                                                                                         | N7   |

## 2. 启动 / 环境准备

1. 前置只读检查：`npm run link:nikkisync:check`（`node_modules/@nikkisync/*` 四个 junction 必须在位，它们是链到 `../NikkiSync` 的软链、不在 deps 声明里，缺席会把 N6 的三套 linked 套件变成 skip 假绿）；`npm run doctor`（sharp / DLL / db 健康探针）。
2. 单簇红灯复现模板：`npx vitest run --config vitest.ci-linux.config.ts <路径>`
3. 全量装置读数：`npm run test:ci-linux`
4. 泄漏检测器（抓任何轴的绕过）：`node -e "console.log(require('fs').readdirSync('D:/tmp').length)"`，基线 190；以及 `C:/WINDOWS/temp` 条目数。

## 3. 参数校验约定（新增 mock 工厂的入参契约）

新增工厂（`ciLinuxOsHost` / `ciLinuxChildProcessHost` / `ciLinuxSqliteHost`）与既有 `ciLinuxFsHost` 同构：

- **非字符串一律原样透传**：沿用 `toReal` 的 `typeof value !== 'string'` 短路（`tests/mocks/ci-linux-fs.ts:51`），Buffer / URL / fd 数字不得当路径翻。
- **只有登记过的参数位才是路径**：沿用 `PATH_ARG_INDEX` 显式表（默认只翻第 0 位）。`execFileSync(file, args, options)` 的 `args` 不得逐位当路径翻（否则 `-c core.quotepath=false` 被搅）；`options.cwd` 走既有 `'cwd' in arg` 分支。
- **边界值**：`':memory:'`、`'/dev/null'`（→ 真宿主 `nul`）、相对 specifier（`fork('./worker.js')`）语义不变；`ciLinuxOsOverrides()` 在 marker 缺席时**必须返回 `{}`**——这是「CI 零变化」的机制保证而非注释承诺。
- **非法值**：不得静默兜底成真值；按既有做法让 `eacces`/原生错误可见。

## 4. 错误处理与兜底策略

- N2 预载失败必须响：`await import('sharp')` 裸放，失败即打死整个 profile，不 try/catch 吞掉（吞了就退回 13 个文件静默 collect 失败）。
- N6 设**探针闸门**：Gate A 未读出不许写轴代码；轴与夹具层适配器两条路都不许 skip。
- N1 的两个连带面必须显式处理：`tests/mocks/ci-linux-fs.ts:33`（沙箱基址）与 `:64`（`realOs.devNull`）在 `os` 被 mock 后会读到 `/tmp` ⇒ 改为由 setup 注入（复用 `setRealRoot` 样板）；`generator.limiter.test.ts:50` 自带 `vi.mock('os')` 会**遮蔽**新轴 ⇒ 必须与 `ciLinuxOsOverrides()` 组合。
- 装置新增轴只在 setup 头部注释交代 WHY（与现有七轴同风格），不引入运行时打印。

## 5. 节点分解

### N1 轴 3b：`os` 改走 `vi.mock`（RC-1，16 盏）

- 文件：`tests/mocks/ci-linux-os.ts`（新）、`tests/mocks/ci-linux-fs.ts`、`tests/ci-linux.setup.ts`、`src/main/thumbnail/generator.limiter.test.ts`、`src/main/utils/ci-linux-emulation.test.ts`（+3 例）、`scripts/__tests__/path-semantics-guard.test.ts`
- 红灯：`npx vitest run --config vitest.ci-linux.config.ts scripts/__tests__/find-related-tests.test.ts` ⇒ 14 failed
- 验收：find-related-tests `14→0`；`scripts/__tests__/pre-dist-check.test.ts` `1→0`；`src/main/thumbnail/generator.limiter.test.ts` `1→0`；丝线 `src/main/utils/startup-diagnostic.test.ts`、`src/main/sync/server/export-route.test.ts` 保持 0 failed；`D:/tmp` 与 `C:/WINDOWS/temp` 计数不增长
- CI 不受影响：轴只注册在 `tests/ci-linux.setup.ts`，它只出现在 `vitest.ci-linux.config.ts` 的 `setupFiles`（`vitest.config.ts:62` 仍是 `['./tests/setup.ts']`）
- 两个必须同时喂的守卫：`scripts/__tests__/path-semantics-guard.test.ts:197-207` 要求 setup 源含 `realOs.tmpdir = ` / `realOs.homedir = ` ⇒ 就地改写行**保留**（指向 `createRequire` 取到的真 `os`，它同时保护 `require('os')` 的外部消费者如 `src/main/services/log-service.ts:279`）；`scripts/__tests__/pack-identity-name.test.ts:241-251` 逐字钉每个 rig 文件里装置根字面量的**处数**（setup=2 / ci-linux-fs=2 / 自检=3）⇒ 新 mock 文件 `import { CI_TMP, CI_HOME } from './ci-linux-fs'`，自检新例从 `marker.root` 取根，不写字面量

### N2 轴 6：sharp 预载先于 `process.platform` 改写（RC-2）

- 文件：`tests/ci-linux.setup.ts`（+约 4 行，置于轴 2 的 `Object.defineProperty(process,'platform',…)` **之前**）、`src/main/utils/ci-linux-emulation.test.ts`（+1 例）、`scripts/__tests__/path-semantics-guard.test.ts`（+1 token）
- 做法：`await import('sharp')`。必须 ESM specifier（`sharp` 的 `exports` 里 import/require 是两个实例）；必须落 `setupFiles` 而非 `globalSetup`（`vitest.config.ts:61` 是 `pool: 'forks'`，每 fork 一份缓存）。纯 Node 已验证：改写前装载成功（libvips 8.18.7），改写后 `import('sharp')` 返回同一实例
- 不用惰性替身的原因：`src/main/utils/video-frame.test.ts` 明确要**真 sharp** 造素材
- 验收：`scripts/__tests__/app-icon.test.ts` `6→0`；`video-frame / phash / bktree-index / cache` 与 `src/main/scanner/__tests__` 从 collect 失败变真实计数；**随后重跑全量并重记读数**（新收集上来的文件若带出新红，属装置变准，按轴逐条归因后继续）

### N3 轴 8：`vi.mock('child_process')` 翻译 `cwd`（RC-3）

- 文件：`tests/mocks/ci-linux-child-process.ts`（新）、`tests/ci-linux.setup.ts`、`src/main/utils/ci-linux-emulation.test.ts`（+1 例）、`scripts/__tests__/path-semantics-guard.test.ts`（+1 token）
- 做法：覆盖 `execFileSync/execSync/spawnSync/fork/spawn/execFile/exec`（含 promises 侧）；第 0 位与 `options.cwd` 过 `toReal`，**`env` 一律不翻**；复用 `mapArgumentsForOp` 语义与「按真实对象记忆」的 wrapCache 保 `cp.promises` 同一性
- 验收：`check-md-links.test.ts` `2→0`；`source-encoding.test.ts` `1→0`；`scripts/__tests__/core-path-gate.test.ts` 保持 0 failed

### N4 能力探针取代平台开关（RC-4）

- 文件：`src/main/sync/identity-service.test.ts`（复用已有 `makeDirectory()` 与 `afterEach`）
- 做法：`posixModeBitsAreMeaningful()`（写探针文件 → `chmodSync(0o600)` → `statSync` 验模式位），门改 `it.skipIf(!POSIX_MODE)`，断言体逐字不动。ext4 CI 上照样**跑**，只在语义不存在的文件系统上跳
- 同步：`scripts/__tests__/path-semantics-guard.test.ts` 里 `src/main/sync/identity-service.ts` 的 `HOST_IO` 理由串（原写「含 `it.skipIf(win32)` 的真实文件系统用例」）改为能力门控措辞
- 验收：装置 `2→0` 且这两例读作 skipped；`npx vitest run src/main/sync/identity-service.test.ts` 与基线一致。本节点不加轴 ⇒ 无自检例

### N5 期望值改用被测代码同一 `path` 绑定（RC-5）

- 文件：`scripts/__tests__/build-recycle-helper.test.ts`（约 3 行）：`const helperPath = require_('node:path')`，两处期望（`:62`、`:148`）用它拼
- 陷阱：**不许**改钉 `path.win32.join`——`resolveCscPath` 用宿主绑定，Linux CI 上它给出 `D:\Win/Microsoft…/csc.exe`，钉 win32 会把现在绿的 CI 判红
- 验收：装置 `2→0`；`npx vitest run scripts/__tests__/build-recycle-helper.test.ts` 保持 0 failed；`npm run typecheck` 绿

### N6 轴 7：`vi.mock('node:sqlite')`（RC-6，**探针先行**）

- Gate A（动手前必做，临时代码不落库）：在 setup 里临时注册会大声失败的哨兵 `class Sentinel extends actual.DatabaseSync { constructor(loc){ throw new Error('__SQLITE_MOCK_HIT__ ' + loc) } }`，跑 `npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync/runtime-facade.linked.test.ts`。打出 `__SQLITE_MOCK_HIT__ /tmp/…` ⇒ 上游包在 vitest 图里、变量式 specifier 被接管 ⇒ 走轴；仍是 `unable to open database file` ⇒ 被外部化 ⇒ 走兜底。**注意**上游 `dist/src/*.js.map` 带 `sourceMappingURL`，栈帧显示 `.ts` 不构成「在图里」的证据
- 首选设计：`tests/mocks/ci-linux-sqlite.ts`（新）导出 `ciLinuxSqliteHost`，`class CiLinuxDatabaseSync extends RealDatabaseSync { constructor(location, options){ super(toReal(location), options) } }`；`StatementSync/constants/backup` 原样透传；用 `extends` 保 `instanceof`；只注册 `node:sqlite`（`bun:sqlite` 上游不可达）
- 兜底：`rigSqlitePath(p)`（marker 缺席即恒等）只套在每个 linked 文件的 `mkdtemp` 结果那一行（`sync-server.linked.test.ts:260`、`runtime-facade.linked.test.ts:70` 及其 `:485`、`metadata-resolver.linked.test.ts:115`），一次覆盖所有派生库路径；必须在 `tests/ci-linux.setup.ts` 的「已知失真」头标明「sqlite 路径由夹具层翻译，不是宿主轴」。**不许**：把沙箱搬到盘根、把这三套 skip
- 自检例（把 Gate A 结论永久化）：逐字复刻上游装载序列 `const specifier = process.versions.bun ? 'bun:sqlite' : 'node:sqlite'` → `await import(specifier)` → 在 `mkdtemp` 目录建库 `CREATE TABLE` → 再开 `':memory:'` → close → `rmSync`
- 验收：`25→0`；`npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync` 的 **skipped 必须为 0**（非 0 ⇒ junction 没了，是假绿）；`D:/tmp` 不增长

### N7 测试本地修：mock 里的原生 `require` 逃逸（RC-7）

- 文件：`src/main/media-worker/worker-entry.test.ts`（2 行）：删 `:123-124` 的 `require('fs')` / `require('path')`，让 fluent-ffmpeg mock 用文件顶层 `import fs from 'fs'` / `import path from 'path'`（同文件 sharp mock 已是这个写法，属复用）
- 先确认再改：改前后各读 `D:/tmp` 的 `wxnn-media-worker-*` 计数——跑一次装置应 +1 目录（内含 `.jpg.tmp-*`），修后不再增长
- 验收：`5→0`；`npx vitest run src/main/media-worker/worker-entry.test.ts` 保持 0 failed。CI 不受影响：Linux 上顶层 `import fs from 'fs'` 就是真 posix fs

## 6. 基础测试用例（正常 / 异常 / 边界）

| 类别 | 用例                                  | 判据                                                                                                                                                                                                                                |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常 | 轴 3b 具名与命名空间 `os` 取值        | `osTmpdirNamed()==='/tmp'`、`osNs.homedir()==='/home/runner'`、`osNs.EOL==='\n'`、`osNs.userInfo().homedir==='/home/runner'`、且 `osTmpdirNamed()===os.tmpdir()`（「所有导入形态一致」才是真坏掉的那条不变量）                      |
| 正常 | 轴 6 装置态真 sharp 可用              | `sharp.versions.vips` 形如 `x.y.z`；`sharp({create:…}).jpeg().toBuffer()` 前两字节 `0xff 0xd8`（per-fork 自然成立）                                                                                                                 |
| 正常 | 轴 8 `child_process` 的 cwd 被翻译    | `git rev-parse --show-toplevel` == `marker.cwd`（归一后）——一条断言同时证明「不 ENOENT」与「落在真仓库」                                                                                                                            |
| 正常 | 轴 7 变量式 specifier 也被接管        | 上游同形 `await import(specifier)` 建库 + `CREATE TABLE` 成功                                                                                                                                                                       |
| 异常 | 沙箱基址不得被 `os` mock 搬走         | `marker.sandbox === path.win32.join(真宿主 os.tmpdir(),'wxnn-ci-linux')`；`path-semantics-guard` 仍要求 `realOs.tmpdir = ` / `realOs.homedir = `，并新增 `vi.mock('os'` / `vi.mock('child_process'` / `vi.mock('node:sqlite'` token |
| 异常 | 自带 `vi.mock('os')` 的测试不许遮蔽轴 | `RIG_COMPOSING_OS_TESTS` 登记表：`generator.limiter.test.ts` 必须同时含 `vi.mock('os'` 与 `ciLinuxOsOverrides`                                                                                                                      |
| 异常 | 装置根字面量不得散落                  | `pack-identity-name.test.ts` 的逐文件处数计数（改动后如处数变化必须同步该表）                                                                                                                                                       |
| 边界 | `/dev/null` 经装置落本机 `nul`        | `fs.existsSync('/dev/null')===true`                                                                                                                                                                                                 |
| 边界 | `':memory:'` 与普通 Windows 串恒等    | `new DatabaseSync(':memory:')` 可 `exec('SELECT 1')` 并可 close                                                                                                                                                                     |
| 边界 | 非路径参数不被翻译                    | `execFileSync('git',['-c','core.quotepath=false',…])` 的 `args` 原样、`env.PATH` 保持真宿主                                                                                                                                         |

## 7. 回归与收尾闸门（顺序不可缩短）

1. 各节点局部验收命令。
2. `npm run test:ci-linux` 全量：**目标 0 failed**；文件总数应因 N2 新收集上来的文件而上升（朝 454 靠）。
3. 泄漏检测：`D:/tmp` 与 `C:/WINDOWS/temp` 条目数必须与 §2 基线一致。
4. `npm test` 逐字回 `454 files / 7094 passed / 12 skipped`（有 delta ⇒ 装置改动漏进了普通 profile）。
5. `npm run typecheck`、`npm run typecheck:e2e`、`npm run lint`（`tests/**` 不在任何 tsc project 里，**只有 eslint 真正检查它**）、`npm run i18n:guard`、`npx prettier --check --end-of-line auto` 覆盖新/改文件（UTF-8 无 BOM，禁用 PowerShell `Set-Content` 回写）。
6. `npm run verify` 后逐节点提交（Conventional Commits）。
7. 用户点名的五闸门，按序插入 link 复位防假绿：`link:nikkisync:check`（install 前真相）→ **`npm install`** → `link:nikkisync` → `verify:nikkisync` → `doctor` → **`npm run build`** → **`npm run test`** → **`npm run typecheck`** → **`npm run e2e:smoke`**。`npm install` 之后立即补跑一次 `npx vitest run --config vitest.ci-linux.config.ts src/main/nikkisync` 读 skipped 列；若非 0，N6 记「未验证」而不是绿。

## 8. 明确不做

- 不改 `package.json` 依赖、不动 `node_modules`、不给 sharp 做惰性替身。
- 不加 `it.skip` / `it.skipIf(平台)`、不放宽断言、不动覆盖率阈值。
- 不动产品代码 `src/main/**`。
- 不动 `tests/mocks/posix-host-path.ts` 与 `tests/posix-host.setup.ts` 的契约（姊妹装置 `test:posix-host` 刻意只开一根轴，必须保持可跑）。
- 不把沙箱搬到盘根去「迁就」原生模块。
