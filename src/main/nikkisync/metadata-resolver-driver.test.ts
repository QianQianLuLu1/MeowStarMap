import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_METADATA_BATCH_SIZE,
  DEFAULT_METADATA_MAX_PASSES,
  NUAN5_METADATA_ENDPOINT,
  buildMetadataResolverConfig,
  clampMetadataBatchSize,
  clampMetadataMaxPasses,
  resolveMetadataResolverEnabled,
  runBoundedMetadataResolution
} from './metadata-resolver-driver'

/**
 * 阶段 6：元数据解析驱动层单测。
 *
 * 本层是**零依赖纯函数**（不引 Electron、不引上游包、不发网络），因此全部用例用
 * 假对象注入即可运行，CI 未建链时同样必跑 —— 它同时是新源文件的覆盖率配套
 * （`vitest.config.ts` 阈值门控 + `all: true`，链接态 `*.linked.test.ts` 会整件 skip，
 * 不能靠那一份凑覆盖率）。
 *
 * 三条最要紧的不变量：
 * ① 开关关闭时配置里**根本没有 `metadataResolver` 这个键**（不能传 `{enabled:false}`：
 *    上游 `MetadataResolverService.runOnce()` 首行就 `if (!this.config.enabled) return 0`，
 *    那会让手动驱动一起失效）；
 * ② 任何情况下都**不下发 `intervalMs`**，更不许下发 0（上游用 `??` 取值，
 *    传 0 会造出 `setInterval(fn, 0)`）；
 * ③ 驱动**永不 reject**（上游 `runOnce()` 外层只有 try/finally 无 catch，DB 错直接上抛，
 *    冒到扫描链就成了未捕获 rejection）。
 */

const fakeResolver = { id: 'nuan5-compatible', resolve: () => Promise.resolve({}) }

describe('resolveMetadataResolverEnabled 开关判据', () => {
  it('env=1 强制开启，压过设置值 false', () => {
    expect(resolveMetadataResolverEnabled('1', false)).toBe(true)
  })

  it('env=0 强制关闭，压过设置值 true', () => {
    expect(resolveMetadataResolverEnabled('0', true)).toBe(false)
  })

  it('env 未设置时回落到设置值', () => {
    expect(resolveMetadataResolverEnabled(undefined, true)).toBe(true)
    expect(resolveMetadataResolverEnabled(undefined, false)).toBe(false)
  })

  it('边界：env 取非 1/0 的脏值视为未设置，设置值非布尔一律判关', () => {
    expect(resolveMetadataResolverEnabled('yes', true)).toBe(true)
    expect(resolveMetadataResolverEnabled('', true)).toBe(true)
    expect(resolveMetadataResolverEnabled(undefined, undefined)).toBe(false)
    expect(resolveMetadataResolverEnabled(undefined, 'true')).toBe(false)
    expect(resolveMetadataResolverEnabled(undefined, 1)).toBe(false)
  })
})

describe('buildMetadataResolverConfig 单缝注入形状', () => {
  it('端点常量钉在 https://nuan5.pro 上（与设置页披露文案同一主机，见 locales 用例）', () => {
    expect(NUAN5_METADATA_ENDPOINT.startsWith('https://nuan5.pro')).toBe(true)
  })

  it('开关关闭时返回空对象：metadataResolver 键不存在，且 resolver 工厂不被调用', () => {
    const factory = vi.fn(() => fakeResolver)
    const fragment = buildMetadataResolverConfig({
      enabled: false,
      endpoint: NUAN5_METADATA_ENDPOINT,
      createResolver: factory
    })
    expect(fragment).toEqual({})
    expect('metadataResolver' in fragment).toBe(false)
    expect(factory).not.toHaveBeenCalled()
  })

  it('开关开启时下发 resolver 与 service，service 用收窄的 batchSize，端点下传给工厂', () => {
    let seenEndpoint: string | undefined
    const fragment = buildMetadataResolverConfig({
      enabled: true,
      endpoint: NUAN5_METADATA_ENDPOINT,
      createResolver: (endpoint) => {
        seenEndpoint = endpoint
        return fakeResolver
      }
    })
    expect(seenEndpoint).toBe(NUAN5_METADATA_ENDPOINT)
    expect(fragment).toEqual({
      metadataResolver: {
        resolver: fakeResolver,
        service: {
          enabled: true,
          batchSize: DEFAULT_METADATA_BATCH_SIZE,
          retryAfterMs: undefined
        }
      }
    })
    expect(fragment.metadataResolver?.service).not.toHaveProperty('intervalMs')
  })

  it('异常：端点不是 https 时构造期即拒绝（不得静默降级成 http 出口）', () => {
    expect(() =>
      buildMetadataResolverConfig({
        enabled: true,
        endpoint: 'http://nuan5.pro/api/decode-photo2',
        createResolver: () => fakeResolver
      })
    ).toThrow(/https/)
    expect(() =>
      buildMetadataResolverConfig({
        enabled: true,
        endpoint: '   ',
        createResolver: () => fakeResolver
      })
    ).toThrow(/endpoint/)
  })
})

describe('钳制与默认值', () => {
  it('batchSize 落在 [1, 12]，非正/非有限值回落默认', () => {
    expect(clampMetadataBatchSize(0)).toBe(DEFAULT_METADATA_BATCH_SIZE)
    expect(clampMetadataBatchSize(-3)).toBe(DEFAULT_METADATA_BATCH_SIZE)
    expect(clampMetadataBatchSize(999)).toBe(12)
    expect(clampMetadataBatchSize(7.8)).toBe(7)
    expect(clampMetadataBatchSize(undefined)).toBe(DEFAULT_METADATA_BATCH_SIZE)
    expect(clampMetadataBatchSize(Number.NaN)).toBe(DEFAULT_METADATA_BATCH_SIZE)
  })

  it('maxPasses 落在 [1, 200]，缺省取默认', () => {
    expect(clampMetadataMaxPasses(undefined)).toBe(DEFAULT_METADATA_MAX_PASSES)
    expect(clampMetadataMaxPasses(0)).toBe(DEFAULT_METADATA_MAX_PASSES)
    expect(clampMetadataMaxPasses(1000)).toBe(200)
  })
})

describe('runBoundedMetadataResolution 有界驱动', () => {
  const base = () => ({
    initialGeneration: 0,
    generation: () => 0,
    log: vi.fn()
  })

  it('正常：返回值求和，首轮返回 0 即只调一次（上游收敛语义）', async () => {
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
    const result = await runBoundedMetadataResolution({
      runOnce,
      maxPasses: 5,
      ...base()
    })
    expect(runOnce).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ passes: 3, resolved: 6, aborted: false, failed: false })
  })

  it('边界：候选永远不为零时恰好在 maxPasses 处停下（不无限轮询）', async () => {
    const runOnce = vi.fn().mockResolvedValue(4)
    const result = await runBoundedMetadataResolution({
      runOnce,
      maxPasses: DEFAULT_METADATA_MAX_PASSES,
      ...base()
    })
    expect(runOnce).toHaveBeenCalledTimes(DEFAULT_METADATA_MAX_PASSES)
    expect(result.passes).toBe(DEFAULT_METADATA_MAX_PASSES)
    expect(result.resolved).toBe(DEFAULT_METADATA_MAX_PASSES * 4)
  })

  it('失败隔离：runOnce reject 时驱动 resolve、只 warn 一次且不继续下一轮', async () => {
    const runOnce = vi.fn().mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('SQLITE_BUSY'))
    const fixture = base()
    const result = await runBoundedMetadataResolution({ runOnce, maxPasses: 5, ...fixture })
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ passes: 1, resolved: 3, aborted: false, failed: true })
    expect(fixture.log).toHaveBeenCalledTimes(1)
    expect(fixture.log.mock.calls[0][0]).toBe('warn')
  })

  it('代次失效：外部在第二轮前递增代次后不再发起下一轮（不假装能取消在飞请求）', async () => {
    let generation = 0
    const runOnce = vi.fn().mockImplementation(async () => {
      if (runOnce.mock.calls.length === 2) generation = 1
      return 4
    })
    const result = await runBoundedMetadataResolution({
      runOnce,
      maxPasses: 5,
      initialGeneration: 0,
      generation: () => generation,
      log: vi.fn()
    })
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(result.aborted).toBe(true)
    expect(result.passes).toBe(2)
  })

  it('边界：代次一开始就已过期 ⇒ 一次都不发起', async () => {
    const runOnce = vi.fn().mockResolvedValue(4)
    const result = await runBoundedMetadataResolution({
      runOnce,
      maxPasses: 5,
      initialGeneration: 7,
      generation: () => 8,
      log: vi.fn()
    })
    expect(runOnce).not.toHaveBeenCalled()
    expect(result).toMatchObject({ passes: 0, resolved: 0, aborted: true })
  })
})
