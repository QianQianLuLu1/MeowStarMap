/**
 * CI（ubuntu-latest）宿主模拟装置 —— 只在开发机跑，**不进 CI**。
 *
 * 用法：`npm run test:ci-linux`（或 `npx vitest run --config vitest.ci-linux.config.ts <路径>`）
 *
 * 为什么需要它：产品只发布 Windows x64，CI 却在 Linux 上跑单测；开发机上「宿主 = win32」
 * 让路径语义分叉天然不可见，只有推到 CI 才红。本装置补齐 CI 的**宿主身份**，让开发机能
 * 自己复现并验证 CI 红灯。判据（详见 docs/plans/2026-10-20-fix-ci-linux-path-semantics-round2.md）：
 * **装置必须能复现 CI 失败注记里的每一处红**；复现不出来的，是装置不合格，先修装置。
 *
 * 模拟的轴：
 * 1. `path` / `node:path` 宿主绑定 → posix（工厂见 `./mocks/posix-host-path`）
 * 2. `process.platform` → `'linux'`，`os.EOL` → `'\n'`
 * 3. `process.cwd()` / `os.homedir()` / `os.tmpdir()` / `os.userInfo().homedir` → CI 上的真实形态
 * 3b. `os` / `node:os` → `vi.mock`（工厂见 `./mocks/ci-linux-os`）：轴 3 的就地改写只治得到
 *     default 导入，具名与命名空间导入拿的是 interop 快照 ⇒ 只有 mock 才能对所有形态成立
 * 4. `fs` / `fs/promises`：posix 假路径双向翻译到本机真实目录 + 复刻容器 `/` 不可写
 *    （实现见 `./mocks/ci-linux-fs`；必须走 `vi.mock`，就地改 `fs` 对象会被 vitest 的
 *    interop Proxy 绕过）
 * 4e. `url`：`fileURLToPath` 返回 CI 工作区形态、`pathToFileURL` 收装置形态
 *    （否则 `import.meta.url` 派生的仓库根会以反斜杠形态混进 posix 绑定，造出 CI 上不存在的串）
 * 5. `electron`：与基座 `vitest.config.ts` 一致，走 `tests/mocks/electron-inert.ts` 惰性替身。
 *    （装置曾把它指向必抛错的壳来复刻 CI；基座加了别名之后 CI 也不再加载真 electron，
 *    于是这一轴改为「与基座同形」，由自检用例断言替身确实生效。）
 * 6. 原生绑定装载时机：`sharp` 在轴 2 改写 `process.platform` **之前**预载，
 *    装置里用的是真 sharp 而不是惰性替身（`video-frame.test.ts` 要真 sharp 造素材）。
 * 8. `child_process` / `node:child_process`：第 0 位（program/file）与 `options.cwd` 走轴 4 的
 *    `toReal`（工厂见 `./mocks/ci-linux-child-process`）——轴 4 只管 `fs`，而子进程的 cwd 由 OS
 *    解析，装置形态的仓库根在 Windows 上并不存在 ⇒ `spawnSync git ENOENT`。
 *
 * 已知失真（读结果时必须知道，逐文件归因就按这些轴点名）：
 * - **裸 `__dirname`** 无法改写（vitest 注入的是真实文件位置）；经 `fileURLToPath(import.meta.url)`
 *   取根的已被 4e 治好。凡失败点确实来自裸 `__dirname` 的文件，装置结论不可直接采信。
 * - 本机文件系统是 NTFS：`C:\a\b` 这类**含反斜杠的文件名**在 Linux 上是合法文件名字符，
 *   在 Windows 上不能创建 ⇒ 「拿非法名去 mkdir」的用例只在装置红、CI 绿。
 * - 大小写不敏感、junction/symlink 语义与 ext4 不同。
 * - 外置 CJS 依赖内部的 `require('fs')` 不经过第 4 轴（只有测试图里的 import 被 mock）。
 */
import realFs from 'fs'
import { createRequire } from 'module'
import { vi } from 'vitest'
import { ensureSandbox, realSandbox, setHostPaths, setRealRoot } from './mocks/ci-linux-fs'

/**
 * 真 `os` 模块：必须经 `createRequire` 取，不能 `import 'os'`——本文件的 `vi.mock('os')` 会被
 * vitest 提到顶部，import 拿到的就是被 mock 的形态，轴 3 的就地改写会落在 mock 对象上，
 * 原生 `require('os')` 那条逃逸路径（`vi.mock` 拦不到）因此失去覆盖。
 */
const realOs = createRequire(import.meta.url)('os') as typeof import('os')

/**
 * 本机真实仓库根：**只能**取自 `process.cwd()` 原样字符串。
 * 不要经 `path.resolve('.')`：本 setup 里 `path` 已被轴 1 换成 posix，posix 归一会把
 * Windows 路径按 `/` 切段，把带空格/中文的目录名截断成 `D:\Zcode项目` 这种半截根，
 * 于是所有「读仓库文件」的用例都撞进错目录（实测踩过一次）。
 * 也不要用 `fileURLToPath(import.meta.url)`：jsdom project 里它不是 file: scheme，会当场抛错。
 */
const realCwd = process.cwd()
setRealRoot(realCwd)

/**
 * 沙箱基址与 null 设备：必须在改写 `os` 与删环境变量**之前**从真 `os` 取。
 * 取晚了会拿到装置形态的 `/tmp`，沙箱就被 `WIN32.join('/tmp', …)` 搬到盘根去。
 */
const hostTmp = realOs.tmpdir()
setHostPaths({ tmp: hostTmp, devNull: realOs.devNull })

// ---------- 轴 6：原生绑定的装载时机（必须在轴 2 改写 platform 之前） ----------
/**
 * sharp 的原生运行时 id 是在**首次装载**时算出来的：
 * `node_modules/sharp/dist/libvips.cjs:40-41` 用 `${process.platform}${runtimeLibc()}-${arch}`，
 * 而 `runtimeLibc()` 走 detect-libc——轴 2 把 platform 改成 'linux' 之后 `isNonGlibcLinuxSync()`
 * 为真，但 `familySync()` 在 Windows 上四个探针全失败返回 null，模板把 null 拼进串里
 * ⇒ `linuxnull-x64`，装载当场抛错，凡 import 到 sharp 的测试文件整文件收集失败。
 * 真 CI（ubuntu）装载的是真 linux 绑定，所以装置的忠实做法是「让装载发生在改写之前」，
 * 用**真 sharp**（`src/main/utils/video-frame.test.ts` 明确要真 sharp 造素材，惰性替身会打死它）。
 *
 * 必须是 `await import('sharp')`：sharp 的 exports 里 import/require 是两个不同实例，
 * createRequire 预热的是错的那一份。必须在 setupFiles 而非 globalSetup：
 * `pool: 'forks'`（vitest.config.ts:61）意味着每 fork 一份模块缓存，globalSetup 只在父进程跑一次。
 * 不 try/catch：预载失败就该打死整个 profile，而不是退回「一片文件静默 collect 失败」。
 */
await import('sharp')

// ---------- 轴 2 / 3：宿主身份 ----------
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
Object.defineProperty(realOs, 'EOL', { value: '\n', configurable: true })
Object.defineProperty(process, 'cwd', {
  value: () => '/home/runner/work/MeowStarMap/MeowStarMap',
  configurable: true
})
realOs.tmpdir = () => '/tmp'
realOs.homedir = () => '/home/runner'
const realUserInfo = realOs.userInfo.bind(realOs)
realOs.userInfo = ((options?: { encoding?: 'buffer' }) => ({
  ...realUserInfo(options as never),
  homedir: '/home/runner'
})) as typeof realOs.userInfo
// CI 上没有这些 Windows 环境变量；测试自己显式 set 的不受影响
for (const key of [
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'ProgramFiles(x86)',
  'USERPROFILE',
  'SystemDrive',
  'TEMP',
  'TMP'
]) {
  delete process.env[key]
}
process.env.HOME = '/home/runner'
process.env.USER = 'runner'

// 沙箱要在替换 fs 实现之前用真 fs 建好
ensureSandbox((p, o) => realFs.mkdirSync(p, o))

// ---------- 轴 1：path 绑定 ----------
// `vi.mock` 会被 vitest 提到文件最顶部：工厂里引用**顶层 import 绑定**会撞上未初始化TDZ，
// 所以共享实现改为工厂内动态 import。
vi.mock('path', async (importOriginal) => {
  const { posixHost } = await import('./mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:path', async (importOriginal) => {
  const { posixHost } = await import('./mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})

// ---------- 轴 3b：os 的具名/命名空间导入形态 ----------
// 轴 3 的就地改写只覆盖 default 导入；工厂同轴 1 走动态 import（被提升的 vi.mock 不能引用顶层绑定）
vi.mock('os', async (importOriginal) => {
  const { ciLinuxOsHost } = await import('./mocks/ci-linux-os')
  return ciLinuxOsHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:os', async (importOriginal) => {
  const { ciLinuxOsHost } = await import('./mocks/ci-linux-os')
  return ciLinuxOsHost(importOriginal as () => Promise<unknown>)
})

// ---------- 轴 4：文件系统翻译 + 容器根不可写 ----------
// 工厂必须逐条内联（同轴 1：被提升的 vi.mock 不能引用顶层绑定；写成循环也不会按预期展开）
vi.mock('fs', async (importOriginal) => {
  const { ciLinuxFsHost } = await import('./mocks/ci-linux-fs')
  return ciLinuxFsHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:fs', async (importOriginal) => {
  const { ciLinuxFsHost } = await import('./mocks/ci-linux-fs')
  return ciLinuxFsHost(importOriginal as () => Promise<unknown>)
})
vi.mock('fs/promises', async (importOriginal) => {
  const { ciLinuxFsHost } = await import('./mocks/ci-linux-fs')
  return ciLinuxFsHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const { ciLinuxFsHost } = await import('./mocks/ci-linux-fs')
  return ciLinuxFsHost(importOriginal as () => Promise<unknown>)
})

// ---------- 轴 4e：url —— 让 fileURLToPath 说出 CI 的方言 ----------
// 不翻译它，`__dirname`/`import.meta.url` 这类模块级真实位置会以反斜杠形态混进 posix 绑定，
// 造出 CI 上不存在的串（成片假红）。翻译之后仓库根就是 CI 工作区形态。
vi.mock('url', async (importOriginal) => {
  const { ciLinuxUrlHost } = await import('./mocks/ci-linux-fs')
  return ciLinuxUrlHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:url', async (importOriginal) => {
  const { ciLinuxUrlHost } = await import('./mocks/ci-linux-fs')
  return ciLinuxUrlHost(importOriginal as () => Promise<unknown>)
})

// ---------- 轴 8：child_process —— 子进程的路径参数（cwd 与 program）也要翻译 ----------
// 工厂逐条内联（同轴 1：被提升的 vi.mock 不能引用顶层绑定）
vi.mock('child_process', async (importOriginal) => {
  const { ciLinuxChildProcessHost } = await import('./mocks/ci-linux-child-process')
  return ciLinuxChildProcessHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:child_process', async (importOriginal) => {
  const { ciLinuxChildProcessHost } = await import('./mocks/ci-linux-child-process')
  return ciLinuxChildProcessHost(importOriginal as () => Promise<unknown>)
})

// 供装置自检用例（src/main/utils/ci-linux-emulation.test.ts）判定本轮是否真在模拟态下运行
;(globalThis as Record<string, unknown>).__wxnnCiLinuxEmulation = {
  cwd: realCwd,
  root: '/home/runner/work/MeowStarMap/MeowStarMap',
  // 沙箱落点与它的宿主基址：自检用例据此判「os 被 mock 之后沙箱没被搬到盘根」
  sandbox: realSandbox(),
  hostTmp
}
