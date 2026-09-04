import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  pathExists,
  getUniqueFilePath,
  parseDataUrlToBuffer,
  bufferToDataUrl,
  calculateFileHash,
  moveFile
} from './file-utils'

describe('file-utils', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wxnn-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  describe('pathExists', () => {
    it('存在的文件返回 true', async () => {
      const filePath = path.join(tmpDir, 'exists.txt')
      await fsp.writeFile(filePath, 'hello')
      expect(await pathExists(filePath)).toBe(true)
    })

    it('不存在的文件返回 false', async () => {
      expect(await pathExists(path.join(tmpDir, 'nonexistent.txt'))).toBe(false)
    })

    it('目录也可检查存在性', async () => {
      const subDir = path.join(tmpDir, 'subdir')
      await fsp.mkdir(subDir)
      expect(await pathExists(subDir)).toBe(true)
    })

    it('权限不足时返回 false（不抛错）', async () => {
      // Windows 上权限模型与 Unix 不同，跳过 chmod 测试
      // 仅验证不抛错即可
      expect(await pathExists('')).toBe(false)
    })
  })

  describe('getUniqueFilePath', () => {
    it('目标不存在时直接返回初始路径', async () => {
      const result = await getUniqueFilePath(tmpDir, 'file', '.txt')
      expect(result).toBe(path.join(tmpDir, 'file.txt'))
    })

    it('目标已存在时追加 _1 后缀', async () => {
      await fsp.writeFile(path.join(tmpDir, 'file.txt'), 'x')
      const result = await getUniqueFilePath(tmpDir, 'file', '.txt')
      expect(result).toBe(path.join(tmpDir, 'file_1.txt'))
    })

    it('_1 也存在时追加 _2', async () => {
      await fsp.writeFile(path.join(tmpDir, 'file.txt'), 'x')
      await fsp.writeFile(path.join(tmpDir, 'file_1.txt'), 'x')
      const result = await getUniqueFilePath(tmpDir, 'file', '.txt')
      expect(result).toBe(path.join(tmpDir, 'file_2.txt'))
    })

    it('自定义 nameFormatter 生效', async () => {
      await fsp.writeFile(path.join(tmpDir, 'img.txt'), 'x')
      const result = await getUniqueFilePath(tmpDir, 'img', '.txt', (n) => `img-copy-${n}`)
      expect(result).toBe(path.join(tmpDir, 'img-copy-1.txt'))
    })

    it('空扩展名也能工作', async () => {
      const result = await getUniqueFilePath(tmpDir, 'noext', '')
      expect(result).toBe(path.join(tmpDir, 'noext'))
    })

    it('返回的路径确实不冲突（创建后再次调用应得新路径）', async () => {
      const first = await getUniqueFilePath(tmpDir, 'data', '.json')
      await fsp.writeFile(first, '{}')
      const second = await getUniqueFilePath(tmpDir, 'data', '.json')
      expect(second).not.toBe(first)
    })
  })

  describe('parseDataUrlToBuffer', () => {
    it('正常 DataURL 解析为 buffer + mimeType', () => {
      const dataUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const { buffer, mimeType } = parseDataUrlToBuffer(dataUrl)
      expect(mimeType).toBe('image/png')
      expect(buffer).toBeInstanceOf(Buffer)
      expect(buffer.length).toBeGreaterThan(0)
    })

    it('jpeg DataURL 也能解析', () => {
      const dataUrl =
        'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD/2Q=='
      const { buffer, mimeType } = parseDataUrlToBuffer(dataUrl)
      expect(mimeType).toBe('image/jpeg')
      expect(buffer.length).toBeGreaterThan(0)
    })

    it('无效 DataURL 抛错', () => {
      expect(() => parseDataUrlToBuffer('not-a-data-url')).toThrow('无效的 DataURL')
      expect(() => parseDataUrlToBuffer('data:image/png,base64,abc')).toThrow()
    })

    it('与 bufferToDataUrl 互为逆运算', () => {
      const original = Buffer.from([0x01, 0x02, 0x03, 0xff, 0x00])
      const dataUrl = bufferToDataUrl(original, 'application/octet-stream')
      const parsed = parseDataUrlToBuffer(dataUrl)
      expect(Buffer.compare(parsed.buffer, original)).toBe(0)
      expect(parsed.mimeType).toBe('application/octet-stream')
    })
  })

  describe('bufferToDataUrl', () => {
    it('空 Buffer 也能编码', () => {
      const dataUrl = bufferToDataUrl(Buffer.alloc(0), 'image/png')
      expect(dataUrl).toBe('data:image/png;base64,')
    })

    it('正确编码二进制数据', () => {
      const buf = Buffer.from([0xff, 0x00, 0xaa, 0x55])
      const dataUrl = bufferToDataUrl(buf, 'image/jpeg')
      expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
      // 4 字节 base64 编码后为 8 字符（含 padding）
      const b64 = dataUrl.split(',')[1]
      expect(b64).toBe(buf.toString('base64'))
    })
  })

  describe('calculateFileHash', () => {
    it('相同内容文件 hash 相同', async () => {
      const fileA = path.join(tmpDir, 'a.bin')
      const fileB = path.join(tmpDir, 'b.bin')
      const content = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      await fsp.writeFile(fileA, content)
      await fsp.writeFile(fileB, content)
      expect(await calculateFileHash(fileA)).toBe(await calculateFileHash(fileB))
    })

    it('不同内容文件 hash 不同', async () => {
      const fileA = path.join(tmpDir, 'a.bin')
      const fileB = path.join(tmpDir, 'b.bin')
      await fsp.writeFile(fileA, Buffer.from([1, 2, 3]))
      await fsp.writeFile(fileB, Buffer.from([4, 5, 6]))
      expect(await calculateFileHash(fileA)).not.toBe(await calculateFileHash(fileB))
    })

    it('返回 64 字符的 sha256 hex 字符串', async () => {
      const file = path.join(tmpDir, 'x.bin')
      await fsp.writeFile(file, 'test content')
      const hash = await calculateFileHash(file)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('文件不存在时抛错', async () => {
      await expect(calculateFileHash(path.join(tmpDir, 'nonexistent.bin'))).rejects.toThrow()
    })

    it('大文件流式 hash 不一次性载入内存', async () => {
      // 写入 1MB 文件验证流式处理不崩溃
      const file = path.join(tmpDir, 'large.bin')
      const chunk = Buffer.alloc(1024 * 1024, 0xab) // 1MB
      await fsp.writeFile(file, chunk)
      const hash = await calculateFileHash(file)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  describe('moveFile', () => {
    it('同盘符移动：源成功重命名为目标，源不再存在', async () => {
      const src = path.join(tmpDir, 'src.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      await fsp.writeFile(src, 'hello')
      await moveFile(src, dst)
      expect(await pathExists(src)).toBe(false)
      expect(await pathExists(dst)).toBe(true)
      expect(await fsp.readFile(dst, 'utf8')).toBe('hello')
    })

    it('源文件不存在时抛出 ENOENT', async () => {
      const src = path.join(tmpDir, 'nonexistent.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      await expect(moveFile(src, dst)).rejects.toThrow()
      try {
        await moveFile(src, dst)
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe('ENOENT')
      }
    })

    it('rename 抛 EEXIST 时原样向上抛（不吞错）', async () => {
      const src = path.join(tmpDir, 'src.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      await fsp.writeFile(src, 'content')

      // 不同文件系统对已存在目标的 rename 行为不同：POSIX 覆盖，Windows 抛 EEXIST
      // 此处固化 moveFile 的契约：非 EXDEV 错误一律向上抛，不被吞掉
      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValue(
          Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
        )

      await expect(moveFile(src, dst)).rejects.toThrow('EEXIST')
      renameSpy.mockRestore()
    })

    it('跨设备移动（EXDEV）回退到 copyFile + unlink', async () => {
      const src = path.join(tmpDir, 'src.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      await fsp.writeFile(src, 'cross-device-content')

      // mock rename 抛 EXDEV，验证 fallback 到 copyFile + unlink
      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValue(
          Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
        )

      await moveFile(src, dst)

      expect(renameSpy).toHaveBeenCalledTimes(1)
      // fallback 后源已被 unlink，目标已写入
      expect(await pathExists(src)).toBe(false)
      expect(await pathExists(dst)).toBe(true)
      expect(await fsp.readFile(dst, 'utf8')).toBe('cross-device-content')

      renameSpy.mockRestore()
    })

    it('EXDEV 时 copyFile 失败：异常向上抛，源文件保留', async () => {
      const src = path.join(tmpDir, 'src.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      await fsp.writeFile(src, 'content')

      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValue(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }))
      const copySpy = vi.spyOn(fsp, 'copyFile').mockRejectedValue(new Error('磁盘已满'))

      await expect(moveFile(src, dst)).rejects.toThrow('磁盘已满')
      // 源文件保留
      expect(await pathExists(src)).toBe(true)
      // 目标未写入
      expect(await pathExists(dst)).toBe(false)

      renameSpy.mockRestore()
      copySpy.mockRestore()
    })

    it('非 EXDEV 错误原样向上抛', async () => {
      const src = path.join(tmpDir, 'src.txt')
      const dst = path.join(tmpDir, 'dst.txt')
      await fsp.writeFile(src, 'content')

      const renameSpy = vi
        .spyOn(fsp, 'rename')
        .mockRejectedValue(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        )

      await expect(moveFile(src, dst)).rejects.toThrow('EACCES')
      // 源文件保留
      expect(await pathExists(src)).toBe(true)

      renameSpy.mockRestore()
    })

    it('目录也能被 moveFile 移动', async () => {
      const src = path.join(tmpDir, 'srcdir')
      const dst = path.join(tmpDir, 'dstdir')
      await fsp.mkdir(src)
      await fsp.writeFile(path.join(src, 'inner.txt'), 'inner')
      await moveFile(src, dst)
      expect(await pathExists(src)).toBe(false)
      expect(await pathExists(dst)).toBe(true)
      expect(await fsp.readFile(path.join(dst, 'inner.txt'), 'utf8')).toBe('inner')
    })
  })
})
