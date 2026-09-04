import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import { RecordsView } from './RecordsView'
import { useResonanceStore } from '../../stores/resonanceStore'
import { BANNER_DATA, OUTFIT_ITEMS } from '../../utils/resonance/staticData'
import type { ResonancePullRow, ResonanceEditRow } from '../../../shared/types/resonance'
import namesZh from '../../data/resonance/names/zh-CN.json'

/**
 * RecordsView 组件测试：使用真实静态数据（banners/outfits/名称包）。
 * react-virtuoso 在 jsdom 下无法量测尺寸，mock 为直接渲染全部行。
 */

const names = namesZh as unknown as {
  banner: Record<string, string>
  item: Record<string, string>
  outfit: Record<string, string>
}

vi.mock('react-virtuoso', async () => {
  const { createElement } = await import('react')
  return {
    Virtuoso: ({
      data,
      itemContent
    }: {
      data?: unknown[]
      itemContent?: (index: number, row: unknown) => ReactNode
    }) =>
      createElement(
        'div',
        { 'data-testid': 'virtuoso-list' },
        (data ?? []).map((row, index) => itemContent?.(index, row))
      )
  }
})

/** 卡池 2（限定池）的 5★ 套装与部件 */
const BANNER_2 = BANNER_DATA['2']!
const OUTFIT_5 = BANNER_2.outfit5StarId[0]!
const ITEM_5 = OUTFIT_ITEMS[OUTFIT_5]![0]!
const ITEM_5_B = OUTFIT_ITEMS[OUTFIT_5]![1]!

const pullRow: ResonancePullRow = {
  id: 1,
  banner_id: '2',
  item_id: ITEM_5,
  obtained_at: '2025-07-01 10:00:00',
  source: 'json',
  created_at: ''
}
const editRow: ResonanceEditRow = {
  id: 1,
  banner_id: '2',
  item_id: ITEM_5_B,
  obtained_at: '2025-07-02 10:00:00',
  created_at: ''
}

describe('RecordsView', () => {
  beforeEach(() => {
    useResonanceStore.getState().reset()
    useResonanceStore.setState({
      loaded: true,
      pulls: [pullRow],
      edits: [editRow]
    })
  })
  afterEach(cleanup)

  it('渲染卡池信息、垫抽提示与记录行（含名称包名称与补录徽标）', async () => {
    render(<RecordsView />)
    // 名称包加载后显示卡池名与物品名
    expect((await screen.findAllByText(names.banner['2'])).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(names.item[ITEM_5]).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(names.item[ITEM_5_B]).length).toBeGreaterThanOrEqual(1)
    // 补录行带徽标（编辑行时间更晚，排在前面）
    expect(screen.getAllByText('补录').length).toBeGreaterThanOrEqual(2) // 按钮 + 徽标
    // 统计条
    expect(screen.getByText('总抽数 1')).toBeTruthy()
    expect(screen.getByText('距上次5★ 0 抽')).toBeTruthy()
    expect(screen.getByText('距上次4★ 1 抽')).toBeTruthy()
    // 限定池徽标
    expect(screen.getByText(/限定池/)).toBeTruthy()
  })

  it('切换卡池后显示无记录空态', async () => {
    render(<RecordsView />)
    await screen.findAllByText(names.banner['2'])
    const select = screen.getByRole('combobox', { name: '卡池' }) as HTMLSelectElement
    fireEvent.change(select, { target: { value: '73' } })
    expect(await screen.findByText('暂无共鸣记录')).toBeTruthy()
  })

  it('打开手动补录对话框并可关闭', async () => {
    render(<RecordsView />)
    await screen.findAllByText(names.banner['2'])
    fireEvent.click(screen.getByRole('button', { name: '补录' }))
    expect(screen.getByText('手动补录')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitForAbsent(() => screen.queryByText('手动补录'))
  })

  it('删除按钮唤起确认框（取消不删除）', async () => {
    render(<RecordsView />)
    await screen.findAllByText(names.banner['2'])
    const deleteButtons = screen.getAllByRole('button', { name: '删除' })
    fireEvent.click(deleteButtons[0]!)
    expect(screen.getByText('删除记录')).toBeTruthy()
    expect(screen.getByText(/此操作不可撤销/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    // 未调用 IPC
    const deleteFn = (
      window as unknown as { electronAPI?: { resonance?: { deleteRecord?: unknown } } }
    ).electronAPI?.resonance?.deleteRecord
    expect(deleteFn).toBeUndefined()
  })

  it('补录行提供修改时间入口', async () => {
    render(<RecordsView />)
    await screen.findAllByText(names.banner['2'])
    fireEvent.click(screen.getAllByRole('button', { name: '修改补录时间' })[0]!)
    expect(screen.getByText('修改补录时间')).toBeTruthy()
  })
})

async function waitForAbsent(query: () => HTMLElement | null): Promise<void> {
  for (let i = 0; i < 20 && query() !== null; i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(query()).toBeNull()
}
