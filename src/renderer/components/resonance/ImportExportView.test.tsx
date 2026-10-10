import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ImportExportView } from './ImportExportView'
import { useResonanceStore } from '../../stores/resonanceStore'
import { GlobalToastContext } from '../../pages/settings/shared'
import type { ResonanceWardrobeData } from '../../../shared/types/resonance'

/**
 * ImportExportView 组件测试：store 模块函数走真实实现，
 * 仅 mock electronAPI（dialog + resonance IPC），验证导入预览 / 版本不兼容 /
 * 分批提交 / 导出 / 清空的完整交互。Toast 经 Context 捕获断言。
 */

const LEGACY_FILE = JSON.stringify({
  '2': [
    ['2025-07-01 10:00:00', '1021720039'],
    ['2025-07-02 11:00:00', '1021720040'],
    ['not-a-time', '1021720039']
  ]
})

const MISMATCH_FILE = JSON.stringify({
  version: 99,
  pulls: { '2': [['2025-07-01 10:00:00', '1021720039']] }
})

const emptyWardrobe: ResonanceWardrobeData = {
  version: 1,
  ownedItemIds: [],
  ownedMakeupIds: [],
  ownedMomoIds: [],
  ownedPropIds: [],
  ownedEurekaColorIds: [],
  updatedAt: ''
}

const emptyData = {
  pulls: [],
  edits: [],
  pearpal: [],
  evo: [],
  wardrobe: emptyWardrobe
}

const mocks = vi.hoisted(() => ({
  openFile: vi.fn(),
  saveFile: vi.fn(),
  readImportFile: vi.fn(),
  commitImport: vi.fn(),
  export: vi.fn(),
  clearAll: vi.fn(),
  getData: vi.fn()
}))

type ToastType = 'success' | 'error' | 'info'
const toastMessages: Array<{ text: string; type: ToastType }> = []

const ToastCapture: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <GlobalToastContext.Provider
    value={(text, type) => {
      toastMessages.push({ text, type: type ?? 'info' })
    }}
  >
    {children}
  </GlobalToastContext.Provider>
)

function lastToast(text: string | RegExp): { text: string; type: ToastType } | undefined {
  return [...toastMessages]
    .reverse()
    .find((entry) => (typeof text === 'string' ? entry.text === text : text.test(entry.text)))
}

async function pickFile(content: string): Promise<void> {
  mocks.openFile.mockResolvedValue('C:/fake/import.json')
  mocks.readImportFile.mockResolvedValue({ content, sizeBytes: content.length })
  fireEvent.click(screen.getByRole('button', { name: '选择 JSON 文件' }))
}

describe('ImportExportView', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset()
    toastMessages.length = 0
    mocks.getData.mockResolvedValue(emptyData)
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      dialog: { openFile: mocks.openFile, saveFile: mocks.saveFile },
      resonance: {
        readImportFile: mocks.readImportFile,
        commitImport: mocks.commitImport,
        export: mocks.export,
        clearAll: mocks.clearAll,
        getData: mocks.getData,
        updateWardrobe: vi.fn()
      }
    }
    useResonanceStore.getState().reset()
    useResonanceStore.setState({ loaded: true })
  })
  afterEach(cleanup)

  it('选择文件后显示预览摘要（格式 / 分区 / 计数 / 无效样本）', async () => {
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    await pickFile(LEGACY_FILE)
    expect(await screen.findByText('旧版格式')).toBeTruthy()
    // 分区 chip 与导出勾选框文案重复，按出现次数断言
    expect(screen.getAllByText('抽卡记录').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('新增 2 条')).toBeTruthy()
    expect(screen.getByText('重复（跳过）0 条')).toBeTruthy()
    expect(screen.getByText('无效（跳过）1 条')).toBeTruthy()
    expect(screen.getByText(/卡池 2 \/ 第 3 条/)).toBeTruthy()
    expect(screen.getByText(/时间格式无效/)).toBeTruthy()
    expect(useResonanceStore.getState().pendingImport).not.toBeNull()
  })

  it('版本不兼容给出兼容导入/放弃双选项，放弃后清空预览', async () => {
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    await pickFile(MISMATCH_FILE)
    expect(await screen.findByText(/高于当前支持版本/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '尝试兼容导入' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    await vi.waitFor(() => {
      expect(useResonanceStore.getState().pendingImport).toBeNull()
    })
    expect(screen.queryByText(/高于当前支持版本/)).toBeNull()
  })

  it('损坏 JSON 报可读错误且不暂存预览', async () => {
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    await pickFile('{not-json')
    await vi.waitFor(() => {
      expect(lastToast(/不是有效的 JSON/)).toBeTruthy()
    })
    expect(useResonanceStore.getState().pendingImport).toBeNull()
    expect(mocks.commitImport).not.toHaveBeenCalled()
  })

  it('提交导入按批次调用 commitImport 并刷新数据', async () => {
    mocks.commitImport.mockResolvedValue({ imported: 2 })
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    await pickFile(LEGACY_FILE)
    await screen.findByText('旧版格式')
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    await vi.waitFor(() => {
      expect(mocks.commitImport).toHaveBeenCalledTimes(1)
    })
    const batch = mocks.commitImport.mock.calls[0]![0] as {
      pulls: unknown[]
      edits: unknown[]
    }
    expect(batch.pulls).toHaveLength(2)
    expect(batch.edits).toHaveLength(0)
    await vi.waitFor(() => {
      expect(mocks.getData).toHaveBeenCalled()
      expect(useResonanceStore.getState().pendingImport).toBeNull()
      expect(lastToast('导入完成，共写入 2 条记录')).toBeTruthy()
    })
  })

  it('提交中显示进度条与取消按钮，取消后停止后续批次', async () => {
    let resolveCommit: (value: { imported: number }) => void = () => {}
    mocks.commitImport.mockImplementation(
      () =>
        new Promise<{ imported: number }>((resolve) => {
          resolveCommit = resolve
        })
    )
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    await pickFile(LEGACY_FILE)
    await screen.findByText('旧版格式')
    fireEvent.click(screen.getByRole('button', { name: '开始导入' }))
    expect(await screen.findByRole('progressbar')).toBeTruthy()
    expect(screen.getByText('0 / 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消导入' }))
    resolveCommit({ imported: 2 })
    await vi.waitFor(() => {
      expect(useResonanceStore.getState().importRunning).toBe(false)
      expect(lastToast('已取消导入；已写入部分保留，重复导入可安全补齐')).toBeTruthy()
    })
    // 单批次文件：取消发生在批次边界前，不应产生第二次提交调用
    expect(mocks.commitImport).toHaveBeenCalledTimes(1)
  })

  it('导出：勾选内容后经保存对话框写出 JSON', async () => {
    useResonanceStore.setState({
      pulls: [
        {
          id: 1,
          banner_id: '2',
          item_id: '1021720039',
          obtained_at: '2025-07-01 10:00:00',
          source: 'json',
          created_at: ''
        }
      ]
    })
    mocks.saveFile.mockResolvedValue('C:/fake/out.json')
    mocks.export.mockResolvedValue({ path: 'C:/fake/out.json', recordCount: 1 })
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    fireEvent.click(await screen.findByRole('button', { name: '导出 JSON' }))
    await vi.waitFor(() => {
      expect(mocks.export).toHaveBeenCalledTimes(1)
    })
    expect(mocks.saveFile).toHaveBeenCalledTimes(1)
    const [, payload] = mocks.export.mock.calls[0] as [string, { pulls: Record<string, unknown> }]
    expect(Object.keys(payload.pulls)).toContain('2')
    await vi.waitFor(() => {
      expect(lastToast('已导出 1 条记录')).toBeTruthy()
    })
  })

  it('导出：全部取消勾选时前置拦截，不弹对话框不写盘', async () => {
    useResonanceStore.setState({
      pulls: [
        {
          id: 1,
          banner_id: '2',
          item_id: '1021720039',
          obtained_at: '2025-07-01 10:00:00',
          source: 'json',
          created_at: ''
        }
      ]
    })
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    await screen.findByRole('button', { name: '导出 JSON' })
    for (const label of [
      '抽卡记录',
      '手动补录',
      'Pearpal 手账',
      '进化覆盖',
      '衣橱拥有状态',
      '卡池心愿单'
    ]) {
      fireEvent.click(screen.getByRole('checkbox', { name: label }))
    }
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }))
    await vi.waitFor(() => {
      expect(mocks.saveFile).not.toHaveBeenCalled()
    })
    expect(mocks.export).not.toHaveBeenCalled()
  })

  it('清空全部：危险确认后调用 clearAll', async () => {
    mocks.clearAll.mockResolvedValue({ cleared: true })
    render(
      <ToastCapture>
        <ImportExportView />
      </ToastCapture>
    )
    fireEvent.click(await screen.findByRole('button', { name: '清空全部共鸣数据' }))
    expect(
      await screen.findByText('将删除全部共鸣记录、衣橱与统计相关数据，且不可恢复。是否继续？')
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await vi.waitFor(() => {
      expect(mocks.clearAll).toHaveBeenCalledTimes(1)
    })
  })
})
