/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { MediaFile } from '../../stores/mediaStore'
import type { PhotographyInfo } from '../../types/decryption'

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
  getWeatherName: (w: number) => (w === 1 ? '晴天' : w === 2 ? '雨天' : null),
  getPuzzleName: (tag: number) => (tag === 100 ? '错位 1' : null),
  getInteractiveName: (tag: number) => (tag === 200 ? '交互 1' : null)
}))

vi.mock('../../utils/location-map', () => ({
  getLocationName: (x: number, y: number, z: number) =>
    x === 1 && y === 2 && z === 3 ? '奇迹大陆' : null
}))

vi.mock('../../icons', () => ({
  IconInfo: (p: ComponentProps<'svg'>) => <svg data-testid="icon-info" {...p} />
}))

// i18n mock：返回 detail.photography 命名空间的中文值，保证组件渲染与 formatPhotographyForCopy 输出一致
const mockT = (key: string, options?: Record<string, unknown>): string => {
  const map: Record<string, string> = {
    'detail.photography.copyHeader': '=== 拍摄信息 ===',
    'detail.photography.title': '拍摄信息',
    'detail.photography.loadingText': '正在解析拍摄信息...',
    'detail.photography.emptyText': '此图片未包含拍摄信息',
    'detail.photography.edit.label': '是否编辑',
    'detail.photography.edit.edited': '已编辑',
    'detail.photography.edit.notEdited': '未编辑',
    'detail.photography.edit.sticker': '贴纸',
    'detail.photography.edit.text': '文字',
    'detail.photography.date.label': '拍摄日期',
    'detail.photography.time.label': '拍摄时间',
    'detail.photography.location.label': '拍摄地点',
    'detail.photography.weather.label': '天气',
    'detail.photography.photoWall.label': '照片墙',
    'detail.photography.photoWall.notJoined': '未加入',
    'detail.photography.task.label': '拍摄任务',
    'detail.photography.task.none': '无任务',
    'detail.photography.task.risk': '惊险拍摄'
  }
  if (key === 'detail.photography.edit.editedWithDetails') {
    return `已编辑（${options?.details ?? ''}）`
  }
  if (key === 'detail.photography.date.dayValue') {
    return `第 ${options?.day ?? ''} 天`
  }
  if (key === 'detail.photography.photoWall.joinedValue') {
    return `已加入 (${options?.count ?? ''} 张)`
  }
  if (key === 'detail.photography.weather.typeValue') {
    return `类型 ${options?.type ?? ''}`
  }
  if (key === 'detail.photography.task.puzzleFallback') {
    return `错位摄影(#${options?.tag ?? ''})`
  }
  if (key === 'detail.photography.task.interactiveFallback') {
    return `拍摄任务(#${options?.tag ?? ''})`
  }
  return map[key] ?? key
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'zh-CN' } })
}))

// useGameParams mock 状态（仅注入 photography 分路）
const mockGameParamsResult: {
  data: { photography?: PhotographyInfo } | null
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

import { PhotographyPanel, formatPhotographyForCopy } from './PhotographyPanel'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

describe('PhotographyPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGameParamsResult.data = null
    mockGameParamsResult.loading = false
    mockGameParamsResult.error = null
  })

  it('file_type 非 image 时返回 null', () => {
    const { container } = render(<PhotographyPanel file={makeFile({ file_type: 'video' })} />)
    expect(container.firstChild).toBeNull()
  })

  it('无 album_type 时返回 null', () => {
    const { container } = render(<PhotographyPanel file={makeFile({ album_type: undefined })} />)
    expect(container.firstChild).toBeNull()
  })

  it('enabled 时渲染 InfoRowPanel', () => {
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel')).toBeTruthy()
  })

  it('loading=true 时透传', () => {
    mockGameParamsResult.loading = true
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading')).toBe('true')
  })

  it('error 非 null 时透传', () => {
    mockGameParamsResult.error = 'parse fail'
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-error')).toBe('parse fail')
  })

  it('标题为"拍摄信息"', () => {
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-title')).toBe('拍摄信息')
  })

  it('loadingText 为"正在解析拍摄信息..."', () => {
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-loading-text')).toBe(
      '正在解析拍摄信息...'
    )
  })

  it('emptyText 为"此图片未包含拍摄信息"', () => {
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByTestId('info-row-panel').getAttribute('data-empty-text')).toBe(
      '此图片未包含拍摄信息'
    )
  })

  it('data.photography 完整时渲染所有行', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: true, hasSticker: true, hasText: false },
        date: { day: 5 },
        time: { hour: 10, minute: 30, second: 45 },
        location: { pos: { x: 1, y: 2, z: 3 }, name: null },
        weather: 1,
        photoWall: [1, 2, 3],
        tasks: [{ type: 'puzzle', tag: 100 }]
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('是否编辑')).toBeTruthy()
    expect(screen.getByText('已编辑（贴纸）')).toBeTruthy()
    expect(screen.getByText('拍摄日期')).toBeTruthy()
    expect(screen.getByText('第 5 天')).toBeTruthy()
    expect(screen.getByText('拍摄时间')).toBeTruthy()
    expect(screen.getByText('10:30:45')).toBeTruthy()
    expect(screen.getByText('拍摄地点')).toBeTruthy()
    expect(screen.getByText('奇迹大陆')).toBeTruthy()
    expect(screen.getByText('天气')).toBeTruthy()
    expect(screen.getByText('晴天')).toBeTruthy()
    expect(screen.getByText('照片墙')).toBeTruthy()
    expect(screen.getByText('已加入 (3 张)')).toBeTruthy()
    expect(screen.getByText('拍摄任务')).toBeTruthy()
    expect(screen.getByText('错位 1')).toBeTruthy()
  })

  it('edit.enabled=false 时显示"未编辑"', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: null,
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('未编辑')).toBeTruthy()
  })

  it('edit.enabled=true 且 hasSticker + hasText 时显示两项', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: true, hasSticker: true, hasText: true },
        date: null,
        time: null,
        location: null,
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('已编辑（贴纸、文字）')).toBeTruthy()
  })

  it('photoWall 为空时显示"未加入"', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: null,
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('未加入')).toBeTruthy()
  })

  it('tasks 为空时显示"无任务"', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: null,
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('无任务')).toBeTruthy()
  })

  it('location.name 非空时优先使用 name', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: { pos: { x: 0, y: 0, z: 0 }, name: '自定义地点' },
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('自定义地点')).toBeTruthy()
  })

  it('location.name 为空且 location-map 未匹配时回退到坐标', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: { pos: { x: 99, y: 99, z: 99 }, name: null },
        weather: null,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('(99.0, 99.0, 99.0)')).toBeTruthy()
  })

  it('tasks 包含 risk 类型时显示"惊险拍摄"', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: null,
        weather: null,
        photoWall: [],
        tasks: [{ type: 'risk', tag: 0 }]
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('惊险拍摄')).toBeTruthy()
  })

  it('tasks 包含 interactive 类型且未匹配时显示"拍摄任务(#tag)"', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: null,
        weather: null,
        photoWall: [],
        tasks: [{ type: 'interactive', tag: 999 }]
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('拍摄任务(#999)')).toBeTruthy()
  })

  it('weather 未知时显示"类型 N"', () => {
    mockGameParamsResult.data = {
      photography: {
        edit: { enabled: false, hasSticker: false, hasText: false },
        date: null,
        time: null,
        location: null,
        weather: 99,
        photoWall: [],
        tasks: []
      }
    }
    render(<PhotographyPanel file={makeFile()} />)
    expect(screen.getByText('类型 99')).toBeTruthy()
  })
})

describe('formatPhotographyForCopy', () => {
  it('p=null 返回空字符串', () => {
    expect(formatPhotographyForCopy(null)).toBe('')
  })

  it('p=undefined 返回空字符串', () => {
    expect(formatPhotographyForCopy(undefined)).toBe('')
  })

  it('p 完整时返回格式化文本', () => {
    const p: PhotographyInfo = {
      edit: { enabled: true, hasSticker: true, hasText: false },
      date: { day: 5 },
      time: { hour: 10, minute: 30, second: 45 },
      location: { pos: { x: 1, y: 2, z: 3 }, name: null },
      weather: 1,
      photoWall: [1, 2, 3],
      tasks: [{ type: 'puzzle', tag: 100 }]
    }
    const text = formatPhotographyForCopy(p, mockT)
    expect(text).toContain('=== 拍摄信息 ===')
    expect(text).toContain('是否编辑: 已编辑（贴纸）')
    expect(text).toContain('拍摄日期: 第 5 天')
    expect(text).toContain('拍摄时间: 10:30:45')
    expect(text).toContain('拍摄地点: 奇迹大陆')
    expect(text).toContain('天气: 晴天')
    expect(text).toContain('照片墙: 已加入 (3 张)')
    expect(text).toContain('拍摄任务: 错位 1')
  })

  it('p 各字段为空时仍返回格式化文本', () => {
    const p: PhotographyInfo = {
      edit: { enabled: false, hasSticker: false, hasText: false },
      date: null,
      time: null,
      location: null,
      weather: null,
      photoWall: [],
      tasks: []
    }
    const text = formatPhotographyForCopy(p, mockT)
    expect(text).toContain('=== 拍摄信息 ===')
    expect(text).toContain('是否编辑: 未编辑')
    expect(text).toContain('照片墙: 未加入')
    expect(text).toContain('拍摄任务: 无任务')
  })

  it('p.edit.enabled=true 且 hasSticker=true hasText=true 时显示两项', () => {
    const p: PhotographyInfo = {
      edit: { enabled: true, hasSticker: true, hasText: true },
      date: null,
      time: null,
      location: null,
      weather: null,
      photoWall: [],
      tasks: []
    }
    const text = formatPhotographyForCopy(p, mockT)
    expect(text).toContain('已编辑（贴纸、文字）')
  })

  it('p.time.second 为小数时取整', () => {
    const p: PhotographyInfo = {
      edit: { enabled: false, hasSticker: false, hasText: false },
      date: null,
      time: { hour: 8, minute: 5, second: 9.7 },
      location: null,
      weather: null,
      photoWall: [],
      tasks: []
    }
    const text = formatPhotographyForCopy(p, mockT)
    expect(text).toContain('拍摄时间: 08:05:09')
  })
})
