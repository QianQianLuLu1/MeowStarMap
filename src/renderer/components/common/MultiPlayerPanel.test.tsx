/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { MediaFile } from '../../stores/mediaStore'
import type { GameParamsData } from '../../types/decryption'

/** InfoRowPanel mock 的 props 子集（仅覆盖本测试断言用到的字段） */
interface MockInfoRowPanelProps {
  title?: string
  rows?: { label: string; value: string }[]
}

vi.mock('./InfoRowPanel', () => ({
  InfoRowPanel: (props: MockInfoRowPanelProps) => (
    <div data-testid="info-row-panel" data-title={props.title}>
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
  getPoseName: (id: number) => (id === 7 ? 'enums.poseId.7' : null)
}))

vi.mock('../../icons', () => ({
  IconInfo: (p: ComponentProps<'svg'>) => <svg data-testid="icon-info" {...p} />
}))

// i18n mock：返回 detail.multiPlayer 命名空间的中文值，保证组件渲染与 formatMultiPlayerForCopy 输出一致
const mockT = (key: string): string => {
  const map: Record<string, string> = {
    'detail.multiPlayer.title': '联机信息',
    'detail.multiPlayer.anotherPose': '另一位玩家的动作',
    'detail.multiPlayer.poseTime': '进度',
    'detail.multiPlayer.copyHeader': '=== 联机信息 ===',
    'enums.poseId.7': '测试动作'
  }
  return map[key] ?? key
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'zh-CN' } })
}))

// 渲染用例一律经 gameParams 注入，内部 hook 仅需返回空态；
// 审查修复（2026-11-11）：hoisted spy 钉住「注入时内部 hook 必须禁用」，防重复解密。
const { useGameParamsSpy } = vi.hoisted(() => ({
  useGameParamsSpy: vi.fn((..._args: unknown[]) => ({ data: null, loading: false, error: null }))
}))
vi.mock('../../hooks/useGameParams', () => ({
  useGameParams: (...args: unknown[]) => useGameParamsSpy(...args)
}))

import { MultiPlayerPanel, formatMultiPlayerForCopy } from './MultiPlayerPanel'

const makeFile = (over: Partial<MediaFile> = {}): MediaFile =>
  ({
    file_path: '/x.jpg',
    file_type: 'image',
    album_type: 'NikkiPhotos_HighQuality',
    account_uid: 'acc-1',
    ...over
  }) as unknown as MediaFile

const makeParams = (multiPlayer: GameParamsData['multiPlayer']): GameParamsData => ({
  hasParams: true,
  multiPlayer
})

describe('MultiPlayerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gameParams 无 multiPlayer 字段（旧数据）时整体隐藏', () => {
    const { container } = render(
      <MultiPlayerPanel file={makeFile()} gameParams={makeParams(undefined)} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('multiPlayer=null（单人照）时整体隐藏', () => {
    const { container } = render(
      <MultiPlayerPanel file={makeFile()} gameParams={makeParams(null)} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('全字段：渲染标题、动作行与进度行', () => {
    render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: 123, posePlayingPercent: 0.456 })}
      />
    )
    expect(screen.getByTestId('info-row-panel').getAttribute('data-title')).toBe('联机信息')
    expect(screen.getByText('另一位玩家的动作')).toBeTruthy()
    // POSE_ID_MAP 未命中时回退原始 ID（上游同款行为）
    expect(screen.getByText('#123')).toBeTruthy()
    expect(screen.getByText('进度')).toBeTruthy()
    // 上游公式：(p * 100).ceil() → 45.6 → 46
    expect(screen.getByText('46 %')).toBeTruthy()
  })

  it('poseId 命中映射时显示动作名称', () => {
    render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: 7, posePlayingPercent: null })}
      />
    )
    expect(screen.getByText('测试动作')).toBeTruthy()
    // 进度无值时不渲染进度行
    expect(screen.queryByText('进度')).toBeNull()
  })

  it('poseId 与进度皆无值（空串语义 → null）时整体隐藏，不出现 null/undefined 字样', () => {
    const { container } = render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: null, posePlayingPercent: null })}
      />
    )
    expect(container.firstChild).toBeNull()
    expect(container.textContent).not.toContain('null')
    expect(container.textContent).not.toContain('undefined')
  })

  it('poseId 无值但进度有值时仅渲染进度行', () => {
    render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: null, posePlayingPercent: 0.5 })}
      />
    )
    expect(screen.queryByText('另一位玩家的动作')).toBeNull()
    expect(screen.getByText('进度')).toBeTruthy()
    expect(screen.getByText('50 %')).toBeTruthy()
  })

  it('进度为 0（真实零值）时显示"0 %"', () => {
    render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: 9, posePlayingPercent: 0 })}
      />
    )
    expect(screen.getByText('0 %')).toBeTruthy()
  })

  it('file_type 非 image 时返回 null', () => {
    const { container } = render(
      <MultiPlayerPanel
        file={makeFile({ file_type: 'video' })}
        gameParams={makeParams({ roleId: 1, poseId: 7, posePlayingPercent: 0.5 })}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})

describe('formatMultiPlayerForCopy', () => {
  it('multiPlayer 为 null/undefined 时返回空字符串', () => {
    expect(formatMultiPlayerForCopy(null)).toBe('')
    expect(formatMultiPlayerForCopy(undefined)).toBe('')
  })

  it('全字段时返回格式化文本', () => {
    const text = formatMultiPlayerForCopy(
      { roleId: 1, poseId: 123, posePlayingPercent: 0.456 },
      mockT
    )
    expect(text).toContain('=== 联机信息 ===')
    expect(text).toContain('另一位玩家的动作: #123')
    expect(text).toContain('进度: 46 %')
  })

  it('动作行与进度行各自按有无值输出', () => {
    const text = formatMultiPlayerForCopy(
      { roleId: 1, poseId: null, posePlayingPercent: 0.25 },
      mockT
    )
    expect(text).not.toContain('另一位玩家的动作')
    expect(text).toContain('进度: 25 %')
  })
})

// 审查修复（2026-11-11）：注入数据时禁用内部解密 hook（防重复 decodeFile），
// 并真实消费 PropertiesDialog 传入的 loading/error props。
describe('MultiPlayerPanel — 注入与加载态（审查修复）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('注入 gameParams 时内部 useGameParams 必须禁用（enabled=false）', () => {
    render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: 7, posePlayingPercent: null })}
      />
    )
    expect(useGameParamsSpy).toHaveBeenCalled()
    expect(useGameParamsSpy.mock.calls[0]![3]).toBe(false)
  })

  it('未注入时内部 hook 保持启用（游戏图片）', () => {
    render(<MultiPlayerPanel file={makeFile()} />)
    expect(useGameParamsSpy.mock.calls[0]![3]).toBe(true)
  })

  it('loading=true（共享解密在途）→ 整体隐藏，不渲染陈旧行', () => {
    const { container } = render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: 7, posePlayingPercent: null })}
        loading={true}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('error 非空（共享解密失败）→ 整体隐藏', () => {
    const { container } = render(
      <MultiPlayerPanel
        file={makeFile()}
        gameParams={makeParams({ roleId: 1, poseId: 7, posePlayingPercent: null })}
        error="decrypt failed"
      />
    )
    expect(container.firstChild).toBeNull()
  })
})
