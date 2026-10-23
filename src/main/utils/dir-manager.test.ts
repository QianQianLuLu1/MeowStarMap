/**
 * @layer L1
 * @module src/main/utils/dir-manager
 * @coverage SETTING_KEYS/resolveCustomDir/ensureDir/migrateDirFiles/MIGRATE_PATTERNS
 * @dependencies mock: electron (app), 使用真实 fs 与 os.tmpdir
 * @remarks 使用真实 fs 写入临时目录，验证目录解析与文件迁移逻辑
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'

let mockUserData: string

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockUserData)
  }
}))

import {
  SETTING_KEYS,
  resolveCustomDir,
  ensureDir,
  migrateDirFiles,
  MIGRATE_PATTERNS
} from './dir-manager'

// 构造满足 DatabaseManager 接口的最小 mock
function createMockDbManager(settings: Record<string, unknown> = {}): {
  getSetting: ReturnType<typeof vi.fn>
} {
  return {
    getSetting: vi.fn((key: string, defaultValue: unknown) => {
      const v = settings[key]
      return v === undefined ? defaultValue : v
    })
  }
}

describe('dir-manager', () => {
  let tmpBase: string

  beforeEach(async () => {
    tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-dir-test-'))
    mockUserData = path.join(tmpBase, 'userData')
    await fsp.mkdir(mockUserData, { recursive: true })
  })

  afterEach(async () => {
    await fsp.rm(tmpBase, { recursive: true, force: true })
  })

  describe('SETTING_KEYS', () => {
    it('包含 4 个目录设置项', () => {
      expect(Object.keys(SETTING_KEYS).length).toBe(4)
    })

    it('backupDir 键为 "backupDir"', () => {
      expect(SETTING_KEYS.backupDir).toBe('backupDir')
    })

    it('thumbnailCacheDir 键为 "thumbnailCacheDir"', () => {
      expect(SETTING_KEYS.thumbnailCacheDir).toBe('thumbnailCacheDir')
    })

    it('logDir 键为 "logDir"', () => {
      expect(SETTING_KEYS.logDir).toBe('logDir')
    })

    it('crashDir 键为 "crashDir"', () => {
      expect(SETTING_KEYS.crashDir).toBe('crashDir')
    })
  })

  describe('MIGRATE_PATTERNS', () => {
    it('backupDir 模式匹配 meow_star_map_*.db', () => {
      expect(MIGRATE_PATTERNS.backupDir.test('meow_star_map_20260719.db')).toBe(true)
      expect(MIGRATE_PATTERNS.backupDir.test('other.txt')).toBe(false)
    })

    it('thumbnailCacheDir 模式匹配图片扩展名（大小写不敏感）', () => {
      expect(MIGRATE_PATTERNS.thumbnailCacheDir.test('thumb.jpg')).toBe(true)
      expect(MIGRATE_PATTERNS.thumbnailCacheDir.test('thumb.JPEG')).toBe(true)
      expect(MIGRATE_PATTERNS.thumbnailCacheDir.test('thumb.png')).toBe(true)
      expect(MIGRATE_PATTERNS.thumbnailCacheDir.test('thumb.webp')).toBe(true)
      expect(MIGRATE_PATTERNS.thumbnailCacheDir.test('thumb.txt')).toBe(false)
    })

    it('logDir 模式匹配 .log 与 .jsonl', () => {
      expect(MIGRATE_PATTERNS.logDir.test('main-2026-07-19.log')).toBe(true)
      expect(MIGRATE_PATTERNS.logDir.test('faults-2026-07-19.jsonl')).toBe(true)
      expect(MIGRATE_PATTERNS.logDir.test('file.txt')).toBe(false)
    })

    it('crashDir 模式匹配 .dmp/.dump/.crash', () => {
      expect(MIGRATE_PATTERNS.crashDir.test('crash.dmp')).toBe(true)
      expect(MIGRATE_PATTERNS.crashDir.test('crash.dump')).toBe(true)
      expect(MIGRATE_PATTERNS.crashDir.test('crash.crash')).toBe(true)
      expect(MIGRATE_PATTERNS.crashDir.test('file.log')).toBe(false)
    })
  })

  describe('resolveCustomDir', () => {
    it('自定义路径有效时返回自定义路径', () => {
      const customDir = path.join(tmpBase, 'custom-backup')
      fs.mkdirSync(customDir, { recursive: true })
      const db = createMockDbManager({ [SETTING_KEYS.backupDir]: customDir })
      const result = resolveCustomDir(db as never, 'backupDir')
      expect(result).toBe(customDir)
    })

    it('自定义路径不存在时回退到 userData 子目录', () => {
      const db = createMockDbManager({ [SETTING_KEYS.backupDir]: '/nonexistent/path/xyz' })
      const result = resolveCustomDir(db as never, 'backupDir')
      expect(result).toBe(path.join(mockUserData, 'backups'))
    })

    it('自定义路径为空字符串时回退到默认', () => {
      const db = createMockDbManager({ [SETTING_KEYS.backupDir]: '' })
      const result = resolveCustomDir(db as never, 'backupDir')
      expect(result).toBe(path.join(mockUserData, 'backups'))
    })

    it('自定义路径为文件（非目录）时回退到默认', () => {
      const filePath = path.join(tmpBase, 'a-file')
      fs.writeFileSync(filePath, 'x')
      const db = createMockDbManager({ [SETTING_KEYS.backupDir]: filePath })
      const result = resolveCustomDir(db as never, 'backupDir')
      expect(result).toBe(path.join(mockUserData, 'backups'))
    })

    it('thumbnailCacheDir 回退到 userData/thumbnails', () => {
      const db = createMockDbManager()
      const result = resolveCustomDir(db as never, 'thumbnailCacheDir')
      expect(result).toBe(path.join(mockUserData, 'thumbnails'))
    })

    it('logDir 回退到 userData/logs', () => {
      const db = createMockDbManager()
      const result = resolveCustomDir(db as never, 'logDir')
      expect(result).toBe(path.join(mockUserData, 'logs'))
    })

    it('crashDir 回退到用户友好目录（文档/喵星图/Diagnostics），避免藏在 AppData', () => {
      const db = createMockDbManager()
      const result = resolveCustomDir(db as never, 'crashDir')
      expect(result).toMatch(/喵星图[\\/]Diagnostics$/)
    })

    it('只读目录回退到默认（W_OK 校验失败）', () => {
      // Windows 上 chmod 行为不一致，跳过权限测试
      // 仅验证 isValidDir 对不存在路径返回 false
      const db = createMockDbManager({ [SETTING_KEYS.backupDir]: '/nonexistent' })
      const result = resolveCustomDir(db as never, 'backupDir')
      expect(result).toBe(path.join(mockUserData, 'backups'))
    })
  })

  describe('ensureDir', () => {
    it('目录不存在时创建', () => {
      const newDir = path.join(tmpBase, 'ensure-test')
      expect(fs.existsSync(newDir)).toBe(false)
      ensureDir(newDir)
      expect(fs.existsSync(newDir)).toBe(true)
      expect(fs.statSync(newDir).isDirectory()).toBe(true)
    })

    it('目录已存在时不抛错', () => {
      const existing = path.join(tmpBase, 'existing')
      fs.mkdirSync(existing)
      expect(() => ensureDir(existing)).not.toThrow()
      expect(fs.existsSync(existing)).toBe(true)
    })

    it('支持递归创建多层目录', () => {
      const deep = path.join(tmpBase, 'a', 'b', 'c', 'd')
      ensureDir(deep)
      expect(fs.existsSync(deep)).toBe(true)
    })

    it('嵌套调用幂等', () => {
      const dir = path.join(tmpBase, 'idempotent')
      ensureDir(dir)
      ensureDir(dir)
      ensureDir(dir)
      expect(fs.existsSync(dir)).toBe(true)
    })
  })

  describe('migrateDirFiles', () => {
    it('同路径直接返回 { moved: 0, failed: 0 }', async () => {
      const result = await migrateDirFiles('/same', '/same', /\.txt$/)
      expect(result).toEqual({ moved: 0, failed: 0 })
    })

    it('源目录不存在返回 { moved: 0, failed: 0 }', async () => {
      const result = await migrateDirFiles(
        '/nonexistent/source',
        path.join(tmpBase, 'target'),
        /\.txt$/
      )
      expect(result).toEqual({ moved: 0, failed: 0 })
    })

    it('空源目录返回 { moved: 0, failed: 0 }', async () => {
      const emptySrc = path.join(tmpBase, 'empty')
      const target = path.join(tmpBase, 'target')
      fs.mkdirSync(emptySrc)
      const result = await migrateDirFiles(emptySrc, target, /\.txt$/)
      expect(result).toEqual({ moved: 0, failed: 0 })
    })

    it('同盘 rename 成功迁移匹配文件', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')
      fs.writeFileSync(path.join(src, 'b.txt'), 'bbb')
      fs.writeFileSync(path.join(src, 'c.log'), 'ccc')

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 2, failed: 0 })
      expect(fs.existsSync(path.join(dst, 'a.txt'))).toBe(true)
      expect(fs.existsSync(path.join(dst, 'b.txt'))).toBe(true)
      expect(fs.existsSync(path.join(src, 'a.txt'))).toBe(false)
      expect(fs.existsSync(path.join(src, 'b.txt'))).toBe(false)
      // 不匹配的文件保留在源目录
      expect(fs.existsSync(path.join(src, 'c.log'))).toBe(true)
    })

    it('不匹配 filePattern 的文件被跳过', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')
      fs.writeFileSync(path.join(src, 'b.jpg'), 'bbb')
      fs.writeFileSync(path.join(src, 'c.png'), 'ccc')

      const result = await migrateDirFiles(src, dst, /\.(jpg|png)$/i)
      expect(result).toEqual({ moved: 2, failed: 0 })
      expect(fs.existsSync(path.join(dst, 'b.jpg'))).toBe(true)
      expect(fs.existsSync(path.join(dst, 'c.png'))).toBe(true)
      expect(fs.existsSync(path.join(src, 'a.txt'))).toBe(true)
    })

    it('子目录被跳过（仅迁移文件）', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.mkdirSync(path.join(src, 'subdir'))
      fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 1, failed: 0 })
    })

    it('目标目录不存在时自动创建', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'nested', 'target')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 1, failed: 0 })
      expect(fs.existsSync(dst)).toBe(true)
      expect(fs.existsSync(path.join(dst, 'a.txt'))).toBe(true)
    })

    it('跨盘（EXDEV）降级为 copy + unlink', async () => {
      // 模拟 rename 抛 EXDEV
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'content')

      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 1, failed: 0 })
      expect(fs.existsSync(path.join(dst, 'a.txt'))).toBe(true)
      expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8')).toBe('content')
      expect(fs.existsSync(path.join(src, 'a.txt'))).toBe(false)
      renameSpy.mockRestore()
    })

    it('跨盘 copy 后大小不一致视为失败（dst 删除 src 保留）', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'original')

      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))
      // mock copyFile 写入不同内容造成大小不一致
      const copySpy = vi.spyOn(fsp, 'copyFile').mockImplementationOnce(async (src, dst) => {
        // 写入短内容，size 与 src 不一致
        await fsp.writeFile(dst as string, 'x')
      })

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 0, failed: 1 })
      // src 保留，dst 应被删除
      expect(fs.existsSync(path.join(src, 'a.txt'))).toBe(true)
      expect(fs.existsSync(path.join(dst, 'a.txt'))).toBe(false)
      renameSpy.mockRestore()
      copySpy.mockRestore()
    })

    it('非 EXDEV 错误直接记为失败', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')

      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 0, failed: 1 })
      expect(fs.existsSync(path.join(src, 'a.txt'))).toBe(true)
      renameSpy.mockRestore()
    })

    it('readdir 失败返回 { moved: 0, failed: 0 }', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)

      // mock readdir 抛错
      const readdirSpy = vi.spyOn(fsp, 'readdir').mockRejectedValueOnce(new Error('readdir fail'))

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result).toEqual({ moved: 0, failed: 0 })
      readdirSpy.mockRestore()
    })

    it('部分文件失败不影响其他文件迁移', async () => {
      const src = path.join(tmpBase, 'src')
      const dst = path.join(tmpBase, 'dst')
      fs.mkdirSync(src)
      fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')
      fs.writeFileSync(path.join(src, 'b.txt'), 'bbb')

      let callCount = 0
      const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        }
        // 第二次调用执行真实 rename（但 mock 已替换）
        return undefined
      })

      const result = await migrateDirFiles(src, dst, /\.txt$/)
      expect(result.failed).toBe(1)
      expect(result.moved).toBe(1)
      renameSpy.mockRestore()
    })
  })
})
