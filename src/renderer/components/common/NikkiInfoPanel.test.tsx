/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import type { ComponentProps } from 'react'
import type { MediaFile } from '../../stores/mediaStore'
import type { NikkiParams } from '../../types/decryption'

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

vi.mock('../../icons', () => ({
  IconStar: (p: ComponentProps<'svg'>) => <svg data-testid="icon-star" {...p} />
}))

// useGameParams mock 状态（仅注入 nikki 分路）
const mockGameParamsResult: {
  data: { nikki?: NikkiParams } | null
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

import { NikkiInfoPanel, formatNikkiForCopy } from './NikkiInfoPanel'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

describe('NikkiInfoPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGameParamsResult.data = null
    mockGameParamsResult.loading = false
    mockGameParamsResult.error = null
  })

  it('file_type 非 image 时返回 null', () => {
    const { container } = render(<NikkiInfoPanel file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('无 album_type 时返回 null', () => {
    const { container } = render(<NikkiInfoPanel file={makeFile({ album_type: undefined })} />)
    expect(container.firstChild).toBeNull()
  })

  it('enabled 时渲染 InfoRowPanel', () => {
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel')).toBeTruthy()
  })

  it('loading=true 时透传到 InfoRowPanel', () => {
    mockGameParamsResult.loading = true
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading')).toBe('true')
  })

  it('error 非 null 时透传到 InfoRowPanel', () => {
    mockGameParamsResult.error = 'fail'
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-error')).toBe('fail')
  })

  it('标题为"暖暖信息"', () => {
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-title')).toBe('暖暖信息')
  })

  it('loadingText 为"正在解析暖暖信息..."', () => {
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading-text')).toBe(
      '正在解析暖暖信息...'
    )
  })

  it('emptyText 为"此图片未包含暖暖信息"', () => {
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-empty-text')).toBe(
      '此图片未包含暖暖信息'
    )
  })

  it('data.nikki 存在时渲染所有行', () => {
    mockGameParamsResult.data = {
      nikki: {
        giantState: true,
        hidden: false,
        loc: { x: 1, y: 2, z: 3 },
        rot: { yaw: 0, pitch: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 }
      }
    }
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByText('巨大化')).toBeTruthy()
    expect(screen.getByText('已开启')).toBeTruthy()
    expect(screen.getByText('隐藏暖暖')).toBeTruthy()
    expect(screen.getByText('未隐藏')).toBeTruthy()
    expect(screen.getByText('位置')).toBeTruthy()
    expect(screen.getByText('旋转')).toBeTruthy()
    expect(screen.getByText('缩放')).toBeTruthy()
  })

  it('data.nikki.giantState=false 时显示"未开启"', () => {
    mockGameParamsResult.data = {
      nikki: {
        giantState: false,
        hidden: false,
        loc: null,
        rot: null,
        scale: null
      }
    }
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByText('未开启')).toBeTruthy()
  })

  it('data.nikki.hidden=true 时显示"已隐藏"', () => {
    mockGameParamsResult.data = {
      nikki: {
        giantState: false,
        hidden: true,
        loc: null,
        rot: null,
        scale: null
      }
    }
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.getByText('已隐藏')).toBeTruthy()
  })

  it('data.nikki.loc=null 时不渲染位置行', () => {
    mockGameParamsResult.data = {
      nikki: {
        giantState: false,
        hidden: false,
        loc: null,
        rot: null,
        scale: null
      }
    }
    render(<NikkiInfoPanel file={makeFile()} />)
    expect(screen.queryByText('位置')).toBeNull()
  })
})

describe('formatNikkiForCopy', () => {
  it('n=null 返回空字符串', () => {
    expect(formatNikkiForCopy(null)).toBe('')
  })

  it('n=undefined 返回空字符串', () => {
    expect(formatNikkiForCopy(undefined)).toBe('')
  })

  it('n 完整时返回格式化文本', () => {
    const n: NikkiParams = {
      giantState: true,
      hidden: false,
      loc: { x: 1.5, y: 2.5, z: 3.5 },
      rot: { yaw: 10, pitch: 20, roll: 30 },
      scale: { x: 1.1, y: 2.2, z: 3.3 }
    }
    const text = formatNikkiForCopy(n, i18n.t.bind(i18n))
    expect(text).toContain('=== 暖暖信息 ===')
    expect(text).toContain('巨大化: 已开启')
    expect(text).toContain('隐藏暖暖: 未隐藏')
    expect(text).toContain('位置: (1.5, 2.5, 3.5)')
    expect(text).toContain('旋转: Yaw 10.0°, Pitch 20.0°, Roll 30.0°')
    expect(text).toContain('缩放: (1.10, 2.20, 3.30)')
  })

  it('n 不含 loc/rot/scale 时仅返回巨大化与隐藏信息', () => {
    const n: NikkiParams = {
      giantState: false,
      hidden: true,
      loc: null,
      rot: null,
      scale: null
    }
    const text = formatNikkiForCopy(n, i18n.t.bind(i18n))
    expect(text).toContain('巨大化: 未开启')
    expect(text).toContain('隐藏暖暖: 已隐藏')
    expect(text).not.toContain('位置')
    expect(text).not.toContain('旋转')
    expect(text).not.toContain('缩放')
  })
})
