import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { ResonanceRecordsPage } from './ResonanceRecordsPage'
import { useResonanceStore } from '../stores/resonanceStore'
import type { ResonanceGetDataResult } from '../../shared/types/resonance'

/**
 * 共鸣录页面容器测试：mock electronAPI.resonance（tests/setup.ts 已初始化 i18n
 * 为 zh-CN，断言直接写中文文案）；beforeEach 重置 store 快照。
 */

const emptyData: ResonanceGetDataResult = {
  pulls: [],
  edits: [],
  pearpal: [],
  evo: [],
  wardrobe: {
    version: 1,
    ownedItemIds: [],
    ownedMakeupIds: [],
    ownedMomoIds: [],
    ownedPropIds: [],
    ownedEurekaColorIds: [],
    updatedAt: ''
  }
}

function installElectronApi(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    resonance: {
      getData: vi.fn(() => Promise.resolve(emptyData)),
      addManualRecord: vi.fn(),
      updateManualRecord: vi.fn(),
      deleteRecord: vi.fn(),
      readImportFile: vi.fn(),
      commitImport: vi.fn(),
      export: vi.fn(),
      updateWardrobe: vi.fn(),
      clearAll: vi.fn(),
      ...overrides
    }
  }
}

describe('ResonanceRecordsPage 容器', () => {
  beforeEach(() => {
    useResonanceStore.getState().reset()
    installElectronApi()
  })
  afterEach(() => {
    cleanup()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('渲染品牌标题与四个子页切换按钮', () => {
    render(<ResonanceRecordsPage />)
    expect(screen.getByText('无限暖暖')).toBeTruthy()
    expect(screen.getByText('暖暖共鸣录')).toBeTruthy()
    expect(screen.getByRole('tab', { name: '共鸣记录' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '我的衣橱' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '导入数据' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '个人统计' })).toBeTruthy()
  })

  it('首次挂载触发数据懒加载，加载完成后进入默认子页', async () => {
    const getData = vi.fn(() => Promise.resolve(emptyData))
    installElectronApi({ getData })
    render(<ResonanceRecordsPage />)
    await waitFor(() => expect(getData).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '共鸣记录' }).getAttribute('aria-selected')).toBe(
        'true'
      )
    )
  })

  it('点击子页按钮切换视图', async () => {
    render(<ResonanceRecordsPage />)
    await waitFor(() => expect(useResonanceStore.getState().loaded).toBe(true))
    fireEvent.click(screen.getByRole('tab', { name: '我的衣橱' }))
    expect(useResonanceStore.getState().activeTab).toBe('wardrobe')
    expect(screen.getByRole('tab', { name: '我的衣橱' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: '个人统计' }))
    expect(useResonanceStore.getState().activeTab).toBe('stats')
  })

  it('已加载时切换页面不重复拉取数据', async () => {
    const getData = vi.fn(() => Promise.resolve(emptyData))
    installElectronApi({ getData })
    const { unmount } = render(<ResonanceRecordsPage />)
    await waitFor(() => expect(useResonanceStore.getState().loaded).toBe(true))
    unmount()
    render(<ResonanceRecordsPage />)
    await waitFor(() => expect(screen.getByRole('tab', { name: '共鸣记录' })).toBeTruthy())
    expect(getData).toHaveBeenCalledTimes(1)
  })

  it('加载失败显示错误态，重试成功后恢复', async () => {
    const getData = vi
      .fn(() => Promise.resolve(emptyData))
      .mockRejectedValueOnce(new Error('db unavailable'))
    installElectronApi({ getData })
    render(<ResonanceRecordsPage />)
    expect(await screen.findByText('加载失败')).toBeTruthy()
    expect(screen.getByText('db unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(useResonanceStore.getState().loaded).toBe(true))
    expect(getData).toHaveBeenCalledTimes(2)
  })
})
