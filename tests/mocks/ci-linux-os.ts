/**
 * CI 装置的 `os` 轴：把 `os` 的宿主取值换成 CI 形态，且对**所有导入形态**生效。
 *
 * 为什么必须走 `vi.mock` 而不能只就地改真 `os` 对象：vitest 给外部模块套一层 interop 代理，
 * 具名导入（`import { tmpdir } from 'node:os'`，如 `scripts/__tests__/find-related-tests.test.ts`）
 * 与命名空间导入（`import * as os from 'node:os'`，如 `scripts/__tests__/pre-dist-check.test.ts`）
 * 拿到的是**首次装载时的快照**，`realOs.tmpdir = () => '/tmp'` 改不到它们（与
 * `tests/mocks/ci-linux-fs.ts` 头注里记过的 fs 教训同源）。而装置又必须删掉 `TEMP`/`TMP`
 * 以复刻 CI 的环境 ⇒ 那些快照读到的真 `os.tmpdir()` 会回落到 Node 在 Windows 上的兜底字面量
 * `C:\WINDOWS\temp`，于是 Windows 形态串混进 posix 绑定，造出 CI 上不存在的拼接结果。
 *
 * 就地改写那一层**仍然保留**（在 setup 里）：它护的是原生 `require('os')` 这条 `vi.mock`
 * 拦不到的逃逸路径。两层合起来才覆盖全部消费形态。
 */
import { CI_HOME, CI_TMP } from './ci-linux-fs'

/** CI（ubuntu-latest）上的 `os` 取值形态 */
const CI_EOL = '\n'
const CI_DEV_NULL = '/dev/null'

/** `vi.mock('os')` / `vi.mock('node:os')` 工厂 */
export async function ciLinuxOsHost(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    default?: Record<string, unknown>
  }
  const real = (actual.default ?? actual) as Record<string, unknown>
  const realUserInfo = real.userInfo as (options?: unknown) => Record<string, unknown>
  const wrapped: Record<string, unknown> = {
    ...real,
    tmpdir: () => CI_TMP,
    homedir: () => CI_HOME,
    EOL: CI_EOL,
    devNull: CI_DEV_NULL,
    userInfo: (options?: unknown) => ({ ...realUserInfo(options), homedir: CI_HOME })
  }
  return { ...actual, ...wrapped, default: wrapped }
}

/**
 * 测试文件自带的 `vi.mock('os')` 会**遮蔽**装置轴（`importOriginal()` 给回的是未 mock 的原形），
 * 所以这类文件必须把本函数的返回值组合进自己的工厂。
 * 装置未激活（真宿主 / CI）时返回 `{}` ⇒ 组合等价于今日行为，逐字不变。
 */
export function ciLinuxOsOverrides(): Record<string, unknown> {
  if ((globalThis as Record<string, unknown>).__wxnnCiLinuxEmulation === undefined) return {}
  return {
    tmpdir: () => CI_TMP,
    homedir: () => CI_HOME,
    EOL: CI_EOL,
    devNull: CI_DEV_NULL
  }
}
