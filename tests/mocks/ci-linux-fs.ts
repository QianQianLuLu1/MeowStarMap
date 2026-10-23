/**
 * CI 装置的文件系统层：把「posix 假路径」双向翻译到本机真实目录，并复刻容器里 `/` 不可写。
 *
 * 为什么必须走 `vi.mock` 而不是就地改真 `fs` 模块对象：vitest 会给外部模块套一层
 * interop Proxy，具名导入拿到的是**代理快照**，`Object.defineProperty(fs, ...)` 拦不住
 * （实测 `readFileSync` 仍收到未翻译的 `/home/runner/...`，在 Windows 上被解释成
 * `D:\home\runner\...` 而 ENOENT）。走 `vi.mock('fs')` 才在解析层生效。
 *
 * 各 API 的语义对应关系（本机 → CI）：
 * - `/tmp/...`            → 本机沙箱 `os.tmpdir()/wxnn-ci-linux/tmp`，结果反向翻译回 `/tmp/...`
 * - `/home/runner/...`    → 本机沙箱 `.../home-runner`
 * - `/home/runner/work/...`（CI 工作区）→ 本机真实仓库根（只读用例读的是同一份源码）
 * - `/dev/null`           → 本机 `os.devNull`
 * - 其它 POSIX 绝对路径    → 创建类 API 抛 EACCES（容器里 `/` 属 root，与本机能否建目录无关）
 *
 * 测试文件自带的 `vi.mock('fs')` / `vi.mock('fs/promises')` 优先级高于这里，互不影响。
 */
import realOs from 'os'
import nodePath from 'path'

const WIN32 = nodePath.win32

export const CI_ROOT = '/home/runner/work/MeowStarMap/MeowStarMap'
export const CI_HOME = '/home/runner'
export const CI_TMP = '/tmp'

/** 本机真实仓库根；由 setup 在改写 `process.cwd` 之前注入 */
export let REAL_ROOT = CI_ROOT
export function setRealRoot(root: string): void {
  REAL_ROOT = root.replace(/[\\/]+$/, '')
}

const SANDBOX = WIN32.join(realOs.tmpdir(), 'wxnn-ci-linux')
const REAL_TMP = WIN32.join(SANDBOX, 'tmp')
const REAL_HOME = WIN32.join(SANDBOX, 'home-runner')

/** CI 工作区的两级祖先（`path.resolve(repoRoot, '..')` 这类用法在 CI 上真实存在） */
const CI_WORKSPACE = CI_ROOT.slice(0, CI_ROOT.lastIndexOf('/'))
const CI_WORK = CI_WORKSPACE.slice(0, CI_WORKSPACE.lastIndexOf('/'))

/** 分隔符归一后比较前缀：Windows 真实路径可能是 `\` 形态，而 REAL_ROOT 取自宿主 resolve */
const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '')

/** 返回 `value` 去掉 `prefix` 之后剩下的段（分隔符两种都认） */
function rest(value: string, prefix: string): string[] {
  return norm(value).slice(norm(prefix).length).split('/').filter(Boolean)
}

/** 装置视角（posix）→ 本机真实路径 */
export function toReal(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const p = value
  // 祖先链先于通用 /home/runner：CI 上 `<repo>/..` 是工作区目录，不是家目录
  if (p === CI_ROOT || p.startsWith(`${CI_ROOT}/`))
    return WIN32.join(REAL_ROOT, ...rest(p, CI_ROOT))
  if (p === CI_WORKSPACE || p.startsWith(`${CI_WORKSPACE}/`)) {
    return WIN32.join(WIN32.dirname(REAL_ROOT), ...rest(p, CI_WORKSPACE))
  }
  if (p === CI_WORK || p.startsWith(`${CI_WORK}/`)) {
    return WIN32.join(WIN32.dirname(WIN32.dirname(REAL_ROOT)), ...rest(p, CI_WORK))
  }
  if (p === CI_TMP) return REAL_TMP
  if (p.startsWith(`${CI_TMP}/`)) return WIN32.join(REAL_TMP, ...rest(p, CI_TMP))
  if (p === '/dev/null') return realOs.devNull
  if (p === CI_HOME) return REAL_HOME
  if (p.startsWith(`${CI_HOME}/`)) return WIN32.join(REAL_HOME, ...rest(p, CI_HOME))
  return p
}

/** 本机真实路径 → 装置视角（posix） */
export function toEmulated(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const pairs: Array<[string, string]> = [
    [REAL_ROOT, CI_ROOT],
    [WIN32.dirname(REAL_ROOT), CI_WORKSPACE],
    [WIN32.dirname(WIN32.dirname(REAL_ROOT)), CI_WORK],
    [REAL_TMP, CI_TMP],
    [REAL_HOME, CI_HOME]
  ]
  for (const [real, emulated] of pairs) {
    const a = norm(real).toLowerCase()
    const b = norm(value).toLowerCase()
    if (a === b) return emulated
    if (b.startsWith(`${a}/`)) return `${emulated}/${rest(value, real).join('/')}`
  }
  return value
}

/** 会返回路径、需要反向翻译的 API */
const PATH_RESULT_OPS = new Set([
  'mkdtemp',
  'mkdtempSync',
  'realpath',
  'realpathSync',
  'readlink',
  'readlinkSync'
])

/** 需要按「容器根不可写」判定的创建类 API */
const WRITE_OPS = new Set([
  'appendFile',
  'appendFileSync',
  'copyFile',
  'copyFileSync',
  'createWriteStream',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'open',
  'openSync',
  'rename',
  'renameSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'writeFile',
  'writeFileSync'
])

/** posix 串是否落在 CI 上不可写的根（容器里只有 /tmp 与 /home/runner 对用户可写） */
function isUnwritablePosixPath(p: string): boolean {
  if (!p.startsWith('/')) return false
  if (p === CI_TMP || p.startsWith(`${CI_TMP}/`) || p === '/dev' || p.startsWith('/dev/'))
    return false
  return !(p === CI_HOME || p.startsWith(`${CI_HOME}/`))
}

export function eacces(syscall: string, p: string): NodeJS.ErrnoException {
  const err = new Error(`EACCES: permission denied, ${syscall} '${p}'`) as NodeJS.ErrnoException
  err.code = 'EACCES'
  err.errno = -13
  err.syscall = syscall
  err.path = p
  return err
}

/**
 * 每个 API 里**哪些参数位是路径**。
 * 默认只翻第 0 位——`writeFile(file, data)` 的第 1 位是内容、`open(path, flags)` 的第 1 位是
 * 标志位，一律不能当路径翻译。双路径操作必须逐个登记，否则 `rename(src, dest)` 的 dest
 * 会以 `/tmp/...` 形态直接交给 Windows，被解释成盘符相对路径 `D:\tmp\...` 而 ENOENT
 * （装置第一版就栽在这里：file-service / atomic-file / dir-manager 成片假红）。
 */
const PATH_ARG_INDEX: Record<string, number[]> = {
  rename: [0, 1],
  renameSync: [0, 1],
  copyFile: [0, 1],
  copyFileSync: [0, 1],
  link: [0, 1],
  linkSync: [0, 1],
  symlink: [0, 1],
  symlinkSync: [0, 1]
}

function pathArgIndexes(op: string): number[] {
  return PATH_ARG_INDEX[op] ?? [0]
}

function mapArgumentsForOp(args: unknown[], op: string): unknown[] {
  const indexes = new Set(pathArgIndexes(op))
  return args.map((arg, i) => {
    if (indexes.has(i)) return toReal(arg)
    if (arg && typeof arg === 'object' && 'cwd' in arg) {
      const opt = arg as { cwd?: unknown }
      return { ...opt, cwd: typeof opt.cwd === 'string' ? toReal(opt.cwd) : opt.cwd }
    }
    return arg
  })
}

function mapArguments(args: unknown[], op: string): unknown[] {
  // 可写性判定只看**第一个**路径参数：创建类 API 的目标目录就是它（rename/copy 的 src
  // 已在创建时判过，dest 才是写入目标；两者都在同一规则下）
  for (const index of pathArgIndexes(op)) {
    const candidate = args[index]
    if (typeof candidate === 'string' && WRITE_OPS.has(op) && isUnwritablePosixPath(candidate)) {
      throw eacces(op.replace(/Sync$/, ''), candidate)
    }
  }
  return mapArgumentsForOp(args, op)
}

function splitCallback(args: unknown[]): { rest: unknown[]; cb?: (...a: unknown[]) => unknown } {
  const tailArg = args[args.length - 1]
  if (typeof tailArg === 'function') {
    return { rest: args.slice(0, -1), cb: tailArg as (...a: unknown[]) => unknown }
  }
  return { rest: args }
}

/**
 * 包装一个 fs 命名空间（同步与异步 API 都覆盖）。
 *
 * 必须**按真实对象记忆**：Node 保证 `require('fs').promises === require('fs/promises')`，
 * 而 `vi.spyOn(fs.promises, 'unlink')` 这类用例依赖的正是这层同一性。若两次装配各造一份包装件，
 * spy 只落在其中一份上，被测代码从另一份拿到的仍是原函数 ⇒ 用例假绿（装置第一版就为此
 * 让 `file-service.test.ts` 的 EACCES 分支变成 success=true）。
 * `default` 指向包装件自身，保证 `import fs from 'fs'` 与具名导入同源。
 */
const wrapCache = new Map<object, Record<string, unknown>>()

function wrapNamespace(ns: Record<string, unknown>): Record<string, unknown> {
  const cached = wrapCache.get(ns)
  if (cached) return cached
  const out: Record<string, unknown> = { ...ns }
  wrapCache.set(ns, out)
  for (const [op, raw] of Object.entries(ns)) {
    if (typeof raw !== 'function') continue
    if (op.startsWith('_') || op === 'default') continue
    if (op === 'read' || op === 'write' || op === 'readSync' || op === 'writeSync') continue
    if (SKIP_KEYS.has(op)) continue
    const orig = raw as (...a: unknown[]) => unknown
    out[op] = function ciLinuxFsApi(this: unknown, ...args: unknown[]): unknown {
      let mapped: unknown[]
      try {
        mapped = mapArguments(args, op)
      } catch (err) {
        if (op.endsWith('Sync')) throw err
        const { cb } = splitCallback(args)
        if (cb) {
          setImmediate(() => cb(err))
          return undefined
        }
        return Promise.reject(err)
      }
      if (!PATH_RESULT_OPS.has(op)) return orig.apply(this, mapped)
      const convert = (v: unknown): unknown => toEmulated(v)
      if (op.endsWith('Sync')) return convert(orig.apply(this, mapped))
      const { rest, cb } = splitCallback(mapped)
      if (cb) {
        return orig.apply(this, [...rest, (e: unknown, val: unknown) => cb(e, convert(val))])
      }
      const result = orig.apply(this, mapped)
      return result && typeof (result as Promise<unknown>).then === 'function'
        ? (result as Promise<unknown>).then(convert)
        : convert(result)
    }
  }
  out.default = out
  const promises = ns.promises
  if (promises && typeof promises === 'object') {
    out.promises = wrapNamespace(promises as Record<string, unknown>)
  }
  return out
}

/** 不是「路径函数」的导出：原样透传，别包装 */
const SKIP_KEYS = new Set([
  'promises',
  'constants',
  'Dir',
  'Dirent',
  'Stats',
  'WriteStream',
  'ReadStream',
  'F_OK',
  'R_OK',
  'W_OK',
  'X_OK',
  'CopyFileExcl',
  'WatchEventType'
])

/**
 * `vi.mock('fs')` / `vi.mock('node:fs')` / `vi.mock('fs/promises')` 工厂。
 * 返回包装命名空间本身（不再 spread 成新对象），使 `fs.promises` 与 `fs/promises` 同源。
 */
export async function ciLinuxFsHost(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    default?: Record<string, unknown>
  }
  const real = (actual.default ?? actual) as Record<string, unknown>
  return wrapNamespace(real)
}

/** 供 setup 预建沙箱目录 */
export function ensureSandbox(mkdirSync: (p: string, o: { recursive: true }) => unknown): void {
  mkdirSync(REAL_TMP, { recursive: true })
  mkdirSync(REAL_HOME, { recursive: true })
}

/**
 * `vi.mock('url')` / `vi.mock('node:url')` 工厂：让 `fileURLToPath` 说出 CI 的方言。
 *
 * 这一轴把一大类装置假信号直接消掉：仓内守卫与脚本测试统一用
 * `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')` 定仓库根。
 * 不翻译 `fileURLToPath` 时，装置里它返回真实反斜杠路径，再经 posix 绑定 `resolve` 就被
 * 当成**相对名**拼到 cwd 之后，得到 `/home/runner/work/MeowStarMap/MeowStarMap/D:\…`
 * 这种 CI 上根本不可能出现的串 ⇒ 成片假红。翻译之后，仓库根就是 CI 工作区形态，
 * 后续 `resolve('..','..')` 与 fs 读取都和 CI 一致。
 */
export async function ciLinuxUrlHost(
  importOriginal: () => Promise<unknown>
): Promise<Record<string, unknown>> {
  const actual = (await importOriginal()) as Record<string, unknown> & {
    default?: Record<string, unknown>
  }
  const real = (actual.default ?? actual) as Record<string, unknown>
  const wrapped: Record<string, unknown> = { ...real }
  const realFileURLToPath = real.fileURLToPath as (url: unknown) => string
  const realPathToFileURL = real.pathToFileURL as (p: string) => unknown
  if (typeof realFileURLToPath === 'function') {
    wrapped.fileURLToPath = (url: unknown): string => toEmulated(realFileURLToPath(url)) as string
  }
  if (typeof realPathToFileURL === 'function') {
    wrapped.pathToFileURL = (p: string): unknown => realPathToFileURL(toReal(p) as string)
  }
  return { ...actual, ...wrapped, default: wrapped }
}
