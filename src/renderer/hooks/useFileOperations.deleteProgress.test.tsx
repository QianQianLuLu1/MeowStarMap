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

function stubApi(success = true) {
  const api = {
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
})
