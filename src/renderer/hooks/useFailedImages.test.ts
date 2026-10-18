/**
 * @layer L3
 * @module src/renderer/hooks/useFailedImages
 * @coverage 失败图片 id 集合 + 列表变化只裁剪消失项
 * @dependencies react
 * @remarks jsdom 环境
 *
 * 契约变更（2026-10-18 网格视图滚动闪烁修复 N4，
 * 见 docs/plans/2026-10-18-fix-gallery-grid-scroll-flicker.md）：
 * 原实现是「dep 引用一变就整表清空」。图库向下滚动触底会走
 * `loadNextMediaPage → addMediaFiles`（mediaStore.ts:202-205）产生**新数组**，于是每次翻页
 * 都把已终态的坏图卡全部打回骨架并重新发起加载/重试——即「局部刷新」这一路的闪烁来源。
 * 现改为「只剔除已不在列表中的 id」：既保留 C-O7 的有界增长意图（条目消失即清理），
 * 又不让一次追加把整屏状态抹掉。参数也从任意 T 收窄为 `T extends { id: string }`。
 *
 * ⚠️ 用例注意：items 必须在 render 回调外建好并保持引用稳定。旧实现「dep 变即 setState(新 Set)」
 * 在调用方每次渲染都新建数组时会形成「渲染 → effect → setState → 渲染」无限循环
 * （写本组用例时实测把 worker 打到 OOM 退出码 134）；新实现无变化时返回原引用，免疫该环路。
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFailedImages } from './useFailedImages'

type Row = { id: string }
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }))

describe('useFailedImages', () => {
  describe('初始状态', () => {
    it('failedImages 初始为空 Set', () => {
      const items = rows('a')
      const { result } = renderHook(() => useFailedImages(items))
      expect(result.current.failedImages).toBeInstanceOf(Set)
      expect(result.current.failedImages.size).toBe(0)
    })
  })

  describe('markFailed', () => {
    it('添加一个 id 到 failedImages', () => {
      const items = rows('a')
      const { result } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('img-1')
      })
      expect(result.current.failedImages.has('img-1')).toBe(true)
      expect(result.current.failedImages.size).toBe(1)
    })

    it('重复添加同一 id 不增加 size', () => {
      const items = rows('a')
      const { result } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('img-1')
        result.current.markFailed('img-1')
      })
      expect(result.current.failedImages.size).toBe(1)
    })

    it('添加多个不同 id 全部入集合', () => {
      const items = rows('a')
      const { result } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('a')
        result.current.markFailed('b')
        result.current.markFailed('c')
      })
      expect(result.current.failedImages.size).toBe(3)
      expect(Array.from(result.current.failedImages)).toEqual(['a', 'b', 'c'])
    })

    it('markFailed 引用稳定（同一 render 周期）', () => {
      const items = rows('a')
      const { result } = renderHook(() => useFailedImages(items))
      const first = result.current.markFailed
      act(() => {
        result.current.markFailed('x')
      })
      expect(result.current.markFailed).toBe(first)
    })
  })

  describe('列表变化只裁剪消失项', () => {
    it('① 异常（红灯主体）：触底翻页追加新页（新数组引用）必须保留既有失败记录', () => {
      // 复现路径：向下滚动 → endReached → addMediaFiles([...state.mediaFiles, ...files])
      // ⇒ items 是「新数组 + 老元素仍在」。原实现在此处整表清空 ⇒ 坏图卡退回骨架重闪。
      let items = rows('a', 'b')
      const { result, rerender } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('a')
        result.current.markFailed('b')
      })
      expect(result.current.failedImages.size).toBe(2)

      items = rows('a', 'b', 'c', 'd')
      rerender()
      expect(result.current.failedImages.size).toBe(2)
      expect(result.current.failedImages.has('a')).toBe(true)
      expect(result.current.failedImages.has('b')).toBe(true)
    })

    it('② 正常：条目消失即裁剪对应 id，其余保留（维持 C-O7 有界增长）', () => {
      let items = rows('a', 'b', 'c')
      const { result, rerender } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('a')
        result.current.markFailed('b')
      })

      items = rows('a', 'c')
      rerender()
      expect(result.current.failedImages.has('b')).toBe(false)
      expect(result.current.failedImages.has('a')).toBe(true)
      expect(result.current.failedImages.size).toBe(1)
    })

    it('③ 正常：引用不变（同批数据重渲染）不重复计算，状态保持', () => {
      const items = rows('a', 'b')
      const { result, rerender } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('a')
      })
      rerender()
      expect(result.current.failedImages.size).toBe(1)
    })

    it('④ 边界：列表清空（切板块/切数据源）时全部裁剪，不残留', () => {
      let items = rows('a', 'b')
      const { result, rerender } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('a')
        result.current.markFailed('b')
      })
      items = rows()
      rerender()
      expect(result.current.failedImages.size).toBe(0)
    })

    it('⑤ 异常：items 非数组时不抛错、保留现集（脏数据不得抹掉整屏状态）', () => {
      const { result, rerender } = renderHook(
        ({ list }: { list: Row[] }) => useFailedImages(list),
        { initialProps: { list: rows('a', 'b') } }
      )
      act(() => {
        result.current.markFailed('a')
      })
      expect(() => {
        rerender({ list: null as unknown as Row[] })
      }).not.toThrow()
      expect(result.current.failedImages.size).toBe(1)
    })

    it('⑥ 边界：clearFailed 命中即移除单项，未命中为 no-op（引用不变）', () => {
      const items = rows('a', 'b')
      const { result } = renderHook(() => useFailedImages(items))
      act(() => {
        result.current.markFailed('a')
      })
      const before = result.current.failedImages
      act(() => {
        result.current.clearFailed('zzz')
      })
      expect(result.current.failedImages).toBe(before)
      act(() => {
        result.current.clearFailed('a')
      })
      expect(result.current.failedImages.size).toBe(0)
    })
  })
})
