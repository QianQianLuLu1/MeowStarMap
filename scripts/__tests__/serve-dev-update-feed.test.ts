import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import { EventEmitter } from 'node:events'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  parseServeFeedArgs,
  feedPayloadName,
  buildLatestYml,
  sha512Base64,
  main,
  type ServeFeedArgs
} from '../serve-dev-update-feed'
import { verifyUpdateFeedArtifacts } from '../pre-dist-check'

// main() 会真的 createServer + listen，单测里用 inert server 顶掉，绝不占端口、不留句柄。
// 保留 node:http 其余导出，避免影响同进程里其它模块的 import。
const { createServerMock, fakeServer } = vi.hoisted(() => {
  const fakeServer = {
    on: vi.fn(),
    listen: vi.fn(),
    close: vi.fn(),
    // F10：Node ≥18.2 的 Server 具备该方法；关闭后必须断掉 keep-alive 连接才能退干净
    closeAllConnections: vi.fn()
  }
  return { fakeServer, createServerMock: vi.fn(() => fakeServer) }
})
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, createServer: createServerMock }
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'serve-dev-update-feed.ts')

/** 剔除注释，避免源码结构断言误命中注释里引用的缺陷写法 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 以「脚本直接运行」的形态重新导入模块，借入口守卫触发 main()（不依赖 main 是否导出） */
async function runMainViaEntry(argv: string[]): Promise<void> {
  vi.resetModules()
  const prevArgv = process.argv
  process.argv = ['node', SCRIPT_PATH, ...argv]
  try {
    await import('../serve-dev-update-feed')
  } finally {
    process.argv = prevArgv
  }
}

/** 取解析成功的 args（失败即抛，让用例断言集中在成功形状上） */
function okArgs(argv: string[]): ServeFeedArgs {
  const r = parseServeFeedArgs(argv, ROOT)
  if (!r.ok) throw new Error(`unexpected parse failure: ${r.error}`)
  return r.args
}

function errText(argv: string[]): string {
  const r = parseServeFeedArgs(argv, ROOT)
  if (r.ok) throw new Error('expected parse failure but got ok')
  return r.error
}

/**
 * dev 假更新源夹具的参数校验与产物格式。
 *
 * 为什么值得单测：这个脚本的产物目录如果落在 release/ 之内，CI 发布步骤的
 * `release/latest*.yml` glob 会把**假的** latest.yml 当成真元数据上传到 GitHub Release，
 * 破坏面比本轮修的「误报网络繁忙」更大。该防线必须是可判定的纯函数断言，不能靠人记住。
 */
describe('parseServeFeedArgs —— 正常路径', () => {
  it('只给 --version 时用默认端口与 .cache 目录', () => {
    const args = okArgs(['--version', '9.9.9'])
    expect(args.port).toBe(8123)
    expect(args.version).toBe('9.9.9')
    expect(args.writeFeed).toBe(true)
    expect(args.dir.startsWith(ROOT)).toBe(true)
    expect(args.dir).toContain(path.join('.cache', 'dev-update-feed'))
  })

  it('--port / --dir / --no-yml 全部生效', () => {
    const args = okArgs([
      '--version',
      '2.5.8-beta',
      '--port',
      '9000',
      '--dir',
      'tmp-feed',
      '--no-yml'
    ])
    expect(args.port).toBe(9000)
    expect(args.version).toBe('2.5.8-beta')
    expect(args.writeFeed).toBe(false)
    expect(args.dir).toBe(path.resolve(ROOT, 'tmp-feed'))
  })

  it('预发布版本号被接受（本轮客户端就是 2.5.7-beta）', () => {
    expect(okArgs(['--version', '1.2.3-alpha.1']).version).toBe('1.2.3-alpha.1')
  })
})

describe('parseServeFeedArgs —— 假产物绝不允许落进 release/', () => {
  it('--dir release ⇒ 拒绝并点名 CI glob 风险', () => {
    expect(errText(['--version', '9.9.9', '--dir', 'release'])).toContain('release/')
  })

  it('--dir release/nested ⇒ 同样拒绝（子目录也算）', () => {
    expect(errText(['--version', '9.9.9', '--dir', 'release/nested'])).toContain('release/')
  })

  it('--dir release/../release ⇒ 先归一再判定，仍然拒绝', () => {
    expect(errText(['--version', '9.9.9', '--dir', 'release/../release'])).toContain('release/')
  })

  it('名字里含 release 但不是该目录段 ⇒ 放行（不得误伤 dev-update-feed-release 之类）', () => {
    expect(okArgs(['--version', '9.9.9', '--dir', 'feeds-release'])).toBeTruthy()
    expect(okArgs(['--version', '9.9.9', '--dir', 'a/release-backup/b'])).toBeTruthy()
  })
})

describe('parseServeFeedArgs —— 非法入参', () => {
  it('缺 --version ⇒ 拒绝', () => {
    expect(errText([])).toContain('--version')
  })

  it('--version 非法形态 ⇒ 拒绝（防客户端拿不到可比较的版本）', () => {
    for (const bad of ['abc', '2.5', 'v2.5.7', '2.5.7.1']) {
      expect(errText(['--version', bad])).toContain('--version')
    }
  })

  it('--port 非整数 / 越界 ⇒ 拒绝', () => {
    expect(errText(['--version', '9.9.9', '--port', '80'])).toContain('1024-65535')
    expect(errText(['--version', '9.9.9', '--port', '70000'])).toContain('1024-65535')
    expect(errText(['--version', '9.9.9', '--port', 'abc'])).toContain('整数')
  })

  it('--port 缺取值 / 取值是下一个 flag ⇒ 拒绝', () => {
    expect(errText(['--version', '9.9.9', '--port'])).toContain('缺少取值')
    expect(errText(['--version', '9.9.9', '--port', '--no-yml'])).toContain('缺少取值')
  })

  it('未知参数 ⇒ 拒绝（与 sync-e2e/launch-args 同款口径）', () => {
    expect(errText(['--ver', '9.9.9'])).toContain('未知参数')
  })
})

describe('buildLatestYml / sha512Base64 —— 元数据格式必须与 electron-builder 产物同形', () => {
  it('字段顺序与键名齐备（version / files[]url+sha512+size / path / sha512 / releaseDate）', () => {
    const yml = buildLatestYml({
      version: '9.9.9',
      fileName: 'MeowStarMap-Setup-9.9.9.exe',
      sha512: 'AAA=',
      size: 4096,
      releaseDate: '2026-11-05T03:43:21.279Z'
    })
    expect(yml).toContain('version: 9.9.9')
    expect(yml).toContain('  - url: MeowStarMap-Setup-9.9.9.exe')
    expect(yml).toContain('    sha512: AAA=')
    expect(yml).toContain('    size: 4096')
    expect(yml).toContain('path: MeowStarMap-Setup-9.9.9.exe')
    expect(yml).toContain("releaseDate: '2026-11-05T03:43:21.279Z'")
  })

  it('产出的正文能被本轮发布闸门判为自洽（两侧口径不得各写一套）', () => {
    const yml = buildLatestYml({
      version: '9.9.9',
      fileName: feedPayloadName('9.9.9'),
      sha512: 'AAA=',
      size: 4096,
      releaseDate: '2026-11-05T03:43:21.279Z'
    })
    expect(
      verifyUpdateFeedArtifacts({
        files: [feedPayloadName('9.9.9'), 'latest.yml'],
        feedYml: yml,
        appVersion: '9.9.9'
      })
    ).toEqual([])
  })

  it('假包文件名与 NSIS 产物同形', () => {
    expect(feedPayloadName('2.5.8-beta')).toBe('MeowStarMap-Setup-2.5.8-beta.exe')
  })

  it('sha512 是 base64（electron-updater 校验口径），长度 88', () => {
    const digest = sha512Base64(Buffer.from('meow'))
    expect(digest).toBe(createHash('sha512').update(Buffer.from('meow')).digest('base64'))
    expect(digest).toHaveLength(88)
    expect(digest).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
  })

  // 与真实产物对版：本机跑过 dist:win 时，夹具生成的格式必须能被同一份 latest.yml 的读法解析
  const realFeed = path.join(ROOT, 'release', 'latest.yml')
  it.runIf(existsSync(realFeed))('契约：真实 release/latest.yml 的键集合被夹具格式覆盖', () => {
    const realKeys = readFileSync(realFeed, 'utf-8')
      .split(/\r?\n/)
      .map((line) => /^([ \t]*)([-\w]+):/.exec(line)?.[2])
      .filter((k): k is string => Boolean(k))
      .sort()
    const fakeKeys = buildLatestYml({
      version: '9.9.9',
      fileName: 'a.exe',
      sha512: 'AAA=',
      size: 1,
      releaseDate: 'x'
    })
      .split(/\r?\n/)
      .map((line) => /^([ \t]*)([-\w]+):/.exec(line)?.[2])
      .filter((k): k is string => Boolean(k))
      .sort()
    // 真实产物的每个键在夹具里都要出现（夹具可以少不能少结构）
    for (const key of realKeys) expect(fakeKeys).toContain(key)
  })
})

describe('--no-yml 不得污染已有 latest.yml（A7）', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dev-feed-a7-'))
    createServerMock.mockClear()
    fakeServer.on.mockClear()
    fakeServer.listen.mockClear()
    fakeServer.close.mockClear()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('(缺陷) --no-yml 不得写 latest.yml.bak、不得清空已有 yml', async () => {
    const ymlPath = path.join(tmpDir, 'latest.yml')
    const original = buildLatestYml({
      version: '9.9.9',
      fileName: feedPayloadName('9.9.9'),
      sha512: 'AAA=',
      size: 4096,
      releaseDate: '2026-11-05T03:43:21.279Z'
    })
    writeFileSync(ymlPath, original, 'utf-8')

    await runMainViaEntry(['--version', '9.9.9', '--no-yml', '--dir', tmpDir])

    expect(existsSync(ymlPath + '.bak')).toBe(false)
    expect(readFileSync(ymlPath, 'utf-8')).toBe(original)
  })

  it('(源码) --no-yml 分支不得再有 .bak 备份与清空写操作', () => {
    const src = stripComments(readFileSync(SCRIPT_PATH, 'utf-8'))
    expect(src).not.toContain('.bak')
    expect(src).not.toMatch(/writeFileSync\(feedPath,\s*''/)
  })
})

describe('入口守卫与信号生命周期（A8）', () => {
  beforeEach(() => {
    createServerMock.mockClear()
    fakeServer.on.mockClear()
    fakeServer.listen.mockClear()
    fakeServer.close.mockClear()
    fakeServer.closeAllConnections.mockClear()
  })

  it('(源码) 入口守卫改用 import.meta.url 规范化比对，不再靠 argv[1] 后缀字符串', () => {
    const src = stripComments(readFileSync(SCRIPT_PATH, 'utf-8'))
    expect(src).toContain('isDirectRun')
    expect(src).not.toContain("endsWith('serve-dev-update-feed.ts')")
  })

  it('(缺陷) SIGINT/SIGTERM → 幂等 server.close()（信号连发只关一次，端口/句柄必释放）', async () => {
    const mod = (await import('../serve-dev-update-feed')) as unknown as Record<string, unknown>
    expect(typeof mod.registerShutdown).toBe('function')
    const register = mod.registerShutdown as (server: unknown, target: unknown) => () => void
    const target = new EventEmitter()

    register(fakeServer, target)
    target.emit('SIGINT')
    target.emit('SIGTERM')
    target.emit('SIGINT')

    expect(fakeServer.close).toHaveBeenCalledTimes(1)
  })

  it('(回归锁) 仅导入模块不得触发 main()：不 createServer、不监听端口', async () => {
    vi.resetModules()
    const prevArgv = process.argv
    process.argv = [
      'node',
      path.join(ROOT, 'scripts', '__tests__', 'serve-dev-update-feed.test.ts')
    ]
    try {
      await import('../serve-dev-update-feed')
    } finally {
      process.argv = prevArgv
    }
    expect(createServerMock).not.toHaveBeenCalled()
  })
})

// ============================================================================
// F9/F10/F11：请求处理健壮性与退出链收尾（审查轮发现）
// ============================================================================
describe('F9/F10/F11 请求处理健壮性', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dev-feed-f9-'))
    createServerMock.mockClear()
    fakeServer.on.mockClear()
    fakeServer.listen.mockClear()
    fakeServer.close.mockClear()
    fakeServer.closeAllConnections.mockClear()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 经 main() 起一次服务（server 已 mock），取出请求 handler 并打一发请求 */
  function runHandler(url: string): {
    writeHead: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  } {
    main(['--version', '9.9.9', '--dir', tmpDir])
    // createServerMock 声明为零参工厂，calls 元组无元素类型：经 unknown 数组取首参（handler）
    const lastCall = createServerMock.mock.calls.at(-1) as unknown as unknown[] | undefined
    const handler = lastCall?.[0] as unknown as (
      req: { url?: string },
      res: { writeHead: unknown; end: unknown }
    ) => void
    const res = { writeHead: vi.fn(), end: vi.fn() }
    handler({ url }, res as never)
    return res
  }

  it('F9 畸形百分号编码（GET /%）⇒ 404 且 handler 不抛 URIError（不崩 dev 进程）', () => {
    // 修复前：decodeURIComponent('/%') 在 request handler 里同步抛 URIError
    // ⇒ http server 未捕获即 uncaughtException，与 registerShutdown 的优雅退出目标相悖
    const res = runHandler('/%')
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything())
    expect(res.end).toHaveBeenCalledWith('not found\n')
  })

  it('F11 同请求的 Content-Length 与响应体来自同一次读盘（不得读两次）', () => {
    const src = stripComments(readFileSync(SCRIPT_PATH, 'utf-8'))
    expect(src).not.toMatch(/Content-Length':\s*String\(readFileSync\(file\)\.length\)/)
    expect(src).toMatch(/const body = readFileSync\(file\)/)
  })

  it('F10 SIGINT 关闭后必须补 closeAllConnections（keep-alive 连接不得挂住退出）', async () => {
    const mod = (await import('../serve-dev-update-feed')) as unknown as Record<string, unknown>
    const register = mod.registerShutdown as (server: unknown, target: unknown) => () => void
    const target = new EventEmitter()
    register(fakeServer, target)
    target.emit('SIGINT')
    // 信号连发幂等：close 与 closeAllConnections 都只执行一次
    target.emit('SIGINT')
    expect(fakeServer.close).toHaveBeenCalledTimes(1)
    expect(fakeServer.closeAllConnections).toHaveBeenCalledTimes(1)
  })
})
