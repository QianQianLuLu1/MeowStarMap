/**
 * CI 装置的 `child_process` 轴：交给子进程的路径参数（第 0 位 program/file 与 `options.cwd`）
 * 先经装置 fs 轴同一套 `toReal` 解析，再交给原生实现。
 *
 * 为什么需要它：`scripts/check-md-links.ts:351` 用 `execFileSync('git', args, { cwd: ROOT })`，
 * 而 `ROOT` 在装置里是 CI 工作区形态 `/home/runner/work/MeowStarMap/MeowStarMap`。轴 4 只接管
 * `fs`，子进程的 cwd 由 OS 解析——Windows 上该目录不存在 ⇒ `spawnSync git ENOENT`（第 4 轮 3 盏）。
 * 真 CI 上那个目录是真的存在，所以这一轴是把装置补成 CI 的形状，而不是把测试改成「能过」。
 *
 * 只翻两处，其余一律不动：
 * - 第 0 位：program / file / command。`toReal('git')` 恒等，命令名与相对 specifier 不受影响；
 * - `options.cwd`：与 `tests/mocks/ci-linux-fs.ts` 的 `'cwd' in arg` 分支同一语义。
 * `args` 数组不是路径（`-c core.quotepath=false` 之类逐位翻译会打烂命令）、`env` 更不翻
 * （PATH 必须保持真宿主，否则 git 直接找不到）。
 */
import { toReal } from './ci-linux-fs'

/** 不是「会启动子进程」的导出：原样透传，别包装 */
const SKIP_KEYS = new Set(['ChildProcess', 'CommonPipeType', 'constants', 'default'])

function mapArguments(args: unknown[]): unknown[] {
  return args.map((arg, index) => {
    if (index === 0) return toReal(arg)
    if (arg && typeof arg === 'object' && 'cwd' in arg) {
      const opt = arg as { cwd?: unknown }
      return { ...opt, cwd: typeof opt.cwd === 'string' ? toReal(opt.cwd) : opt.cwd }
    }
    return arg
  })
}

/**
 * 与 fs 轴同一条「按真实对象记忆」的规矩（`ci-linux-fs.ts` 的 wrapCache）：
 * Node 保证 `require('child_process').promises` 与 `require('child_process/promises')` 同源，
 * 装配两次各造一份包装件会让 spy 只落在其中一份上，被测代码从另一份拿到原函数 ⇒ 装置假绿。
 */
const wrapCache = new Map<object, Record<string, unknown>>()

function wrapNamespace(ns: Record<string, unknown>): Record<string, unknown> {
  const cached = wrapCache.get(ns)
  if (cached) return cached
  const out: Record<string, unknown> = { ...ns }
  wrapCache.set(ns, out)
  for (const [op, raw] of Object.entries(ns)) {
    if (typeof raw !== 'function' || SKIP_KEYS.has(op)) continue
    const orig = raw as (...a: unknown[]) => unknown
    out[op] = function ciLinuxChildProcessApi(this: unknown, ...args: unknown[]): unknown {
      return orig.apply(this, mapArguments(args))
    }
  }
  out.default = out
  const promises = ns.promises
  if (promises && typeof promises === 'object') {
    out.promises = wrapNamespace(promises as Record<string, unknown>)
  }
  return out
}

/** `vi.mock('child_process')` / `vi.mock('node:child_process')` 工厂 */
export async function ciLinuxChildProcessHost(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    default?: Record<string, unknown>
  }
  const real = (actual.default ?? actual) as Record<string, unknown>
  return wrapNamespace(real)
}
