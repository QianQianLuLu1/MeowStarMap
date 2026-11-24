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

import { EXTERNAL_INSTALLER_ARGS, launchExternalInstaller, validateInstallerPath } from '../external-installer'

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
    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], { detached: boolean }]
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
