/**
 * @vitest-environment jsdom
 * @module src/renderer/components/layout/Sidebar
 * @coverage 侧边栏第 4 项（resonance-records）文案回归：
 *   nav.resonanceRecords 键曾整体缺失导致界面渲染原始 key 字符串，
 *   本测试在组件级锁定「第四项显示 共鸣录、不出现原始 key」。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from './Sidebar'

const { uiState, mediaState } = vi.hoisted(() => {
  const noop = () => {}
  return {
    uiState: {
      currentView: 'gallery',
      sidebarCollapsed: false,
      navigateTo: noop,
      toggleSidebar: noop,
      goBack: noop,
      viewStack: ['gallery'],
      groupDimension: 'none',
      setGroupDimension: noop
    },
    mediaState: {
      mediaFiles: [],
      categories: [],
      currentProfileUid: 'default',
      profiles: [],
      setMediaFiles: noop,
      setCurrentProfileUid: noop
    }
  }
})

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: typeof uiState) => unknown) => selector(uiState)
}))

vi.mock('../../stores/mediaStore', () => ({
  useMediaStore: (selector: (s: typeof mediaState) => unknown) => selector(mediaState),
  fetchMediaFromDatabase: vi.fn(async () => null),
  loadProfiles: vi.fn(async () => undefined)
}))

vi.mock('../../hooks/useFilteredMediaFiles', () => ({
  useFilteredMediaFiles: () => []
}))

vi.mock('../../utils/motionPresets', () => ({ springSoft: {} }))

describe('Sidebar 第 4 项 nav.resonanceRecords', () => {
  it('第四个导航项显示「共鸣录」，且界面不出现原始 key 文本', () => {
    render(<Sidebar />)
    const navButtons = Array.from(document.querySelectorAll('button.nav-item'))
    // 9 个导航项：图库/截图/收藏/共鸣录/缓存/分类/重复文件/回收站/设置
    expect(navButtons).toHaveLength(9)
    expect(navButtons[3].textContent).toBe('共鸣录')
    // 各项 title 与可见文本均取自 i18n，raw key 不得渲染
    expect(screen.getByTitle('共鸣录')).toBeTruthy()
    expect(screen.queryByText('nav.resonanceRecords')).toBeNull()
  })
})
