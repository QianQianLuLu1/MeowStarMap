/**
 * @vitest-environment jsdom
 * @layer L2
 * @module src/renderer/hooks/useOnDemandThumbnails
 * @coverage 可视区缩略图按需生成的跨视图去重与结果复用
 */
import { StrictMode, useEffect } from 'react'
import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useOnDemandThumbnails } from './useOnDemandThumbnails'

describe('useOnDemandThumbnails', () => {
  it('同一路径并发触发时复用同一个生成请求', async () => {
    const generatedPath = 'C:\\cache\\same-path.jpg'
    const generate = vi.fn().mockResolvedValue(generatedPath)
    const originalElectronApi = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { thumbnail: { generate } }
    })

    try {
      const { result } = renderHook(() => useOnDemandThumbnails())
      const file = {
        file_path: `D:\\photos\\dedupe-${Date.now()}.jpg`,
        thumbnail: null
      }

      let values: Array<string | null> = []
      await act(async () => {
        values = await Promise.all([
          result.current.ensureThumbnail(file),
          result.current.ensureThumbnail(file)
        ])
      })

      expect(generate).toHaveBeenCalledTimes(1)
      expect(values).toEqual([generatedPath, generatedPath])
      expect(result.current.getGeneratedPath(file.file_path)).toBe(generatedPath)
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: originalElectronApi
      })
    }
  })

  it('React StrictMode effect 重挂载后仍回填生成结果', async () => {
    const generatedPath = 'C:\\cache\\strict-mode.jpg'
    const file = {
      file_path: `D:\\photos\\strict-${Date.now()}.jpg`,
      thumbnail: null
    }
    const generate = vi.fn().mockResolvedValue(generatedPath)
    const originalElectronApi = window.electronAPI
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { thumbnail: { generate } }
    })

    const Probe = () => {
      const { ensureThumbnail, getGeneratedPath } = useOnDemandThumbnails()
      useEffect(() => {
        void ensureThumbnail(file)
      }, [ensureThumbnail])
      return <div>{getGeneratedPath(file.file_path) ?? 'pending'}</div>
    }

    try {
      render(
        <StrictMode>
          <Probe />
        </StrictMode>
      )
      expect(await screen.findByText(generatedPath)).toBeTruthy()
    } finally {
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: originalElectronApi
      })
    }
  })
})
