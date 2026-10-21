/**
 * POSIX 宿主（**不带装置**）最小复现 setup —— 只在开发机跑，**不进 CI**。
 *
 * 用法：`npm run test:posix-host -- <路径过滤>`
 *
 * 为什么需要它：CI 的 test / coverage 跑在 ubuntu-latest 上，而开发机是 Windows。开发机上
 * 「宿主 = win32」会让一切「拿宿主平台取值当常量」的断言天然成立，只有推到 CI 才红
 * （run 39440507242 的 `ci-linux-emulation.test.ts:138` 就是这么红的）。
 *
 * 与 `tests/ci-linux.setup.ts` 的分工（**不要合并，也不要互相替代**）：
 * - `ci-linux.setup.ts` = 「CI 宿主 + 装置激活」：七轴全开，并写 `globalThis.__wxnnCiLinuxEmulation`
 *   ⇒ 用来验证「装置轴用例本身还成立」。
 * - 本文件 = 「POSIX 宿主 + 装置**未激活**」：**只开一根轴**（`path` / `node:path` 宿主绑定 → posix），
 *   不写 marker、不改 `process.platform` / `cwd` / `homedir` / `tmpdir`、不 mock `fs` / `url`
 *   ⇒ 用来复现 CI 上「装置没开 + 宿主是 POSIX」这一组合。
 *
 * 只开一根轴是有意的：CI 红的充要条件是「ACTIVE === false 且 path.sep !== path.win32.sep」，
 * 前者的真相源是 marker（本文件不写它），后者的两个形态由 `posixHost` 工厂注入。
 * 多开任何一轴都会把「装置未激活」变成「装置部分激活」，反而复现不出来。
 *
 * 已知失真：本机真 fs 是 NTFS、真 platform 仍是 win32，故本 profile **只用于**跑
 * 「判据落在 path 绑定上」的用例（当前即装置自检文件），全量跑没有意义（真 IO 与 posix 串
 * 会互相打架，那正是 `ci-linux.setup.ts` 用 fs 翻译层解决的问题）。
 */
import { vi } from 'vitest'

// ---------- 唯一一根轴：path 宿主绑定 → posix ----------
// `vi.mock` 会被 vitest 提到文件最顶部：工厂里引用**顶层 import 绑定**会撞上未初始化 TDZ，
// 所以共享实现改为工厂内动态 import（同轴 1 在 ci-linux.setup.ts 里的写法）。
vi.mock('path', async (importOriginal) => {
  const { posixHost } = await import('./mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
vi.mock('node:path', async (importOriginal) => {
  const { posixHost } = await import('./mocks/posix-host-path')
  return posixHost(importOriginal as () => Promise<unknown>)
})
