// @layer main/utils
// @module remote-url-guard
// @coverage 出站 URL 安全守卫的协议白名单与危险地址段拦截
import { describe, it, expect } from 'vitest'
import { assertSafeRemoteUrl, isForbiddenHost, RemoteUrlGuardError } from './remote-url-guard'

describe('assertSafeRemoteUrl', () => {
  it('公网 https/http URL 放行', () => {
    expect(() =>
      assertSafeRemoteUrl('https://nikki.ranaxro.com/app_api/hot_update.json')
    ).not.toThrow()
    expect(() =>
      assertSafeRemoteUrl('http://file-nikki.ranaxro.com/hot_update/nuan5_database/v1.db')
    ).not.toThrow()
  })

  it('解析失败拒绝', () => {
    expect(() => assertSafeRemoteUrl('not-a-url')).toThrow(RemoteUrlGuardError)
  })

  it('非 http/https 协议拒绝', () => {
    for (const url of ['ftp://data.example.test/v1', 'file:///etc/passwd', 'data:text/plain,hi']) {
      expect(() => assertSafeRemoteUrl(url)).toThrow(RemoteUrlGuardError)
    }
  })

  it('localhost / 环回 / 私网 / 保留段拒绝', () => {
    for (const host of [
      'localhost',
      'foo.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.9',
      '172.31.255.255',
      '169.254.10.10',
      '0.1.2.3',
      '240.0.0.1'
    ]) {
      expect(() => assertSafeRemoteUrl(`http://${host}:9/v1`), host).toThrow(RemoteUrlGuardError)
    }
  })

  it('IPv6 环回 / 唯一本地 / 链路本地 / IPv4 映射私网拒绝', () => {
    for (const host of [
      '::',
      '::1',
      '[::1]',
      'fc00::1',
      'fd12::1',
      'fe80::1',
      '::ffff:192.168.1.1'
    ]) {
      expect(() => assertSafeRemoteUrl(`http://${host}/v1`), host).toThrow(RemoteUrlGuardError)
    }
  })

  it('公网 IPv4 / IPv6 / 带尾点域名放行', () => {
    expect(() => assertSafeRemoteUrl('http://8.8.8.8/v1')).not.toThrow()
    expect(() => assertSafeRemoteUrl('http://[2606:4700::1111]/v1')).not.toThrow()
    expect(() => assertSafeRemoteUrl('https://example.test./v1')).not.toThrow()
  })
})

describe('isForbiddenHost', () => {
  it('私网段边界：172.16-31 禁、172.32 放行', () => {
    expect(isForbiddenHost('172.15.0.1')).toBe(false)
    expect(isForbiddenHost('172.16.0.1')).toBe(true)
    expect(isForbiddenHost('172.31.255.255')).toBe(true)
    expect(isForbiddenHost('172.32.0.1')).toBe(false)
  })

  it('非 IP 主机名默认放行（白名单由调用方收窄）', () => {
    expect(isForbiddenHost('file-nikki.ranaxro.com')).toBe(false)
    expect(isForbiddenHost('evil.example.test')).toBe(false)
  })
})
