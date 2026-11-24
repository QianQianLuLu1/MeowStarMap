/**
 * @layer L2
 * @module src/main/app/install-manifest
 * @coverage 清单构造（字段完整/时间戳注入）/ 渠道推断（dev/beta/stable）
 * @dependencies electron（mock app 查询）、../utils/logger（mock）
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '2.5.7',
    getName: () => 'meow-star-map',
    getPath: (name: string) => (name === 'exe' ? 'C:/install/app.exe' : 'C:/userdata'),
    getAppPath: () => 'C:/app'
  }
}))

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  buildInstallManifest,
  inferInstallChannel,
  INSTALL_MANIFEST_SCHEMA_VERSION,
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
