/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { MediaFile } from '../../stores/mediaStore'
import type { ExifData } from '../../hooks/useExif'

vi.mock('../../icons', () => ({
  IconCamera: (p: ComponentProps<'svg'>) => <svg data-testid="icon-camera" {...p} />,
  IconCopyText: (p: ComponentProps<'svg'>) => <svg data-testid="icon-copy" {...p} />,
  IconInfo: (p: ComponentProps<'svg'>) => <svg data-testid="icon-info" {...p} />
}))

const mockExifResult = {
  exif: null as ExifData | null,
  loading: false,
  error: null as string | null
}

vi.mock('../../hooks/useExif', () => ({
  useExif: () => mockExifResult
}))

import { ExifPanel } from './ExifPanel'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    ...over
  }) as unknown as MediaFile

describe('ExifPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExifResult.exif = null
    mockExifResult.loading = false
    mockExifResult.error = null
  })

  it('file_type=video 时不渲染（返回 null）', () => {
    const { container } = render(<ExifPanel file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('file_type=image 时渲染容器', () => {
    const { container } = render(<ExifPanel file={makeFile()} />)
    expect(container.firstChild).not.toBeNull()
  })

  it('loading=true 时显示加载中文案', () => {
    mockExifResult.loading = true
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByText('正在解析相机参数...')).toBeTruthy()
  })

  it('loading=true 时 loading 文案带 spinner', () => {
    mockExifResult.loading = true
    const { container } = render(<ExifPanel file={makeFile()} />)
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('error 非 null 时显示错误信息', () => {
    mockExifResult.error = 'EXIF 读取失败'
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByText(/EXIF 解析失败: EXIF 读取失败/)).toBeTruthy()
  })

  it('exif=null 且无 loading/error 时显示空态文案', () => {
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByText('此图片未包含相机参数信息')).toBeTruthy()
  })

  it('showTitle=true 时渲染标题"拍摄参数"', () => {
    render(<ExifPanel file={makeFile()} showTitle={true} />)
    expect(screen.getByText('拍摄参数')).toBeTruthy()
  })

  it('showTitle=false 时不渲染标题', () => {
    render(<ExifPanel file={makeFile()} showTitle={false} />)
    expect(screen.queryByText('拍摄参数')).toBeNull()
  })

  it('exif 包含完整字段时渲染所有行', () => {
    mockExifResult.exif = {
      camera: 'Canon EOS R5',
      lens: 'RF 50mm F1.2L',
      aperture: 'f/1.4',
      shutter: '1/200s',
      iso: 200,
      focalLength: '50mm',
      dateTaken: '2024-01-15T10:30:00Z',
      gps: { latitude: 31.230416, longitude: 121.473701 },
      width: 1920,
      height: 1080
    }
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByText('Canon EOS R5')).toBeTruthy()
    expect(screen.getByText('RF 50mm F1.2L')).toBeTruthy()
    expect(screen.getByText('f/1.4')).toBeTruthy()
    expect(screen.getByText('1/200s')).toBeTruthy()
    expect(screen.getByText('200')).toBeTruthy()
    expect(screen.getByText('50mm')).toBeTruthy()
    expect(screen.getByText(/31\.230416, 121\.473701/)).toBeTruthy()
    expect(screen.getByText('1920 × 1080')).toBeTruthy()
  })

  it('exif 仅包含 camera 字段时只渲染 camera 行', () => {
    mockExifResult.exif = { camera: 'Sony A7' }
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByText('Sony A7')).toBeTruthy()
    expect(screen.queryByText('镜头')).toBeNull()
  })

  it('exif.dateTaken 非法时不渲染拍摄时间', () => {
    mockExifResult.exif = { dateTaken: 'invalid-date' }
    render(<ExifPanel file={makeFile()} />)
    // 空态文案出现（因为没有有效行）
    expect(screen.getByText('此图片未包含相机参数信息')).toBeTruthy()
  })

  it('有 EXIF 数据时渲染复制按钮', () => {
    mockExifResult.exif = { camera: 'Canon' }
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByText('复制参数')).toBeTruthy()
  })

  it('无 EXIF 数据时不渲染复制按钮', () => {
    render(<ExifPanel file={makeFile()} />)
    expect(screen.queryByText('复制参数')).toBeNull()
  })

  it('点击复制按钮后显示"已复制"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true
    })
    mockExifResult.exif = { camera: 'Canon' }

    render(<ExifPanel file={makeFile()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('复制参数'))
    })
    expect(screen.getByText('已复制')).toBeTruthy()
  })

  it('variant=dark 时使用 dark 主题类', () => {
    mockExifResult.exif = { camera: 'Canon' }
    const { container } = render(<ExifPanel file={makeFile()} variant="dark" />)
    expect(container.querySelector('.text-white\\/90')).toBeTruthy()
  })

  it('variant=light（默认）时不应用 dark 类', () => {
    mockExifResult.exif = { camera: 'Canon' }
    const { container } = render(<ExifPanel file={makeFile()} />)
    expect(container.querySelector('.text-white\\/90')).toBeNull()
  })

  it('复制按钮 aria-label 为"复制相机参数"', () => {
    mockExifResult.exif = { camera: 'Canon' }
    render(<ExifPanel file={makeFile()} />)
    expect(screen.getByLabelText('复制相机参数')).toBeTruthy()
  })

  it('复制按钮 title 为"复制完整相机参数"', () => {
    mockExifResult.exif = { camera: 'Canon' }
    render(<ExifPanel file={makeFile()} />)
    const btn = screen.getByLabelText('复制相机参数')
    expect(btn.getAttribute('title')).toBe('复制完整相机参数')
  })

  it('clipboard.writeText 抛错时使用 textarea 兜底', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      writable: true,
      configurable: true
    })
    mockExifResult.exif = { camera: 'Canon' }
    // mock document.execCommand
    document.execCommand = vi.fn().mockReturnValue(true)

    render(<ExifPanel file={makeFile()} />)
    await act(async () => {
      fireEvent.click(screen.getByText('复制参数'))
    })
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })
})
