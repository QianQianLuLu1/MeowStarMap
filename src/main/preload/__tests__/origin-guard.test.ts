/**
 * @layer L2
 * @module src/main/preload/origin-guard
 * @coverage readDocumentOrigin / isTrustedDocumentOrigin / isPreloadDev
 * @dependencies 仅被测模块（零依赖，electron 亦不引入）
 *
 * 难点：
 * 1. 本模块在 node 环境下没有 location 全局，需用 vi.stubGlobal 模拟渲染进程文档
 * 2. dev 开关是编译期常量 __NIKKI_PRELOAD_DEV__（electron.vite.config.ts 注入），
 *    vitest 直接跑源码时未注入 → 安全缺省 false；dev 分支用 vi.stubGlobal 打开
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { isPreloadDev, isTrustedDocumentOrigin, readDocumentOrigin } from '../origin-guard'

function stubLocation(value: unknown): void {
  Object.defineProperty(globalThis, 'location', {
    value,
    configurable: true,
    writable: true
  })
}

function clearLocation(): void {
  delete (globalThis as unknown as Record<string, unknown>)['location']
}

afterEach(() => {
  clearLocation()
  vi.unstubAllGlobals()
})

describe('readDocumentOrigin', () => {
  it('1. node / 单测环境无 location 全局时返回 null', () => {
    clearLocation()
    expect(readDocumentOrigin()).toBeNull()
  })

  it('2. 有 location 时返回 location.origin', () => {
    stubLocation({ origin: 'app://renderer' })
    expect(readDocumentOrigin()).toBe('app://renderer')
  })

  it('3. location.origin 非字符串时返回 null（防御畸形宿主对象）', () => {
    stubLocation({ origin: 42 })
    expect(readDocumentOrigin()).toBeNull()
  })

  it('4. 读取 location 抛错时返回 null（按非授信处理，宁可拒绝授予）', () => {
    Object.defineProperty(globalThis, 'location', {
      get() {
        throw new Error('blocked')
      },
      configurable: true
    })
    expect(readDocumentOrigin()).toBeNull()
  })
})

describe('isPreloadDev', () => {
  it('1. 编译期常量未注入（vitest 直接跑源码）时安全缺省为 false', () => {
    expect(isPreloadDev()).toBe(false)
  })

  it('2. 注入 true 时为 true（dev 构建）', () => {
    vi.stubGlobal('__NIKKI_PRELOAD_DEV__', true)
    expect(isPreloadDev()).toBe(true)
  })

  it('3. 注入 false 时为 false（生产构建）', () => {
    vi.stubGlobal('__NIKKI_PRELOAD_DEV__', false)
    expect(isPreloadDev()).toBe(false)
  })

  it('4. 注入非布尔值时不误判为 dev', () => {
    vi.stubGlobal('__NIKKI_PRELOAD_DEV__', 'true')
    expect(isPreloadDev()).toBe(false)
  })
})

describe('isTrustedDocumentOrigin', () => {
  const trustedAlways = ['app://renderer', 'media://file', 'app://renderer/']
  const neverTrusted = [
    // 空 / opaque：evil 父页可 document.write 进自建 about:blank iframe 后访问其 contentWindow
    null,
    undefined,
    '',
    'null',
    'about:blank',
    'about:srcdoc',
    // 本地文件：历史白名单放行的正是这一类
    'file://',
    // 外站
    'https://example.com',
    'http://example.com',
    // 非 5173 端口的 localhost（被劫持的 dev server / 本机恶意服务）
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    // 前缀欺骗：不得因 startsWith('http://localhost') 而放行
    'http://localhost:5173.evil.com',
    'http://localhost5173.example'
  ]

  it.each(trustedAlways)('1. 生产与 dev 均放行授信协议源: %s', (origin) => {
    expect(isTrustedDocumentOrigin(origin, false)).toBe(true)
    expect(isTrustedDocumentOrigin(origin, true)).toBe(true)
  })

  it.each(neverTrusted)('2. 生产一律拒绝: %s', (origin) => {
    expect(isTrustedDocumentOrigin(origin, false)).toBe(false)
  })

  it.each(neverTrusted)('3. dev 下同样拒绝（dev 只额外放行 5173 端口）: %s', (origin) => {
    expect(isTrustedDocumentOrigin(origin, true)).toBe(false)
  })

  it('4. dev server 同源源仅在 dev 放行', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect(isTrustedDocumentOrigin(origin, true)).toBe(true)
      expect(isTrustedDocumentOrigin(origin, false)).toBe(false)
    }
  })
})
