// N6：installPreviewMock() 的命名空间装配契约。
// 与 nikkisync-mock.test.ts 互补：本文件只盯「nikkisync 是否被真实挂载」与
// 「Proxy 兜底 / 既有命名空间是否仍成立」，不重复断言桩数据内容。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installPreviewMock } from './install'
import { PREVIEW_UNSUPPORTED } from './ipc-error'

type AnyFn = (...args: unknown[]) => unknown
type ApiShape = Record<string, Record<string, AnyFn>>

function installedApi(): ApiShape {
  return (globalThis as unknown as { window: { electronAPI: ApiShape } }).window.electronAPI
}

beforeEach(() => {
  vi.stubGlobal('window', {})
  installPreviewMock()
})

describe('installPreviewMock 命名空间装配', () => {
  it('nikkisync 作为已实现命名空间被真实挂载（ownKeys 可见）', () => {
    const nikkisync = installedApi().nikkisync
    expect(nikkisync).toBeDefined()
    expect(Object.keys(nikkisync)).toContain('getRuntimeStatus')
  })

  it('未实现的命名空间仍由 Proxy 兜底抛 PREVIEW_UNSUPPORTED', async () => {
    const api = installedApi()
    let caught: unknown
    try {
      await api.noSuchNamespaceInN6.whatever()
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string } | undefined)?.code).toBe(PREVIEW_UNSUPPORTED)
  })

  it('既有 database 命名空间不受影响', () => {
    expect(installedApi().database).toBeDefined()
  })
})
