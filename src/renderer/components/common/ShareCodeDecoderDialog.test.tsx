/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('./BaseDialog', () => ({
  BaseDialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { ShareCodeDecoderDialog } from './ShareCodeDecoderDialog'

describe('ShareCodeDecoderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('open=false 时不渲染', () => {
    const { container } = render(<ShareCodeDecoderDialog open={false} onClose={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('open=true 时渲染对话框', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('渲染标题', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('common.shareCodeDecoder.title')).toBeTruthy()
  })

  it('渲染三个 Tab 选项', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('common.shareCodeDecoder.tabs.clothDiy')).toBeTruthy()
    expect(screen.getByText('common.shareCodeDecoder.tabs.homeBuild')).toBeTruthy()
    expect(screen.getByText('common.shareCodeDecoder.tabs.mediaEncrypt')).toBeTruthy()
  })

  it('默认选中 clothDiy Tab', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    const clothTab = screen.getByText('common.shareCodeDecoder.tabs.clothDiy').closest('button')!
    expect(clothTab.style.background).toBe('var(--bg-primary)')
  })

  it('切换 Tab 时清空输入与结果', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'test input' } })
    expect(textarea.value).toBe('test input')
    fireEvent.click(screen.getByText('common.shareCodeDecoder.tabs.homeBuild'))
    expect(textarea.value).toBe('')
  })

  it('输入为空时解码按钮 disabled', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    const btn = screen.getByText('common.shareCodeDecoder.decodeButton').closest('button')!
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('输入非空时解码按钮可点击', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'cloth_code' } })
    const btn = screen.getByText('common.shareCodeDecoder.decodeButton').closest('button')!
    expect((btn as HTMLButtonElement).disabled).toBe(false)
  })

  it('点击解码按钮调用 electronAPI.decrypt.decodeClothDiy', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      success: true,
      data: { timestamp: 123, uidBytes: 'abc', networkData: 'net-data' }
    })
    ;(window as any).electronAPI = { decrypt: { decodeClothDiy } }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cloth_code' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
      await waitFor(() => expect(decodeClothDiy).toHaveBeenCalledWith('cloth_code'))
    })
  })

  it('Tab=homeBuild 时调用 decodeHomeBuild', async () => {
    const decodeHomeBuild = vi.fn().mockResolvedValue({
      success: true,
      data: { server: 's1', networkData: 'x' }
    })
    ;(window as any).electronAPI = { decrypt: { decodeHomeBuild } }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('common.shareCodeDecoder.tabs.homeBuild'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'home_code' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
      await waitFor(() => expect(decodeHomeBuild).toHaveBeenCalledWith('home_code'))
    })
  })

  it('Tab=mediaEncrypt 时调用 encodeCameraParams', async () => {
    const encodeCameraParams = vi.fn().mockResolvedValue({
      success: true,
      data: 'encoded-string'
    })
    ;(window as any).electronAPI = { decrypt: { encodeCameraParams } }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('common.shareCodeDecoder.tabs.mediaEncrypt'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'camera_data' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common.shareCodeDecoder.encryptButton'))
      await waitFor(() => expect(encodeCameraParams).toHaveBeenCalledWith('camera_data'))
    })
  })

  it('解码成功后渲染结果区', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      success: true,
      data: { timestamp: 999, uidBytes: '0a1b', networkData: 'net-data' }
    })
    ;(window as any).electronAPI = { decrypt: { decodeClothDiy } }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('common.shareCodeDecoder.decodeSuccess')).toBeTruthy()
  })

  it('解码失败时渲染失败信息', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      success: false,
      message: '解析失败原因'
    })
    ;(window as any).electronAPI = { decrypt: { decodeClothDiy } }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bad-code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('解析失败原因')).toBeTruthy()
  })

  it('electronAPI.decrypt 不存在时显示 apiUnavailable', async () => {
    ;(window as any).electronAPI = { decrypt: undefined }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('common.shareCodeDecoder.apiUnavailable')).toBeTruthy()
  })

  it('解码 API 抛错时显示错误消息', async () => {
    const decodeClothDiy = vi.fn().mockRejectedValue(new Error('IPC 异常'))
    ;(window as any).electronAPI = { decrypt: { decodeClothDiy } }

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('IPC 异常')).toBeTruthy()
  })

  it('点击关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(<ShareCodeDecoderDialog open={true} onClose={onClose} />)
    const closeBtn = screen.getByLabelText('common.shareCodeDecoder.closeAriaLabel')
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('输入框支持用户输入', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'new code' } })
    expect(textarea.value).toBe('new code')
  })

  it('渲染说明文案', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    expect(screen.getByText('common.shareCodeDecoder.descriptions.clothDiy')).toBeTruthy()
  })

  it('切换到 homeBuild Tab 显示对应说明', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('common.shareCodeDecoder.tabs.homeBuild'))
    expect(screen.getByText('common.shareCodeDecoder.descriptions.homeBuild')).toBeTruthy()
  })

  it('切换到 mediaEncrypt Tab 显示加密按钮文案', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('common.shareCodeDecoder.tabs.mediaEncrypt'))
    expect(screen.getByText('common.shareCodeDecoder.encryptButton')).toBeTruthy()
  })

  it('输入仅空白字符时解码按钮仍 disabled', () => {
    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '   ' } })
    const btn = screen.getByText('common.shareCodeDecoder.decodeButton').closest('button')!
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})
