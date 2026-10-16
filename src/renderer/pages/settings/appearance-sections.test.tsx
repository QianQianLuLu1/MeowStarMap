/**
 * @vitest-environment jsdom
 *
 * appearance-sections.tsx 的域内回归（文件名刻意与源文件同 base，
 * 让 scripts/find-related-tests.ts 能把 npm run verify / .husky/pre-commit
 * 自动绑到这个文件上——此前 appearance-sections.tsx 完全没有匹配套件）。
 *
 * 钉三件事：
 *  (a) 主题描述文案在同一屏只渲染一次（合并前 settings.theme.desc 被画了两遍：
 *      一次作 SectionShell 的 description，一次作独立 <p>）。
 *  (b) 字号 / 玻璃效果两处手写档位磁贴统一接入设计系统的 SegmentedControl，
 *      语义从 role=button 升级为 role=radiogroup + role=radio（方向键可切换）。
 *  (c) 氛围层两个开关对「轻度增强」档的禁用联动不得因换控件而丢——
 *      这条链断了 html.glass-lite 的降级就会静默失效。
 *
 * 运行：npx vitest run src/renderer/pages/settings/appearance-sections.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import {
  AppearanceThemeSection,
  AppearanceDisplaySection,
  AppearanceThemeDisplaySection
} from './appearance-sections'
import { GlobalToastContext } from './shared'

const mockShowMessage = vi.fn()

let settingsGet: Mock
let settingsSet: Mock
let store: Record<string, unknown>

function installElectronApi(persisted: Record<string, unknown> = {}) {
  store = { ...persisted }
  settingsGet = vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(store[key] !== undefined ? store[key] : fallback)
  )
  settingsSet = vi.fn((key: string, value: unknown) => {
    store[key] = value
    return Promise.resolve()
  })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: { get: settingsGet, set: settingsSet },
    uiTheme: { set: vi.fn(async () => undefined) }
  }
}

const renderWithToast = (ui: React.ReactElement) =>
  render(<GlobalToastContext.Provider value={mockShowMessage}>{ui}</GlobalToastContext.Provider>)

const htmlClasses = () => document.documentElement.className

beforeEach(() => {
  installElectronApi()
  mockShowMessage.mockClear()
  document.documentElement.className = ''
})

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.className = ''
})

describe('AppearanceThemeSection — 描述文案不重复', () => {
  it('settings.theme.desc 在本节只渲染一次', async () => {
    renderWithToast(<AppearanceThemeSection />)
    const desc = '切换后实时生效，主题偏好会自动保存到本地配置。'
    await waitFor(() => expect(screen.getByText('界面主题')).toBeInTheDocument())
    // 合并前这里是 2：SectionShell description 一次 + 独立 <p> 一次
    expect(screen.getAllByText(desc)).toHaveLength(1)
  })
})

describe('AppearanceDisplaySection — 档位控件统一接入 SegmentedControl', () => {
  it('字号与玻璃效果各是一个 radiogroup，且不再残留手写的 button 档位', async () => {
    renderWithToast(<AppearanceDisplaySection />)
    await waitFor(() => expect(screen.getByText('字号大小')).toBeInTheDocument())

    expect(screen.getByRole('radiogroup', { name: '字号大小' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: '玻璃效果' })).toBeInTheDocument()

    // 手写磁贴时代它们是 role=button；换成 SegmentedControl 后必须消失
    expect(screen.queryByRole('button', { name: '特大' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '轻度增强' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('radio', { name: '轻度增强' })).toHaveLength(1)
  })

  it('点 radio「轻度增强」：写设置 + 挂 glass-lite 类 + 氛围开关转为禁用', async () => {
    renderWithToast(<AppearanceDisplaySection />)
    await waitFor(() => expect(screen.getByText('玻璃效果')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('radio', { name: '轻度增强' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('display.glassEffect', 'lite'))
    expect(htmlClasses()).toContain('glass-lite')
    // 降级链：lite 档下颗粒纹理 / 漂浮几何体整层隐藏，开关必须置灰
    await waitFor(() => expect(screen.getByRole('switch', { name: '颗粒纹理' })).toBeDisabled())
    expect(screen.getByRole('switch', { name: '漂浮几何体' })).toBeDisabled()
  })

  it('从 lite 切回「明显流动感」：摘类且氛围开关恢复可用', async () => {
    installElectronApi({ 'display.glassEffect': 'lite' })
    renderWithToast(<AppearanceDisplaySection />)
    await waitFor(() => expect(htmlClasses()).toContain('glass-lite'))
    await waitFor(() => expect(screen.getByRole('switch', { name: '颗粒纹理' })).toBeDisabled())

    fireEvent.click(screen.getByRole('radio', { name: '明显流动感' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('display.glassEffect', 'rich'))
    expect(htmlClasses()).not.toContain('glass-lite')
    await waitFor(() => expect(screen.getByRole('switch', { name: '颗粒纹理' })).toBeEnabled())
    expect(screen.getByRole('switch', { name: '漂浮几何体' })).toBeEnabled()
  })

  it('选字号档位「大」写设置并挂 font-size-large 类', async () => {
    renderWithToast(<AppearanceDisplaySection />)
    await waitFor(() =>
      expect(screen.getByRole('radiogroup', { name: '字号大小' })).toBeInTheDocument()
    )

    fireEvent.click(screen.getByRole('radio', { name: '大' }))

    await waitFor(() => expect(settingsSet).toHaveBeenCalledWith('display.fontSize', 'large'))
    expect(htmlClasses()).toContain('font-size-large')
  })
})

describe('AppearanceThemeDisplaySection — 合并页', () => {
  it('主题块与显示块同屏，两个块标题都在', async () => {
    renderWithToast(<AppearanceThemeDisplaySection />)
    await waitFor(() => expect(screen.getByText('界面主题')).toBeInTheDocument())
    expect(screen.getByRole('heading', { level: 3, name: '主题' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: '字体与显示' })).toBeInTheDocument()
    // 整页只应出现一次主题描述文案，跨块也不重复
    expect(screen.getAllByText('切换后实时生效，主题偏好会自动保存到本地配置。')).toHaveLength(1)
  })
})
