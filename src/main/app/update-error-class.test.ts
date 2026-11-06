/**
 * @layer L1
 * @module src/main/app/update-error-class
 * @coverage 更新错误分类：区分「连不上 GitHub」与「GitHub 连得上但更新源未就绪」，兜底判 source
 * @dependencies 无（纯函数，输入为真实错误形态 fixture）
 * @remarks 判据来源：2026-11-05「检查更新永远误报当前网络繁忙」取证。GitHub 上 10 个 Release
 *   全部缺 latest.yml（实测 `.../releases/download/MeowStarMap-Setup-2.5.6/latest.yml` → 404，
 *   而 `releases.atom` → 200），electron-updater 抛 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND，
 *   旧实现把它与真断网一并推成 stage:'error'，UI 恒显示「当前网络繁忙」。
 *   顺序契约：electron-updater 的 getLatestTagName 会把 DNS/连接失败**包装**进
 *   ERR_UPDATER_LATEST_VERSION_NOT_FOUND 的 message（`Unable to find latest version on GitHub
 *   (url), please ensure a production release exists: <inner stack>`），因此字符串级网络信号
 *   必须优先于 ERR_UPDATER_ 前缀判定，否则真断网仍被误报成「源未就绪」。
 */
import { describe, it, expect } from 'vitest'
import { classifyUpdateError } from './update-error-class'

/** 构造带 code 的错误（builder-util-runtime 的 newError(msg, code) 形态） */
function errWithCode(message: string, code?: string): Error {
  const e = new Error(message) as Error & { code?: string }
  if (code) e.code = code
  return e
}

/** 构造带 statusCode 的 HttpError（builder-util-runtime HttpError 形态） */
function httpError(statusCode: number): Error {
  const e = new Error(`Response code ${statusCode} (Status)`) as Error & { statusCode?: number }
  e.statusCode = statusCode
  e.name = 'HttpError'
  return e
}

describe('classifyUpdateError —— 更新源未就绪不得判成网络', () => {
  it('今天的真实错误：latest.yml 404（ERR_UPDATER_CHANNEL_FILE_NOT_FOUND）⇒ source', () => {
    expect(
      classifyUpdateError(
        errWithCode(
          'Cannot find latest.yml in the latest release artifacts (https://github.com/QianQianLuLu1/MeowStarMap/releases/download/2.5.0/latest.yml): HttpError: Response code 404 (Not Found)',
          'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
        )
      )
    ).toBe('source')
  })

  it('feed 里没有任何已发布版本（ERR_UPDATER_NO_PUBLISHED_VERSIONS）⇒ source', () => {
    expect(
      classifyUpdateError(
        errWithCode('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')
      )
    ).toBe('source')
  })

  it('releases 订阅解析失败（ERR_UPDATER_INVALID_RELEASE_FEED）⇒ source', () => {
    expect(
      classifyUpdateError(
        errWithCode(
          'Cannot parse releases feed: TypeError..., XML:...',
          'ERR_UPDATER_INVALID_RELEASE_FEED'
        )
      )
    ).toBe('source')
  })

  it('app 版本号不是合法 semver（ERR_UPDATER_INVALID_VERSION）⇒ source', () => {
    expect(
      classifyUpdateError(
        errWithCode('App version is not a valid semver version: "x"', 'ERR_UPDATER_INVALID_VERSION')
      )
    ).toBe('source')
  })
})

describe('classifyUpdateError —— 真连不上必须判 network', () => {
  it('DNS 解析失败（ENOTFOUND）⇒ network', () => {
    expect(classifyUpdateError(errWithCode('getaddrinfo ENOTFOUND github.com', undefined))).toBe(
      'network'
    )
  })

  it('DNS 临时失败（EAI_AGAIN）⇒ network', () => {
    expect(classifyUpdateError(errWithCode('getaddrinfo EAI_AGAIN github.com'))).toBe('network')
  })

  it('连接被拒（ECONNREFUSED，本地假源未启动的形态）⇒ network', () => {
    expect(
      classifyUpdateError(errWithCode('connect ECONNREFUSED 127.0.0.1:8123', 'ECONNREFUSED'))
    ).toBe('network')
  })

  it('连接重置（ECONNRESET）⇒ network', () => {
    expect(classifyUpdateError(errWithCode('read ECONNRESET'))).toBe('network')
  })

  it('读超时（ETIMEDOUT）⇒ network', () => {
    expect(classifyUpdateError(errWithCode('connect ETIMEDOUT 140.82.113.3:443'))).toBe('network')
  })

  it('Electron net 栈错误（net::ERR_NAME_NOT_RESOLVED）⇒ network', () => {
    expect(classifyUpdateError(errWithCode('net::ERR_NAME_NOT_RESOLVED'))).toBe('network')
  })

  it('TLS 证书过期（CERT_HAS_EXPIRED）⇒ network', () => {
    expect(
      classifyUpdateError(errWithCode('unable to verify the first certificate: CERT_HAS_EXPIRED'))
    ).toBe('network')
  })

  it('自签证书（DEPTH_ZERO_SELF_SIGNED_CERT）⇒ network', () => {
    expect(
      classifyUpdateError(errWithCode('self-signed certificate: DEPTH_ZERO_SELF_SIGNED_CERT'))
    ).toBe('network')
  })

  it('被包装进 ERR_UPDATER_LATEST_VERSION_NOT_FOUND 的 DNS 失败 ⇒ network（顺序契约，关键用例）', () => {
    expect(
      classifyUpdateError(
        errWithCode(
          'Unable to find latest version on GitHub (https://github.com/QianQianLuLu1/MeowStarMap/releases/latest), please ensure a production release exists: Error: getaddrinfo ENOTFOUND github.com',
          'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
        )
      )
    ).toBe('network')
  })

  it('cause 链上的网络错误码也要认得 ⇒ network', () => {
    const outer = errWithCode('Cannot check for updates', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')
    ;(outer as Error & { cause?: unknown }).cause = errWithCode('socket hang up ECONNRESET')
    expect(classifyUpdateError(outer)).toBe('network')
  })
})

describe('classifyUpdateError —— HTTP 状态码判据', () => {
  it('5xx 服务器侧故障 ⇒ network', () => {
    expect(classifyUpdateError(httpError(500))).toBe('network')
    expect(classifyUpdateError(httpError(503))).toBe('network')
  })

  it('408 请求超时 ⇒ network', () => {
    expect(classifyUpdateError(httpError(408))).toBe('network')
  })

  it('429 限流 ⇒ network', () => {
    expect(classifyUpdateError(httpError(429))).toBe('network')
  })

  it('404 可达但资源不对 ⇒ source（回归锁）', () => {
    expect(classifyUpdateError(httpError(404))).toBe('source')
  })

  it('403 / 407 限流与代理鉴权按 network 归类（GitHub 限流返 403，不是源内容问题）', () => {
    expect(classifyUpdateError(httpError(403))).toBe('network')
    expect(classifyUpdateError(httpError(407))).toBe('network')
  })
})

describe('classifyUpdateError —— 边界与非法输入（永不抛错）', () => {
  it('非 Error 的字符串 ⇒ 兜底 source', () => {
    expect(classifyUpdateError('boom')).toBe('source')
  })

  it('null / undefined ⇒ 兜底 source', () => {
    expect(classifyUpdateError(null)).toBe('source')
    expect(classifyUpdateError(undefined)).toBe('source')
  })

  it('无 code、无 statusCode、message 无网络信号的普通 Error ⇒ 兜底 source', () => {
    expect(classifyUpdateError(new Error('something unexpected in updater'))).toBe('source')
  })

  it('裸对象（既非 Error 也无可读字段）⇒ 兜底 source，且不抛', () => {
    expect(classifyUpdateError({ weird: true })).toBe('source')
  })

  it('兜底方向必须是 source：兜底 network 就是本轮要消灭的误报形状', () => {
    expect(classifyUpdateError(new Error('完全无法归类的第三种失败'))).toBe('source')
  })
})

describe('classifyUpdateError —— statusOf / code 沿 cause 链递归提取', () => {
  it('cause.statusCode=503 ⇒ network（statusOf 不能只查 err 自身）', () => {
    const outer = errWithCode('Cannot check for updates')
    ;(outer as Error & { cause?: unknown }).cause = httpError(503)
    expect(classifyUpdateError(outer)).toBe('network')
  })

  it('深层 cause（两层）里的 statusCode=503 也要判 network（递归，不止一层）', () => {
    const outer = errWithCode('Cannot check for updates')
    const mid = errWithCode('wrapped by provider')
    ;(mid as Error & { cause?: unknown }).cause = httpError(503)
    ;(outer as Error & { cause?: unknown }).cause = mid
    expect(classifyUpdateError(outer)).toBe('network')
  })

  it('cause.code=ERR_UPDATER_* 沿链识别：深层 cause + 循环引用不抛、归 source', () => {
    const outer = errWithCode('Cannot check for updates')
    const mid = errWithCode('wrapped by provider', 'ERR_UPDATER_INVALID_RELEASE_FEED')
    ;(outer as Error & { cause?: unknown }).cause = mid
    // 循环引用：递归提取必须带 seen 保护，否则栈溢出
    ;(mid as Error & { cause?: unknown }).cause = outer
    expect(() => classifyUpdateError(outer)).not.toThrow()
    expect(classifyUpdateError(outer)).toBe('source')
  })
})

describe('classifyUpdateError —— 属性访问永不抛错（throwing getter / Proxy 边界）', () => {
  it('code 是 throwing getter 时不抛、归 source（兜底方向不变）', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'code', {
      get() {
        throw new Error('code getter exploded')
      },
      configurable: true
    })
    expect(() => classifyUpdateError(err)).not.toThrow()
    expect(classifyUpdateError(err)).toBe('source')
  })

  it('cause 是 throwing getter 时不抛（cause 链遍历也要 safe getter）', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'cause', {
      get() {
        throw new Error('cause getter exploded')
      },
      configurable: true
    })
    expect(() => classifyUpdateError(err)).not.toThrow()
    expect(classifyUpdateError(err)).toBe('source')
  })

  it('Proxy 的 get trap 抛错时不抛、归 source', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy get exploded')
        }
      }
    )
    expect(() => classifyUpdateError(hostile)).not.toThrow()
    expect(classifyUpdateError(hostile)).toBe('source')
  })
})
