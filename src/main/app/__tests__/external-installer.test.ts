/**
 * @layer L2
 * @module src/main/app/external-installer
 * @coverage 路径校验（空/非 exe/不存在/有效）/ 启动参数契约（--updated --force-run）/ detached 启动
 * @dependencies node:child_process（mock spawn）、node:fs（真实临时文件）、../utils/logger（mock）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { spawnMock, unrefMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  unrefMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { AppError } from '../../../shared/errors/app-error'
import {
  EXTERNAL_INSTALLER_ARGS,
  launchExternalInstaller,
  validateInstallerPath
} from '../external-installer'

/** 断言路径被 UNC 判据拦截（validation 分类，而非 lstat notFound 兜底） */
function expectUncRejected(input: string): void {
  try {
    validateInstallerPath(input)
    expect.unreachable(`应拒绝 UNC 形态: ${input}`)
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('IPC_VALIDATION_ERROR')
    expect((err as AppError).details).toEqual({ path: expect.stringContaining('nas') })
  }
}

let tempDir = ''

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nikki-installer-test-'))
  spawnMock.mockReset()
  unrefMock.mockReset()
  spawnMock.mockReturnValue({ pid: 1234, unref: unrefMock })
})

afterEach(() => {
  if (tempDir !== '') {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('validateInstallerPath', () => {
  it('拒绝空值/非字符串', () => {
    expect(() => validateInstallerPath('')).toThrow()
    expect(() => validateInstallerPath(undefined)).toThrow()
    expect(() => validateInstallerPath(123)).toThrow()
  })

  it('拒绝 UNC 形态（反斜杠与正斜杠同判）', () => {
    // 反斜杠 UNC：现有判据已拦截
    expectUncRejected('\\\\nas\\share\\Setup.exe')
    // 正斜杠 UNC：normalize 后同指网络共享，与 isBareDirectoryRoot 修复的同型绕过形态
    expectUncRejected('//nas/share/Setup.exe')
    // UNC 子目录形态同样不得放行
    expectUncRejected('//nas/share/sub/Setup.exe')
  })

  it('拒绝非 .exe 与不存在的文件', () => {
    const txt = path.join(tempDir, 'installer.txt')
    fs.writeFileSync(txt, 'x')
    expect(() => validateInstallerPath(txt)).toThrow()
    expect(() => validateInstallerPath(path.join(tempDir, 'missing.exe'))).toThrow()
  })

  it('接受存在且非空的 .exe，并返回绝对路径', () => {
    const exe = path.join(tempDir, 'Setup.exe')
    fs.writeFileSync(exe, 'MZ')
    expect(validateInstallerPath(exe)).toBe(path.resolve(exe))
  })
})

describe('launchExternalInstaller', () => {
  it('以 --updated --force-run 启动并 unref（不阻塞应用退出）', () => {
    const exe = path.join(tempDir, 'Setup.exe')
    fs.writeFileSync(exe, 'MZ')
    const pid = launchExternalInstaller(exe)
    expect(pid).toBe(1234)
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached: boolean }
    ]
    expect(command).toBe(path.resolve(exe))
    expect(args).toEqual([...EXTERNAL_INSTALLER_ARGS])
    expect(options.detached).toBe(true)
    expect(unrefMock).toHaveBeenCalledTimes(1)
  })

  it('非法路径不启动子进程', () => {
    expect(() => launchExternalInstaller(path.join(tempDir, 'missing.exe'))).toThrow()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
