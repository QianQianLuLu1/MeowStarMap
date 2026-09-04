/**
 * @layer L1
 * @module src/main/utils/path-safety
 * @coverage hasNonAsciiPath/ensureWritableDir/resolveSafeBinaryPath
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

import { hasNonAsciiPath, ensureWritableDir, resolveSafeBinaryPath } from './path-safety'

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
