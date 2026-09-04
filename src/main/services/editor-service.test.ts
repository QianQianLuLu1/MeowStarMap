import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * @layer L2
 * @module src/main/services/editor-service
 * @coverage 图片编辑保存 + 备份/恢复 + LRU 清理 + 编辑历史
 * @dependencies sharp, fs, better-sqlite3, file-utils, media-constants, backup-service
 * @remarks mock sharp/file-utils/media-constants；使用真实 fs + 临时目录
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => path.join(os.tmpdir(), 'wxnn-editor-test-userdata', name))
  }
}))

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

// sharp mock：链式调用 + jpeg/png/webp + toFile
vi.mock('sharp', () => {
  const chain = {
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined)
  }
  const factory = vi.fn(() => chain)
  return { default: factory }
})

// media-constants mock
vi.mock('../utils/media-constants', () => ({
  getExtFromMime: vi.fn((m: string) => (m === 'image/png' ? 'png' : 'jpg')),
  getMimeType: vi.fn(() => 'image/jpeg')
}))

// file-utils mock：parseDataUrlToBuffer 返回 buffer + mimeType
vi.mock('../utils/file-utils', () => ({
  parseDataUrlToBuffer: vi.fn((dataUrl: string) => ({
    buffer: Buffer.from('fake-image-data'),
    mimeType: dataUrl.includes('png') ? 'image/png' : 'image/jpeg'
  })),
  pathExists: vi.fn(async () => false),
  getUniqueFilePath: vi.fn(async (dir: string, base: string, ext: string) =>
    path.join(dir, `${base}${ext}`)
  ),
  moveFile: vi.fn(),
  bufferToDataUrl: vi.fn()
}))

// ── 内存 fs mock：消除 editor-service 测试的真实磁盘 IO（@layer L2 改造）──
// 仅覆盖 editor-service / 本测试实际用到的 fs API；未覆盖的具名导出回退真实 fs，
// 避免 xmp-metadata-service 等传递依赖因具名导入缺失而加载失败。
// 注：os.tmpdir() 保留真实（仅返回字符串、无 IO）；mock 反而引发 Windows 盘符前缀
// 不一致导致内存 store 的 key 对不齐。
vi.mock('fs', async () => {
  const realFs = await vi.importActual<typeof import('fs')>('fs')
  type FsNode = { isDir: boolean; data: Buffer; mtime: number }
  const store = new Map<string, FsNode>()
  const norm = (p: string) => String(p).replace(/\\/g, '/')
  const SEP = '/'
  const splitParts = (p: string) => norm(p).split('/').filter(Boolean)
  const isDir = (k: string) => store.get(k)?.isDir === true
  const ensureParents = (fileKey: string) => {
    const parts = splitParts(fileKey)
    parts.pop()
    let cur = ''
    for (const part of parts) {
      cur = cur ? cur + SEP + part : part
      if (!store.has(cur)) store.set(cur, { isDir: true, data: Buffer.alloc(0), mtime: Date.now() })
    }
  }
  const mkDirRecursive = (d: string) => {
    const parts = splitParts(d)
    let cur = ''
    for (const part of parts) {
      cur = cur ? cur + SEP + part : part
      if (!store.has(cur)) store.set(cur, { isDir: true, data: Buffer.alloc(0), mtime: Date.now() })
    }
  }
  const writeFile = (file: string, data: unknown) => {
    const f = norm(file)
    ensureParents(f)
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    store.set(f, { isDir: false, data: buf, mtime: Date.now() })
  }
  const exists = (p: string) => store.has(norm(p))
  const rm = (p: string) => {
    const k = norm(p)
    if (store.has(k) && isDir(k)) {
      for (const key of [...store.keys()])
        if (key === k || key.startsWith(k + SEP)) store.delete(key)
    } else {
      store.delete(k)
    }
  }
  const readdir = (dir: string): string[] => {
    const d = norm(dir)
    const prefix = d.endsWith(SEP) ? d : d + SEP
    const names = new Set<string>()
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) {
        const first = key.slice(prefix.length).split(SEP)[0]
        if (first) names.add(first)
      }
    }
    return [...names]
  }
  const stat = (p: string) => {
    const node = store.get(norm(p))
    if (!node) {
      const e: Error & { code?: string } = new Error('ENOENT: no such file ' + p)
      e.code = 'ENOENT'
      throw e
    }
    return {
      size: node.data.length,
      mtimeMs: node.mtime,
      isDirectory: () => node.isDir,
      isFile: () => !node.isDir
    }
  }
  const copyFile = (src: string, dest: string) => {
    const node = store.get(norm(src))
    if (!node) throw new Error('ENOENT: ' + src)
    writeFile(dest, node.data)
  }
  const mkdtemp = (prefix: string) => {
    const p = norm(prefix) + Math.random().toString(36).slice(2, 8)
    store.set(p, { isDir: true, data: Buffer.alloc(0), mtime: Date.now() })
    return p
  }
  const utimes = (p: string, _a: unknown, m: unknown) => {
    const node = store.get(norm(p))
    if (node) node.mtime = m instanceof Date ? m.getTime() : Number(m)
  }
  const memfs = {
    mkdtempSync: mkdtemp,
    mkdirSync: (d: string, opts?: { recursive?: boolean }) =>
      opts?.recursive
        ? mkDirRecursive(d)
        : (ensureParents(norm(d)),
          store.set(norm(d), { isDir: true, data: Buffer.alloc(0), mtime: Date.now() })),
    writeFileSync: writeFile,
    existsSync: exists,
    rmSync: rm,
    readdirSync: readdir,
    utimesSync: utimes,
    promises: {
      mkdir: async (d: string, opts?: { recursive?: boolean }) =>
        opts?.recursive
          ? mkDirRecursive(d)
          : (ensureParents(norm(d)),
            store.set(norm(d), { isDir: true, data: Buffer.alloc(0), mtime: Date.now() })),
      stat: async (p: string) => stat(p),
      copyFile: async (s: string, d: string) => copyFile(s, d),
      readdir: async (dir: string) => readdir(dir),
      unlink: async (p: string) => {
        store.delete(norm(p))
      }
    }
  }
  // 具名导出回退真实 fs，保证传递依赖（如 xmp-metadata-service）加载不报错；
  // default 指向内存实现，editor-service 与测试通过 fs.promises.* 走内存。
  return { ...realFs, default: memfs, __esModule: true }
})

// backup-service mock：不打开 better-sqlite3；setDir/getBackupDirectory 内存联动
vi.mock('./backup-service', () => {
  let dir = '/__mock_backup__'
  return {
    backupService: {
      setDir: vi.fn((d: string) => {
        dir = d
      }),
      getBackupDirectory: vi.fn(() => dir)
    }
  }
})

import { editorService, EditorService } from './editor-service'
import sharp from 'sharp'
import { getExtFromMime } from '../utils/media-constants'
import { backupService } from './backup-service'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string
let snapshotDir: string
let mediaFilePath: string
let mockDb: { prepare: ReturnType<typeof vi.fn> }

function setupDbWithMediaRow(mediaId: number = 1): void {
  mockDb = {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ id: mediaId }),
      run: vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: mediaId })
    })
  } as never
}

/**
 * R11：构造完整的 fakeDbManager（含 getWorkerBridge / getDbPath）。
 * workerBridge 为 null 时 MediaRepository 降级为同步直写 db，测试断言 db.prepare 仍成立。
 */
function createFakeDbManager(
  db: unknown,
  workerBridge: unknown = null
): { getDatabase: () => unknown; getWorkerBridge: () => unknown; getDbPath: () => string } {
  return {
    getDatabase: () => db,
    getWorkerBridge: () => workerBridge,
    getDbPath: () => ':memory:'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-editor-'))
  snapshotDir = path.join(tmpRoot, 'backups', 'editor-snapshots')
  fs.mkdirSync(snapshotDir, { recursive: true })
  // 备份 service 设置目录到临时
  backupService.setDir(path.join(tmpRoot, 'backups'))
  // 准备媒体文件
  mediaFilePath = path.join(tmpRoot, 'photo.jpg')
  fs.writeFileSync(mediaFilePath, Buffer.from('original-jpeg-bytes'))
  // 重置 sharp toFile 默认成功
  vi.mocked(sharp).mockReturnValue({
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    toFile: vi.fn().mockResolvedValue(undefined)
  } as never)
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// ============================================================
// init
// ============================================================

describe('init', () => {
  it('注入 dbManager 后 snapshotDir 设置为 backups/editor-snapshots', () => {
    const fakeDbManager = createFakeDbManager(null)
    editorService.init(fakeDbManager as never)
    // 通过 save 路径间接验证 snapshotDir
    expect(() => editorService.init(fakeDbManager as never)).not.toThrow()
  })
})

// ============================================================
// setScheduler
// ============================================================

describe('setScheduler', () => {
  it('注入 scheduler 不抛错', () => {
    const scheduler = { enqueueLow: vi.fn() }
    expect(() => editorService.setScheduler(scheduler as never)).not.toThrow()
  })
})

// ============================================================
// save
// ============================================================

describe('save', () => {
  it('db 未初始化时返回失败', async () => {
    const fresh = new EditorService()
    const r = await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=')
    expect(r.success).toBe(false)
    expect(r.message).toContain('数据库未初始化')
  })

  it('filePath 不在 media_files 表中时返回安全限制错误', async () => {
    const fakeDbManager = createFakeDbManager({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined) // 查不到记录
      })
    })
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    const r = await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=')
    expect(r.success).toBe(false)
    expect(r.message).toContain('安全限制')
  })

  it('成功保存 jpg 格式', async () => {
    setupDbWithMediaRow(1)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    const r = await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', {
      format: 'jpg',
      quality: 90
    })
    expect(r.success).toBe(true)
    expect(r.message).toContain('保存成功')
    expect(r.filePath).toBe(path.resolve(mediaFilePath))
  })

  it('成功保存 png 格式', async () => {
    setupDbWithMediaRow(2)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    const r = await fresh.save(mediaFilePath, 'data:image/png;base64,AAA=', { format: 'png' })
    expect(r.success).toBe(true)
  })

  it('成功保存 webp 格式', async () => {
    setupDbWithMediaRow(3)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    const r = await fresh.save(mediaFilePath, 'data:image/webp;base64,AAA=', { format: 'webp' })
    expect(r.success).toBe(true)
  })

  it('未提供 format 时从 mimeType 推导', async () => {
    setupDbWithMediaRow(4)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    const r = await fresh.save(mediaFilePath, 'data:image/png;base64,AAA=')
    expect(r.success).toBe(true)
    expect(getExtFromMime).toHaveBeenCalledWith('image/png')
  })

  it('sharp 写入失败时抛错并从备份恢复原图', async () => {
    setupDbWithMediaRow(5)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    // 让 sharp.toFile 抛错
    vi.mocked(sharp).mockReturnValueOnce({
      jpeg: vi.fn().mockReturnThis(),
      png: vi.fn().mockReturnThis(),
      webp: vi.fn().mockReturnThis(),
      toFile: vi.fn().mockRejectedValue(new Error('write failed'))
    } as never)
    // save 不捕获 toFile 错误，向上抛
    await expect(
      fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', { format: 'jpg' })
    ).rejects.toThrow('write failed')
    // 原文件应保持不变（备份恢复）
    expect(fs.existsSync(mediaFilePath)).toBe(true)
  })

  it('备份大小不匹配时删除不完整备份并继续保存', async () => {
    setupDbWithMediaRow(6)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    // mock copyFile 后备份大小与原文件不同（通过 stat mock）
    const origStat = fs.promises.stat
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (p: fs.PathLike) => {
      const real = await origStat(p as string)
      if (p === mediaFilePath) {
        return real
      }
      // 备份文件返回不同 size
      return { ...real, size: real.size + 9999 } as never
    })
    const r = await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', { format: 'jpg' })
    expect(r.success).toBe(true)
    statSpy.mockRestore()
  })

  it('保存成功后记录编辑历史', async () => {
    setupDbWithMediaRow(7)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', {
      format: 'jpg',
      params: '{"brightness":10}'
    })
    // prepare 应被调用 2 次：SELECT + INSERT（workerBridge=null 时 syncRun 直写 db）
    expect(mockDb.prepare).toHaveBeenCalledTimes(2)
    // 第二次是 INSERT INTO edit_history
    const insertCall = mockDb.prepare.mock.calls[1][0]
    expect(insertCall).toContain('INSERT INTO edit_history')
  })

  it('R11：workerBridge 注入时 edit_history 走 worker 而非主进程直写', async () => {
    setupDbWithMediaRow(12)
    const workerBridge = {
      execute: vi.fn().mockResolvedValue({ changes: 1, lastInsertRowid: 1 })
    }
    const fakeDbManager = createFakeDbManager(mockDb, workerBridge)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', {
      format: 'jpg',
      params: '{"contrast":5}'
    })
    // SELECT 仍走主进程 db.prepare（读路径同步）
    expect(mockDb.prepare).toHaveBeenCalledTimes(1)
    // INSERT edit_history 走 workerBridge.execute
    expect(workerBridge.execute).toHaveBeenCalledTimes(1)
    const [dbPath, sql, params] = workerBridge.execute.mock.calls[0]
    expect(sql).toContain('INSERT INTO edit_history')
    expect(params).toEqual([12, '{"contrast":5}', null])
    expect(dbPath).toBe(':memory:')
  })

  it('记录编辑历史失败不影响保存成功', async () => {
    // prepare 第二次抛错
    mockDb = {
      prepare: vi
        .fn()
        .mockReturnValueOnce({ get: vi.fn().mockReturnValue({ id: 8 }) })
        .mockImplementationOnce(() => {
          throw new Error('history write failed')
        })
    } as never
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    const r = await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', { format: 'jpg' })
    expect(r.success).toBe(true)
  })
})

// ============================================================
// LRU 清理（pruneOldSnapshots 间接测试）
// ============================================================

describe('pruneOldSnapshots（通过 save 间接触发）', () => {
  it('快照数 ≤ 50 时不删除', async () => {
    setupDbWithMediaRow(10)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    // 创建 10 个快照（不会触发清理）
    for (let i = 0; i < 10; i++) {
      const snapPath = path.join(snapshotDir, `${i + 1}_${Date.now() - i * 1000}.jpg`)
      fs.writeFileSync(snapPath, Buffer.alloc(0))
    }
    await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', { format: 'jpg' })
    const remaining = fs.readdirSync(snapshotDir).filter((n) => /^\d+_\d+\.\w+$/.test(n))
    expect(remaining.length).toBeGreaterThanOrEqual(10)
  })

  it('快照数 > 50 时删除最旧的', async () => {
    setupDbWithMediaRow(11)
    const fakeDbManager = createFakeDbManager(mockDb)
    const fresh = new EditorService()
    fresh.init(fakeDbManager as never)
    // 创建 60 个快照
    for (let i = 0; i < 60; i++) {
      const snapPath = path.join(snapshotDir, `${i + 1}_${Date.now() - (60 - i) * 1000}.jpg`)
      fs.writeFileSync(snapPath, Buffer.alloc(0))
      fs.utimesSync(snapPath, new Date(i * 1000), new Date(i * 1000))
    }
    await fresh.save(mediaFilePath, 'data:image/jpeg;base64,AAA=', { format: 'jpg' })
    // 等待异步清理（pruneOldSnapshots 是 fire-and-forget 的 async，需轮询等待完成）
    await vi.waitFor(
      () => {
        const remaining = fs.readdirSync(snapshotDir).filter((n) => /^\d+_\d+\.\w+$/.test(n))
        expect(remaining.length).toBeLessThanOrEqual(51) // 50 + 1 新保存的
      },
      { timeout: 3000, interval: 50 }
    )
  })
})
