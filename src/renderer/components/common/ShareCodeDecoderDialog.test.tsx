/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('./BaseDialog', () => ({
  BaseDialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

/** electronAPI 测试子集：仅挂 decrypt 分路（传 undefined 模拟 API 缺失） */
type MockDecryptAPI = Record<string, ReturnType<typeof vi.fn>>

const setDecryptAPI = (decrypt: MockDecryptAPI | undefined): void => {
  ;(window as unknown as { electronAPI: { decrypt: MockDecryptAPI | undefined } }).electronAPI = {
    decrypt
  }
}

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
      ok: true,
      data: { timestamp: 123, uidBytes: 'abc', networkData: 'net-data' }
    })
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'cloth_code' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
      await waitFor(() => expect(decodeClothDiy).toHaveBeenCalledWith('cloth_code'))
    })
  })

  it('Tab=homeBuild 时调用 decodeHomeBuild', async () => {
    const decodeHomeBuild = vi.fn().mockResolvedValue({
      ok: true,
      data: { server: 's1', networkData: 'x' }
    })
    setDecryptAPI({ decodeHomeBuild })

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
      ok: true,
      data: 'encoded-string'
    })
    setDecryptAPI({ encodeCameraParams })

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
      ok: true,
      data: { timestamp: 999, uidBytes: '0a1b', networkData: 'net-data' }
    })
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('common.shareCodeDecoder.decodeSuccess')).toBeTruthy()
  })

  // 回归：主进程 handler 运行时形状是 { ok, data, message }（decrypt-handler.ts），
  // 响应不含 success 字段——组件必须按 ok 判定，否则解码成功永远落入失败分支。
  it('运行时真实形状（仅 ok 字段）也判定为解码成功', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      ok: true,
      data: { timestamp: 999, uidBytes: '0a1b', networkData: 'net-data' }
    })
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('common.shareCodeDecoder.decodeSuccess')).toBeTruthy()
    expect(screen.queryByText('common.shareCodeDecoder.operationFailed')).toBeNull()
  })

  // ---- 阶段 4：clothDiy 结构化服饰列表 ----

  /** structured 投影样例：3 件服饰（第 2 件查询无数据，验证 #id 兜底） */
  const structuredSample = {
    poseId: 90,
    clothes: [
      { id: 2113020301, clothType: 30, state: 0, species: 211, outfitFeature: 301 },
      { id: 2113020302, clothType: 41, state: 2, species: 211, outfitFeature: 302 },
      { id: 502050401, clothType: 50, state: 9, species: 502, outfitFeature: 401 }
    ]
  }

  /** decodeClothDiy 成功返回 structured 的标准 mock */
  const mockDecodeWithStructured = (
    decodeClothDiy: ReturnType<typeof vi.fn>,
    structured: unknown = structuredSample
  ): void => {
    decodeClothDiy.mockResolvedValue({
      ok: true,
      data: { timestamp: 999, uidBytes: '0a1b', networkData: 'net-data', structured }
    })
  }

  it('解码成功 + structured 存在时：批量查询服饰数据并渲染名称/图标/#id 兜底', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy)
    const lookupCloth = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        '2113020301': {
          name: '示例上衣',
          iconUrl: 'https://cdn.gongeo.us/images/items/icons/2113020301.png'
        },
        '2113020302': {},
        '502050401': { name: '示例鞋履' }
      }
    })
    setDecryptAPI({ decodeClothDiy, lookupCloth })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    // 列表小节标题
    expect(await screen.findByText('common.shareCodeDecoder.result.outfitTitle')).toBeTruthy()
    // 名称（查询命中）
    expect(screen.getByText('示例上衣')).toBeTruthy()
    expect(screen.getByText('示例鞋履')).toBeTruthy()
    // 查询无数据的条目回退 #id
    expect(screen.getByText('#2113020302')).toBeTruthy()
    // 图标（仅第 1 件有 iconUrl）
    const img = screen.getByRole('img')
    expect(img.getAttribute('src')).toBe('https://cdn.gongeo.us/images/items/icons/2113020301.png')
    // 批量查询恰好一次，入参为保持顺序的服饰 id 数组
    expect(lookupCloth).toHaveBeenCalledTimes(1)
    expect(lookupCloth).toHaveBeenCalledWith([2113020301, 2113020302, 502050401])
  })

  it('structured.poseId 存在时显示动作 ID 行', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy)
    setDecryptAPI({
      decodeClothDiy,
      lookupCloth: vi.fn().mockResolvedValue({ ok: true, data: {} })
    })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    expect(await screen.findByText('common.shareCodeDecoder.result.poseId')).toBeTruthy()
    expect(screen.getByText('90')).toBeTruthy()
  })

  it('服饰条目渲染部位/状态枚举文案与系列/款型标注', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy)
    setDecryptAPI({
      decodeClothDiy,
      lookupCloth: vi.fn().mockResolvedValue({ ok: true, data: {} })
    })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    await screen.findByText('common.shareCodeDecoder.result.outfitTitle')
    // 部位：enums 映射命中（t 回显 key）
    expect(screen.getByText('enums.clothType.30')).toBeTruthy()
    expect(screen.getByText('enums.clothType.41')).toBeTruthy()
    expect(screen.getByText('enums.clothType.50')).toBeTruthy()
    // 状态：enums 映射命中
    expect(screen.getByText('enums.clothState.0')).toBeTruthy()
    expect(screen.getByText('enums.clothState.2')).toBeTruthy()
    expect(screen.getByText('enums.clothState.9')).toBeTruthy()
    // 系列/款型无映射，走数字标注键（3 件 → 各 3 处）
    expect(screen.getAllByText('common.shareCodeDecoder.result.speciesRaw')).toHaveLength(3)
    expect(screen.getAllByText('common.shareCodeDecoder.result.featureRaw')).toHaveLength(3)
  })

  it('lookupCloth 整体失败时列表照常渲染，名称回退 #id', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy)
    setDecryptAPI({
      decodeClothDiy,
      lookupCloth: vi.fn().mockRejectedValue(new Error('IPC 校验失败'))
    })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    expect(await screen.findByText('common.shareCodeDecoder.result.outfitTitle')).toBeTruthy()
    expect(screen.getByText('#2113020301')).toBeTruthy()
    expect(screen.getByText('#2113020302')).toBeTruthy()
    expect(screen.getByText('#502050401')).toBeTruthy()
    expect(screen.queryByText('common.shareCodeDecoder.operationFailed')).toBeNull()
  })

  it('lookupCloth 同步抛错时也按空映射降级，列表照常渲染', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy)
    const lookupCloth = vi.fn(() => {
      throw new Error('sync boom')
    })
    setDecryptAPI({ decodeClothDiy, lookupCloth })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    expect(await screen.findByText('common.shareCodeDecoder.result.outfitTitle')).toBeTruthy()
    expect(screen.getByText('#2113020301')).toBeTruthy()
    expect(screen.queryByText('common.shareCodeDecoder.operationFailed')).toBeNull()
  })

  it('structured 为 null（解析失败）时显示友好错误与原始数据折叠区', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      ok: true,
      data: { timestamp: 999, networkData: 'RAW-NETWORK-DATA', structured: null }
    })
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    expect(await screen.findByText('common.shareCodeDecoder.result.parseFailed')).toBeTruthy()
    // 折叠区摘要 + 原始数据内容可见（details 内容始终在 DOM 中）
    expect(screen.getByText('common.shareCodeDecoder.result.rawDataSummary')).toBeTruthy()
    expect(screen.getByText('RAW-NETWORK-DATA')).toBeTruthy()
  })

  it('structured 缺省（离线降级）时保持网络不可用提示，不渲染列表', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      ok: true,
      data: { timestamp: 999, uidBytes: '0a1b' }
    })
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    expect(
      await screen.findByText('common.shareCodeDecoder.result.networkUnavailable')
    ).toBeTruthy()
    expect(screen.queryByText('common.shareCodeDecoder.result.outfitTitle')).toBeNull()
  })

  it('clothes 为空数组时显示空态文案', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy, { clothes: [] })
    setDecryptAPI({
      decodeClothDiy,
      lookupCloth: vi.fn().mockResolvedValue({ ok: true, data: {} })
    })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    expect(await screen.findByText('common.shareCodeDecoder.result.clothesEmpty')).toBeTruthy()
  })

  it('服饰超过 50 件时分块批量查询', async () => {
    const clothes = Array.from({ length: 51 }, (_, i) => ({
      id: i + 1,
      clothType: 30,
      state: 0,
      species: 211,
      outfitFeature: 1
    }))
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy, { clothes })
    const lookupCloth = vi.fn().mockResolvedValue({ ok: true, data: {} })
    setDecryptAPI({ decodeClothDiy, lookupCloth })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    await screen.findByText('common.shareCodeDecoder.result.outfitTitle')
    expect(lookupCloth).toHaveBeenCalledTimes(2)
    expect(lookupCloth.mock.calls[0]?.[0]).toHaveLength(50)
    expect(lookupCloth.mock.calls[1]?.[0]).toHaveLength(1)
  })

  it('图标加载失败（onError）时组件不崩溃且图标被隐藏', async () => {
    const decodeClothDiy = vi.fn()
    mockDecodeWithStructured(decodeClothDiy)
    setDecryptAPI({
      decodeClothDiy,
      lookupCloth: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          '2113020301': {
            name: '示例上衣',
            iconUrl: 'https://cdn.gongeo.us/images/items/icons/2113020301.png'
          },
          '2113020302': {},
          '502050401': { name: '示例鞋履' }
        }
      })
    })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))

    const img = await screen.findByRole('img')
    fireEvent.error(img)
    // onError 后图标隐藏，但列表与名称仍正常
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('示例上衣')).toBeTruthy()
  })

  it('解码进行中（含服饰查询阶段）解码按钮禁用', async () => {
    const decodeClothDiy = vi.fn().mockImplementation(() => new Promise(() => {}))
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    await act(async () => {
      fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    })
    const btn = screen
      .getByText('common.shareCodeDecoder.decoding')
      .closest('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('解码失败时渲染失败信息', async () => {
    const decodeClothDiy = vi.fn().mockResolvedValue({
      ok: false,
      message: '解析失败原因'
    })
    setDecryptAPI({ decodeClothDiy })

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'bad-code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('解析失败原因')).toBeTruthy()
  })

  it('electronAPI.decrypt 不存在时显示 apiUnavailable', async () => {
    setDecryptAPI(undefined)

    render(<ShareCodeDecoderDialog open={true} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code' } })
    fireEvent.click(screen.getByText('common.shareCodeDecoder.decodeButton'))
    expect(await screen.findByText('common.shareCodeDecoder.apiUnavailable')).toBeTruthy()
  })

  it('解码 API 抛错时显示错误消息', async () => {
    const decodeClothDiy = vi.fn().mockRejectedValue(new Error('IPC 异常'))
    setDecryptAPI({ decodeClothDiy })

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
