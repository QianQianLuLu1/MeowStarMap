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
  hasWindowsExecutableHeader
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
