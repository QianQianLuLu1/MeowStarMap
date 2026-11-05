/**
 * @layer L2
 * @module src/main/app/cdn-user-agent
 * @coverage 固定 User-Agent 注册：目标主机改写 / 其它主机零干预 / fail-open / callback 恰好一次
 * @dependencies electron (session)、utils/logger
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { onBeforeSendHeaders, loggerWarn } = vi.hoisted(() => ({
  onBeforeSendHeaders: vi.fn(),
  loggerWarn: vi.fn()
}))

vi.mock('electron', () => ({
  session: { defaultSession: { webRequest: { onBeforeSendHeaders } } }
}))
vi.mock('../utils/logger', () => ({ logger: { warn: loggerWarn } }))

import { CDN_USER_AGENT, registerCdnUserAgent } from './cdn-user-agent'

type Headers = Record<string, string>
type BeforeResponse = { requestHeaders?: Headers }
type BeforeDetails = { url: string; requestHeaders?: Headers }
type BeforeListener = (details: BeforeDetails, callback: (response: BeforeResponse) => void) => void

// clearMocks:false：共享 vi.fn 的调用历史跨用例累积，取 listener 前必须手动清
beforeEach(() => {
  onBeforeSendHeaders.mockClear()
  loggerWarn.mockClear()
})

/** 每次重新注册并取出本次注册进 onBeforeSendHeaders 的 listener */
function registeredListener(): BeforeListener {
  registerCdnUserAgent()
  const listener = onBeforeSendHeaders.mock.calls[0]?.[0]
  if (typeof listener !== 'function') throw new Error('onBeforeSendHeaders 未注册')
  return listener as BeforeListener
}

/** 同步驱动 listener，收集它交给 callback 的响应 */
function drive(listener: BeforeListener, details: BeforeDetails): BeforeResponse {
  let response: BeforeResponse | undefined
  listener(details, (value) => {
    response = value
  })
  if (!response) throw new Error('callback 未被调用')
  return response
}

function hasWarn(text: string): boolean {
  return loggerWarn.mock.calls.some((call) => String(call[0]).includes(text))
}

describe('cdn-user-agent / 固定 User-Agent 标识', () => {
  it('正常 1：导出上游约定的固定标识', () => {
    expect(CDN_USER_AGENT).toBe('MeowStarMap')
  })

  it('正常 2：目标主机请求写入唯一 MeowStarMap 并保留其它头', () => {
    const listener = registeredListener()
    const original = { Accept: '*/*', 'User-Agent': 'Mozilla/5.0 Chrome/131' }
    const out = drive(listener, {
      url: 'https://cdn.gongeo.us/images/items/icons/1020100001.png',
      requestHeaders: { ...original }
    })

    expect(out.requestHeaders).toBeDefined()
    expect(out.requestHeaders!['User-Agent']).toBe('MeowStarMap')
    expect(
      Object.keys(out.requestHeaders!).filter((key) => key.toLowerCase() === 'user-agent')
    ).toEqual(['User-Agent'])
    expect(out.requestHeaders!['Accept']).toBe(original.Accept)
    expect(original['User-Agent']).toBe('Mozilla/5.0 Chrome/131')
  })

  it('正常 3：非目标主机零干预且不 mutate 入参', () => {
    const listener = registeredListener()
    const before = { 'User-Agent': 'Keep/1.0', Accept: '*/*' }
    const snapshot = { ...before }
    const out = drive(listener, {
      url: 'http://localhost:5173/@vite/client',
      requestHeaders: before
    })

    expect(out).toEqual({})
    expect(before).toEqual(snapshot)
  })

  it('异常 1：URL 解析失败 fail-open 并留下诊断', () => {
    const listener = registeredListener()
    const out = drive(listener, {
      url: 'not a valid url',
      requestHeaders: { 'User-Agent': 'Keep/1.0' }
    })

    expect(out).toEqual({})
    expect(hasWarn('URL parse failed')).toBe(true)
  })

  it('异常 2：目标请求缺少 requestHeaders 时 fail-open 并留下诊断', () => {
    const listener = registeredListener()
    const out = drive(listener, { url: 'https://cdn.gongeo.us/x.png', requestHeaders: undefined })

    expect(out).toEqual({})
    expect(hasWarn('requestHeaders')).toBe(true)
  })

  it('异常 3：callback 抛错时仍恰好调用一次（不重入）', () => {
    const callback = vi.fn().mockImplementationOnce(() => {
      throw new Error('callback boom')
    })
    const details: BeforeDetails = {
      url: 'https://cdn.gongeo.us/x.png',
      requestHeaders: { Accept: '*/*' }
    }

    expect(() => registeredListener()(details, callback)).not.toThrow()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('边界 1：空 requestHeaders 只补上唯一 UA', () => {
    const listener = registeredListener()
    const out = drive(listener, { url: 'https://cdn.gongeo.us/x.png', requestHeaders: {} })

    expect(out.requestHeaders).toEqual({ 'User-Agent': 'MeowStarMap' })
  })

  it('边界 2：既有 UA 的任意大小写变体都被剔除', () => {
    const listener = registeredListener()
    const out = drive(listener, {
      url: 'https://cdn.gongeo.us/x.png',
      requestHeaders: { 'user-agent': 'OldAgent/1.0', 'USER-AGENT': 'Other/2.0', Accept: '*/*' }
    })

    expect(
      Object.keys(out.requestHeaders!).filter((key) => key.toLowerCase() === 'user-agent')
    ).toEqual(['User-Agent'])
    expect(out.requestHeaders!['User-Agent']).toBe('MeowStarMap')
    expect(JSON.stringify(out.requestHeaders!)).not.toContain('OldAgent')
    expect(JSON.stringify(out.requestHeaders!)).not.toContain('Other')
  })

  it('边界 3：伪冒主机与路径含主机串都不改写', () => {
    const listener = registeredListener()
    for (const url of [
      'https://cdn.gongeo.us.evil.com/x.png',
      'https://evilcdn.gongeo.us/x.png',
      'https://example.com/cdn.gongeo.us/x.png'
    ]) {
      const before = { 'User-Agent': 'Keep/1.0' }
      expect(drive(listener, { url, requestHeaders: before })).toEqual({})
      expect(before['User-Agent']).toBe('Keep/1.0')
    }
  })
})
