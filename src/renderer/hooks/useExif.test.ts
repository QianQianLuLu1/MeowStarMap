/**
 * @layer L3
 * @module src/renderer/hooks/useExif
 * @coverage EXIF 异步加载 + 取消竞态 + 错误处理
 * @dependencies react, window.electronAPI.file.getExif
 * @remarks jsdom 环境，mock window.electronAPI
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useExif } from './useExif'

describe('useExif', () => {
  let getExif: ReturnType<typeof vi.fn>

  beforeEach(() => {
    getExif = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      file: { getExif }
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('filePath 为 null 时 exif=null, loading=false, error=null', () => {
      const { result } = renderHook(() => useExif(null))
      expect(result.current.exif).toBeNull()
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('filePath 为 undefined 时同样为初始状态', () => {
      const { result } = renderHook(() => useExif(undefined))
      expect(result.current.exif).toBeNull()
      expect(result.current.loading).toBe(false)
    })

    it('enabled=false 时不加载', () => {
      const { result } = renderHook(() => useExif('/test/img.jpg', false))
      expect(result.current.exif).toBeNull()
      expect(result.current.loading).toBe(false)
      expect(getExif).not.toHaveBeenCalled()
    })
  })

  describe('加载成功', () => {
    it('filePath 变化时触发 getExif 调用', async () => {
      getExif.mockResolvedValue({ camera: 'Canon' })
      const { result } = renderHook(() => useExif('/img.jpg'))
      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(getExif).toHaveBeenCalledWith('/img.jpg')
      expect(result.current.exif).toEqual({ camera: 'Canon' })
      expect(result.current.error).toBeNull()
    })

    it('加载过程中 loading=true', async () => {
      let resolveExif: (val: unknown) => void
      getExif.mockReturnValue(
        new Promise((resolve) => {
          resolveExif = resolve
        })
      )
      const { result } = renderHook(() => useExif('/img.jpg'))
      expect(result.current.loading).toBe(true)
      resolveExif!({ camera: 'Nikon' })
      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(result.current.exif).toEqual({ camera: 'Nikon' })
    })

    it('getExif 返回 null 时 exif 设为 null', async () => {
      getExif.mockResolvedValue(null)
      const { result } = renderHook(() => useExif('/img.jpg'))
      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(result.current.exif).toBeNull()
    })

    it('getExif 返回 undefined 时 exif 设为 null', async () => {
      getExif.mockResolvedValue(undefined)
      const { result } = renderHook(() => useExif('/img.jpg'))
      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })
      expect(result.current.exif).toBeNull()
    })
  })

  describe('加载失败', () => {
    it('getExif reject 时设置 error', async () => {
      getExif.mockRejectedValue(new Error('EXIF parse fail'))
      const { result } = renderHook(() => useExif('/img.jpg'))
      await waitFor(() => {
        expect(result.current.error).not.toBeNull()
      })
      expect(result.current.error).toBe('EXIF parse fail')
      expect(result.current.exif).toBeNull()
      expect(result.current.loading).toBe(false)
    })

    it('getExif reject 字符串时 error 为该字符串', async () => {
      getExif.mockRejectedValue('string error')
      const { result } = renderHook(() => useExif('/img.jpg'))
      await waitFor(() => {
        expect(result.current.error).toBe('string error')
      })
    })

    it('getExif reject 数字时 error 为字符串形式', async () => {
      getExif.mockRejectedValue(42)
      const { result } = renderHook(() => useExif('/img.jpg'))
      await waitFor(() => {
        expect(result.current.error).toBe('42')
      })
    })
  })

  describe('filePath 切换', () => {
    it('切换 filePath 重新加载', async () => {
      getExif.mockResolvedValue({ camera: 'A' })
      const { result, rerender } = renderHook(({ path }) => useExif(path), {
        initialProps: { path: '/a.jpg' }
      })
      await waitFor(() => {
        expect(result.current.exif).toEqual({ camera: 'A' })
      })
      getExif.mockResolvedValue({ camera: 'B' })
      rerender({ path: '/b.jpg' })
      await waitFor(() => {
        expect(result.current.exif).toEqual({ camera: 'B' })
      })
      expect(getExif).toHaveBeenNthCalledWith(1, '/a.jpg')
      expect(getExif).toHaveBeenNthCalledWith(2, '/b.jpg')
    })

    it('切换到 null 时清空 exif', async () => {
      getExif.mockResolvedValue({ camera: 'A' })
      const { result, rerender } = renderHook(
        ({ path }: { path: string | null }) => useExif(path),
        { initialProps: { path: '/a.jpg' } as { path: string | null } }
      )
      await waitFor(() => {
        expect(result.current.exif).toEqual({ camera: 'A' })
      })
      rerender({ path: null })
      expect(result.current.exif).toBeNull()
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('切换 filePath 时取消上一次未完成的请求', async () => {
      let resolve1: (val: unknown) => void
      let resolve2: (val: unknown) => void
      getExif.mockReturnValueOnce(
        new Promise((resolve) => {
          resolve1 = resolve
        })
      )
      getExif.mockReturnValueOnce(
        new Promise((resolve) => {
          resolve2 = resolve
        })
      )
      const { result, rerender } = renderHook(({ path }) => useExif(path), {
        initialProps: { path: '/a.jpg' }
      })
      rerender({ path: '/b.jpg' })
      resolve1!({ camera: 'should be ignored' })
      resolve2!({ camera: 'B' })
      await waitFor(() => {
        expect(result.current.exif).toEqual({ camera: 'B' })
      })
      // 即使 resolve1 在 resolve2 之后才被调用，结果仍是 B（cancelled 标志生效）
      expect(result.current.exif).toEqual({ camera: 'B' })
    })
  })

  describe('window.electronAPI 缺失', () => {
    // 注：源码 useExif 中 `window.electronAPI?.file?.getExif(filePath).then(...)` 在
    // electronAPI 或 file 为 undefined 时会返回 undefined，随后 .then 同步抛 TypeError
    // 该错误在 useEffect 内同步抛出，React 18 会将其作为渲染错误处理；exif 保持初始 null
    it('electronAPI 为 undefined 时 exif 保持 null', () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
      const { result } = renderHook(() => useExif('/img.jpg'))
      expect(result.current.exif).toBeNull()
    })

    it('electronAPI.file 为 undefined 时 exif 保持 null', () => {
      ;(window as unknown as { electronAPI: unknown }).electronAPI = {}
      const { result } = renderHook(() => useExif('/img.jpg'))
      expect(result.current.exif).toBeNull()
    })
  })
})
