/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MediaFile } from '../../stores/mediaStore'

// 隔离 BaseDialog
vi.mock('./BaseDialog', () => ({
  BaseDialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null)
}))

// 隔离 i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

// 隔离图标
vi.mock('../../icons', () => ({
  IconFolderOpen: (props: any) => <svg data-testid="icon-folder" {...props} />,
  IconCopyText: (props: any) => <svg data-testid="icon-copy" {...props} />,
  IconCamera: (props: any) => <svg data-testid="icon-camera" {...props} />,
  IconInfo: (props: any) => <svg data-testid="icon-info" {...props} />,
  IconStar: (props: any) => <svg data-testid="icon-star" {...props} />,
  IconOutfit: (props: any) => <svg data-testid="icon-outfit" {...props} />,
  IconCategory: (props: any) => <svg data-testid="icon-category" {...props} />
}))

// 隔离工具函数
vi.mock('../../utils/format', () => ({
  formatSize: (size: number) => `${size}B`
}))

vi.mock('../../utils/date', () => ({
  formatDateTime: (ts: string) => `date-${ts}`
}))

// 隔离 InfoPanel 组件
vi.mock('./ExifPanel', () => ({
  ExifPanel: () => <div data-testid="exif-panel" />
}))
vi.mock('./CameraInfoPanel', () => ({
  CameraInfoPanel: () => <div data-testid="camera-panel" />,
  formatCameraForCopy: () => ''
}))
vi.mock('./PhotographyPanel', () => ({
  PhotographyPanel: () => <div data-testid="photo-panel" />,
  formatPhotographyForCopy: () => ''
}))
vi.mock('./NikkiInfoPanel', () => ({
  NikkiInfoPanel: () => <div data-testid="nikki-panel" />,
  formatNikkiForCopy: () => ''
}))
vi.mock('./OutfitPanel', () => ({
  OutfitPanel: () => <div data-testid="outfit-panel" />,
  formatOutfitForCopy: () => ''
}))
vi.mock('./InteractionPanel', () => ({
  InteractionPanel: () => <div data-testid="interaction-panel" />,
  formatInteractionsForCopy: () => ''
}))

// 隔离 useGameParams（PropertiesDialog 层级调用，避免触发真实 IPC）
vi.mock('../../hooks/useGameParams', () => ({
  useGameParams: () => ({
    data: null,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

import { PropertiesDialog } from './PropertiesDialog'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    id: 1,
    file_name: 'test.jpg',
    file_path: '/path/to/test.jpg',
    file_type: 'image',
    file_size: 1024,
    width: 1920,
    height: 1080,
    created_at: 1700000000000,
    modified_at: 1700000001000,
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

describe('PropertiesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染', () => {
    const { container } = render(
      <PropertiesDialog open={false} file={makeFile()} onClose={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('open=true 且 file=null 时不渲染', () => {
    const { container } = render(<PropertiesDialog open={true} file={null} onClose={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('open=true 且 file 非空时渲染对话框', () => {
    render(<PropertiesDialog open={true} file={makeFile()} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('渲染文件名作为基础信息', () => {
    render(
      <PropertiesDialog open={true} file={makeFile({ file_name: 'photo.jpg' })} onClose={vi.fn()} />
    )
    expect(screen.getByText('photo.jpg')).toBeTruthy()
  })

  it('渲染文件路径作为基础信息', () => {
    render(
      <PropertiesDialog
        open={true}
        file={makeFile({ file_path: '/x/y/z.png' })}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('/x/y/z.png')).toBeTruthy()
  })

  it('image 类型显示 typeImage 文案', () => {
    render(
      <PropertiesDialog open={true} file={makeFile({ file_type: 'image' })} onClose={vi.fn()} />
    )
    expect(screen.getByText('common.propertiesDialog.basic.typeImage')).toBeTruthy()
  })

  it('video 类型显示 typeVideo 文案', () => {
    render(
      <PropertiesDialog open={true} file={makeFile({ file_type: 'video' })} onClose={vi.fn()} />
    )
    expect(screen.getByText('common.propertiesDialog.basic.typeVideo')).toBeTruthy()
  })

  it('有 width 和 height 时显示分辨率', () => {
    render(
      <PropertiesDialog
        open={true}
        file={makeFile({ width: 800, height: 600 })}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('800 × 600')).toBeTruthy()
  })

  it('无 width 或 height 时分辨率显示 -', () => {
    render(
      <PropertiesDialog
        open={true}
        file={makeFile({ width: undefined as any, height: undefined as any })}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('-')).toBeTruthy()
  })

  it('渲染所有 InfoPanel 子组件', () => {
    render(<PropertiesDialog open={true} file={makeFile()} onClose={vi.fn()} />)
    expect(screen.getByTestId('exif-panel')).toBeTruthy()
    expect(screen.getByTestId('camera-panel')).toBeTruthy()
    expect(screen.getByTestId('photo-panel')).toBeTruthy()
    expect(screen.getByTestId('nikki-panel')).toBeTruthy()
    expect(screen.getByTestId('outfit-panel')).toBeTruthy()
    expect(screen.getByTestId('interaction-panel')).toBeTruthy()
  })

  it('渲染关闭按钮', () => {
    render(<PropertiesDialog open={true} file={makeFile()} onClose={vi.fn()} />)
    expect(screen.getByText('common.close')).toBeTruthy()
  })

  it('点击关闭按钮触发 onClose', async () => {
    const onClose = vi.fn()
    const { fireEvent } = await import('@testing-library/react')
    render(<PropertiesDialog open={true} file={makeFile()} onClose={onClose} />)
    fireEvent.click(screen.getByText('common.close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('渲染打开目录按钮', () => {
    render(<PropertiesDialog open={true} file={makeFile()} onClose={vi.fn()} />)
    expect(screen.getByText('common.propertiesDialog.openLocation')).toBeTruthy()
  })

  it('渲染复制全部按钮', () => {
    render(<PropertiesDialog open={true} file={makeFile()} onClose={vi.fn()} />)
    expect(screen.getByText('common.propertiesDialog.copyAll')).toBeTruthy()
  })

  it('渲染文件大小（通过 formatSize）', () => {
    render(<PropertiesDialog open={true} file={makeFile({ file_size: 2048 })} onClose={vi.fn()} />)
    expect(screen.getByText('2048B')).toBeTruthy()
  })

  it('渲染创建时间（通过 formatDateTime）', () => {
    render(
      <PropertiesDialog open={true} file={makeFile({ created_at: '12345' })} onClose={vi.fn()} />
    )
    expect(screen.getByText('date-12345')).toBeTruthy()
  })

  it('渲染修改时间（通过 formatDateTime）', () => {
    render(
      <PropertiesDialog open={true} file={makeFile({ modified_at: '67890' })} onClose={vi.fn()} />
    )
    expect(screen.getByText('date-67890')).toBeTruthy()
  })
})
