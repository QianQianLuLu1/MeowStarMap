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
 *   二轮（2026-11-21）：线上 latest tag（MeowStarMap-Setup-2.5.6）的 release 缺 latest.yml，404 归
 *   source 按契约没错，错在「明明没有更新版本还弹错误弹窗」。新增 missingChannelUpToDateVersion：
 *   缺通道文件且 tag 版本 ≤ 当前版本 ⇒ 返回 tag 版本供主进程推 not-available；其余一律 null 保守回退。
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

describe('classifyUpdateError —— 传输层无码信号与包装状态码（2026-11-21 补口）', () => {
  // 取证：builder-util-runtime httpExecutor.js:282 的 60s socket 超时抛 new Error("Request timed out")，
  // 无 code、无 statusCode；atom feed / /releases/latest / latest.yml 三个请求任一超时都落到这个形状。
  // 契约（electron-api.ts:423）超时 ⇒ network，落到兜底就是「网络可达却弹『未获取到可用的更新信息』」本尊。
  it('60s socket 超时（「Request timed out」无码无状态）⇒ network', () => {
    expect(classifyUpdateError(new Error('Request timed out'))).toBe('network')
  })

  // httpExecutor.js:145：响应中途被服务端断开，同样无码。
  it('服务端中途断开（「Request has been aborted by the server」无码）⇒ network', () => {
    expect(classifyUpdateError(new Error('Request has been aborted by the server'))).toBe('network')
  })

  // GitHubProvider.getLatestTagName()（GitHubProvider.js:172-174）把 /releases/latest 的任何失败
  // 包成 ERR_UPDATER_LATEST_VERSION_NOT_FOUND：statusCode 丢失，只剩 e.stack 内嵌文本
  // 「HttpError: 403 …」。GitHub 限流返 403，归 source 会把限流误报成「更新源未就绪」。
  it('/releases/latest 包装丢失 statusCode：内嵌 HttpError: 403 ⇒ network', () => {
    expect(
      classifyUpdateError(
        errWithCode(
          'Unable to find latest version on GitHub (https://github.com/QianQianLuLu1/MeowStarMap/releases/latest), please ensure a production release exists: HttpError: 403 rate limit exceeded\n    at createHttpError (node_modules/builder-util-runtime/out/httpExecutor.js:53:12)',
          'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
        )
      )
    ).toBe('network')
  })

  it('内嵌 HttpError: 502（网关故障被包装）⇒ network', () => {
    expect(
      classifyUpdateError(
        errWithCode(
          'Unable to find latest version on GitHub (https://github.com/QianQianLuLu1/MeowStarMap/releases/latest), please ensure a production release exists: HttpError: 502 Bad Gateway\n    at createHttpError (node_modules/builder-util-runtime/out/httpExecutor.js:53:12)',
          'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
        )
      )
    ).toBe('network')
  })

  // 防过度矫正：该端点内嵌 404 是「没有已发布版本」，仍属源未就绪，不得被新提取拔成 network。
  it('包装内嵌 HttpError: 404 ⇒ 仍 source（防过度矫正）', () => {
    expect(
      classifyUpdateError(
        errWithCode(
          'Unable to find latest version on GitHub (https://github.com/QianQianLuLu1/MeowStarMap/releases/latest), please ensure a production release exists: HttpError: 404 Not Found',
          'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
        )
      )
    ).toBe('source')
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

describe('missingChannelUpToDateVersion —— 缺通道文件且无更新版本 ⇒ not-available（2026-11-21 二轮）', () => {
  // 线上实况（2026-11-21 实测）：/releases/latest = MeowStarMap-Setup-2.5.6，该 release 只有 exe、
  // 缺 latest.yml（404）。老行为弹「未获取到可用的更新信息」错误弹窗；新行为：tag 版本 ≤ 当前版本
  // ⇒ 返回 tag 版本供主进程推 not-available（「当前已是最新版本」）。
  // 红灯阶段函数尚未实现，用动态 import 保证既有用例不受影响地先跑红。
  const load = async (): Promise<typeof import('./update-error-class')> =>
    await import('./update-error-class')

  /** 线上真实抛错形状：channel 文件 404，message 内嵌带 tag 的下载 URL */
  function channelMissing(tag: string): Error {
    const e = new Error(
      `Cannot find latest.yml in the latest release artifacts (https://github.com/QianQianLuLu1/MeowStarMap/releases/download/${tag}/latest.yml): HttpError: Response code 404 (Not Found)`
    ) as Error & { code?: string }
    e.code = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
    return e
  }

  it('线上真实形态：tag MeowStarMap-Setup-2.5.6 + 当前 2.5.7 ⇒ 返回 2.5.6（→ not-available）', async () => {
    const { missingChannelUpToDateVersion } = await load()
    expect(missingChannelUpToDateVersion(channelMissing('MeowStarMap-Setup-2.5.6'), '2.5.7')).toBe(
      '2.5.6'
    )
  })

  it('版本相等：tag 2.5.7 + 当前 2.5.7 ⇒ 返回 2.5.7（已是最新）', async () => {
    const { missingChannelUpToDateVersion } = await load()
    expect(missingChannelUpToDateVersion(channelMissing('2.5.7'), '2.5.7')).toBe('2.5.7')
  })

  it('确有更新版本：tag 9.9.9 > 当前 2.5.7 ⇒ null（维持 source 错误弹窗）', async () => {
    const { missingChannelUpToDateVersion } = await load()
    expect(missingChannelUpToDateVersion(channelMissing('9.9.9'), '2.5.7')).toBeNull()
  })

  it('v 前缀 tag：v2.5.7 + 当前 2.5.7 ⇒ 返回 2.5.7', async () => {
    const { missingChannelUpToDateVersion } = await load()
    expect(missingChannelUpToDateVersion(channelMissing('v2.5.7'), '2.5.7')).toBe('2.5.7')
  })

  it('非缺失通道错误（ECONNREFUSED / Request timed out / INVALID_RELEASE_FEED）⇒ null', async () => {
    const { missingChannelUpToDateVersion } = await load()
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:8123') as Error & { code?: string }
    refused.code = 'ECONNREFUSED'
    const feed = new Error('Cannot parse releases feed: ...') as Error & { code?: string }
    feed.code = 'ERR_UPDATER_INVALID_RELEASE_FEED'
    expect(missingChannelUpToDateVersion(refused, '2.5.7')).toBeNull()
    expect(missingChannelUpToDateVersion(new Error('Request timed out'), '2.5.7')).toBeNull()
    expect(missingChannelUpToDateVersion(feed, '2.5.7')).toBeNull()
  })

  it('tag 无数字三元组（nightly）⇒ null（保守回退错误弹窗）', async () => {
    const { missingChannelUpToDateVersion } = await load()
    expect(missingChannelUpToDateVersion(channelMissing('nightly'), '2.5.7')).toBeNull()
  })

  it('字符串 / null 入参 ⇒ null 且不抛；cause 链内嵌的缺失通道错误也要提取到', async () => {
    const { missingChannelUpToDateVersion } = await load()
    expect(() => missingChannelUpToDateVersion('boom', '2.5.7')).not.toThrow()
    expect(missingChannelUpToDateVersion('boom', '2.5.7')).toBeNull()
    expect(missingChannelUpToDateVersion(null, '2.5.7')).toBeNull()
    const outer = new Error('Cannot check for updates')
    ;(outer as Error & { cause?: unknown }).cause = channelMissing('2.5.0')
    expect(missingChannelUpToDateVersion(outer, '2.5.7')).toBe('2.5.0')
  })
})
