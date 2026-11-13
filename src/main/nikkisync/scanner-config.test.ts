/**
 * N3/G3 红灯来源：scanner-config.ts 尚不存在；本仓只下发 selectedInstallRoot + watcher。
 */
import { describe, expect, it, vi } from 'vitest'

import { buildScannerConfig } from './scanner-config'

const CACHED_ROOT = 'D:/games/InfinityNikki'

describe('upstream scanner constructor options', () => {
  it('normal: carries the seven windows-app.ts scanner options', () => {
    const onProgress = vi.fn()
    const onSettled = vi.fn()
    const onDiscoveryComplete = vi.fn()
    const extra = [{ id: 'd1' }]
    const retired = [{ id: 'd2' }]
    const cfg = buildScannerConfig({
      watcher: true,
      gameRoot: 'D:/nikki',
      extraDirectories: extra,
      retiredExtraDirectories: retired,
      cachedInstallRoot: CACHED_ROOT,
      onProgress,
      onSettled,
      onDiscoveryComplete
    })
    expect(cfg.allowMissingInstallation).toBe(true)
    expect(cfg.selectedInstallRoot).toBe('D:/nikki')
    expect(cfg.extraDirectories).toBe(extra)
    expect(cfg.retiredExtraDirectories).toBe(retired)
    expect(cfg.cachedInstallRoot).toBe(CACHED_ROOT)
    expect(cfg.onProgress).toBe(onProgress)
    expect(cfg.onSettled).toBe(onSettled)
    expect(cfg.onDiscoveryComplete).toBe(onDiscoveryComplete)
  })

  it('abnormal: absent callbacks are omitted, never replaced by no-op stubs', () => {
    const cfg = buildScannerConfig({ watcher: false })
    expect('onProgress' in cfg).toBe(false)
    expect('onSettled' in cfg).toBe(false)
    expect('onDiscoveryComplete' in cfg).toBe(false)
    expect('selectedInstallRoot' in cfg).toBe(false)
  })

  it('boundary: watcher=false is preserved literally', () => {
    expect(buildScannerConfig({ watcher: false }).watcher).toBe(false)
    expect(buildScannerConfig({ watcher: true }).watcher).toBe(true)
  })
})
