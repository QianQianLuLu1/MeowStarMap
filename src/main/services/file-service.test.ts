import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
// 改用 import 方式获取 mock 模块（vitest ESM 环境下 require 不可靠）
import { shell, dialog } from 'electron'
import exifr from 'exifr'
import * as fileUtils from '../utils/file-utils'

/**
 * @layer L2
 * @module src/main/services/file-service
 * @coverage 回收站/复制/移动/重命名/批量重命名/导出/另存为/永久删除/EXIF/DataUrl/导入预览/批量导入
 * @dependencies electron, fs, sharp, exifr, file-utils, media-constants, disk
 * @remarks mock electron/sharp/exifr；使用真实 fs + 临时目录
 */

vi.mock('electron', () => ({
  shell: {
    trashItem: vi.fn().mockResolvedValue(undefined)
  },
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [] })
  }
}))

// sharp mock：链式调用；toFile 实际写入文件以便测试验证导出文件存在
vi.mock('sharp', () => {
  const chain = {
    jpeg: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    metadata: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
    toFile: vi.fn().mockImplementation((targetPath: string) => {
      fs.writeFileSync(targetPath, Buffer.from('mock-jpg'))
      return Promise.resolve()
    })
  }
  return { default: vi.fn(() => chain) }
})

// exifr mock
vi.mock('exifr', () => ({
  default: {
    parse: vi.fn().mockResolvedValue(null)
  }
}))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logFault: vi.fn(),
  getLogDirectory: vi.fn(() => '/mock/logs')
}))

// file-utils mock：保留 pathExists 真实实现，便于冲突检测
vi.mock('../utils/file-utils', async () => {
  const actual = await vi.importActual<typeof import('../utils/file-utils')>('../utils/file-utils')
  return {
    ...actual
    // 其余保留原实现
  }
})

import { FileService } from './file-service'
// 同一个 PathGuard 单例（file-service.ts 内部用的就是它），用于在 fixture 里声明写入根
import { pathGuard } from '../ipc/validator'

// ============================================================
// Helpers
// ============================================================

let tmpRoot: string
let service: FileService

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wxnn-file-'))
  // 写通道的白名单前提必须显式声明：PathGuard 默认只放行「用户主目录 / userData / 已登记根」。
  // 本机 Windows 上 os.tmpdir() 恰好落在 C:\Users\<u>\AppData\Local\Temp 里，被 userHome 前缀
  // 顺带放行；CI 的 ubuntu runner 上 /tmp 不在 /home/runner 之下，同一条用例会判
  // 「路径不在白名单内」（2026-10-19 CI 注记 file-service.test.ts:464 即为此）。
  // 产品里目标目录一律来自对话框登记，所以 register 才是与生产同形的 fixture。
  pathGuard.register(tmpRoot)
  service = new FileService()
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function makeFile(relPath: string, content: Buffer = Buffer.from('hello')): string {
  const fullPath = path.join(tmpRoot, relPath)
  fs.mkdirSync(path.dirname(fullPath), { recursive: true })
  fs.writeFileSync(fullPath, content)
  return fullPath
}

// ============================================================
// moveToRecycleBin
// ============================================================

describe('moveToRecycleBin', () => {
  it('成功移至回收站', async () => {
    vi.mocked(shell.trashItem).mockResolvedValue(undefined)
    const r = await service.moveToRecycleBin(['C:\\a.jpg', 'C:\\b.jpg'])
    expect(r.success).toBe(true)
    expect(r.message).toContain('2')
  })

  it('trashItem 抛错时返回失败', async () => {
    vi.mocked(shell.trashItem).mockRejectedValue(new Error('EACCES'))
    const r = await service.moveToRecycleBin(['C:\\a.jpg'])
    expect(r.success).toBe(false)
    expect(r.message).toContain('EACCES')
  })

  it('空数组也返回成功', async () => {
    const r = await service.moveToRecycleBin([])
    expect(r.success).toBe(true)
  })
})

// ============================================================
// copyFiles
// ============================================================

describe('copyFiles', () => {
  it('成功复制多个文件', async () => {
    const src1 = makeFile('src/a.jpg', Buffer.from('aaa'))
    const src2 = makeFile('src/b.jpg', Buffer.from('bbb'))
    const targetDir = path.join(tmpRoot, 'target')
    const r = await service.copyFiles([src1, src2], targetDir)
    expect(r.success).toBe(true)
    expect(r.actualPaths).toHaveLength(2)
    expect(fs.existsSync(r.actualPaths![0])).toBe(true)
    expect(fs.existsSync(r.actualPaths![1])).toBe(true)
  })

  it('目标目录已存在文件时自动重命名', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'target')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'a.jpg'), Buffer.from('existing'))
    const r = await service.copyFiles([src], targetDir)
    expect(r.success).toBe(true)
    expect(r.actualPaths![0]).toMatch(/a_1\.jpg$/)
  })

  it('源文件不存在时跳过 stat 但仍返回成功', async () => {
    const targetDir = path.join(tmpRoot, 'target')
    const r = await service.copyFiles([path.join(tmpRoot, 'not_exist.jpg')], targetDir)
    expect(r.success).toBe(false) // copyFile 失败
  })
})

// ============================================================
// moveFiles
// ============================================================

describe('moveFiles', () => {
  it('成功移动文件', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'target')
    const r = await service.moveFiles([src], targetDir)
    expect(r.success).toBe(true)
    expect(fs.existsSync(r.actualPaths![0])).toBe(true)
    expect(fs.existsSync(src)).toBe(false)
  })

  it('跨设备移动失败时返回 EBUSY/EPERM 友好提示', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'target')
    // mock moveFile 抛 EBUSY：通过 spyOn file-utils 实现
    const moveFileSpy = vi
      .spyOn(fileUtils, 'moveFile')
      .mockRejectedValueOnce(Object.assign(new Error('resource busy'), { code: 'EBUSY' }))
    const r = await service.moveFiles([src], targetDir)
    expect(r.success).toBe(false)
    expect(r.message).toContain('占用')
    moveFileSpy.mockRestore()
  })

  it('FIX(组14-1): 批量移动中途失败时回传已完成项的 renamed 映射且终止后续项', async () => {
    const src1 = makeFile('src/m1.jpg', Buffer.from('1'))
    const src2 = makeFile('src/m2.jpg', Buffer.from('2'))
    const src3 = makeFile('src/m3.jpg', Buffer.from('3'))
    const targetDir = path.join(tmpRoot, 'target-partial')
    // 第 2 项 EBUSY 失败，其余走真实移动
    const originalMove = fileUtils.moveFile
    let call = 0
    const moveFileSpy = vi
      .spyOn(fileUtils, 'moveFile')
      .mockImplementation(async (from: string, to: string) => {
        call++
        if (call === 2) {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
        }
        return originalMove(from, to)
      })
    const r = await service.moveFiles([src1, src2, src3], targetDir)
    moveFileSpy.mockRestore()

    expect(r.success).toBe(false)
    expect(r.message).toContain('占用')
    // 已成功移动的第 1 项映射必须回传（供 handler 同步 DB，修复前被 catch 丢弃）
    expect(r.renamed).toHaveLength(1)
    expect(r.renamed![0].oldPath).toBe(src1)
    expect(r.actualPaths).toHaveLength(1)
    // 失败后终止：第 3 项未被尝试（moveFile 共调用 2 次），源文件仍在原地
    expect(call).toBe(2)
    expect(fs.existsSync(src1)).toBe(false)
    expect(fs.existsSync(src2)).toBe(true)
    expect(fs.existsSync(src3)).toBe(true)
  })
})

// ============================================================
// renameFile
// ============================================================

describe('renameFile', () => {
  it('成功重命名', async () => {
    const src = makeFile('src/old_name.jpg', Buffer.from('aaa'))
    const r = await service.renameFile(src, 'new_name')
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(path.dirname(src), 'new_name.jpg'))).toBe(true)
    expect(fs.existsSync(src)).toBe(false)
  })

  it('包含非法字符（\\）时返回失败', async () => {
    const src = makeFile('src/a.jpg')
    const r = await service.renameFile(src, 'new\\name')
    expect(r.success).toBe(false)
    expect(r.message).toContain('非法字符')
  })

  it('包含路径分隔符（/）时返回失败', async () => {
    const src = makeFile('src/a.jpg')
    const r = await service.renameFile(src, 'sub/name')
    expect(r.success).toBe(false)
    expect(r.message).toContain('非法')
  })

  it('文件名为 .. 时返回失败', async () => {
    const src = makeFile('src/a.jpg')
    const r = await service.renameFile(src, '..')
    expect(r.success).toBe(false)
    expect(r.message).toContain('路径引用')
  })

  it('目标文件已存在时返回失败', async () => {
    const src = makeFile('src/a.jpg')
    makeFile('src/b.jpg')
    const r = await service.renameFile(src, 'b')
    expect(r.success).toBe(false)
    expect(r.message).toContain('同名文件')
  })
})

// ============================================================
// batchRename
// ============================================================

describe('batchRename', () => {
  it('成功批量重命名', async () => {
    const f1 = makeFile('a.jpg', Buffer.from('1'))
    const f2 = makeFile('b.jpg', Buffer.from('2'))
    const r = await service.batchRename([
      { oldPath: f1, newName: 'x' },
      { oldPath: f2, newName: 'y' }
    ])
    expect(r.success).toBe(true)
    expect(r.renamed).toHaveLength(2)
    expect(r.failed).toHaveLength(0)
  })

  it('单个失败不影响其他文件', async () => {
    const f1 = makeFile('a.jpg')
    const r = await service.batchRename([
      { oldPath: f1, newName: 'valid' },
      { oldPath: path.join(tmpRoot, 'not_exist.jpg'), newName: 'ok' }
    ])
    expect(r.success).toBe(false)
    expect(r.renamed).toHaveLength(1)
    expect(r.failed).toHaveLength(1)
  })

  it('批次内同名时自动追加 _N', async () => {
    const f1 = makeFile('a.jpg')
    const f2 = makeFile('b.jpg')
    const r = await service.batchRename([
      { oldPath: f1, newName: 'same' },
      { oldPath: f2, newName: 'same' }
    ])
    expect(r.success).toBe(true)
    expect(r.renamed[0].newFileName).toBe('same.jpg')
    expect(r.renamed[1].newFileName).toMatch(/same_1\.jpg$/)
  })

  it('空操作列表返回 success:true', async () => {
    const r = await service.batchRename([])
    expect(r.success).toBe(true)
    expect(r.renamed).toHaveLength(0)
  })

  it('包含非法字符的项计入 failed', async () => {
    const f1 = makeFile('a.jpg')
    const r = await service.batchRename([{ oldPath: f1, newName: 'a/b' }])
    expect(r.success).toBe(false)
    expect(r.failed).toHaveLength(1)
  })
})

// ============================================================
// exportFiles
// ============================================================

describe('exportFiles', () => {
  it('format=original 时直接复制文件', async () => {
    const src = makeFile('a.jpg', Buffer.from('jpg-bytes'))
    const targetDir = path.join(tmpRoot, 'export')
    const r = await service.exportFiles([src], targetDir, { format: 'original' })
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'a.jpg'))).toBe(true)
  })

  it('format=jpg 时通过 sharp 转换格式', async () => {
    const src = makeFile('a.png', Buffer.from('png-bytes'))
    const targetDir = path.join(tmpRoot, 'export')
    const r = await service.exportFiles([src], targetDir, { format: 'jpg', quality: 80 })
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'a.jpg'))).toBe(true)
  })

  it('namingPattern 变量替换正确', async () => {
    const src = makeFile('a.jpg', Buffer.from('jpg-bytes'))
    const targetDir = path.join(tmpRoot, 'export')
    const meta = new Map([[src, { album_type: 'NikkiPhotos', account_uid: 'uid_001' } as never]])
    const r = await service.exportFiles(
      [src],
      targetDir,
      {
        format: 'original',
        namingPattern: '{album_type}_{uid}_{original_name}_{sequence}'
      },
      meta
    )
    expect(r.success).toBe(true)
    // readdirSync 返回数组，应用 toContainEqual 匹配单项
    const files = fs.readdirSync(targetDir)
    expect(files).toContainEqual(expect.stringMatching(/NikkiPhotos_uid_001_a_001\.jpg$/))
  })

  it('目标文件冲突时自动重命名', async () => {
    const src = makeFile('a.jpg', Buffer.from('src'))
    const targetDir = path.join(tmpRoot, 'export')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'a.jpg'), Buffer.from('existing'))
    const r = await service.exportFiles([src], targetDir, { format: 'original' })
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'a_1.jpg'))).toBe(true)
  })

  /**
   * 回归（用户报障「批量导出到一半就断、文件不全」）：原实现把整个 for 循环包在**单一 try**
   * 里，第 N 个文件抛错即中断其余文件，且只回一条 formatFileError 泛化消息、不报已成功数量。
   * 现改为逐文件 try/catch（形态照抄同服务 batchRename 的 renamed/failed）。
   */
  it('P1 单个源文件失败时其余文件照常导出，并如实回报成功/失败数', async () => {
    const good = makeFile('good.jpg', Buffer.from('good-bytes'))
    const missing = makeFile('missing.jpg', Buffer.from('to-be-removed'))
    const targetDir = path.join(tmpRoot, 'export-partial')
    fs.rmSync(missing)

    const r = await service.exportFiles([good, missing], targetDir, { format: 'original' })

    expect(r.success).toBe(false)
    // 已成功的那张必须真实落盘（原实现在 missing 之前处理 good，但若失败点在第 1 个则全丢）
    expect(fs.existsSync(path.join(targetDir, 'good.jpg'))).toBe(true)
    // 计数进消息：不新增返回字段（FileOpResult 形状已被 DEBT-011 冻结），走 i18n 文案
    expect(r.message).toContain('成功 1 个')
    expect(r.message).toContain('失败 1 个')
  })

  it('P2 全部成功时仍回报「已导出 N 个文件」（守住既有文案，防改造回退）', async () => {
    const a = makeFile('p2a.jpg', Buffer.from('a'))
    const b = makeFile('p2b.jpg', Buffer.from('b'))
    const targetDir = path.join(tmpRoot, 'export-all-ok')
    const r = await service.exportFiles([a, b], targetDir, { format: 'original' })
    expect(r.success).toBe(true)
    expect(r.message).toContain('2')
    expect(fs.existsSync(path.join(targetDir, 'p2a.jpg'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'p2b.jpg'))).toBe(true)
  })

  /**
   * 服务层纵深防御（非本次用户报障成因：当前 UI 只传 {} / {useDefaultDir:true}，
   * 不会带 format 走这条分支）。原实现把"是否转码"与"目标扩展名"绑在一起，
   * 于是 .mp4「转 jpg」会产出一个改了名的原始字节文件——扩展名说自己是 jpg，内容不是。
   */
  it('P3 非图片源在要求转码格式时保持源扩展名，不产出改了名的原始字节', async () => {
    const src = makeFile('clip.mp4', Buffer.from('mp4-bytes'))
    const targetDir = path.join(tmpRoot, 'export-video')
    const r = await service.exportFiles([src], targetDir, { format: 'jpg' })
    expect(r.success).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'clip.mp4'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'clip.jpg'))).toBe(false)
  })

  it('P4 空路径数组不再回报成功（同为服务层纵深防御，IPC 层已被 min(1) 拦下）', async () => {
    const targetDir = path.join(tmpRoot, 'export-empty')
    const r = await service.exportFiles([], targetDir, { format: 'original' })
    expect(r.success).toBe(false)
  })
})

// ============================================================
// saveAs
// ============================================================

describe('saveAs', () => {
  it('成功另存为指定名称', async () => {
    const src = makeFile('a.jpg', Buffer.from('data'))
    const targetDir = path.join(tmpRoot, 'saveas')
    const r = await service.saveAs(src, targetDir, 'renamed')
    expect(r.success).toBe(true)
    expect(r.newPath).toContain('renamed.jpg')
    expect(fs.existsSync(r.newPath!)).toBe(true)
  })

  it('未提供 newName 时使用原文件名', async () => {
    const src = makeFile('a.jpg', Buffer.from('data'))
    const targetDir = path.join(tmpRoot, 'saveas')
    const r = await service.saveAs(src, targetDir)
    expect(r.success).toBe(true)
    expect(r.newPath).toContain('a.jpg')
  })
})

// ============================================================
// deletePermanent
// ============================================================

describe('deletePermanent', () => {
  it('成功永久删除文件', async () => {
    const f1 = makeFile('a.jpg')
    const f2 = makeFile('b.jpg')
    const r = await service.deletePermanent([f1, f2])
    expect(r.success).toBe(true)
    expect(fs.existsSync(f1)).toBe(false)
    expect(fs.existsSync(f2)).toBe(false)
  })

  it('文件不存在（ENOENT）视为已删除', async () => {
    const r = await service.deletePermanent([path.join(tmpRoot, 'not_exist.jpg')])
    expect(r.success).toBe(true)
    expect(r.message).toContain('1')
  })

  it('其他错误（EACCES）如实反馈失败', async () => {
    const f1 = makeFile('a.jpg')
    const unlinkSpy = vi
      .spyOn(fs.promises, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const r = await service.deletePermanent([f1])
    expect(r.success).toBe(false)
    // 源码用 err.message 拼接失败信息，故消息包含 'permission denied'
    expect(r.message).toContain('permission denied')
    unlinkSpy.mockRestore()
  })
})

// ============================================================
// getExif
// ============================================================

describe('getExif', () => {
  it('exifr.parse 返回 null 时返回空对象', async () => {
    vi.mocked(exifr.parse).mockResolvedValueOnce(null)
    const r = await service.getExif(path.join(tmpRoot, 'a.jpg'))
    expect(r).toEqual({})
  })

  it('成功解析 EXIF 信息', async () => {
    vi.mocked(exifr.parse).mockResolvedValueOnce({
      Make: 'Canon',
      Model: 'EOS R5',
      LensModel: '50mm f/1.8',
      FNumber: 1.8,
      ExposureTime: 0.005,
      ISO: 100,
      FocalLength: 50,
      DateTimeOriginal: new Date('2026-01-01T00:00:00Z'),
      ExifImageWidth: 1920,
      ExifImageHeight: 1080
    })
    const r = await service.getExif(path.join(tmpRoot, 'a.jpg'))
    expect(r.camera).toContain('Canon')
    expect(r.aperture).toBe('f/1.8')
    expect(r.shutter).toBe('1/200')
    expect(r.iso).toBe(100)
  })

  it('exifr 抛错时返回空对象', async () => {
    vi.mocked(exifr.parse).mockRejectedValueOnce(new Error('parse fail'))
    const r = await service.getExif(path.join(tmpRoot, 'a.jpg'))
    expect(r).toEqual({})
  })
})

// ============================================================
// saveDataUrl
// ============================================================

describe('saveDataUrl', () => {
  it('成功保存 DataURL 到指定目录', async () => {
    const targetDir = path.join(tmpRoot, 'dataurl')
    // 源码 saveDataUrl 不自动创建目录，需预先创建
    fs.mkdirSync(targetDir, { recursive: true })
    const r = await service.saveDataUrl('data:image/jpeg;base64,AAA=', {
      directory: targetDir,
      fileName: 'test'
    })
    expect(r.success).toBe(true)
    expect(r.filePath).toContain('test.jpg')
    expect(fs.existsSync(r.filePath!)).toBe(true)
  })

  it('文件超过 100MB 时返回失败', async () => {
    const targetDir = path.join(tmpRoot, 'dataurl')
    // mock parseDataUrlToBuffer 返回超大 buffer
    vi.spyOn(fileUtils, 'parseDataUrlToBuffer').mockReturnValueOnce({
      buffer: Buffer.alloc(101 * 1024 * 1024),
      mimeType: 'image/jpeg'
    })
    const r = await service.saveDataUrl('data:image/jpeg;base64,AAA=', {
      directory: targetDir,
      fileName: 'big'
    })
    expect(r.success).toBe(false)
    expect(r.message).toContain('超过限制')
  })

  it('未指定 directory 且 dialog 取消时返回失败', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const r = await service.saveDataUrl('data:image/jpeg;base64,AAA=')
    expect(r.success).toBe(false)
    expect(r.message).toContain('未选择')
  })
})

// ============================================================
// previewImport
// ============================================================

describe('previewImport', () => {
  it('源路径不是目录时返回失败', async () => {
    const f = makeFile('a.jpg')
    const r = await service.previewImport(f)
    expect(r.success).toBe(false)
    expect(r.message).toContain('不是目录')
  })

  it('源路径不存在时返回失败', async () => {
    const r = await service.previewImport(path.join(tmpRoot, 'not_exist'))
    expect(r.success).toBe(false)
    expect(r.message).toContain('无法访问')
  })

  it('递归扫描目录返回所有支持的媒体文件', async () => {
    makeFile('src/a.jpg')
    makeFile('src/sub/b.png')
    makeFile('src/sub/deep/c.mp4')
    makeFile('src/ignore.txt')
    const r = await service.previewImport(path.join(tmpRoot, 'src'))
    expect(r.success).toBe(true)
    expect(r.files).toHaveLength(3)
    const names = r.files.map((f) => f.fileName).sort()
    expect(names).toEqual(['a.jpg', 'b.png', 'c.mp4'])
  })

  it('isVideo 字段根据扩展名正确判定', async () => {
    makeFile('src/a.jpg')
    makeFile('src/b.mp4')
    const r = await service.previewImport(path.join(tmpRoot, 'src'))
    const jpg = r.files.find((f) => f.fileName === 'a.jpg')
    const mp4 = r.files.find((f) => f.fileName === 'b.mp4')
    expect(jpg?.isVideo).toBe(false)
    expect(mp4?.isVideo).toBe(true)
  })
})

// ============================================================
// importFiles
// ============================================================

describe('importFiles', () => {
  it('成功按 keep 命名 + flat 分类导入', async () => {
    const src1 = makeFile('src/a.jpg', Buffer.from('aaa'))
    const src2 = makeFile('src/b.jpg', Buffer.from('bbb'))
    const targetDir = path.join(tmpRoot, 'imported')
    const r = await service.importFiles([src1, src2], targetDir, {
      namingRule: 'keep',
      categorize: 'flat',
      conflictStrategy: 'skip'
    })
    expect(r.success).toBe(true)
    expect(r.imported).toHaveLength(2)
    expect(fs.existsSync(path.join(targetDir, 'a.jpg'))).toBe(true)
  })

  it('conflictStrategy=skip 时跳过已存在文件', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'imported')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'a.jpg'), Buffer.from('existing'))
    const r = await service.importFiles([src], targetDir, {
      namingRule: 'keep',
      categorize: 'flat',
      conflictStrategy: 'skip'
    })
    expect(r.skipped).toHaveLength(1)
    expect(r.imported).toHaveLength(0)
  })

  it('conflictStrategy=rename 时自动重命名', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'imported')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'a.jpg'), Buffer.from('existing'))
    const r = await service.importFiles([src], targetDir, {
      namingRule: 'keep',
      categorize: 'flat',
      conflictStrategy: 'rename'
    })
    expect(r.imported).toHaveLength(1)
    expect(r.imported[0].targetPath).toMatch(/a_1\.jpg$/)
  })

  it('categorize=byDate 时按日期分目录', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'imported')
    const r = await service.importFiles([src], targetDir, {
      namingRule: 'keep',
      categorize: 'byDate',
      conflictStrategy: 'skip'
    })
    expect(r.success).toBe(true)
    // 目标路径应包含 YYYY-MM-DD 子目录
    expect(r.imported[0].targetPath).toMatch(/\d{4}-\d{2}-\d{2}[\\/]a\.jpg$/)
  })

  it('categorize=byMonth 时按月份分目录', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'imported')
    const r = await service.importFiles([src], targetDir, {
      namingRule: 'keep',
      categorize: 'byMonth',
      conflictStrategy: 'skip'
    })
    expect(r.success).toBe(true)
    expect(r.imported[0].targetPath).toMatch(/\d{4}-\d{2}[\\/]a\.jpg$/)
  })

  it('namingRule=date 时按 mtime 命名', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'imported')
    const r = await service.importFiles([src], targetDir, {
      namingRule: 'date',
      categorize: 'flat',
      conflictStrategy: 'skip'
    })
    expect(r.success).toBe(true)
    expect(r.imported[0].targetPath).toMatch(/\d{8}_\d{6}\.jpg$/)
  })

  it('namingRule=seq 时按序号命名', async () => {
    const src = makeFile('src/a.jpg', Buffer.from('aaa'))
    const targetDir = path.join(tmpRoot, 'imported')
    const r = await service.importFiles([src], targetDir, {
      namingRule: 'seq',
      categorize: 'flat',
      conflictStrategy: 'skip',
      seqStart: 5
    })
    expect(r.success).toBe(true)
    expect(r.imported[0].targetPath).toMatch(/0005\.jpg$/)
  })

  it('源文件不存在时计入 failed', async () => {
    const targetDir = path.join(tmpRoot, 'imported')
    const r = await service.importFiles([path.join(tmpRoot, 'not_exist.jpg')], targetDir, {
      namingRule: 'keep',
      categorize: 'flat',
      conflictStrategy: 'skip'
    })
    expect(r.success).toBe(false)
    expect(r.failed).toHaveLength(1)
  })

  it('onProgress 回调被正确触发', async () => {
    const src1 = makeFile('src/a.jpg')
    const src2 = makeFile('src/b.jpg')
    const targetDir = path.join(tmpRoot, 'imported')
    const onProgress = vi.fn()
    await service.importFiles(
      [src1, src2],
      targetDir,
      { namingRule: 'keep', categorize: 'flat', conflictStrategy: 'skip' },
      onProgress
    )
    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith(2, 2)
  })
})
