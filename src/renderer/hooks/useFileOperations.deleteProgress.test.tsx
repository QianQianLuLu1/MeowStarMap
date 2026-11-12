/**
 * T4 集成测试：验证 useFileOperations 的删除 / 批量删除已接入「阶段步骤」进度。
 * 覆盖：批量成功、单文件成功、空 ids 早退、批量部分失败。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useFileOperations } from './useFileOperations'
import { useMediaStore, type MediaFile } from '../stores/mediaStore'

function makeFile(id: string): MediaFile {
  return {
    id,
    file_path: `C:/p/${id}.png`,
    file_name: `${id}.png`,
    file_type: 'image',
    file_size: 1,
    created_at: '2026-01-01T00:00:00.000Z'
  } as MediaFile
}

function makeAssetFile(id: string): MediaFile {
  return {
    ...makeFile(id),
    nikkisync: {
      assetId: id,
      assetType: 'photo',
      state: 'ready',
      revision: 1,
      hasMotion: false,
      hasMetadata: false
    }
  } as MediaFile
}

function stubApi(success = true) {
  const api = {
    assetEdits: {
      set: vi.fn(async () => ({ edit: null }))
    },
    file: {
      delete: vi.fn(async () =>
        success ? { success: true, message: '已删除' } : { success: false, message: '失败' }
      ),
      deletePermanent: vi.fn(async () =>
        success ? { success: true, message: '已永久删除' } : { success: false, message: '失败' }
      )
    },
    mediaAction: {
      softDelete: vi.fn(async () =>
        success ? { success: true, message: 'ok' } : { success: false, message: '失败' }
      ),
      delete: vi.fn(async () =>
        success ? { success: true, message: 'ok' } : { success: false, message: '失败' }
      )
    }
  }
  // 覆盖 setup.ts 中的 Proxy 占位
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

function mount() {
  let ref: ReturnType<typeof useFileOperations> | null = null
  const C: React.FC = () => {
    ref = useFileOperations({
      filteredFiles: [],
      onShowMessage: vi.fn(),
      onRefreshMedia: async () => {}
    })
    return null
  }
  render(<C />)
  return () => ref
}

describe('useFileOperations 阶段步骤进度接入', () => {
  it('deleteFilesBatch 成功 → 终态 done 且阶段全 done', async () => {
    stubApi(true)
    useMediaStore.getState().setMediaFiles([makeFile('a'), makeFile('b')])
    const get = mount()
    let res: { succeeded: string[]; failed: { id: string; error: string }[] } | undefined
    await act(async () => {
      res = await get()!.deleteFilesBatch(['a', 'b'])
    })
    expect(res?.succeeded).toEqual(['a', 'b'])
    expect(get()!.deleteProgress?.phase).toBe('done')
    expect(get()!.deleteProgress?.stages?.every((s) => s.status === 'done')).toBe(true)
  })

  it('单文件软删除 → 终态 done 且阶段全 done', async () => {
    stubApi(true)
    const get = mount()
    const confirm = get()!.getDeleteConfirm(makeFile('a'), false)
    await act(async () => {
      await confirm.onConfirm()
    })
    expect(get()!.deleteProgress?.phase).toBe('done')
    expect(get()!.deleteProgress?.stages?.every((s) => s.status === 'done')).toBe(true)
  })

  it('deleteFilesBatch([]) 空输入早退，不弹进度', async () => {
    stubApi(true)
    const get = mount()
    const res = await get()!.deleteFilesBatch([])
    expect(res).toEqual({ succeeded: [], failed: [] })
    expect(get()!.deleteProgress).toBeNull()
  })

  it('批量部分失败（缺路径）→ failed 非空，终态仍 done', async () => {
    stubApi(true)
    // store 中仅有 a，b 缺少路径 → deleteOne 抛 missingFile
    useMediaStore.getState().setMediaFiles([makeFile('a')])
    const get = mount()
    let res: { succeeded: string[]; failed: { id: string; error: string }[] } | undefined
    await act(async () => {
      res = await get()!.deleteFilesBatch(['a', 'b'])
    })
    expect(res?.succeeded).toEqual(['a'])
    expect(res?.failed.length).toBe(1)
    expect(res?.failed[0].id).toBe('b')
    expect(get()!.deleteProgress?.phase).toBe('done')
  })

  it('删除完成终态 3 秒后 deleteProgress 自动清空（浮窗自动关闭）', async () => {
    vi.useFakeTimers()
    try {
      stubApi(true)
      useMediaStore.getState().setMediaFiles([makeFile('a')])
      const get = mount()
      await act(async () => {
        await get()!.deleteFilesBatch(['a'])
      })
      expect(get()!.deleteProgress?.phase).toBe('done')
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(get()!.deleteProgress).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

// T6 覆盖补齐：nikkisync 数据源的删除进度回归（assetEdits 叠加层分流）。
// 断言收窄到通道实参、本地通道零调用、失败项精确保留，避免只验证「终态 done」的弱覆盖。
describe('useFileOperations nikkisync 删除进度（T6 覆盖补齐）', () => {
  it('单文件软删除：assetEdits.set(assetId,{isHidden:true})，本地 softDelete 零调用', async () => {
    const api = stubApi(true)
    const get = mount()
    const confirm = get()!.getDeleteConfirm(makeAssetFile('a/1'), false)
    await act(async () => {
      await confirm.onConfirm()
    })
    expect(api.assetEdits.set).toHaveBeenCalledWith('a/1', { isHidden: true })
    expect(api.assetEdits.set).toHaveBeenCalledTimes(1)
    expect(api.mediaAction.softDelete).not.toHaveBeenCalled()
    expect(api.file.deletePermanent).not.toHaveBeenCalled()
    expect(get()!.deleteProgress?.phase).toBe('done')
    expect(get()!.deleteProgress?.stages?.every((s) => s.status === 'done')).toBe(true)
  })

  it('单文件永久删除：文件通道删实体 + 叠加层隐藏，本地 delete 零调用', async () => {
    const api = stubApi(true)
    const file = makeAssetFile('a/1')
    const get = mount()
    const confirm = get()!.getDeleteConfirm(file, true)
    await act(async () => {
      await confirm.onConfirm()
    })
    expect(api.file.deletePermanent).toHaveBeenCalledWith([file.file_path])
    expect(api.file.deletePermanent).toHaveBeenCalledTimes(1)
    expect(api.assetEdits.set).toHaveBeenCalledWith('a/1', { isHidden: true })
    expect(api.mediaAction.delete).not.toHaveBeenCalled()
    expect(api.mediaAction.softDelete).not.toHaveBeenCalled()
    expect(get()!.deleteProgress?.phase).toBe('done')
  })

  it('批量混合 nikkisync / 本地 id：分别走叠加层与本地 softDelete', async () => {
    const api = stubApi(true)
    useMediaStore.getState().setMediaFiles([makeAssetFile('a/1'), makeFile('2')])
    const get = mount()
    let res: { succeeded: string[]; failed: { id: string; error: string }[] } | undefined
    await act(async () => {
      res = await get()!.deleteFilesBatch(['a/1', '2'])
    })
    expect(res?.succeeded).toEqual(['a/1', '2'])
    expect(res?.failed).toEqual([])
    expect(api.assetEdits.set).toHaveBeenCalledWith('a/1', { isHidden: true })
    expect(api.assetEdits.set).toHaveBeenCalledTimes(1)
    expect(api.mediaAction.softDelete).toHaveBeenCalledWith([2])
    expect(api.mediaAction.softDelete).toHaveBeenCalledTimes(1)
    expect(get()!.deleteProgress?.phase).toBe('done')
  })

  it('叠加层写入失败：失败项保留在 failed，succeeded 不含，终态仍 done', async () => {
    const api = stubApi(true)
    api.assetEdits.set.mockRejectedValue(new Error('叠加层写入失败'))
    useMediaStore.getState().setMediaFiles([makeAssetFile('a/1'), makeFile('2')])
    const get = mount()
    let res: { succeeded: string[]; failed: { id: string; error: string }[] } | undefined
    await act(async () => {
      res = await get()!.deleteFilesBatch(['a/1', '2'])
    })
    expect(res?.succeeded).toEqual(['2'])
    expect(res?.failed).toHaveLength(1)
    expect(res?.failed[0].id).toBe('a/1')
    expect(res?.failed[0].error).toBe('叠加层写入失败')
    expect(api.assetEdits.set).toHaveBeenCalledTimes(1)
    expect(api.mediaAction.softDelete).toHaveBeenCalledWith([2])
    expect(get()!.deleteProgress?.phase).toBe('done')
    expect(get()!.deleteProgress?.stages?.every((s) => s.status === 'done')).toBe(true)
  })
})
