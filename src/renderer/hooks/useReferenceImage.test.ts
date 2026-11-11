/**
 * @vitest-environment jsdom
 *
 * useReferenceImage 契约：按需解析一张参考图片（一次一张、不预取不批量）。
 * - 前置闸门（预览版 / 桥缺失 / id 非正安全整数）→ src=null 且不发 IPC；
 * - 模块级终态缓存 + in-flight 去重：同 key 重复挂载零重复 IPC（null 终态也缓存）；
 * - kind/id 切换竞态与卸载取消：旧结果不得覆盖新状态。
 * 主进程侧已有磁盘缓存/负缓存/冷却，渲染层收敛优先，会话内不重试。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type HookModule = typeof import('./useReferenceImage')

let useReferenceImage: HookModule['useReferenceImage']
let resolveImage: ReturnType<typeof vi.fn>

const CACHE_PATH = '/tmp/reference-images/abc.png'
const EXPECTED_SRC = `media://file?path=${encodeURIComponent(CACHE_PATH)}`

function installBridge(): void {
  resolveImage = vi.fn(async () => ({ path: CACHE_PATH, status: 'cached' }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    referenceData: { resolveImage }
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.unstubAllGlobals()
  installBridge()
  ;({ useReferenceImage } = await import('./useReferenceImage'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('useReferenceImage — 正常', () => {
  it('resolve 返回缓存路径 → src 为 media:// 供图 URL，IPC 按 (kind,id) 调用一次', async () => {
    const { result } = renderHook(() => useReferenceImage('nikkiPose', 42))
    await waitFor(() => expect(result.current.src).toBe(EXPECTED_SRC))
    expect(resolveImage).toHaveBeenCalledTimes(1)
    expect(resolveImage).toHaveBeenCalledWith('nikkiPose', 42)
  })

  it('同 key 两个并发挂载 → in-flight 去重只发一次 IPC，两者同得 src', async () => {
    const a = renderHook(() => useReferenceImage('momoPose', 7))
    const b = renderHook(() => useReferenceImage('momoPose', 7))
    await waitFor(() => expect(a.result.current.src).toBe(EXPECTED_SRC))
    expect(b.result.current.src).toBe(EXPECTED_SRC)
    expect(resolveImage).toHaveBeenCalledTimes(1)
  })

  it('终态缓存命中：卸载后重新挂载同 key → 零新增 IPC', async () => {
    const first = renderHook(() => useReferenceImage('nikkiPose', 42))
    await waitFor(() => expect(first.result.current.src).toBe(EXPECTED_SRC))
    first.unmount()
    const second = renderHook(() => useReferenceImage('nikkiPose', 42))
    await waitFor(() => expect(second.result.current.src).toBe(EXPECTED_SRC))
    expect(resolveImage).toHaveBeenCalledTimes(1)
  })
})

describe('useReferenceImage — 异常', () => {
  it('resolve 返回 path:null → src=null；null 终态缓存，重挂载不再发 IPC', async () => {
    resolveImage.mockResolvedValue({ path: null, status: 'unauthorized' })
    const first = renderHook(() => useReferenceImage('nikkiPose', 42))
    await waitFor(() => expect(resolveImage).toHaveBeenCalledTimes(1))
    expect(first.result.current.src).toBeNull()
    first.unmount()
    renderHook(() => useReferenceImage('nikkiPose', 42))
    await Promise.resolve()
    expect(resolveImage).toHaveBeenCalledTimes(1)
  })

  it('IPC 抛错（桥异常）→ 静默降级 src=null，不崩溃', async () => {
    resolveImage.mockRejectedValue(new Error('bridge boom'))
    const { result } = renderHook(() => useReferenceImage('nikkiPose', 42))
    await waitFor(() => expect(resolveImage).toHaveBeenCalledTimes(1))
    expect(result.current.src).toBeNull()
  })

  it('window.electronAPI 缺失 → src=null 且不抛错', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    const { result } = renderHook(() => useReferenceImage('nikkiPose', 42))
    await Promise.resolve()
    expect(result.current.src).toBeNull()
  })

  it('预览版（__PREVIEW__=true）→ src=null 且不发 IPC', async () => {
    vi.stubGlobal('__PREVIEW__', true)
    const { result } = renderHook(() => useReferenceImage('nikkiPose', 42))
    await Promise.resolve()
    expect(result.current.src).toBeNull()
    expect(resolveImage).not.toHaveBeenCalled()
  })
})

describe('useReferenceImage — 边界', () => {
  it.each([0, -1, 1.5, Number.NaN])('id=%s 非正安全整数 → src=null 且不发 IPC', async (id) => {
    const { result } = renderHook(() => useReferenceImage('nikkiPose', id))
    await Promise.resolve()
    expect(result.current.src).toBeNull()
    expect(resolveImage).not.toHaveBeenCalled()
  })

  it('kind/id 切换竞态：慢的旧结果不得覆盖快的新结果', async () => {
    resolveImage.mockImplementation((_kind: string, id: number) => {
      const path = id === 1 ? '/tmp/old.png' : '/tmp/new.png'
      return new Promise((resolve) =>
        setTimeout(() => resolve({ path, status: 'cached' }), id === 1 ? 40 : 5)
      )
    })
    const { result, rerender } = renderHook(({ id }) => useReferenceImage('nikkiPose', id), {
      initialProps: { id: 1 }
    })
    rerender({ id: 2 })
    await waitFor(() =>
      expect(result.current.src).toBe(`media://file?path=${encodeURIComponent('/tmp/new.png')}`)
    )
    // 等旧请求落地后仍不得回写
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(result.current.src).toBe(`media://file?path=${encodeURIComponent('/tmp/new.png')}`)
  })

  it('resolve 落地前卸载 → 不 setState、不抛错', async () => {
    let settle: (value: { path: string; status: string }) => void = () => undefined
    resolveImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const { unmount } = renderHook(() => useReferenceImage('nikkiPose', 42))
    unmount()
    settle({ path: CACHE_PATH, status: 'cached' })
    await Promise.resolve()
    expect(resolveImage).toHaveBeenCalledTimes(1)
  })
})
