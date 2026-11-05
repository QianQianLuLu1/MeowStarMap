import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import {
  parseServeFeedArgs,
  feedPayloadName,
  buildLatestYml,
  sha512Base64,
  type ServeFeedArgs
} from '../serve-dev-update-feed'
import { verifyUpdateFeedArtifacts } from '../pre-dist-check'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')

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
