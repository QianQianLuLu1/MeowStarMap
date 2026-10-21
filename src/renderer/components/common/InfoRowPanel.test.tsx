/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { InfoRowPanel, type InfoRow, type ParamGroup } from './InfoRowPanel'

vi.mock('../../icons', () => ({
  IconCopy: (p: ComponentProps<'svg'>) => <svg data-testid="icon-copy" {...p} />
}))

const sampleRows: InfoRow[] = [
  { label: '名称', value: '测试图片.jpg' },
  { label: '路径', value: '/path/to/file' }
]

const sampleGroups: ParamGroup[] = [
  {
    title: '基础',
    rows: [
      { label: '名称', value: 'A' },
      { label: '路径', value: 'B' }
    ]
  },
  {
    title: '其他',
    rows: [{ label: '尺寸', value: '1920x1080' }]
  }
]

describe('InfoRowPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('传入 icon 与 title 时渲染标题', () => {
    render(
      <InfoRowPanel icon={<span data-testid="icon">📷</span>} title="基础信息" rows={sampleRows} />
    )
    expect(screen.getByTestId('icon')).toBeTruthy()
    expect(screen.getByText('基础信息')).toBeTruthy()
  })

  it('showTitle=false 时不渲染标题区域', () => {
    render(
      <InfoRowPanel
        icon={<span data-testid="icon">📷</span>}
        title="基础信息"
        rows={sampleRows}
        showTitle={false}
      />
    )
    expect(screen.queryByText('基础信息')).toBeNull()
  })

  it('loading=true 时显示加载文案', () => {
    render(
      <InfoRowPanel
        icon={<span>📷</span>}
        title="基础信息"
        loading={true}
        loadingText="正在载入..."
      />
    )
    expect(screen.getByText('正在载入...')).toBeTruthy()
  })

  it('loading=true 时使用默认 loadingText', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" loading={true} />)
    expect(screen.getByText('正在解析...')).toBeTruthy()
  })

  it('loading=true 时不渲染数据行', () => {
    render(
      <InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={sampleRows} loading={true} />
    )
    expect(screen.queryByText('名称')).toBeNull()
  })

  it('error 非 null 时显示错误信息', () => {
    render(
      <InfoRowPanel icon={<span>📷</span>} title="基础信息" error="解析失败" errorPrefix="错误" />
    )
    expect(screen.getByText(/错误: 解析失败/)).toBeTruthy()
  })

  it('error 非 null 时使用默认 errorPrefix', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" error="boom" />)
    expect(screen.getByText(/信息解析失败: boom/)).toBeTruthy()
  })

  it('rows 为空数组且无 loading/error 时显示 emptyText', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={[]} emptyText="暂无数据" />)
    expect(screen.getByText('暂无数据')).toBeTruthy()
  })

  it('rows 为空数组且未传 emptyText 时使用默认文案', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={[]} />)
    expect(screen.getByText('此图片未包含相关信息')).toBeTruthy()
  })

  it('传入 rows 时渲染全部数据行', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={sampleRows} />)
    expect(screen.getByText('名称')).toBeTruthy()
    expect(screen.getByText('测试图片.jpg')).toBeTruthy()
    expect(screen.getByText('路径')).toBeTruthy()
    expect(screen.getByText('/path/to/file')).toBeTruthy()
  })

  it('传入 groups 时渲染分组标题与所有行', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" groups={sampleGroups} />)
    expect(screen.getByText('基础')).toBeTruthy()
    expect(screen.getByText('其他')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
    expect(screen.getByText('1920x1080')).toBeTruthy()
  })

  it('传入 onCopy 且 hasContent 时渲染复制按钮', () => {
    render(
      <InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={sampleRows} onCopy={vi.fn()} />
    )
    expect(screen.getByTestId('icon-copy')).toBeTruthy()
    expect(screen.getByText('复制')).toBeTruthy()
  })

  it('传入 onCopy 但无内容时不渲染复制按钮', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={[]} onCopy={vi.fn()} />)
    expect(screen.queryByTestId('icon-copy')).toBeNull()
  })

  it('点击复制按钮触发 onCopy', () => {
    const onCopy = vi.fn()
    render(
      <InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={sampleRows} onCopy={onCopy} />
    )
    fireEvent.click(screen.getByText('复制'))
    expect(onCopy).toHaveBeenCalledTimes(1)
  })

  it('copied=true 时显示"已复制"文案', () => {
    render(
      <InfoRowPanel
        icon={<span>📷</span>}
        title="基础信息"
        rows={sampleRows}
        onCopy={vi.fn()}
        copied={true}
      />
    )
    expect(screen.getByText('已复制')).toBeTruthy()
  })

  it('copyLabel 自定义文案覆盖默认"复制"', () => {
    render(
      <InfoRowPanel
        icon={<span>📷</span>}
        title="基础信息"
        rows={sampleRows}
        onCopy={vi.fn()}
        copyLabel="复制参数"
      />
    )
    expect(screen.getByText('复制参数')).toBeTruthy()
  })

  it('variant=dark 时使用 dark 主题类', () => {
    const { container } = render(
      <InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={sampleRows} variant="dark" />
    )
    expect(container.querySelector('.text-white\\/90')).toBeTruthy()
  })

  it('variant=light（默认）时不应用 dark 类', () => {
    const { container } = render(
      <InfoRowPanel icon={<span>📷</span>} title="基础信息" rows={sampleRows} variant="light" />
    )
    expect(container.querySelector('.text-white\\/90')).toBeNull()
  })

  it('未传 rows/groups 且非 loading/error 时显示 emptyText', () => {
    render(<InfoRowPanel icon={<span>📷</span>} title="基础信息" emptyText="空空如也" />)
    expect(screen.getByText('空空如也')).toBeTruthy()
  })

  it('rows 与 groups 同时传入时优先使用 groups', () => {
    render(
      <InfoRowPanel
        icon={<span>📷</span>}
        title="基础信息"
        rows={sampleRows}
        groups={sampleGroups}
      />
    )
    expect(screen.getByText('基础')).toBeTruthy()
    // rows 中的 '测试图片.jpg' 不应出现
    expect(screen.queryByText('测试图片.jpg')).toBeNull()
  })
})
