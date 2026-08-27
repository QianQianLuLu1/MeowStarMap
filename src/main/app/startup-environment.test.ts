/**
 * @layer L1
 * @module src/main/app/startup-environment
 * @coverage verifyStartupEnvironment 三分支：可写继续 / 不可写弹窗终止 / 中文路径仅警告
 * @dependencies 使用真实 fs 临时目录 + 注入 mock（showErrorBox / getExecPath / getUserDataPath）
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { verifyStartupEnvironment } from './startup-environment'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-env-'))
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

describe('verifyStartupEnvironment', () => {
  it('userData 不可写时弹窗并返回 false', () => {
    const dir = makeTmpDir()
    fs.chmodSync(dir, 0o444)
    const showErrorBox = vi.fn()
    const result = verifyStartupEnvironment({
      getExecPath: () => 'C:\\Program Files\\NikkiGallery\\NikkiGallery.exe',
      getUserDataPath: () => dir,
      showErrorBox
    })
    expect(result).toBe(false)
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(showErrorBox.mock.calls[0][0]).toContain('数据目录')
  })

  it('userData 可写且英文路径时不弹窗并返回 true', () => {
    const dir = makeTmpDir()
    const showErrorBox = vi.fn()
    const result = verifyStartupEnvironment({
      getExecPath: () => 'C:\\Program Files\\NikkiGallery\\NikkiGallery.exe',
      getUserDataPath: () => dir,
      showErrorBox
    })
    expect(result).toBe(true)
    expect(showErrorBox).not.toHaveBeenCalled()
  })

  it('安装路径含中文时弹窗警告但仍返回 true（继续启动）', () => {
    const dir = makeTmpDir()
    const showErrorBox = vi.fn()
    const result = verifyStartupEnvironment({
      getExecPath: () => 'D:\\中文目录\\NikkiGallery\\NikkiGallery.exe',
      getUserDataPath: () => dir,
      showErrorBox
    })
    expect(result).toBe(true)
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(showErrorBox.mock.calls[0][0]).toContain('特殊字符')
  })

  it('NIKKI_SKIP_ENV_GUARD=1 时跳过检测返回 true', () => {
    const showErrorBox = vi.fn()
    const result = verifyStartupEnvironment({
      getExecPath: () => 'D:\\中文目录\\NikkiGallery\\NikkiGallery.exe',
      getUserDataPath: () => '/readonly/nonexistent',
      getEnv: () => ({ NIKKI_SKIP_ENV_GUARD: '1' }) as NodeJS.ProcessEnv,
      showErrorBox
    })
    expect(result).toBe(true)
    expect(showErrorBox).not.toHaveBeenCalled()
  })
})
