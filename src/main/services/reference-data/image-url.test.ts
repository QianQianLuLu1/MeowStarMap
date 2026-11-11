// @layer main/services
// @module reference-data/image-url
// @coverage 按主机授权核实 + Nuan5NetworkImage 地址生成（正常 / 异常 / 边界三类）
//
// 授权事实来源：RanAxro/nikki_albums#20（cdn.nikkialbums.com，UA 须为「应用名/版本」）
// 与 dastrokes/gongeo.us-nikki-tracker#218（cdn.gongeo.us 已批准热链，走既有固定 UA 路径）。
// 本模块只做纯函数判定，不发网络请求。
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  AUTHORIZED_REFERENCE_IMAGE_HOSTS,
  getReferenceImageHostPolicy,
  resolveNetworkImageUrl,
  NIKKI_ALBUMS_CDN_HOST
} from './image-url'
import { NETWORK_IMAGE_KINDS } from './nuan5-config-proto'
import type { NetworkImageTemplateInfo } from '../../../shared/types/electron-api'

const NIKKI_BASE = 'https://cdn.nikkialbums.com/assets/{id}.webp'
const GONGEO_BASE = 'https://cdn.gongeo.us/nikki/cloth/{id}.png'

/** RanAxro #20 授权范围内的 8 类（cloth / clothOutfit 明确不在其范围） */
const AUTHORIZED_KINDS = [
  'light',
  'filter',
  'momoPose',
  'nikkiPose',
  'diyPattern',
  'clothType',
  'clothProp',
  'clothTag'
] as const

function templates(
  extra?: Partial<Record<string, Partial<NetworkImageTemplateInfo>>>
): NetworkImageTemplateInfo[] {
  const base: NetworkImageTemplateInfo[] = [
    ...AUTHORIZED_KINDS.map((kind) => ({
      kind,
      baseUrl: NIKKI_BASE,
      replace: '{id}'
    })),
    { kind: 'cloth', baseUrl: GONGEO_BASE, replace: '{id}' },
    { kind: 'clothOutfit', baseUrl: GONGEO_BASE, replace: '{id}' }
  ]
  if (!extra) return base
  return base.map((item) => {
    const patch = extra[item.kind]
    return patch ? { ...item, ...patch } : item
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('getReferenceImageHostPolicy — 按主机授权核实', () => {
  it('正常：nikkialbums 主机为 versioned-ua（#20 要求「应用名/版本」）', () => {
    expect(getReferenceImageHostPolicy('cdn.nikkialbums.com')).toBe('versioned-ua')
  })

  it('正常：gongeo 主机为 existing-hotlink（#218 已批准，走既有固定 UA 热链）', () => {
    expect(getReferenceImageHostPolicy('cdn.gongeo.us')).toBe('existing-hotlink')
  })

  it('边界：hostname 大小写与尾点归一后仍命中注册表', () => {
    expect(getReferenceImageHostPolicy('CDN.NikkiAlbums.COM')).toBe('versioned-ua')
    expect(getReferenceImageHostPolicy('cdn.nikkialbums.com.')).toBe('versioned-ua')
  })

  it('异常：未登记主机一律 null（授权状态不明 → fail-closed 不接入）', () => {
    expect(getReferenceImageHostPolicy('cdn.example.test')).toBeNull()
    expect(getReferenceImageHostPolicy('')).toBeNull()
    // 子域伪装 / 前缀伪装不得命中
    expect(getReferenceImageHostPolicy('evil-cdn.nikkialbums.com')).toBeNull()
    expect(getReferenceImageHostPolicy('cdn.nikkialbums.com.evil.test')).toBeNull()
  })

  it('注册表只含两个已核实主机，杜绝投机性扩展', () => {
    expect(Object.keys(AUTHORIZED_REFERENCE_IMAGE_HOSTS).sort()).toEqual(
      ['cdn.gongeo.us', 'cdn.nikkialbums.com'].sort()
    )
    expect(NIKKI_ALBUMS_CDN_HOST).toBe('cdn.nikkialbums.com')
  })
})

describe('resolveNetworkImageUrl — 正常路径', () => {
  it.each(AUTHORIZED_KINDS)('授权类别 %s 生成 nikkialbums 实际地址', (kind) => {
    const resolved = resolveNetworkImageUrl({ kind, id: 10203, templates: templates() })
    expect(resolved).not.toBeNull()
    expect(resolved?.fetchUrl).toBe('https://cdn.nikkialbums.com/assets/10203.webp')
    expect(resolved?.host).toBe('cdn.nikkialbums.com')
    expect(resolved?.policy).toBe('versioned-ua')
  })

  it('cacheKey = sha256("<kind>:<id>")，与镜像入口无关（换镜像不失效缓存）', () => {
    const plain = resolveNetworkImageUrl({ kind: 'light', id: 7, templates: templates() })
    const mirrored = resolveNetworkImageUrl({
      kind: 'light',
      id: 7,
      templates: templates(),
      mirrorBaseUrl: 'https://mirror.example.org'
    })
    expect(plain?.cacheKey).toBe(sha256('light:7'))
    expect(mirrored?.cacheKey).toBe(plain?.cacheKey)
  })

  it('占位串多次出现时全量替换（replaceAll 语义，非 replace 首次）', () => {
    const resolved = resolveNetworkImageUrl({
      kind: 'light',
      id: 42,
      templates: templates({
        light: { baseUrl: 'https://cdn.nikkialbums.com/{id}/thumb_{id}.webp', replace: '{id}' }
      })
    })
    expect(resolved?.fetchUrl).toBe('https://cdn.nikkialbums.com/42/thumb_42.webp')
  })

  it('kind 覆盖 NETWORK_IMAGE_KINDS 全集（10 类均有明确处置，无遗漏分支）', () => {
    expect(AUTHORIZED_KINDS.length + 2).toBe(NETWORK_IMAGE_KINDS.length)
    for (const kind of NETWORK_IMAGE_KINDS) {
      const resolved = resolveNetworkImageUrl({ kind, id: 1, templates: templates() })
      const authorized = (AUTHORIZED_KINDS as readonly string[]).includes(kind)
      expect(resolved !== null).toBe(authorized)
    }
  })
})

describe('resolveNetworkImageUrl — 未授权主机不接入', () => {
  it.each(['cloth', 'clothOutfit'] as const)(
    '%s 落在 gongeo 主机 → null（继续走既有衣橱热链，不经新取图路径）',
    (kind) => {
      expect(resolveNetworkImageUrl({ kind, id: 9001, templates: templates() })).toBeNull()
    }
  )

  it('未知主机 → null（v1.db 数据漂移到未授权域时安全默认不接入）', () => {
    const resolved = resolveNetworkImageUrl({
      kind: 'light',
      id: 1,
      templates: templates({ light: { baseUrl: 'https://cdn.unknown.test/a/{id}.webp' } })
    })
    expect(resolved).toBeNull()
  })

  it('镜像入口不得把未授权资源「洗白」：gongeo 类别配了镜像仍返回 null', () => {
    expect(
      resolveNetworkImageUrl({
        kind: 'cloth',
        id: 1,
        templates: templates(),
        mirrorBaseUrl: 'https://mirror.example.org'
      })
    ).toBeNull()
  })

  it('授权核实按 resolved URL 的实际 host，而非按 kind 硬编码信任', () => {
    // kind 属授权类别，但 v1.db 把它的 baseUrl 指向 gongeo → 按 host 判定为既有热链，不接入
    const resolved = resolveNetworkImageUrl({
      kind: 'light',
      id: 1,
      templates: templates({ light: { baseUrl: GONGEO_BASE } })
    })
    expect(resolved).toBeNull()
  })
})

describe('resolveNetworkImageUrl — 加速/镜像入口', () => {
  it('正常：镜像仅替换 protocol+host+port，path/query/hash 原样保留', () => {
    const resolved = resolveNetworkImageUrl({
      kind: 'filter',
      id: 5,
      templates: templates({
        filter: { baseUrl: 'https://cdn.nikkialbums.com/assets/{id}.webp?v=2#frag' }
      }),
      mirrorBaseUrl: 'https://mirror.example.org:8443'
    })
    expect(resolved?.fetchUrl).toBe('https://mirror.example.org:8443/assets/5.webp?v=2#frag')
    // host 仍报告**授权主机**（UA 选择依据），不被镜像改写
    expect(resolved?.host).toBe('cdn.nikkialbums.com')
    expect(resolved?.policy).toBe('versioned-ua')
  })

  it('边界：镜像尾部斜杠（含多个）归一，不产生双斜杠', () => {
    for (const mirror of ['https://mirror.example.org', 'https://mirror.example.org/']) {
      const resolved = resolveNetworkImageUrl({
        kind: 'light',
        id: 1,
        templates: templates(),
        mirrorBaseUrl: mirror
      })
      expect(resolved?.fetchUrl).toBe('https://mirror.example.org/assets/1.webp')
    }
  })

  it('边界：镜像带路径前缀时作为 path 前缀拼接（反代子路径部署形态）', () => {
    const resolved = resolveNetworkImageUrl({
      kind: 'light',
      id: 1,
      templates: templates(),
      mirrorBaseUrl: 'https://mirror.example.org/nikki-cdn/'
    })
    expect(resolved?.fetchUrl).toBe('https://mirror.example.org/nikki-cdn/assets/1.webp')
  })

  it('边界：镜像为空白串时等同未配置，走原始地址', () => {
    const resolved = resolveNetworkImageUrl({
      kind: 'light',
      id: 1,
      templates: templates(),
      mirrorBaseUrl: '   '
    })
    expect(resolved?.fetchUrl).toBe('https://cdn.nikkialbums.com/assets/1.webp')
  })

  it.each([
    ['环回地址', 'https://127.0.0.1/x'],
    ['localhost', 'http://localhost:8080'],
    ['私网 192.168', 'https://192.168.1.10'],
    ['私网 10.x', 'https://10.0.0.5'],
    ['链路本地 IPv6', 'https://[fe80::1]'],
    ['非 http(s) 协议', 'file:///etc/passwd'],
    ['不可解析串', 'not a url']
  ])(
    '异常：镜像为%s时 → null（SSRF 守卫拒绝，不回退原始地址以免静默绕过用户配置）',
    (_label, mirror) => {
      expect(
        resolveNetworkImageUrl({
          kind: 'light',
          id: 1,
          templates: templates(),
          mirrorBaseUrl: mirror
        })
      ).toBeNull()
    }
  )
})

describe('resolveNetworkImageUrl — 参数校验与边界', () => {
  it.each([
    ['0', 0],
    ['负数', -1],
    ['小数', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['超出安全整数', Number.MAX_SAFE_INTEGER + 1]
  ])('异常：id 为%s → null', (_label, id) => {
    expect(resolveNetworkImageUrl({ kind: 'light', id, templates: templates() })).toBeNull()
  })

  it('边界：id = 1 与 MAX_SAFE_INTEGER 均可生成（正安全整数闭区间）', () => {
    expect(resolveNetworkImageUrl({ kind: 'light', id: 1, templates: templates() })?.fetchUrl).toBe(
      'https://cdn.nikkialbums.com/assets/1.webp'
    )
    expect(
      resolveNetworkImageUrl({
        kind: 'light',
        id: Number.MAX_SAFE_INTEGER,
        templates: templates()
      })?.fetchUrl
    ).toBe(`https://cdn.nikkialbums.com/assets/${Number.MAX_SAFE_INTEGER}.webp`)
  })

  it('异常：kind 不在 NETWORK_IMAGE_KINDS 内 → null', () => {
    expect(
      resolveNetworkImageUrl({
        kind: 'worldMapTile' as never,
        id: 1,
        templates: templates()
      })
    ).toBeNull()
    expect(resolveNetworkImageUrl({ kind: '' as never, id: 1, templates: templates() })).toBeNull()
  })

  it('异常：templates 为空数组 / 缺该 kind → null（索引未就绪时回退占位）', () => {
    expect(resolveNetworkImageUrl({ kind: 'light', id: 1, templates: [] })).toBeNull()
    const withoutLight = templates().filter((item) => item.kind !== 'light')
    expect(resolveNetworkImageUrl({ kind: 'light', id: 1, templates: withoutLight })).toBeNull()
  })

  it.each([
    ['baseUrl 空串', { baseUrl: '', replace: '{id}' }],
    ['baseUrl 非法 URL', { baseUrl: 'cdn.nikkialbums.com/{id}.webp', replace: '{id}' }],
    ['baseUrl 非 http(s)', { baseUrl: 'ftp://cdn.nikkialbums.com/{id}.webp', replace: '{id}' }],
    ['replace 空串', { baseUrl: NIKKI_BASE, replace: '' }]
  ])('异常：模板%s → null', (_label, patch) => {
    expect(
      resolveNetworkImageUrl({
        kind: 'light',
        id: 1,
        templates: templates({ light: patch })
      })
    ).toBeNull()
  })

  it('边界：baseUrl 不含占位串时 replaceAll 无副作用，仍按 host 授权判定', () => {
    const resolved = resolveNetworkImageUrl({
      kind: 'light',
      id: 1,
      templates: templates({ light: { baseUrl: 'https://cdn.nikkialbums.com/static/fixed.webp' } })
    })
    expect(resolved?.fetchUrl).toBe('https://cdn.nikkialbums.com/static/fixed.webp')
  })

  it('异常：baseUrl 指向环回/私网（即便 host 名不在注册表）→ null', () => {
    expect(
      resolveNetworkImageUrl({
        kind: 'light',
        id: 1,
        templates: templates({ light: { baseUrl: 'https://127.0.0.1/{id}.webp' } })
      })
    ).toBeNull()
  })

  it('边界：templates 含重复 kind 时取首条（索引构建侧已去重，此处防御性钉住）', () => {
    const duplicated: NetworkImageTemplateInfo[] = [
      { kind: 'light', baseUrl: 'https://cdn.nikkialbums.com/first/{id}.webp', replace: '{id}' },
      { kind: 'light', baseUrl: 'https://cdn.nikkialbums.com/second/{id}.webp', replace: '{id}' }
    ]
    expect(resolveNetworkImageUrl({ kind: 'light', id: 1, templates: duplicated })?.fetchUrl).toBe(
      'https://cdn.nikkialbums.com/first/1.webp'
    )
  })
})
