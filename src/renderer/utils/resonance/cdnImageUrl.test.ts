import { describe, it, expect } from 'vitest'
import { cdnImageUrl } from './cdnImageUrl'

/**
 * CDN 图片地址构造测试：六类真实样本逐条映射、非法输入、边界值与唯一主机约束。
 * 纯逻辑能力，无网络请求、无副作用。
 */

const HOST = 'https://cdn.gongeo.us'

const PATHS = {
  outfit: '/images/outfits',
  item: '/images/items/icons',
  makeup: '/images/items/makeups',
  momo: '/images/momo/icons',
  prop: '/images/props',
  eureka: '/images/eurekas'
} as const

type Category = keyof typeof PATHS

const VALID_SAMPLES: Array<[Category, number]> = [
  ['outfit', 10347],
  ['outfit', 10001],
  ['item', 1020100001],
  ['item', 2113020301],
  ['makeup', 10399003],
  ['makeup', 10001001],
  ['momo', 1160100134],
  ['prop', 1280010126],
  ['eureka', 1341],
  ['eureka', 1342],
  ['eureka', 9001]
]

describe('cdnImageUrl：六类正常映射', () => {
  it('六类真实样本逐条生成与已核实规则一致的地址', () => {
    for (const [category, id] of VALID_SAMPLES) {
      const url = cdnImageUrl(category, id)
      expect(url).toBe(`${HOST}${PATHS[category]}/${id}.png`)
      const parsed = new URL(url!)
      expect(parsed.protocol).toBe('https:')
      expect(parsed.hostname).toBe('cdn.gongeo.us')
      expect(parsed.pathname).toBe(`${PATHS[category]}/${id}.png`)
      expect(parsed.search).toBe('')
      expect(parsed.hash).toBe('')
    }
  })

  it('输出主机唯一且只能是 cdn.gongeo.us', () => {
    const hosts = new Set<string>()
    for (const [category, id] of VALID_SAMPLES) {
      const url = cdnImageUrl(category, id)
      expect(url).not.toBeNull()
      expect(url!.startsWith(`${HOST}/`)).toBe(true)
      hosts.add(new URL(url!).hostname)
    }
    expect([...hosts]).toEqual(['cdn.gongeo.us'])
  })

  it('单条集合与六类混合列表逐条映射无交叉污染', () => {
    expect(cdnImageUrl('outfit', 10347)).toBe(`${HOST}/images/outfits/10347.png`)
    for (const [category, id] of VALID_SAMPLES) {
      expect(cdnImageUrl(category, id)).toContain(PATHS[category])
    }
  })
})

describe('cdnImageUrl：非法输入明确返回 null', () => {
  it('未知分类返回 null，不产生地址', () => {
    for (const category of ['unknown', '', 'ITEM', 'outfits', null, undefined, 0, {}, []]) {
      expect(cdnImageUrl(category, 10347)).toBeNull()
    }
  })

  it('标识缺失或类型异常返回 null', () => {
    for (const id of [undefined, null, NaN, Infinity, -Infinity, true, false, {}, [], 10n]) {
      expect(cdnImageUrl('outfit', id)).toBeNull()
    }
    expect(cdnImageUrl('outfit', Symbol('x'))).toBeNull()
  })

  it('字符串数字一律返回 null（含空白与控制字符）', () => {
    for (const id of [
      '10347',
      '010347',
      '+10347',
      ' 10347',
      '10347 ',
      '1034\u00007',
      '10\t347',
      '\n10347',
      '10347\r',
      '1e4'
    ]) {
      expect(cdnImageUrl('outfit', id)).toBeNull()
    }
  })

  it('位数与分类不匹配（每类少一位 / 多一位）返回 null', () => {
    const wrongLengthSamples: Array<[Category, number]> = [
      ['outfit', 1034],
      ['outfit', 103470],
      ['item', 102010000],
      ['item', 10201000010],
      ['makeup', 1039900],
      ['makeup', 103990030],
      ['momo', 116010013],
      ['momo', 11601001340],
      ['prop', 128001012],
      ['prop', 12800101260],
      ['eureka', 134],
      ['eureka', 13410]
    ]
    for (const [category, id] of wrongLengthSamples) {
      expect(cdnImageUrl(category, id)).toBeNull()
    }
  })

  it('超出安全整数范围返回 null', () => {
    for (const id of [
      Number.MAX_SAFE_INTEGER + 1,
      9007199254740992,
      Number.MAX_SAFE_INTEGER,
      '9007199254740993'
    ]) {
      expect(cdnImageUrl('item', id)).toBeNull()
    }
  })

  it('负数 / 非整数 / 零返回 null', () => {
    for (const id of [-10347, 10347.5, 0, -0, -1, 0.5]) {
      expect(cdnImageUrl('outfit', id)).toBeNull()
    }
  })

  it('任意非法输入不抛异常且从不产生地址', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      true,
      0,
      -1,
      1.5,
      {},
      [],
      10n,
      Symbol('x'),
      'x',
      () => 1
    ]
    for (const value of inputs) {
      expect(() => cdnImageUrl(value, value)).not.toThrow()
      expect(() => cdnImageUrl('item', value)).not.toThrow()
      expect(cdnImageUrl(value, value)).toBeNull()
      expect(cdnImageUrl('item', value)).toBeNull()
    }
  })
})

describe('cdnImageUrl：边界值', () => {
  it('每类最小有效标识生成合法地址', () => {
    const minValidSamples: Array<[Category, number]> = [
      ['outfit', 10000],
      ['item', 1000000000],
      ['makeup', 10000000],
      ['momo', 1000000000],
      ['prop', 1000000000],
      ['eureka', 1000]
    ]
    for (const [category, id] of minValidSamples) {
      expect(cdnImageUrl(category, id)).toBe(`${HOST}${PATHS[category]}/${id}.png`)
    }
  })

  it('10 位类上界合法，接近安全整数上限的多位标识判非法', () => {
    expect(cdnImageUrl('item', 9999999999)).toBe(`${HOST}/images/items/icons/9999999999.png`)
    expect(cdnImageUrl('momo', 9999999999)).toBe(`${HOST}/images/momo/icons/9999999999.png`)
    expect(cdnImageUrl('prop', 9999999999)).toBe(`${HOST}/images/props/9999999999.png`)
    expect(cdnImageUrl('item', 9007199254740991)).toBeNull()
  })

  it('空集合不产生断言错误，单条集合稳定', () => {
    const emptySamples: Array<[Category, number]> = []
    for (const [category, id] of emptySamples) {
      expect(cdnImageUrl(category, id)).not.toBeNull()
    }
    expect(emptySamples).toHaveLength(0)
    const singleSample: Array<[Category, number]> = [['eureka', 1341]]
    for (const [category, id] of singleSample) {
      expect(cdnImageUrl(category, id)).toBe(`${HOST}${PATHS[category]}/${id}.png`)
    }
  })
})
