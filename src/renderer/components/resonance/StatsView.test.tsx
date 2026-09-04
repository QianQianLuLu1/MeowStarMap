import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { StatsView } from './StatsView'
import { useResonanceStore } from '../../stores/resonanceStore'
import { BANNER_DATA, OUTFIT_ITEMS } from '../../utils/resonance/staticData'
import namesZh from '../../data/resonance/names/zh-CN.json'
import type { ResonancePullRow } from '../../../shared/types/resonance'

/**
 * StatsView 组件测试：使用真实静态数据（卡池/套装/名称包/百分位），
 * 验证空态 / 总览卡 / 欧非区块 / 直方图 / 排名表 / 累计曲线与快照缺失降级。
 */

const BANNER_2 = BANNER_DATA['2']!
const OUTFIT_5 = BANNER_2.outfit5StarId[0]!
const ITEM_5 = OUTFIT_ITEMS[OUTFIT_5]![0]!
const OUTFIT_4 = BANNER_2.outfit4StarId[0]!
const ITEM_4 = OUTFIT_ITEMS[OUTFIT_4]![0]!
const names = namesZh as unknown as { banner: Record<string, string> }

const percentileState = vi.hoisted(() => ({ disabled: false }))

vi.mock('../../utils/resonance/staticData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/resonance/staticData')>()
  return {
    ...actual,
    loadPercentile: vi.fn(() =>
      percentileState.disabled ? Promise.resolve(null) : actual.loadPercentile()
    )
  }
})

function makePull(id: number, itemId: string, obtainedAt: string): ResonancePullRow {
  return {
    id,
    banner_id: '2',
    item_id: itemId,
    obtained_at: obtainedAt,
    source: 'json',
    created_at: ''
  }
}

const pullRows: ResonancePullRow[] = [
  makePull(1, ITEM_4, '2025-07-01 10:00:00'),
  makePull(2, ITEM_4, '2025-07-02 10:00:00'),
  makePull(3, ITEM_5, '2025-07-03 10:00:00')
]

describe('StatsView', () => {
  beforeEach(() => {
    percentileState.disabled = false
    useResonanceStore.getState().reset()
    useResonanceStore.setState({ loaded: true })
  })
  afterEach(cleanup)

  it('无记录时显示空态', () => {
    render(<StatsView />)
    expect(screen.getByText('暂无统计数据')).toBeTruthy()
    expect(screen.getByText(/先在「共鸣记录」补录/)).toBeTruthy()
  })

  it('有记录时渲染总览卡与欧非分析区块', async () => {
    useResonanceStore.setState({ pulls: pullRows })
    render(<StatsView />)
    // 总览卡：标签 + 数值（就近断言；「总抽数」在明细表头中复现，取首个）
    const totalCard = screen.getAllByText('总抽数')[0]!.closest('div')
    expect(totalCard?.textContent).toContain('3')
    expect(screen.getByText('平均出货（每 5★）')).toBeTruthy()
    expect(screen.getByText('已获 5★ 套装')).toBeTruthy()
    // 欧非分析（真实百分位快照）
    expect(await screen.findByText('欧非分析')).toBeTruthy()
    expect(screen.getByText(/档位 \d \/ 6/)).toBeTruthy()
    expect(screen.getByText(/社区静态快照/)).toBeTruthy()
  })

  it('渲染 5★ 出货分布直方图（SVG）', async () => {
    useResonanceStore.setState({ pulls: pullRows })
    render(<StatsView />)
    expect(screen.getByText('出货分布')).toBeTruthy()
    expect(await screen.findByRole('img', { name: /5★/ })).toBeTruthy()
  })

  it('渲染按卡池明细表（卡池名 + 百分位列）', async () => {
    useResonanceStore.setState({ pulls: pullRows })
    render(<StatsView />)
    expect(await screen.findByText('限定池（5★）')).toBeTruthy()
    expect(screen.getByText(names.banner['2'])).toBeTruthy()
    expect(screen.getByText('百分位').closest('table')).toBeTruthy()
    // 真实快照下百分位应有数值展示
    expect(screen.getAllByText(/\d+%/).length).toBeGreaterThanOrEqual(1)
  })

  it('多卡池记录时渲染累计曲线', async () => {
    const banner1 = BANNER_DATA['1']!
    const item1 = OUTFIT_ITEMS[banner1.outfit5StarId[0]!]![0]!
    useResonanceStore.setState({
      pulls: [
        ...pullRows,
        {
          id: 9,
          banner_id: '1',
          item_id: item1,
          obtained_at: '2025-07-04 10:00:00',
          source: 'json',
          created_at: ''
        }
      ]
    })
    render(<StatsView />)
    expect(await screen.findByText('抽取活动（按卡池累计）')).toBeTruthy()
  })

  it('百分位快照缺失时隐藏欧非区块且不崩溃', async () => {
    percentileState.disabled = true
    useResonanceStore.setState({ pulls: pullRows })
    render(<StatsView />)
    // 等待加载完成后断言降级
    await screen.findByText('限定池（5★）')
    expect(screen.queryByText('欧非分析')).toBeNull()
  })
})
