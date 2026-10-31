import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

/**
 * @layer L2
 * @module src/main/services/cloth-diy-cache
 * @coverage 搭配码网络结果磁盘缓存：默认根解析 / 原子写读回 / trim 归一化 / 读写失败兜底 / clear
 * @remarks 缓存根经 setClothDiyCacheRoot 注入临时目录，不触碰真实用户数据；
 *          electron app.getPath 经 vi.mock 控制，覆盖缺省根与「app 未就绪禁用」两分支
 */

const { getPathMock } = vi.hoisted(() => ({ getPathMock: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import {
  setClothDiyCacheRoot,
  getClothDiyCachePath,
  readClothDiyCache,
  writeClothDiyCache,
  clearClothDiyCache
} from './cloth-diy-cache'

/**
 * 与实现一致的 key 规则：sha256(trim(code)) hex——测试侧独立计算，锁定「路径可预测」。
 * basename 白名单校验后再拼路径（sha256 hex 产物必为 [0-9a-f]{64}.txt）。
 */
function expectedCacheFilePath(dir: string, code: string): string {
  const name = `${crypto.createHash('sha256').update(code.trim(), 'utf8').digest('hex')}.txt`
  if (!/^[0-9a-f]{64}\.txt$/.test(name)) throw new Error(`unsafe cache file name: ${name}`)
  return path.join(dir, name)
}

let tmpRoot: string
let defaultUserData: string

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-cloth-cache-'))
}

beforeEach(() => {
  tmpRoot = mkdtemp()
  defaultUserData = path.join(tmpRoot, 'userdata')
  fs.mkdirSync(defaultUserData, { recursive: true })
  getPathMock.mockImplementation((name: string) => {
    if (name !== 'userData') throw new Error(`unexpected getPath: ${name}`)
    return defaultUserData
  })
  // 缺省注入每用例隔离根；需要走缺省根的用例自行 setClothDiyCacheRoot(null)
  setClothDiyCacheRoot(path.join(tmpRoot, 'cache'))
})

afterEach(() => {
  setClothDiyCacheRoot(null)
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

describe('cloth-diy-cache（搭配码网络结果磁盘缓存）', () => {
  it('write→read 往返一致，文件名 = sha256(trim(code)).txt（路径可预测）', async () => {
    expect(await writeClothDiyCache('CODE123', '{"Content":{}}')).toBe(true)
    const file = expectedCacheFilePath(path.join(tmpRoot, 'cache'), 'CODE123')
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('{"Content":{}}')
    expect(await readClothDiyCache('CODE123')).toBe('{"Content":{}}')
  })

  it('未注入根时缺省落在 userData/cloth-diy-cache 下（用户数据目录，路径可预测）', async () => {
    setClothDiyCacheRoot(null)
    expect(await writeClothDiyCache('CODE', 'payload')).toBe(true)
    const file = expectedCacheFilePath(path.join(defaultUserData, 'cloth-diy-cache'), 'CODE')
    expect(fs.existsSync(file)).toBe(true)
    expect(await readClothDiyCache('CODE')).toBe('payload')
  })

  it('trim 归一化：带首尾空白的同码命中缓存', async () => {
    expect(await writeClothDiyCache('CODE', 'payload')).toBe(true)
    expect(await readClothDiyCache('  CODE  ')).toBe('payload')
    expect(getClothDiyCachePath(' CODE ')).toBe(getClothDiyCachePath('CODE'))
  })

  it('getClothDiyCachePath 返回可预测路径；根不可用时返回 null', async () => {
    setClothDiyCacheRoot(null)
    getPathMock.mockImplementation(() => {
      throw new Error('app not ready')
    })
    expect(getClothDiyCachePath('CODE')).toBeNull()
    setClothDiyCacheRoot(tmpRoot)
    expect(getClothDiyCachePath('CODE')).toBe(expectedCacheFilePath(tmpRoot, 'CODE'))
  })

  it('读未命中返回 undefined；空内容文件视为未命中；空 networkData 不写', async () => {
    expect(await readClothDiyCache('MISSING')).toBeUndefined()
    expect(await writeClothDiyCache('EMPTY', '')).toBe(false)
    setClothDiyCacheRoot(tmpRoot)
    const file = getClothDiyCachePath('EMPTY')
    expect(file).not.toBeNull()
    fs.writeFileSync(file as string, '', 'utf8')
    expect(await readClothDiyCache('EMPTY')).toBeUndefined()
  })

  it('写失败（根指向普通文件，mkdir 失败）返回 false 且不抛错', async () => {
    const notADir = path.join(tmpRoot, 'plain.txt')
    fs.writeFileSync(notADir, 'x', 'utf8')
    setClothDiyCacheRoot(notADir)
    await expect(writeClothDiyCache('CODE', 'payload')).resolves.toBe(false)
  })

  it('getPath 抛错（app 未就绪）→ 缓存禁用兜底：read undefined / write false / clear {0,0}', async () => {
    setClothDiyCacheRoot(null)
    getPathMock.mockImplementation(() => {
      throw new Error('app not ready')
    })
    expect(await readClothDiyCache('CODE')).toBeUndefined()
    await expect(writeClothDiyCache('CODE', 'payload')).resolves.toBe(false)
    await expect(clearClothDiyCache()).resolves.toEqual({ clearedCount: 0, clearedSize: 0 })
  })

  it('clear 清空全部缓存文件并返回计数与字节数', async () => {
    await writeClothDiyCache('A', 'aaaa')
    await writeClothDiyCache('B', 'bb')
    const res = await clearClothDiyCache()
    expect(res.clearedCount).toBe(2)
    expect(res.clearedSize).toBe(6) // 4 + 2 字节（utf8）
    expect(fs.readdirSync(path.join(tmpRoot, 'cache'))).toEqual([])
  })

  it('clear 目录不存在 → {0,0} 不抛错', async () => {
    await expect(clearClothDiyCache()).resolves.toEqual({ clearedCount: 0, clearedSize: 0 })
  })
})
