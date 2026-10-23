// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { toRuntimeGroup, SyncGalleryToolbar } from './SyncGalleryToolbar'

/**
 * 阶段 5 · A3：同步图库工具栏。
 * 纯函数 `toRuntimeGroup` 覆盖 8 个状态机取值，壳层只验「状态可见 + 两个动作可点」。
 *
 * 「同步服务」入口（同步服务从设置页剥离后落在这里）额外锁三条：
 *  - 未传 `onOpenService` 时不渲染入口（既有调用点与加载态分支不受影响）
 *  - 传了就能点并回调一次
 *  - **运行时未启动（runtimeState: null）时绝不禁用** —— 服务没起来才是用户最需要
 *    点进「同步服务」子页把它打开的时刻，禁用等于把唯一的入口藏起来
 */

function renderToolbar(
  props: Partial<{
    runtimeState:
      | 'unavailable'
      | 'idle'
      | 'starting'
      | 'running'
      | 'scanning'
      | 'degraded'
      | 'stopping'
      | 'error'
      | null
    scanning: boolean
    /** 显式开关：不打开就不给组件传 onOpenService（覆盖「未传不渲染」那条契约） */
    withServiceEntry: boolean
  }> = {}
): {
  onRefresh: Mock
  onScan: Mock
  onOpenService: Mock
} {
  const onRefresh = vi.fn()
  const onScan = vi.fn()
  const onOpenService = vi.fn()
  render(
    <SyncGalleryToolbar
      runtimeState={props.runtimeState === undefined ? null : props.runtimeState}
      onRefresh={onRefresh}
      onScan={onScan}
      scanning={props.scanning ?? false}
      {...(props.withServiceEntry ? { onOpenService } : {})}
    />
  )
  return { onRefresh, onScan, onOpenService }
}

/**
 * 「关于 NikkiSync」入口的外链桩：手法同 `SyncGalleryPage.test.tsx` 的 setBridge/clearBridge。
 * 必须显式覆写——`tests/setup.ts` 的占位桩是单层 Proxy（get 返回新 vi.fn），
 * `electronAPI.shell.openExternal` 取到的是 undefined，可选链会静默短路成 0 次调用，
 * 用它断言只会得到假绿。
 */
function setShellBridge(openExternal: ReturnType<typeof vi.fn>): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { shell: { openExternal } }
}

function clearBridge(): void {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = undefined
}

afterEach(() => {
  clearBridge()
})

describe('toRuntimeGroup', () => {
  it('ready 档收 running / scanning / starting', () => {
    expect(toRuntimeGroup('running')).toBe('ready')
    expect(toRuntimeGroup('scanning')).toBe('ready')
    expect(toRuntimeGroup('starting')).toBe('ready')
  })

  it('degraded 档收 degraded / error', () => {
    expect(toRuntimeGroup('degraded')).toBe('degraded')
    expect(toRuntimeGroup('error')).toBe('degraded')
  })

  it('off 档收 unavailable / idle / stopping / null', () => {
    expect(toRuntimeGroup('unavailable')).toBe('off')
    expect(toRuntimeGroup('idle')).toBe('off')
    expect(toRuntimeGroup('stopping')).toBe('off')
    expect(toRuntimeGroup(null)).toBe('off')
  })
})

describe('SyncGalleryToolbar', () => {
  it('状态徽标带 data-runtime-state，便于自动化与排查', () => {
    renderToolbar({ runtimeState: 'degraded' })
    const badge = document.querySelector('[data-runtime-state]')
    expect(badge?.getAttribute('data-runtime-state')).toBe('degraded')
    expect(badge?.textContent).toBe('未找到游戏目录')
  })

  it('点击刷新/扫描分别回调对应动作', () => {
    const { onRefresh, onScan } = renderToolbar({ runtimeState: 'running' })
    fireEvent.click(screen.getByTitle('刷新'))
    fireEvent.click(screen.getByTitle('扫描游戏相册'))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledTimes(1)
  })

  it('扫描进行中按钮进入 loading（禁用重复触发）', () => {
    const { onScan } = renderToolbar({ runtimeState: 'running', scanning: true })
    const button = screen.getByTitle('扫描游戏相册') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onScan).not.toHaveBeenCalled()
  })

  it('未传 onOpenService 时不渲染「同步服务」入口（既有调用点向后兼容）', () => {
    renderToolbar({ runtimeState: 'running' })
    expect(screen.queryByTitle('同步服务')).not.toBeInTheDocument()
  })

  it('传入 onOpenService 后入口可点并回调一次', () => {
    const { onOpenService } = renderToolbar({ runtimeState: 'running', withServiceEntry: true })
    fireEvent.click(screen.getByTitle('同步服务'))
    expect(onOpenService).toHaveBeenCalledTimes(1)
  })

  it('运行时未启动（runtimeState: null）时入口不得禁用——服务没起来才最需要点进去', () => {
    const { onOpenService } = renderToolbar({ runtimeState: null, withServiceEntry: true })
    const entry = screen.getByTitle('同步服务') as HTMLButtonElement
    expect(entry.disabled).toBe(false)
    fireEvent.click(entry)
    expect(onOpenService).toHaveBeenCalledTimes(1)
  })

  it('渲染出「关于 NikkiSync」入口', () => {
    renderToolbar({ runtimeState: 'running' })
    expect(screen.getByTitle('关于 NikkiSync')).toBeInTheDocument()
  })

  it('点击后经 shell.openExternal 打开 NikkiSync 上游引擎仓库', () => {
    const openExternal = vi.fn()
    setShellBridge(openExternal)
    renderToolbar({ runtimeState: 'running' })
    fireEvent.click(screen.getByTitle('关于 NikkiSync'))
    expect(openExternal).toHaveBeenCalledTimes(1)
    // URL 逐字锁定：本应用仓库（QianQianLuLu1/MeowStarMap，阶段 7 起随远端改名）与上游引擎仓库是两个 repo，混了就跳错地方
    expect(openExternal).toHaveBeenCalledWith('https://github.com/ToStardust/NikkiSync')
  })

  it('桥缺失时点击「关于 NikkiSync」不抛错（非授信 origin 下 preload 一个全局都不暴露）', async () => {
    clearBridge()
    // React 19 把事件处理器里的同步异常交回 jsdom 异步上报，`fireEvent.click` 抓不到，
    // 故 `expect(() => fireEvent.click(…)).not.toThrow()` 恒为真（假绿）。实测 window 的
    // 'error' 监听器能接住该异常，改用它作观测通道。
    const errors: Event[] = []
    const onError = (e: Event): void => {
      errors.push(e)
    }
    window.addEventListener('error', onError)
    try {
      renderToolbar({ runtimeState: 'running' })
      fireEvent.click(screen.getByTitle('关于 NikkiSync'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      window.removeEventListener('error', onError)
    }
    expect(errors).toHaveLength(0)
  })
})
