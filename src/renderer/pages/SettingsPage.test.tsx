// @vitest-environment jsdom
/**
 * SettingsPage 导航结构回归守卫（同步服务剥离带出的两项契约）。
 *
 * ① `sync` 分组已从 `SETTINGS_GROUPS` 整体移除，同步服务改由「同步图库」板块下的
 *    二级子页承载 → 设置页左导航不得再出现「同步」分组或「同步服务」节。
 *    这一条没有类型系统兜底：`SETTINGS_GROUPS` 是普通数组常量，漏删只是少一个分组，
 *    编译与既有测试都不会报，只能在这里锁。
 *
 * ② 旧用户残留：`activeSection` 持久化在 localStorage 的 `settings-active-section`，
 *    删除分组前保存在这里的 `'sync-service'` 在升级后依然会被读出来。
 *    `findSection()` 返回 undefined 后由 `|| SETTINGS_GROUPS[0].sections[0]` 兜底，
 *    必须验证「不崩 + 渲染默认节」，而不是指望那行兜底代码永远不被改坏。
 *
 * 运行：npx vitest run src/renderer/pages/SettingsPage.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { SettingsPage } from './SettingsPage'

const ACTIVE_SECTION_KEY = 'settings-active-section'

/**
 * `tests/setup.ts` 的 electronAPI 是「每次属性访问都返回一个新 vi.fn」的 Proxy，
 * 所以 `electronAPI.settings.get` 取到的是 undefined——默认节（GeneralStartupSection）
 * 的 `load()` 未被 await，会以 unhandled rejection 的形式炸掉整轮测试。
 * 这里显式装上 `settings.get/set` 的最小替身：被测对象是导航结构，不是那个开关的存取。
 */
beforeEach(() => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: {
      get: vi.fn(async (_key: string, fallback: unknown) => fallback),
      set: vi.fn(async () => undefined)
    },
    // 合并后的导航测试要点进「应用信息与联系方式」，而 AboutInfoSection 对
    // getVersion 的返回值直接 .then()（about-sections.tsx:26-33），缺它即在 mount
    // effect 抛 TypeError 崩掉整棵树——补上，否则红是崩出来的而不是断言出来的。
    app: { relaunch: vi.fn(), getVersion: vi.fn(async () => '2.5.5') },
    // 以下均为合并页内各块的 mount 依赖，逐一给最小替身，避免未定义即早退的分支
    dialog: { selectDirectory: vi.fn(async () => null), showMessageBox: vi.fn(async () => 1) },
    scanner: {
      start: vi.fn(async () => ({ success: true, filesFound: 0 })),
      onComplete: vi.fn(() => vi.fn()),
      detectGameRoots: vi.fn(async () => [])
    },
    importRoot: {
      list: vi.fn(async () => []),
      removeRoot: vi.fn(async () => ({ removed: false }))
    },
    cache: {
      getStats: vi.fn(async () => ({ totalSize: 0, fileCount: 0, limit: 0, cacheDir: '' }))
    },
    export: {
      setDefaultDir: vi.fn(async () => undefined),
      setNamingPattern: vi.fn(async () => undefined)
    },
    mediaAction: { analyzeSceneTime: vi.fn(async () => ({ success: true, analyzed: 0 })) }
  }
})

describe('SettingsPage 不再承载同步服务', () => {
  it('左导航既无「同步」分组标题，也无「同步服务」节', async () => {
    localStorage.removeItem(ACTIVE_SECTION_KEY)
    render(<SettingsPage />)
    // 先等默认节（启动行为）渲染出来，确认不是整页崩了导致的「查不到」
    await screen.findByRole('switch', { name: '启动时自动扫描' })

    expect(
      screen.queryByRole('button', { name: '同步服务' }),
      '「同步服务」节应已从 SETTINGS_GROUPS 移除'
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('同步服务'),
      '设置页任何位置都不得再出现「同步服务」文案'
    ).not.toBeInTheDocument()
    expect(screen.queryByText('同步')).not.toBeInTheDocument()
  })

  it("残留 activeSection='sync-service' 时回退到默认节，不崩不白屏", async () => {
    localStorage.setItem(ACTIVE_SECTION_KEY, 'sync-service')
    render(<SettingsPage />)
    await screen.findByRole('switch', { name: '启动时自动扫描' })
    expect(
      screen.getByRole('heading', { level: 2, name: '设置' }),
      '页头必须仍在（证明不是整树卸载）'
    ).toBeInTheDocument()
    localStorage.removeItem(ACTIVE_SECTION_KEY)
  })
})

/**
 * 设置导航合并后的结构契约（2026-10-16 轮次，见 docs/plans/2026-10-16-settings-nav-consolidation.md）。
 *
 * 钉三件事：
 * ① 二级侧边栏从 9 组 23 项收敛到 8 组 17 项——`SETTINGS_GROUPS` 是普通数组常量，
 *    漏删/多删任何一项都不会被类型系统或编译发现，只能在这里锁。
 * ② 被合并掉的旧项不得再作为**导航项**出现。注意「游戏目录」「缓存管理」等文案在合并后
 *    降级成了页内块标题（`SectionShell` 的 h3），因此必须按导航项 role 在 nav 内断言，
 *    不能用全文 queryByText——那会把仍然合法的块标题误判成残留。
 * ③ 旧用户 localStorage 里残留的节 id 必须迁移到合并后的新页，而不是被静默弹回默认节。
 *    迁移同时要让该项获得高亮，所以断言「内容区真的渲染了目标块」+「落盘的是新 id」两条。
 */
describe('合并后的导航结构', () => {
  /** 取左导航容器（aria-label 来自 settings.navigation.ariaLabel = 「设置导航」） */
  const getNav = () => screen.getByRole('navigation', { name: '设置导航' })

  it('二级侧边栏为 8 个分组、17 个导航项', async () => {
    localStorage.removeItem(ACTIVE_SECTION_KEY)
    render(<SettingsPage />)
    await screen.findByRole('switch', { name: '启动时自动扫描' })

    const nav = getNav()
    expect(within(nav).getAllByRole('button'), '合并后导航项应为 17 个（原 23 个）').toHaveLength(
      17
    )

    for (const group of [
      '通用',
      '外观',
      '扫描',
      '角色档案',
      '数据管理',
      '日志与诊断',
      '关于',
      '工具与插件'
    ]) {
      expect(within(nav).getByText(group), `分组「${group}」应存在`).toBeInTheDocument()
    }
    // 原 tools / plugins 两个分组并成一个，旧分组标题不得再出现
    expect(
      within(nav).queryByText('工具'),
      '「工具」应已并入「工具与插件」'
    ).not.toBeInTheDocument()
    expect(
      within(nav).queryByText('插件'),
      '「插件」应已并入「工具与插件」'
    ).not.toBeInTheDocument()
  })

  it('四个合并后的新页面出现在导航中', async () => {
    localStorage.removeItem(ACTIVE_SECTION_KEY)
    render(<SettingsPage />)
    await screen.findByRole('switch', { name: '启动时自动扫描' })

    const nav = getNav()
    for (const label of ['扫描目录', '主题与显示', '缓存与清理', '应用信息与联系方式']) {
      expect(
        within(nav).getByRole('button', { name: label }),
        `导航项「${label}」应存在`
      ).toBeInTheDocument()
    }
  })

  it('被合并掉的 10 个旧项不再作为导航项出现（但仍可作块标题）', async () => {
    localStorage.removeItem(ACTIVE_SECTION_KEY)
    render(<SettingsPage />)
    await screen.findByRole('switch', { name: '启动时自动扫描' })

    const nav = getNav()
    for (const label of [
      '主题',
      '字体与显示',
      '游戏目录',
      '检测到的游戏目录',
      '指定目录',
      '手动兜底扫描',
      '缓存管理',
      '清除数据',
      '应用信息',
      '联系方式'
    ]) {
      expect(
        within(nav).queryByRole('button', { name: label }),
        `「${label}」已降为块标题，不得再是导航项`
      ).not.toBeInTheDocument()
    }

    // 同屏的另一侧：合并进来的两个兄弟项必须仍在
    expect(within(nav).getByRole('button', { name: '插件管理' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: '分享码工具' })).toBeInTheDocument()
  })

  /** 旧 id → 合并后新 id，外加「渲染到目标页」的判别块标题 */
  const LEGACY_ALIASES: ReadonlyArray<readonly [string, string, string]> = [
    ['appearance-theme', 'appearance-theme-display', '主题'],
    ['appearance-display', 'appearance-theme-display', '字体与显示'],
    ['scan-paths', 'scan-directories', '游戏目录'],
    ['scan-game-roots', 'scan-directories', '检测到的游戏目录'],
    ['scan-import-roots', 'scan-directories', '指定目录'],
    ['scan-fallback', 'scan-directories', '手动兜底扫描'],
    ['data-cache', 'data-cache-clear', '缓存管理'],
    ['data-clear', 'data-cache-clear', '清除数据'],
    ['about-info', 'about-overview', '应用信息'],
    ['about-contact', 'about-overview', '联系方式']
  ]

  it.each(LEGACY_ALIASES)(
    '残留 activeSection=%s 迁移到 %s 并真正渲染出该页',
    async (legacyId, expectedId, blockTitle) => {
      localStorage.setItem(ACTIVE_SECTION_KEY, legacyId)
      render(<SettingsPage />)
      // 块标题是 SectionShell 的 h3，与导航按钮 role 天然区分，不受同名文案干扰
      await screen.findByRole('heading', { level: 3, name: blockTitle })
      // 迁移后必须把有效 id 回写，否则下次进来仍是脏 id、且导航无高亮
      await waitFor(() => expect(localStorage.getItem(ACTIVE_SECTION_KEY)).toBe(expectedId))
      localStorage.removeItem(ACTIVE_SECTION_KEY)
    }
  )

  it('无法识别的残留 id 仍回退默认节（既有契约不削弱）', async () => {
    localStorage.setItem(ACTIVE_SECTION_KEY, 'totally-unknown-id')
    render(<SettingsPage />)
    await screen.findByRole('switch', { name: '启动时自动扫描' })
    await waitFor(() => expect(localStorage.getItem(ACTIVE_SECTION_KEY)).toBe('general-startup'))
    localStorage.removeItem(ACTIVE_SECTION_KEY)
  })
})
