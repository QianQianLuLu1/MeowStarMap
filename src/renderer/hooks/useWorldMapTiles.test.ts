/**
 * @vitest-environment jsdom
 *
 * useWorldMapTiles 契约（阶段 4 T4）：只消费既有 refdata:* 查询通道，不改契约。
 * - 正常：v1.db 索引就绪 → 返回 6 世界瓦片参数；
 * - 异常：available:false / IPC 抛错 / 桥缺失 / 返回非数组 → 可判定的降级态，不崩溃；
 * - 边界：预览版不发 IPC；卸载后异步 resolve 不产生后续状态写入或报错。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type HookModule = typeof import('./useWorldMapTiles')

let useWorldMapTiles: HookModule['useWorldMapTiles']
let getWorldMapTiles: ReturnType<typeof vi.fn>
let getStatus: ReturnType<typeof vi.fn>

const TILE = {
  worldId: 1,
  urlTemplate:
    'https://assets.papegames.com/maps/tiles-1/{z}-{x}-{y}.webp?x-oss-process=image/format,webp',
  minZoom: 0,
  maxZoom: 6,
  mapWidthOfMaxZoom: 16384,
  mapHeightOfMaxZoom: 16384,
  originalPointX: 8192,
  originalPointY: -51838.2,
  pxPreUnit: 4
}

function installBridge(): void {
  getWorldMapTiles = vi.fn(async () => ({ tiles: [TILE] }))
  getStatus = vi.fn(async () => ({
    available: true,
    packages: [],
    lastCheckedAt: null,
    lastError: null,
    updating: false
  }))
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    referenceData: { getWorldMapTiles, getStatus }
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.unstubAllGlobals()
  installBridge()
  ;({ useWorldMapTiles } = await import('./useWorldMapTiles'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('useWorldMapTiles — 正常', () => {
  it('返回瓦片 + available:true → tiles 就绪、两通道各调用一次', async () => {
    const { result } = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tiles).toEqual([TILE])
    expect(result.current.serviceAvailable).toBe(true)
    expect(result.current.error).toBeNull()
    expect(getWorldMapTiles).toHaveBeenCalledTimes(1)
    expect(getStatus).toHaveBeenCalledTimes(1)
  })
})

describe('useWorldMapTiles — 异常', () => {
  it('getStatus 报 available:false → 降级态可判定，tiles 原样保留', async () => {
    getStatus.mockResolvedValue({
      available: false,
      packages: [],
      lastCheckedAt: null,
      lastError: 'offline',
      updating: false
    })
    const { result } = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.serviceAvailable).toBe(false)
    expect(result.current.tiles).toEqual([TILE])
    expect(result.current.error).toBeNull()
  })

  it('IPC 抛错 → error=ipc-error、空瓦片，不崩溃', async () => {
    getWorldMapTiles.mockRejectedValue(new Error('bridge boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { result } = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tiles).toEqual([])
    expect(result.current.serviceAvailable).toBe(false)
    expect(result.current.error).toBe('ipc-error')
    expect(errorSpy).toHaveBeenCalled()
  })

  it('window.electronAPI 缺失 → error=no-bridge 且不发 IPC', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    const { result } = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('no-bridge')
    expect(result.current.tiles).toEqual([])
    expect(getWorldMapTiles).not.toHaveBeenCalled()
  })

  it('返回非数组 / undefined → tiles=[] 且不抛错', async () => {
    getWorldMapTiles.mockResolvedValue(undefined)
    const first = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    expect(first.result.current.tiles).toEqual([])
    first.unmount()

    getWorldMapTiles.mockResolvedValue({ tiles: 'garbage' })
    const second = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(second.result.current.loading).toBe(false))
    expect(second.result.current.tiles).toEqual([])
  })
})

describe('useWorldMapTiles — 边界', () => {
  it('预览版（__PREVIEW__=true）→ error=preview 且不发 IPC', async () => {
    vi.stubGlobal('__PREVIEW__', true)
    const { result } = renderHook(() => useWorldMapTiles())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('preview')
    expect(result.current.tiles).toEqual([])
    expect(getWorldMapTiles).not.toHaveBeenCalled()
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('卸载后异步 resolve → 不抛错、无 console.error', async () => {
    let resolveTiles: (value: unknown) => void = () => undefined
    getWorldMapTiles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTiles = resolve
        })
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = renderHook(() => useWorldMapTiles())
    unmount()
    resolveTiles({ tiles: [TILE] })
    await Promise.resolve()
    await Promise.resolve()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // 审查修复（2026-11-11）：enabled=false（非游戏图片/注入数据形态）零 IPC。
  it('enabled=false → 不发起任何 IPC，返回可判定空态', async () => {
    const { result } = renderHook(() => useWorldMapTiles(false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.tiles).toEqual([])
    expect(result.current.serviceAvailable).toBe(false)
    expect(result.current.error).toBeNull()
    expect(getWorldMapTiles).not.toHaveBeenCalled()
    expect(getStatus).not.toHaveBeenCalled()
  })
})
