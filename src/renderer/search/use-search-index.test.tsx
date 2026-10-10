/**
 * FIX(组22-2) 回归测试：首次 ready 时 mediaFiles 为空，之后新增文件必须被增量加入索引。
 *
 * 修复前：空 baseline 死锁——增量 effect 以 lastSeen.size === 0 判定"首次"，
 * 空 mediaFiles 记录空 baseline 后，后续非空列表仍命中该分支只更新 baseline 不触发 update，
 * 新增文档永远不会进入索引（直到下次全量重建）。
 *
 * 注：文件名用 .test.tsx 以命中 vitest.config 的 jsdom 环境匹配（hooks 需要 renderHook）。
 *
 * 运行：npx vitest run src/renderer/search/use-search-index.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { renderHook, act } from '@testing-library/react'

import { useSearchIndex } from './use-search-index'
import { searchService } from './search-service'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

function makeFile(id: string, name: string): MediaFile {
  return {
    id,
    file_name: name,
    modified_at: '2026-01-01T00:00:00.000Z',
    tags: [],
    outfit: '',
    notes: '',
    scene_category: 'other'
  } as unknown as MediaFile
}

// vitest 5：显式给出被 mock 的签名，ReturnType<typeof vi.fn> 已不能赋给方法参数位
let updateSpy: Mock<typeof searchService.update>

beforeEach(() => {
  // 桩掉 searchService：状态恒为 ready，init/update 不产生副作用
  vi.spyOn(searchService, 'init').mockResolvedValue(undefined)
  vi.spyOn(searchService, 'getState').mockReturnValue('ready')
  vi.spyOn(searchService, 'onStateChange').mockReturnValue(() => {})
  updateSpy = vi.fn<typeof searchService.update>()
  vi.spyOn(searchService, 'update').mockImplementation(updateSpy)
  useMediaStore.setState({ mediaFiles: [] })
})

afterEach(() => {
  vi.restoreAllMocks()
  useMediaStore.setState({ mediaFiles: [] })
})

describe('组22-2：空 baseline 死锁', () => {
  it('首次 ready 时 mediaFiles 为空，之后新增文件应被增量加入索引（修复前永不触发 update）', async () => {
    renderHook(() => useSearchIndex())
    // 首次 ready：空列表仅记录 baseline
    await act(async () => {
      useMediaStore.setState({ mediaFiles: [] })
    })
    expect(updateSpy).not.toHaveBeenCalled()

    // 模拟扫描入库后 mediaFiles 变为非空：应走 diff 分支把新增文件加入索引
    await act(async () => {
      useMediaStore.setState({ mediaFiles: [makeFile('1', 'a.jpg'), makeFile('2', 'b.jpg')] })
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const changes = updateSpy.mock.calls[0][0] as {
      added: MediaFile[]
      updated: MediaFile[]
      removed: number[]
    }
    expect(changes.added).toHaveLength(2)
    expect(changes.updated).toHaveLength(0)
    expect(changes.removed).toHaveLength(0)
  })

  it('首次 ready 时已有文件仅记录 baseline，不触发重复 add', async () => {
    await act(async () => {
      useMediaStore.setState({ mediaFiles: [makeFile('1', 'a.jpg')] })
    })
    renderHook(() => useSearchIndex())
    await act(async () => {})
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('baseline 建立后文件内容变化应走 updated 分支', async () => {
    // 先让 mediaFiles 非空再挂载：首次 ready 记录非空 baseline，不触发 update
    await act(async () => {
      useMediaStore.setState({ mediaFiles: [makeFile('1', 'a.jpg')] })
    })
    renderHook(() => useSearchIndex())
    await act(async () => {})
    expect(updateSpy).not.toHaveBeenCalled()

    const renamed = { ...makeFile('1', 'renamed.jpg'), modified_at: '2026-02-01T00:00:00.000Z' }
    await act(async () => {
      useMediaStore.setState({ mediaFiles: [renamed] })
    })
    expect(updateSpy).toHaveBeenCalledTimes(1)
    const changes = updateSpy.mock.calls[0][0] as { added: MediaFile[]; updated: MediaFile[] }
    expect(changes.added).toHaveLength(0)
    expect(changes.updated).toHaveLength(1)
  })
})
