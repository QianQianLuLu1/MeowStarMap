/**
 * @layer L2
 * @module src/main/app/install-manifest
 * @coverage 清单构造（字段完整/时间戳注入）/ 渠道推断（dev/beta/stable）
 * @dependencies electron（mock app 查询）、../utils/logger（mock）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: false,
    getVersion: vi.fn(() => '2.5.7'),
    getName: vi.fn(() => 'meow-star-map'),
    getPath: vi.fn((name: string) => (name === 'exe' ? 'C:/install/app.exe' : 'C:/userdata')),
    getAppPath: vi.fn(() => 'C:/app')
  }
}))

vi.mock('electron', () => ({ app: appMock }))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  buildInstallManifest,
  inferInstallChannel,
  INSTALL_MANIFEST_SCHEMA_VERSION,
  writeInstallManifest,
  type InstallManifestInput
} from '../install-manifest'

const input: InstallManifestInput = {
  appId: 'com.qianlu.meow-star-map',
  productName: 'meow-star-map',
  version: '2.5.8',
  channel: 'stable',
  arch: 'x64',
  installDir: 'C:/install',
  exePath: 'C:/install/app.exe',
  electronVersion: '41.10.6'
}

describe('install-manifest', () => {
  let tempDir = ''

  beforeEach(() => {
    appMock.isPackaged = false
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-manifest-test-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('打包态清单必须经临时文件原子替换两个落点', () => {
    const installDir = path.join(tempDir, 'install')
    const userData = path.join(tempDir, 'user-data')
    appMock.isPackaged = true
    appMock.getPath.mockImplementation((name: string) =>
      name === 'exe' ? path.join(installDir, 'MeowStarMap.exe') : userData
    )
    const renameSpy = vi.spyOn(fs, 'renameSync')

    writeInstallManifest()

    expect(renameSpy).toHaveBeenCalledTimes(2)
    for (const [source] of renameSpy.mock.calls) {
      expect(String(source)).toContain('.install-manifest.json.tmp-')
    }
    expect(renameSpy.mock.calls.map(([, target]) => String(target))).toEqual(
      expect.arrayContaining([
        path.join(installDir, 'install-manifest.json'),
        path.join(userData, 'install-manifest.json')
      ])
    )
  })

  it('构造清单包含全部字段与 schemaVersion', () => {
    const manifest = buildInstallManifest(input)
    expect(manifest.schemaVersion).toBe(INSTALL_MANIFEST_SCHEMA_VERSION)
    expect(manifest.appId).toBe('com.qianlu.meow-star-map')
    expect(manifest.version).toBe('2.5.8')
    expect(manifest.installDir).toBe('C:/install')
    expect(manifest.exePath).toBe('C:/install/app.exe')
    expect(manifest.channel).toBe('stable')
  })

  it('时间戳使用注入的 now（可复现）', () => {
    const manifest = buildInstallManifest(input, new Date('2026-11-24T12:00:00.000Z'))
    expect(manifest.generatedAt).toBe('2026-11-24T12:00:00.000Z')
  })

  it('渠道推断：dev（未打包）/ beta（带预发布后缀）/ stable（正式版）', () => {
    expect(inferInstallChannel('2.5.8', false)).toBe('dev')
    expect(inferInstallChannel('2.5.8-beta.1', true)).toBe('beta')
    expect(inferInstallChannel('2.5.8', true)).toBe('stable')
  })
})
