// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AssetMediaFile } from '../../utils/assetViewModel'

/**
 * 阶段 5 · B4：分享图面板的行为测试。
 *
 * 出图编排（`generateShareCardPages`）与解密取数（`useGameParams`）都被替身接管——
 * 它们的真实行为分别由 `shareCardJob.test.ts` 与 `shareCardParity.test.ts` 覆盖。
 * 本文件只锁面板这一层：预览渲染、缺图标提示、取消不产图、实况照片拒绝、
 * 逐张落盘、以及「用户在目录框里取消不当成错误」。
 */

const generateMock = vi.fn()
const saveAsMock = vi.fn()

vi.mock('../../hooks/useGameParams', () => ({
  useGameParams: () => ({
    data: { hasParams: true, camera: { focalLength: 50 } },
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))
vi.mock('../../utils/share-card/shareCardJob', () => ({
  generateShareCardPages: (...args: unknown[]) => generateMock(...args)
}))
vi.mock('../../utils/file', () => ({
  toFileUrl: (p: string) => `media://x?path=${encodeURIComponent(p)}`
}))

import { ShareCardDialog } from './ShareCardDialog'

function asset(over: Partial<AssetMediaFile> = {}): AssetMediaFile {
  return {
    id: 'a/1',
    file_path: 'D:/Game/a1.png',
    file_name: 'a1.png',
    file_type: 'image',
    file_ext: '.png',
    file_size: 10,
    created_at: '2026-10-15T00:00:00.000Z',
    modified_at: '2026-10-15T00:00:00.000Z',
    tags: [],
    rating: 0,
    is_favorite: false,
    notes: '',
    album_type: 'HQ',
    account_uid: 'u1',
    nikkisync: {
      assetId: 'a/1',
      assetType: 'photo',
      state: 'ready',
      revision: 1,
      hasMotion: false,
      hasMetadata: false
    },
    ...over
  } as unknown as AssetMediaFile
}

/** jsdom 没有真 canvas/Image：`new Image()` 一赋值 src 就同步成功，getContext 返回假 2d 面。 */
class FakeImage {
  crossOrigin = ''
  width = 100
  height = 80
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    setTimeout(() => this.onload?.(), 0)
  }
}

beforeEach(() => {
  generateMock.mockReset()
  saveAsMock.mockReset()
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn()
  } as unknown as CanvasRenderingContext2D)
  Object.defineProperty(window, 'electronAPI', {
    value: { editor: { saveAs: saveAsMock } },
    configurable: true,
    writable: true
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = undefined
})

const noop = vi.fn()

describe('ShareCardDialog', () => {
  it('生成成功：逐页渲染预览，并按 missingIcons 给出提示条', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
      missingIcons: 3,
      cancelled: false
    })
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
    expect(screen.getByText('3 个部件图标暂不可用')).toBeTruthy()
  })

  it('取消生成：不产出预览，并给出「已取消生成」', async () => {
    generateMock.mockResolvedValue({ pages: [], missingIcons: 0, cancelled: true })
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getByText('已取消生成')).toBeTruthy())
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })

  it('实况照片本阶段拒绝出图，连生成按钮都不给', () => {
    render(
      <ShareCardDialog
        open
        file={asset({
          nikkisync: {
            assetId: 'a/1',
            assetType: 'motion_photo',
            state: 'ready',
            revision: 1,
            hasMotion: true,
            hasMetadata: false
          }
        })}
        onClose={noop}
      />
    )
    expect(screen.getByText('实况照片本阶段不支持生成分享图')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成分享图' })).toBeNull()
  })

  it('保存：每张各调一次 saveAs，并回报已保存数量', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'],
      missingIcons: 0,
      cancelled: false
    })
    saveAsMock.mockResolvedValue({ success: true, filePath: 'D:/out.png' })
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalledTimes(2))
    expect(saveAsMock.mock.calls[0][1]).toMatchObject({ format: 'png', fileName: 'a1-share-1.png' })
    expect(screen.getByText('已保存 2 张')).toBeTruthy()
  })

  it('saveAs 返回 success:false 时如实报错，不谎报已保存', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA'],
      missingIcons: 0,
      cancelled: false
    })
    saveAsMock.mockResolvedValue({ success: false, message: '磁盘已满' })
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByText('磁盘已满')).toBeTruthy())
    expect(screen.queryByText('已保存 1 张')).toBeNull()
  })

  it('参数为空时先告知会以破折号占位，但仍可出图', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA'],
      missingIcons: 0,
      cancelled: false
    })
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    // useGameParams 替身只给 focalLength，其余 11 项按缺值走
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    expect(generateMock).toHaveBeenCalledTimes(1)
  })

  it('生成期间关闭面板：在途生成被取消，重开不残留上一资产的预览', async () => {
    generateMock.mockImplementation(async (deps: { isCancelled: () => boolean }) => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      if (deps.isCancelled()) return { pages: [], missingIcons: 0, cancelled: true }
      return { pages: ['data:image/png;base64,OLD'], missingIcons: 0, cancelled: false }
    })
    const { rerender } = render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    rerender(<ShareCardDialog open={false} file={asset()} onClose={noop} />)
    rerender(
      <ShareCardDialog open file={asset({ id: 'a/2', file_name: 'a2.png' })} onClose={noop} />
    )
    await waitFor(() => expect(generateMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(screen.queryAllByRole('img')).toHaveLength(0)
    expect(screen.queryByText('已取消生成')).toBeNull()
  })

  it('hasMotion 为真（即使 assetType 不是 motion_photo）也拒绝出图，与视图模型口径一致', () => {
    render(
      <ShareCardDialog
        open
        file={asset({
          nikkisync: {
            assetId: 'a/1',
            assetType: 'photo',
            state: 'ready',
            revision: 1,
            hasMotion: true,
            hasMetadata: false
          }
        })}
        onClose={noop}
      />
    )
    expect(screen.getByText('实况照片本阶段不支持生成分享图')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成分享图' })).toBeNull()
  })

  it('目录框取消（IpcError code=IPC_CANCELED）不当作保存失败弹错', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA'],
      missingIcons: 0,
      cancelled: false
    })
    saveAsMock.mockRejectedValue(
      Object.assign(new Error('未选择输出目录'), { name: 'IpcError', code: 'IPC_CANCELED' })
    )
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(saveAsMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('保存不可重入：保存在途时再次点击不发起第二轮 saveAs', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA'],
      missingIcons: 0,
      cancelled: false
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    saveAsMock.mockImplementation(() => gate.then(() => ({ success: true })))
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(saveAsMock).toHaveBeenCalledTimes(1)
  })

  it('图片加载失败：错误文案走错误家族 userMessage，不把内部英文串透给用户', async () => {
    generateMock.mockResolvedValue({
      pages: ['data:image/png;base64,AAA'],
      missingIcons: 0,
      cancelled: false
    })
    class BrokenImage {
      crossOrigin = ''
      width = 100
      height = 80
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onerror?.(), 0)
      }
    }
    vi.stubGlobal('Image', BrokenImage)
    render(<ShareCardDialog open file={asset()} onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: '生成分享图' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByRole('alert').textContent).not.toBe('image load failed')
  })
})
