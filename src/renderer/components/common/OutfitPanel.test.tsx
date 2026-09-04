/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentProps } from 'react'
import type { MediaFile } from '../../stores/mediaStore'
import type { DressingParams } from '../../types/decryption'

/** InfoRowPanel mock 的 props 子集（仅覆盖本测试断言用到的字段） */
interface MockInfoRowPanelProps {
  loading?: boolean
  error?: string | null
  title?: string
  loadingText?: string
  emptyText?: string
  rows?: { label: string; value: string }[]
}

vi.mock('./InfoRowPanel', () => ({
  InfoRowPanel: (props: MockInfoRowPanelProps) => (
    <div
      data-testid="info-row-panel"
      data-loading={props.loading ? 'true' : 'false'}
      data-error={props.error ?? ''}
      data-title={props.title}
      data-loading-text={props.loadingText}
      data-empty-text={props.emptyText}
    >
      {props.rows?.map((r: { label: string; value: string }, i: number) => (
        <div key={i}>
          <span>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  )
}))

vi.mock('../../utils/enum-mappings', () => ({
  getClothTypeName: (id: number) => (id === 1 ? '上衣' : id === 2 ? '下装' : null),
  getClothStateName: (state: number) =>
    state === 0 ? '无' : state === 1 ? '焕新' : state === 2 ? '进化' : null,
  getEurekaAttachmentPointName: (p: number) => (p === 1 ? '头部' : null),
  getEurekaColorName: (c: number) => (c === 1 ? '红色' : null)
}))

vi.mock('../../utils/cloth-name-lookup', () => ({
  getClothName: (id: number) => (id === 100 ? '星河裙' : null),
  getOutfitName: (id: number) => (id === 200 ? '星河套装' : null)
}))

vi.mock('../../icons', () => ({
  IconOutfit: (p: ComponentProps<'svg'>) => <svg data-testid="icon-outfit" {...p} />
}))

// useGameParams mock 状态（仅注入 dressing 分路）
const mockGameParamsResult: {
  data: { dressing?: DressingParams } | null
  loading: boolean
  error: string | null
} = {
  data: null,
  loading: false,
  error: null
}

vi.mock('../../hooks/useGameParams', () => ({
  useGameParams: () => mockGameParamsResult
}))

import { OutfitPanel, formatOutfitForCopy } from './OutfitPanel'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

describe('OutfitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGameParamsResult.data = null
    mockGameParamsResult.loading = false
    mockGameParamsResult.error = null
  })

  it('file_type 非 image 时返回 null', () => {
    const { container } = render(<OutfitPanel file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('无 album_type 时返回 null', () => {
    const { container } = render(<OutfitPanel file={makeFile({ album_type: undefined })} />)
    expect(container.firstChild).toBeNull()
  })

  it('enabled 时渲染 InfoRowPanel', () => {
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel')).toBeTruthy()
  })

  it('loading=true 时透传', () => {
    mockGameParamsResult.loading = true
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading')).toBe('true')
  })

  it('error 非 null 时透传', () => {
    mockGameParamsResult.error = 'fail'
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-error')).toBe('fail')
  })

  it('标题为"搭配"', () => {
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-title')).toBe('搭配')
  })

  it('loadingText 为"正在解析搭配信息..."', () => {
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading-text')).toBe(
      '正在解析搭配信息...'
    )
  })

  it('emptyText 为"此图片未包含搭配信息"', () => {
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-empty-text')).toBe(
      '此图片未包含搭配信息'
    )
  })

  it('data.notContained=true 时走空态显示"不包含该参数"，不展示误导性错误', () => {
    render(
      <OutfitPanel
        file={makeFile()}
        gameParams={{
          hasParams: false,
          notContained: true,
          error: '未找到 CameraParams 字段'
        }}
      />
    )
    const panel = screen.getByTestId('info-row-panel')
    // notContained 空态：错误不展示，文案为“不包含该参数”
    expect(panel.getAttribute('data-error')).toBe('')
    expect(panel.getAttribute('data-empty-text')).toBe('不包含该参数')
  })

  it('data.dressing 包含 clothes 时渲染服装行', () => {
    mockGameParamsResult.data = {
      dressing: {
        clothes: [{ id: 100, clothType: 1, clothTypeName: '上衣', state: 0, species: 0 }],
        eureka: []
      }
    }
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByText('上衣')).toBeTruthy()
    expect(screen.getByText(/星河裙 #100/)).toBeTruthy()
  })

  it('data.dressing.clothName 为 null 时仅显示 #ID', () => {
    mockGameParamsResult.data = {
      dressing: {
        clothes: [{ id: 999, clothType: 1, clothTypeName: '上衣', state: 0, species: 0 }],
        eureka: []
      }
    }
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByText(/#999/)).toBeTruthy()
  })

  it('data.dressing.clothes[].state 非"无"时追加状态标记', () => {
    mockGameParamsResult.data = {
      dressing: {
        clothes: [{ id: 100, clothType: 1, clothTypeName: '上衣', state: 1, species: 0 }],
        eureka: []
      }
    }
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByText(/星河裙 #100 \[焕新\]/)).toBeTruthy()
  })

  it('data.dressing 包含 eureka 时渲染祝福闪光行', () => {
    mockGameParamsResult.data = {
      dressing: {
        clothes: [],
        eureka: [{ id: 200, level: 5, color: 1, attachmentPoint: 1, outfit: 200 }]
      }
    }
    render(<OutfitPanel file={makeFile()} />)
    expect(screen.getByText('祝福闪光')).toBeTruthy()
    // 文案包含 outfit 名 + id + 颜色 + 挂载点 + 等级
    expect(screen.getByText(/星河套装 #200/)).toBeTruthy()
    expect(screen.getByText(/\[红色\]/)).toBeTruthy()
    expect(screen.getByText(/\[头部\]/)).toBeTruthy()
    expect(screen.getByText(/Lv\.5/)).toBeTruthy()
  })
})

describe('formatOutfitForCopy', () => {
  it('d=null 返回空字符串', () => {
    expect(formatOutfitForCopy(null)).toBe('')
  })

  it('d=undefined 返回空字符串', () => {
    expect(formatOutfitForCopy(undefined)).toBe('')
  })

  it('d 完整时返回格式化文本', () => {
    const d: DressingParams = {
      clothes: [{ id: 100, clothType: 1, clothTypeName: '上衣', state: 1, species: 0 }],
      eureka: [{ id: 200, level: 5, color: 1, attachmentPoint: 1, outfit: 200 }]
    }
    const text = formatOutfitForCopy(d, i18n.t.bind(i18n))
    expect(text).toContain('=== 搭配 ===')
    expect(text).toContain('上衣: 星河裙 #100 [焕新]')
    expect(text).toContain('祝福闪光: 星河套装 #200[红色][头部] (Lv.5)')
  })

  it('d 无 clothes 与 eureka 时仅返回标题', () => {
    const d: DressingParams = { clothes: [], eureka: [] }
    const text = formatOutfitForCopy(d)
    expect(text).toBe('')
  })

  it('d.clothes[].clothName 未找到时不显示名称', () => {
    const d: DressingParams = {
      clothes: [{ id: 999, clothType: 1, clothTypeName: '上衣', state: 0, species: 0 }],
      eureka: []
    }
    const text = formatOutfitForCopy(d)
    // getClothName(999) = null，回退到 c.clothTypeName='上衣'
    expect(text).toContain('上衣: 上衣 #999')
  })
})
