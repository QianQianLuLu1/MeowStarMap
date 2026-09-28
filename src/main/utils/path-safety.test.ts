/**
 * @layer L1
 * @module src/main/utils/path-safety
 * @coverage hasNonAsciiPath/ensureWritableDir/resolveSafeBinaryPath/hasWindowsExecutableHeader
 * @dependencies mock: electron (app), 使用真实 fs 与 os.tmpdir
 * @remarks 使用真实 fs 写入临时目录，验证特殊字符判定与目录可写性
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => os.tmpdir())
  }
}))

import {
  hasNonAsciiPath,
  ensureWritableDir,
  resolveSafeBinaryPath,
  hasWindowsExecutableHeader,
  hasValidPeStructure
} from './path-safety'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    try {
      fs.chmodSync(dir, 0o777)
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不阻塞
    }
  }
})

describe('hasNonAsciiPath', () => {
  it('中文路径返回 true', () => {
    expect(hasNonAsciiPath('C:\\中文\\app.exe')).toBe(true)
  })
  it('纯英文路径返回 false', () => {
    expect(hasNonAsciiPath('C:\\Program Files\\app.exe')).toBe(false)
  })
  it('空串返回 false（参数校验）', () => {
    expect(hasNonAsciiPath('')).toBe(false)
  })
})

describe('ensureWritableDir', () => {
  it('可创建并返回 true', () => {
    const dir = makeTmpDir()
    expect(ensureWritableDir(dir)).toBe(true)
    expect(fs.existsSync(dir)).toBe(true)
  })
  it('相对路径直接返回 false（参数校验）', () => {
    expect(ensureWritableDir('relative/path')).toBe(false)
  })
  it('只读目录返回 false（权限不足场景）', () => {
    const dir = makeTmpDir()
    // Windows 上 chmod 0o444 对目录不收回写权限（POSIX 语义才生效），
    // 故直接模拟 isValidDir 内部 fs.accessSync(dir, W_OK) 的 EACCES 拒绝，各平台行为一致
    const originalAccessSync = fs.accessSync
    const spy = vi.spyOn(fs, 'accessSync').mockImplementation((p, mode) => {
      if (p === dir && typeof mode === 'number' && mode & fs.constants.W_OK) {
        const denied = new Error(
          `EACCES: permission denied, access '${String(p)}'`
        ) as NodeJS.ErrnoException
        denied.code = 'EACCES'
        throw denied
      }
      originalAccessSync(p, mode)
    })
    try {
      expect(ensureWritableDir(dir)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('resolveSafeBinaryPath', () => {
  it('中文候选路径降级到系统 PATH fallback', () => {
    const candidate = 'D:\\中文目录\\ffmpeg.exe'
    const fallback = 'ffmpeg'
    expect(resolveSafeBinaryPath(candidate, fallback)).toBe(fallback)
  })
  it('存在且纯英文的候选采用本地路径', () => {
    const dir = makeTmpDir()
    const candidate = path.join(dir, 'bin.exe')
    fs.writeFileSync(candidate, 'x')
    expect(resolveSafeBinaryPath(candidate, 'fallback')).toBe(candidate)
  })
})

describe('hasWindowsExecutableHeader', () => {
  it('MZ 头二进制文件返回 true（正常）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'ffmpeg.exe')
    // 'MZ' DOS 头 + 任意后续内容，模拟真实 PE
    fs.writeFileSync(file, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))
    expect(hasWindowsExecutableHeader(file)).toBe(true)
  })
  it('文本占位文件（杀软替换场景）返回 false（异常）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'ffmpeg.exe')
    fs.writeFileSync(file, 'This program is blocked by your antivirus.', 'utf8')
    expect(hasWindowsExecutableHeader(file)).toBe(false)
  })
  it('0 字节文件返回 false（异常）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'ffmpeg.exe')
    fs.writeFileSync(file, '')
    expect(hasWindowsExecutableHeader(file)).toBe(false)
  })
  it('目录返回 false（异常）', () => {
    const dir = makeTmpDir()
    expect(hasWindowsExecutableHeader(dir)).toBe(false)
  })
  it('不存在的路径返回 false（异常）', () => {
    expect(hasWindowsExecutableHeader(path.join(os.tmpdir(), 'not-exist-at-all.bin'))).toBe(false)
  })
  it('空串返回 false（参数校验）', () => {
    expect(hasWindowsExecutableHeader('')).toBe(false)
  })
  it('恰 2 字节 MZ 返回 true（边界）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'tiny.exe')
    fs.writeFileSync(file, Buffer.from([0x4d, 0x5a]))
    expect(hasWindowsExecutableHeader(file)).toBe(true)
  })
  it('仅 1 字节 M 返回 false（边界）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'tiny.exe')
    fs.writeFileSync(file, Buffer.from([0x4d]))
    expect(hasWindowsExecutableHeader(file)).toBe(false)
  })
  it('非 MZ 开头的二进制返回 false（边界）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'elf.bin')
    // ELF 魔数 0x7f 'ELF'，非 Windows PE
    fs.writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    expect(hasWindowsExecutableHeader(file)).toBe(false)
  })
})

/**
 * 构造一个最小化的 PE 结构 Buffer，用于 hasValidPeStructure 测试。
 * 布局：DOS头(64B) + PE签名(4B) + COFF头(20B) + OptionalHeader(optSize B) + 节表(numSections*40B) + 填充到 totalSize
 */
function buildPeBuffer(opts: {
  machine?: number
  numSections?: number
  sizeOfOptionalHeader?: number
  sections?: Array<{ pointerToRawData: number; sizeOfRawData: number }>
  totalSize?: number
}): Buffer {
  const machine = opts.machine ?? 0x8664
  const numSections = opts.numSections ?? 1
  const sizeOfOptionalHeader = opts.sizeOfOptionalHeader ?? 112
  const e_lfanew = 64
  const sectionTableStart = e_lfanew + 24 + sizeOfOptionalHeader
  const minSize = sectionTableStart + numSections * 40
  const totalSize = opts.totalSize ?? Math.max(minSize, 2048)

  const buf = Buffer.alloc(totalSize, 0)
  // DOS 头: MZ 魔数
  buf[0] = 0x4d
  buf[1] = 0x5a
  // e_lfanew at offset 0x3C (little-endian uint32)
  buf.writeUInt32LE(e_lfanew, 0x3c)
  // PE 签名 at e_lfanew
  buf[0x50] = undefined as never // clear
  buf.writeUInt8(0x50, e_lfanew) // 'P'
  buf.writeUInt8(0x45, e_lfanew + 1) // 'E'
  buf.writeUInt8(0x00, e_lfanew + 2)
  buf.writeUInt8(0x00, e_lfanew + 3)
  // COFF 头 at e_lfanew+4
  buf.writeUInt16LE(machine, e_lfanew + 4) // Machine
  buf.writeUInt16LE(numSections, e_lfanew + 6) // NumberOfSections
  buf.writeUInt16LE(sizeOfOptionalHeader, e_lfanew + 20) // SizeOfOptionalHeader
  // 节表
  const sections = opts.sections ?? [{ pointerToRawData: 512, sizeOfRawData: 1024 }]
  for (let i = 0; i < Math.min(numSections, sections.length); i++) {
    const offset = sectionTableStart + i * 40
    buf.writeUInt32LE(sections[i].sizeOfRawData, offset + 16) // SizeOfRawData
    buf.writeUInt32LE(sections[i].pointerToRawData, offset + 20) // PointerToRawData
  }
  return buf
}

describe('hasValidPeStructure', () => {
  it('合法 PE（x64，节表 maxRawEnd ≤ fileSize）返回 true', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'valid.exe')
    const buf = buildPeBuffer({
      machine: 0x8664,
      numSections: 1,
      sections: [{ pointerToRawData: 512, sizeOfRawData: 1024 }],
      totalSize: 2048
    })
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(true)
  })

  it('合法 PE（x86 Machine=0x14c）返回 true', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'x86.exe')
    const buf = buildPeBuffer({
      machine: 0x014c,
      numSections: 2,
      sections: [
        { pointerToRawData: 512, sizeOfRawData: 512 },
        { pointerToRawData: 1024, sizeOfRawData: 256 }
      ],
      totalSize: 2048
    })
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(true)
  })

  it('截断 PE（节表 maxRawEnd > fileSize）返回 false', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'truncated.exe')
    // PointerToRawData + SizeOfRawData = 512 + 99999 = 100511，远超 fileSize(2048)
    const buf = buildPeBuffer({
      numSections: 1,
      sections: [{ pointerToRawData: 512, sizeOfRawData: 99999 }],
      totalSize: 2048
    })
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('多节表项中某一项截断即返回 false', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'multi-sec.exe')
    const buf = buildPeBuffer({
      numSections: 3,
      sections: [
        { pointerToRawData: 512, sizeOfRawData: 256 },
        { pointerToRawData: 768, sizeOfRawData: 256 },
        { pointerToRawData: 1024, sizeOfRawData: 80000 } // 截断
      ],
      totalSize: 2048
    })
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('ELF 文件返回 false（非 PE）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'binary')
    const buf = Buffer.alloc(2048, 0)
    buf[0] = 0x7f
    buf.write('ELF', 1)
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('文本占位文件返回 false（非 PE）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'blocked.exe')
    fs.writeFileSync(file, 'This program is blocked by your antivirus.', 'utf8')
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('0 字节文件返回 false', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'empty.exe')
    fs.writeFileSync(file, '')
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('仅 MZ 两字节返回 false（文件太小，size < 64）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'tiny.exe')
    fs.writeFileSync(file, Buffer.from([0x4d, 0x5a]))
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('e_lfanew 越界（指向超出文件范围）返回 false', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'bad-elfanew.exe')
    const buf = Buffer.alloc(2048, 0)
    buf[0] = 0x4d
    buf[1] = 0x5a
    // e_lfanew 指向 9999，远超文件大小
    buf.writeUInt32LE(9999, 0x3c)
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('PE 签名不匹配（e_lfanew 处非 PE\0\0）返回 false', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'bad-sig.exe')
    const buf = Buffer.alloc(2048, 0)
    buf[0] = 0x4d
    buf[1] = 0x5a
    buf.writeUInt32LE(64, 0x3c)
    // 在 e_lfanew=64 处写错误签名
    buf.writeUInt8(0x4e, 64) // 'N' 而非 'P'
    buf.writeUInt8(0x45, 65)
    buf.writeUInt8(0x00, 66)
    buf.writeUInt8(0x00, 67)
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('节表项超出已读范围返回 false（越界保护）', () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'sec-oob.exe')
    // 声明 100 个节但文件仅 2048 字节，节表实际需要 64+24+112+100*40=4200 字节
    const buf = buildPeBuffer({
      numSections: 100,
      sizeOfOptionalHeader: 112,
      totalSize: 2048
    })
    fs.writeFileSync(file, buf)
    expect(hasValidPeStructure(file)).toBe(false)
  })

  it('目录返回 false', () => {
    const dir = makeTmpDir()
    expect(hasValidPeStructure(dir)).toBe(false)
  })

  it('不存在的路径返回 false', () => {
    expect(hasValidPeStructure(path.join(os.tmpdir(), 'nonexistent-xyz.exe'))).toBe(false)
  })

  it('空串返回 false（参数校验）', () => {
    expect(hasValidPeStructure('')).toBe(false)
  })
})
