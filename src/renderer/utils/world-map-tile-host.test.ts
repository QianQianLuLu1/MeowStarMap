import { describe, it, expect } from 'vitest'
import { AUTHORIZED_WORLD_MAP_TILE_HOSTS, isAuthorizedTileTemplate } from './world-map-tile-host'

/**
 * 阶段 4 T3：瓦片来源合规。
 *
 * 官方「奇迹大陆大地图」瓦片（assets.papegames.com）按 nikki_albums #20 条款 6
 * 不要求额外 User-Agent，可按现有方式直连；上游作者自有 CDN（cdn.nikkialbums.com）
 * 的授权范围仅为图片资源，瓦片一律 fail-closed，不默认接入、不镜像、不二次分发。
 */
const OFFICIAL =
  'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp?x-oss-process=image/format,webp'

describe('AUTHORIZED_WORLD_MAP_TILE_HOSTS', () => {
  it('封闭集只含官方 host，不含上游作者 CDN 与既有图片 CDN', () => {
    expect([...AUTHORIZED_WORLD_MAP_TILE_HOSTS]).toEqual(['assets.papegames.com'])
    expect(AUTHORIZED_WORLD_MAP_TILE_HOSTS.has('cdn.nikkialbums.com')).toBe(false)
    expect(AUTHORIZED_WORLD_MAP_TILE_HOSTS.has('cdn.gongeo.us')).toBe(false)
  })
})

describe('isAuthorizedTileTemplate', () => {
  it('正常：官方模板（{z}-{x}-{y} + OSS query）放行并返回归一 host', () => {
    expect(isAuthorizedTileTemplate(OFFICIAL)).toEqual({
      ok: true,
      host: 'assets.papegames.com'
    })
  })

  it('正常：{z}/{x}/{y} 形式、FQDN 尾点、大小写混写均可归一', () => {
    const cases = [
      'https://assets.papegames.com/maps/{z}/{x}/{y}.webp',
      'https://assets.papegames.com./maps/{z}-{x}-{y}.webp',
      'https://ASSETS.PAPEGAMES.COM/maps/{z}-{x}-{y}.webp'
    ]
    for (const template of cases) {
      expect(isAuthorizedTileTemplate(template)).toEqual({
        ok: true,
        host: 'assets.papegames.com'
      })
    }
  })

  it('异常：非 https（http/file/javascript）→ insecure-protocol', () => {
    const cases = [
      'http://assets.papegames.com/maps/{z}-{x}-{y}.webp',
      'file:///C:/tiles/{z}-{x}-{y}.webp',
      'javascript:alert({z}{x}{y})'
    ]
    for (const template of cases) {
      expect(isAuthorizedTileTemplate(template)).toEqual({
        ok: false,
        reason: 'insecure-protocol'
      })
    }
  })

  it('异常：未授权 host 一律 fail-closed（不发出任何瓦片请求）', () => {
    const cases = [
      'https://cdn.nikkialbums.com/maps/{z}-{x}-{y}.webp',
      'https://cdn.gongeo.us/maps/{z}-{x}-{y}.webp',
      'https://evil.example.com/maps/{z}-{x}-{y}.webp',
      'https://assets.papegames.com.evil.com/maps/{z}-{x}-{y}.webp',
      'https://evilassets.papegames.com/maps/{z}-{x}-{y}.webp',
      'https://127.0.0.1/maps/{z}-{x}-{y}.webp',
      'https://localhost/maps/{z}-{x}-{y}.webp',
      'https://192.168.1.1/maps/{z}-{x}-{y}.webp'
    ]
    for (const template of cases) {
      expect(isAuthorizedTileTemplate(template)).toEqual({
        ok: false,
        reason: 'unauthorized-host'
      })
    }
  })

  it('异常：空串/空白/非字符串 → empty', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
      expect(isAuthorizedTileTemplate(bad)).toEqual({ ok: false, reason: 'empty' })
    }
  })

  it('异常：不可解析 URL 或携带 userinfo → unparsable', () => {
    for (const bad of [
      'garbage',
      '://no-scheme',
      'https://',
      'https://evil@assets.papegames.com/maps/{z}-{x}-{y}.webp',
      'https://user:pwd@assets.papegames.com/maps/{z}-{x}-{y}.webp'
    ]) {
      expect(isAuthorizedTileTemplate(bad)).toEqual({ ok: false, reason: 'unparsable' })
    }
  })

  it('边界：缺任一占位符 → missing-placeholders', () => {
    const cases = [
      'https://assets.papegames.com/maps/tiles.webp',
      'https://assets.papegames.com/maps/{z}-{x}.webp',
      'https://assets.papegames.com/maps/{x}-{y}.webp',
      'https://assets.papegames.com/maps/{Z}-{X}-{Y}.webp'
    ]
    for (const template of cases) {
      expect(isAuthorizedTileTemplate(template)).toEqual({
        ok: false,
        reason: 'missing-placeholders'
      })
    }
  })

  it('边界：host 授权判定先于占位符判定（未授权域不泄露模板细节）', () => {
    expect(
      isAuthorizedTileTemplate('https://cdn.nikkialbums.com/maps/no-placeholders.webp')
    ).toEqual({ ok: false, reason: 'unauthorized-host' })
  })
})

// 审查修复（2026-11-11）：非 443 端口显式拒绝。CSP img-src 的默认端口匹配实际会拦，
// 但守卫层不应依赖浏览器兜底——授权主机 + 非标端口仍可能是代理/劫持入口。
describe('isAuthorizedTileTemplate — 端口闸门（审查修复）', () => {
  it('异常：官方 host 但非 443 端口 → non-standard-port', () => {
    expect(
      isAuthorizedTileTemplate('https://assets.papegames.com:8443/maps/tiles-1/{z}-{x}-{y}.webp')
    ).toEqual({ ok: false, reason: 'non-standard-port' })
    expect(isAuthorizedTileTemplate('https://assets.papegames.com:444/{z}-{x}-{y}.webp')).toEqual({
      ok: false,
      reason: 'non-standard-port'
    })
  })

  it('正常：显式 443 与缺省端口均放行', () => {
    expect(
      isAuthorizedTileTemplate('https://assets.papegames.com:443/maps/{z}-{x}-{y}.webp')
    ).toEqual({ ok: true, host: 'assets.papegames.com' })
    expect(isAuthorizedTileTemplate('https://assets.papegames.com/maps/{z}-{x}-{y}.webp')).toEqual({
      ok: true,
      host: 'assets.papegames.com'
    })
  })
})
