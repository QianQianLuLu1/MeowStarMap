/**
 * @vitest-environment jsdom
 * @layer L3
 * @module src/renderer/hooks/{useBatchOperations,useFileOperations}
 * @coverage zustand 字段级订阅回归
 * @dependencies @testing-library/react, vitest
 * @remarks 防止回退到 `const { a, b } = useMediaStore()` 式的整 store 订阅。
 *   整 store 订阅下，扫描进度每次 tick（setScanProgress）都会让所有引用这两个
 *   共享 hook 的组件重渲染；改为字段级 selector 后不应再发生。
 *
 * 断言口径：宿主组件的实际渲染次数，而非 store 内部状态。
 */
import React from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useBatchOperations } from './useBatchOperations'
import { useFileOperations } from './useFileOperations'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'
import { useUIStore } from '../stores/uiStore'

const noop = (): void => {}
const asyncNoop = async (): Promise<void> => {}
const NO_FILES: MediaFile[] = []

function makeFile(id: string): MediaFile {
  return {
    id,
    file_path: `C:/photos/${id}.png`,
    file_name: `${id}.png`,
    file_type: 'image',
    file_size: 1024,
    created_at: '2026-01-01T00:00:00.000Z'
  } as MediaFile
}

// 渲染计数探针：挂载被测 hook，只统计宿主组件渲染次数
function mountProbe(useHook: () => unknown): { renders: () => number } {
  let count = 0
  const Probe: React.FC = () => {
    count += 1
    useHook()
    return null
  }
  render(<Probe />)
  return { renders: () => count }
}

// 模拟一次扫描过程中的高频进度推送
function pumpScanProgress(ticks: number): void {
  for (let i = 1; i <= ticks; i += 1) {
    act(() => {
      useMediaStore.getState().setScanProgress({
        scanning: true,
        scanned: i,
        found: i,
        currentPath: `C:/photos/batch-${i}`,
        status: 'running'
      })
    })
  }
}

describe('共享 hook 的 zustand 字段级订阅', () => {
  beforeEach(() => {
    useMediaStore.setState({
      mediaFiles: [],
      categories: [],
      loading: false,
      recycleBinFiles: [],
      recycleBinLoading: false,
      profiles: [],
      scanProgress: { scanning: false, scanned: 0, found: 0, currentPath: '', status: 'idle' }
    })
    useUIStore.setState({
      selectedMediaIds: [],
      searchQuery: '',
      sidebarCollapsed: false
    })
  })

  describe('useFileOperations（只订阅 action，均为稳定引用）', () => {
    const useProbeHook = (): unknown =>
      useFileOperations({
        filteredFiles: NO_FILES,
        onShowMessage: noop,
        onRefreshMedia: asyncNoop
      })

    it('扫描进度连续 60 次 tick 不应触发任何重渲染', () => {
      const probe = mountProbe(useProbeHook)
      const baseline = probe.renders()

      pumpScanProgress(60)

      expect(probe.renders()).toBe(baseline)
    })

    it('mediaFiles / selectedMediaIds 变化也不应触发重渲染（未订阅这些字段）', () => {
      const probe = mountProbe(useProbeHook)
      const baseline = probe.renders()

      act(() => {
        useMediaStore.getState().setMediaFiles([makeFile('a'), makeFile('b')])
      })
      act(() => {
        useUIStore.setState({ selectedMediaIds: ['a'] })
      })

      expect(probe.renders()).toBe(baseline)
    })
  })

  describe('useBatchOperations（订阅 mediaFiles + selectedMediaIds）', () => {
    const useProbeHook = (): unknown => useBatchOperations({ onShowMessage: noop })

    it('扫描进度连续 60 次 tick 不应触发任何重渲染', () => {
      const probe = mountProbe(useProbeHook)
      const baseline = probe.renders()

      pumpScanProgress(60)

      expect(probe.renders()).toBe(baseline)
    })

    it('搜索词等无关 UI 字段变化不应触发重渲染', () => {
      const probe = mountProbe(useProbeHook)
      const baseline = probe.renders()

      act(() => {
        useUIStore.setState({ searchQuery: 'sunset' })
      })
      act(() => {
        useUIStore.setState({ sidebarCollapsed: true })
      })

      expect(probe.renders()).toBe(baseline)
    })

    // 反向用例：订阅不能被削没，已订阅字段变化必须照常触发更新
    it('已订阅字段变化仍应触发重渲染', () => {
      const probe = mountProbe(useProbeHook)
      const baseline = probe.renders()

      act(() => {
        useMediaStore.getState().setMediaFiles([makeFile('a')])
      })
      expect(probe.renders()).toBe(baseline + 1)

      act(() => {
        useUIStore.setState({ selectedMediaIds: ['a'] })
      })
      expect(probe.renders()).toBe(baseline + 2)
    })
  })
})
