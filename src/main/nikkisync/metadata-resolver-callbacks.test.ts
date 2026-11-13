/**
 * N2 红灯来源：buildMetadataResolverConfig 目前只下发 {enabled,batchSize}，
 * canResolve / onWorkSettled 两枚上游回调缺失（windows-app.ts:186-191）。
 */
import { describe, expect, it, vi } from 'vitest'

import { NUAN5_METADATA_ENDPOINT, buildMetadataResolverConfig } from './metadata-resolver-driver'

describe('metadataResolver service callbacks', () => {
  it('normal: forwards canResolve and onWorkSettled when enabled', () => {
    const canResolve = vi.fn(() => true)
    const onWorkSettled = vi.fn()
    const fragment = buildMetadataResolverConfig({
      enabled: true,
      endpoint: NUAN5_METADATA_ENDPOINT,
      createResolver: () => ({ id: 'fake' }),
      canResolve,
      onWorkSettled
    })
    expect(fragment.metadataResolver?.service.canResolve).toBeTypeOf('function')
    expect(fragment.metadataResolver?.service.onWorkSettled).toBeTypeOf('function')
    expect(fragment.metadataResolver?.service.canResolve?.()).toBe(true)
    fragment.metadataResolver?.service.onWorkSettled?.()
    expect(onWorkSettled).toHaveBeenCalledTimes(1)
  })

  it('abnormal: disabled config carries no metadataResolver key at all', () => {
    const createResolver = vi.fn(() => ({ id: 'fake' }))
    const fragment = buildMetadataResolverConfig({
      enabled: false,
      endpoint: NUAN5_METADATA_ENDPOINT,
      createResolver,
      canResolve: () => true,
      onWorkSettled: () => {}
    })
    expect(fragment).toEqual({})
    expect(createResolver).not.toHaveBeenCalled()
  })

  it('boundary: never emits intervalMs and clamps batchSize to 12', () => {
    const fragment = buildMetadataResolverConfig({
      enabled: true,
      endpoint: NUAN5_METADATA_ENDPOINT,
      createResolver: () => ({ id: 'fake' }),
      batchSize: 999
    })
    const service = fragment.metadataResolver?.service as unknown as Record<string, unknown>
    expect(service.batchSize).toBe(12)
    expect('intervalMs' in service).toBe(false)
  })
})
