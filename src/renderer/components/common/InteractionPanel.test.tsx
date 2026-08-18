/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import type { MediaFile } from '../../stores/mediaStore'
import type { InteractionParams } from '../../types/decryption'

vi.mock('./InfoRowPanel', () => ({
  InfoRowPanel: (props: any) => (
    <div
      data-testid="info-row-panel"
      data-loading={props.loading ? 'true' : 'false'}
      data-error={props.error ?? ''}
      data-title={props.title}
      data-loading-text={props.loadingText}
      data-empty-text={props.emptyText}
    >
      {props.rows?.map((r: any, i: number) => (
        <div key={i} data-testid="row">
          <span>{r.label}</span>
          <span>{r.value}</span>
        </div>
      ))}
    </div>
  )
}))

vi.mock('../../icons', () => ({
  IconCategory: (p: any) => <svg data-testid="icon-category" {...p} />
}))

const mockGameParamsResult = {
  data: null as any,
  loading: false,
  error: null as string | null
}

vi.mock('../../hooks/useGameParams', () => ({
  useGameParams: () => mockGameParamsResult
}))

import { InteractionPanel, formatInteractionsForCopy } from './InteractionPanel'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

describe('InteractionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGameParamsResult.data = null
    mockGameParamsResult.loading = false
    mockGameParamsResult.error = null
  })

  it('file_type 非 image 时返回 null', () => {
    const { container } = render(<InteractionPanel file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('无 album_type 时返回 null', () => {
    const { container } = render(
      <InteractionPanel file={makeFile({ album_type: undefined as any })} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('enabled 时渲染 InfoRowPanel', () => {
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel')).toBeTruthy()
  })

  it('loading=true 时透传到 InfoRowPanel', () => {
    mockGameParamsResult.loading = true
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading')).toBe('true')
  })

  it('error 非 null 时透传到 InfoRowPanel', () => {
    mockGameParamsResult.error = 'parse fail'
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-error')).toBe('parse fail')
  })

  it('标题为"交互物"', () => {
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-title')).toBe('交互物')
  })

  it('loadingText 为"正在解析交互物信息..."', () => {
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading-text')).toBe(
      '正在解析交互物信息...'
    )
  })

  it('emptyText 为"此图片未包含交互物信息"', () => {
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-empty-text')).toBe(
      '此图片未包含交互物信息'
    )
  })

  it('data.interactions 存在时渲染所有行（坐骑/载具/交互物）', () => {
    mockGameParamsResult.data = {
      interactions: {
        mount: {
          id: 100,
          loc: { x: 1, y: 2, z: 3 },
          rot: { yaw: 0, pitch: 0, roll: 0 },
          scale: { x: 1, y: 1, z: 1 }
        },
        carrier: null,
        interactions: [
          {
            id: 200,
            loc: { x: 1, y: 2, z: 3 },
            rot: { yaw: 0, pitch: 0, roll: 0 },
            scale: { x: 1, y: 1, z: 1 }
          }
        ]
      }
    }
    render(<InteractionPanel file={makeFile()} />)
    expect(screen.getByText('坐骑')).toBeTruthy()
    expect(screen.getByText('载具')).toBeTruthy()
    expect(screen.getByText('交互物1')).toBeTruthy()
  })

  it('data.interactions.mount=null 时显示"无"', () => {
    mockGameParamsResult.data = {
      interactions: {
        mount: null,
        carrier: null,
        interactions: []
      }
    }
    render(<InteractionPanel file={makeFile()} />)
    const rows = screen.getAllByTestId('row')
    // mount 行 value 为"无"，carrier 行 value 为"无"
    expect(rows.some((r) => r.textContent?.includes('无'))).toBe(true)
  })
})

describe('formatInteractionsForCopy', () => {
  it('d=null 返回空字符串', () => {
    expect(formatInteractionsForCopy(null)).toBe('')
  })

  it('d=undefined 返回空字符串', () => {
    expect(formatInteractionsForCopy(undefined)).toBe('')
  })

  it('d 完整时返回格式化文本', () => {
    const d: InteractionParams = {
      mount: {
        id: 1,
        loc: { x: 1, y: 2, z: 3 },
        rot: { yaw: 0, pitch: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 }
      },
      carrier: null,
      interactions: []
    }
    const text = formatInteractionsForCopy(d, i18n.t.bind(i18n))
    expect(text).toContain('=== 交互物 ===')
    expect(text).toContain('坐骑: #1')
    expect(text).toContain('位置(1.0, 2.0, 3.0)')
    expect(text).toContain('载具: 无')
  })

  it('d 包含 interactions 时格式化所有交互物', () => {
    const d: InteractionParams = {
      mount: null,
      carrier: null,
      interactions: [
        {
          id: 10,
          loc: { x: 1, y: 2, z: 3 },
          rot: { yaw: 0, pitch: 0, roll: 0 },
          scale: { x: 1, y: 1, z: 1 }
        },
        {
          id: 20,
          loc: { x: 4, y: 5, z: 6 },
          rot: { yaw: 0, pitch: 0, roll: 0 },
          scale: { x: 1, y: 1, z: 1 }
        }
      ]
    }
    const text = formatInteractionsForCopy(d, i18n.t.bind(i18n))
    expect(text).toContain('交互物1: #10')
    expect(text).toContain('交互物2: #20')
  })

  it('d 所有字段为空时仍输出"坐骑: 无"和"载具: 无"', () => {
    const d: InteractionParams = {
      mount: null,
      carrier: null,
      interactions: []
    }
    const text = formatInteractionsForCopy(d, i18n.t.bind(i18n))
    expect(text).toContain('坐骑: 无')
    expect(text).toContain('载具: 无')
  })

  it('formatObj 输出位置/旋转/缩放三段', () => {
    const d: InteractionParams = {
      mount: {
        id: 5,
        loc: { x: 1.5, y: 2.5, z: 3.5 },
        rot: { yaw: 10, pitch: 20, roll: 30 },
        scale: { x: 1.1, y: 2.2, z: 3.3 }
      },
      carrier: null,
      interactions: []
    }
    const text = formatInteractionsForCopy(d, i18n.t.bind(i18n))
    expect(text).toContain('位置(1.5, 2.5, 3.5)')
    expect(text).toContain('旋转(10.0°, 20.0°, 30.0°)')
    expect(text).toContain('缩放(1.10, 2.20, 3.30)')
  })
})
