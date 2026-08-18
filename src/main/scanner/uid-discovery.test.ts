/**
 * @layer L1
 * @module src/main/scanner/uid-discovery
 * @coverage discoverUidsFromGameDirs UID 发现逻辑
 * @dependencies fs（mock，仅需 readdirSync）
 * @remarks 纯逻辑测试，验证路径查找、UID 提取、去重、错误容错
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fs 模块 — uid-discovery 仅使用 readdirSync
vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn()
  }
}))

import fs from 'fs'
import { findGamePlayPhotosDir, discoverUidsFromGameDirs } from './uid-discovery'

/** 创建 mock Dirent 对象 */
function mockDirent(name: string, isDir: boolean): fs.Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false
  } as fs.Dirent
}

describe('findGamePlayPhotosDir', () => {
  it('直接是 GamePlayPhotos 目录时返回自身', () => {
    expect(findGamePlayPhotosDir('D:\\Game\\GamePlayPhotos')).toBe('D:\\Game\\GamePlayPhotos')
  })

  it('子目录时向上查找父目录 GamePlayPhotos', () => {
    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    expect(findGamePlayPhotosDir(dir)).toBe('D:\\Game\\GamePlayPhotos')
  })

  it('向上查找最多 5 层，5 层以内能找到', () => {
    // GamePlayPhotos 到当前目录共 4 层（uid/sub1/sub2/sub3），i=4 时匹配
    const dir = 'D:\\Game\\GamePlayPhotos\\uid\\sub1\\sub2\\sub3'
    expect(findGamePlayPhotosDir(dir)).toBe('D:\\Game\\GamePlayPhotos')
  })

  it('超过 5 层时返回 null', () => {
    // GamePlayPhotos 到当前目录共 5 层（uid/sub1/sub2/sub3/sub4），i=4 时仍在 sub3，i=5 超出循环
    const dir = 'D:\\Game\\GamePlayPhotos\\uid\\sub1\\sub2\\sub3\\sub4'
    expect(findGamePlayPhotosDir(dir)).toBeNull()
  })

  it('路径中无 GamePlayPhotos 时返回 null', () => {
    expect(findGamePlayPhotosDir('D:\\Photos\\MyAlbums\\photo.jpg')).toBeNull()
  })

  it('空字符串输入返回 null', () => {
    expect(findGamePlayPhotosDir('')).toBeNull()
  })
})

describe('discoverUidsFromGameDirs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('从 GamePlayPhotos 目录发现多个 UID', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('123456789', true),
      mockDirent('987654321', true),
      mockDirent('12345', true) // 5 位数字，不匹配 6-12 位
    ])

    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    const result = discoverUidsFromGameDirs([dir])

    expect(result).toHaveLength(2)
    expect(result).toContain('123456789')
    expect(result).toContain('987654321')
  })

  it('多个游戏目录指向同一 GamePlayPhotos 时去重', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([mockDirent('123456789', true)])

    const dirs = [
      'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality',
      'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_LowQuality'
    ]
    const result = discoverUidsFromGameDirs(dirs)

    // readdirSync 被调用 2 次（每个目录各一次），但 UID 去重后只有 1 个
    expect(fs.readdirSync).toHaveBeenCalledTimes(2)
    expect(result).toEqual(['123456789'])
  })

  it('多个不同 GamePlayPhotos 目录时合并所有 UID', () => {
    let callCount = 0
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      callCount++
      if (callCount === 1) return [mockDirent('111111111', true)]
      return [mockDirent('222222222', true)]
    })

    const dirs = [
      'D:\\Game1\\GamePlayPhotos\\111111111\\NikkiPhotos_HighQuality',
      'D:\\Game2\\GamePlayPhotos\\222222222\\NikkiPhotos_HighQuality'
    ]
    const result = discoverUidsFromGameDirs(dirs)

    expect(result).toHaveLength(2)
    expect(result).toContain('111111111')
    expect(result).toContain('222222222')
  })

  it('目录中含非 UID 子目录时仅返回有效 UID', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('123456789', true),
      mockDirent('NikkiPhotos_HighQuality', true), // 非数字目录名
      mockDirent('Collage', true),
      mockDirent('1234567890123', true), // 13 位数字，超出上限
      mockDirent('abc123def', true) // 含非数字字符
    ])

    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    const result = discoverUidsFromGameDirs([dir])

    expect(result).toEqual(['123456789'])
  })

  it('readdirSync 抛异常时返回空数组不崩溃', () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    const result = discoverUidsFromGameDirs([dir])

    expect(result).toEqual([])
  })

  it('路径无 GamePlayPhotos 祖先时不调用 readdirSync', () => {
    const dir = 'D:\\Photos\\MyCustomDir\\photo.jpg'
    discoverUidsFromGameDirs([dir])

    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('空目录列表返回空数组', () => {
    const result = discoverUidsFromGameDirs([])
    expect(result).toEqual([])
    expect(fs.readdirSync).not.toHaveBeenCalled()
  })

  it('发现 UID 时调用 log 回调', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([mockDirent('123456789', true)])

    const log = vi.fn()
    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    discoverUidsFromGameDirs([dir], log)

    expect(log).toHaveBeenCalledWith(
      'info',
      expect.stringContaining('[uid-discovery]'),
      expect.any(Array)
    )
  })

  it('未发现 UID 时不调用 log 回调', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([])

    const log = vi.fn()
    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    discoverUidsFromGameDirs([dir], log)

    expect(log).not.toHaveBeenCalled()
  })

  it('文件类型条目不被当作 UID', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      mockDirent('123456789', false) // 文件而非目录
    ])

    const dir = 'D:\\Game\\GamePlayPhotos\\123456789\\NikkiPhotos_HighQuality'
    const result = discoverUidsFromGameDirs([dir])

    expect(result).toEqual([])
  })
})
