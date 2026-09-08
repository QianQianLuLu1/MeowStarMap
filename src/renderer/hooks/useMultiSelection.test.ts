/**
 * @layer L3
 * @module src/renderer/hooks/useMultiSelection
 * @coverage 多选模式：进入/退出、单项勾选、全选/取消全选切换、反选、非法入参兜底
 * @dependencies @testing-library/react（renderHook）、uiStore
 *
 * 测试策略：hook 只依赖 uiStore，用真实 store + renderHook 验证行为，
 * 不 mock 任何模块；用例覆盖正常流程 / 异常流程 / 边界条件三类。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMultiSelection } from './useMultiSelection'
import { useUIStore } from '../stores/uiStore'
import type { MediaFile } from '../stores/mediaStore'

/** 构造最小 MediaFile 夹具：本 hook 仅消费 id 字段 */
function makeFile(id: string): MediaFile {
  return { id } as unknown as MediaFile
}

const files = [makeFile('a'), makeFile('b'), makeFile('c')]

beforeEach(() => {
  useUIStore.setState({ selectedMediaIds: [], multiSelectMode: false })
})

describe('useMultiSelection｜正常流程', () => {
  it('初始应处于非多选模式，并暴露文件总数', () => {
    const { result } = renderHook(() => useMultiSelection({ files }))

    expect(result.current.multiSelectMode).toBe(false)
    expect(result.current.totalCount).toBe(3)
    expect(result.current.selectedCount).toBe(0)
    expect(result.current.isAllSelected).toBe(false)
  })

  it('enter / exit 应切换多选模式，且 exit 同时清空选中', () => {
    const { result } = renderHook(() => useMultiSelection({ files }))

    act(() => result.current.enter())
    expect(result.current.multiSelectMode).toBe(true)

    act(() => result.current.toggle('a'))
    expect(result.current.selectedIds).toEqual(['a'])

    act(() => result.current.exit())
    expect(result.current.multiSelectMode).toBe(false)
    expect(result.current.selectedIds).toEqual([])
  })

  it('toggle 应幂等切换单项选中态', () => {
    const { result } = renderHook(() => useMultiSelection({ files }))
    act(() => result.current.enter())

    act(() => result.current.toggle('b'))
    expect(result.current.isSelected('b')).toBe(true)
    expect(result.current.selectedIds).toEqual(['b'])

    act(() => result.current.toggle('b'))
    expect(result.current.isSelected('b')).toBe(false)
    expect(result.current.selectedIds).toEqual([])
  })

  it('toggleSelectAll 应在全选与取消全选之间切换', () => {
    const { result } = renderHook(() => useMultiSelection({ files }))
    act(() => result.current.enter())

    act(() => result.current.toggleSelectAll())
    expect(result.current.selectedIds).toEqual(['a', 'b', 'c'])
    expect(result.current.isAllSelected).toBe(true)

    act(() => result.current.toggleSelectAll())
    expect(result.current.selectedIds).toEqual([])
    expect(result.current.isAllSelected).toBe(false)
  })

  it('invert 应反转当前列表内的选中态', () => {
    const { result } = renderHook(() => useMultiSelection({ files }))
    act(() => result.current.enter())

    act(() => result.current.toggle('a'))
    act(() => result.current.invert())
    expect(result.current.selectedIds).toEqual(['b', 'c'])
  })
})

describe('useMultiSelection｜异常流程（非法入参兜底）', () => {
  const illegalValues: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['空对象', {}],
    ['字符串', 'not-an-array'],
    ['数字', 42]
  ]

  for (const [label, value] of illegalValues) {
    it(`files 为 ${label} 时应降级为空列表且不抛错`, () => {
      const { result } = renderHook(() =>
        useMultiSelection({ files: value as unknown as MediaFile[] })
      )

      expect(result.current.totalCount).toBe(0)
      expect(result.current.isAllSelected).toBe(false)

      // 全选 / 反选 / 单项勾选均为 no-op，不得抛错
      act(() => result.current.enter())
      act(() => result.current.toggleSelectAll())
      act(() => result.current.invert())
      act(() => result.current.toggle('x'))

      expect(result.current.selectedIds).toEqual([])
      expect(useUIStore.getState().selectedMediaIds).toEqual([])
    })
  }
})

describe('useMultiSelection｜边界条件', () => {
  it('空列表时 isAllSelected 应为 false 且全选为 no-op', () => {
    const { result } = renderHook(() => useMultiSelection({ files: [] }))

    expect(result.current.totalCount).toBe(0)
    expect(result.current.isAllSelected).toBe(false)

    act(() => result.current.enter())
    act(() => result.current.toggleSelectAll())
    expect(result.current.selectedIds).toEqual([])
  })

  it('列表含重复 id 时全选结果应去重', () => {
    const dup = [makeFile('a'), makeFile('a'), makeFile('b')]
    const { result } = renderHook(() => useMultiSelection({ files: dup }))

    act(() => result.current.enter())
    act(() => result.current.toggleSelectAll())

    expect(result.current.selectedIds).toEqual(['a', 'b'])
    expect(result.current.isAllSelected).toBe(true)
  })

  it('已全选时若列表缩小，isAllSelected 应重新计算为 true（仅统计当前列表）', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: MediaFile[] }) => useMultiSelection({ files: items }),
      { initialProps: { items: files } }
    )

    act(() => result.current.enter())
    act(() => result.current.toggleSelectAll())
    expect(result.current.isAllSelected).toBe(true)

    rerender({ items: [makeFile('a')] })
    expect(result.current.totalCount).toBe(1)
    expect(result.current.isAllSelected).toBe(true)
  })
})
