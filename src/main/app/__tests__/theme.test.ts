/**
 * @layer L1
 * @module src/main/app/theme
 * @coverage applyUITheme / setupThemeListener
 * @dependencies electron (nativeTheme)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeAppCtx } from '../../ipc/handlers/_test-helpers'

// nativeTheme mock：含 themeSource setter、shouldUseDarkColors getter、on 方法
const { nativeThemeMock } = vi.hoisted(() => {
  let _shouldUseDarkColors = false
  const listeners: Record<string, Array<() => void>> = {}
  return {
    nativeThemeMock: {
      _setShouldUseDarkColors(v: boolean): void {
        _shouldUseDarkColors = v
      },
      _emit(event: string): void {
        for (const fn of listeners[event] ?? []) fn()
      },
      _reset(): void {
        for (const k of Object.keys(listeners)) delete listeners[k]
        _shouldUseDarkColors = false
        nativeThemeMock.themeSource = 'system'
      },
      get shouldUseDarkColors(): boolean {
        return _shouldUseDarkColors
      },
      themeSource: 'system' as 'system' | 'light' | 'dark',
      on(event: string, fn: () => void): void {
        ;(listeners[event] ??= []).push(fn)
      },
      off(_event: string, _fn: () => void): void {
        /* no-op for tests */
      }
    }
  }
})

vi.mock('electron', () => ({
  nativeTheme: nativeThemeMock
}))

import { applyUITheme, setupThemeListener } from '../theme'

describe('theme.ts', () => {
  beforeEach(() => {
    nativeThemeMock._reset()
  })

  describe('applyUITheme', () => {
    it('1. applyUITheme(ctx, "default") 持久化 uiTheme=default', () => {
      const ctx = makeAppCtx()
      applyUITheme(ctx, 'default')
      expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('uiTheme', 'default')
    })

    it('2. applyUITheme(ctx, "soft-pink-luxury") 持久化 uiTheme=soft-pink-luxury', () => {
      const ctx = makeAppCtx()
      applyUITheme(ctx, 'soft-pink-luxury')
      expect(ctx.dbManager.setSetting).toHaveBeenCalledWith('uiTheme', 'soft-pink-luxury')
    })

    it('3. 当前所有主题均为浅色，nativeTheme.themeSource 被设为 "light"', () => {
      const ctx = makeAppCtx()
      applyUITheme(ctx, 'default')
      expect(nativeThemeMock.themeSource).toBe('light')
      applyUITheme(ctx, 'soft-pink-luxury')
      expect(nativeThemeMock.themeSource).toBe('light')
    })

    it('4. mainWindow 存在且未销毁时调用 setTitleBarOverlay（symbolColor 为 #1A1A1A 浅色）', () => {
      const setTitleBarOverlay = vi.fn()
      const setBackgroundColor = vi.fn()
      const mainWindow = {
        isDestroyed: vi.fn(() => false),
        setTitleBarOverlay,
        setBackgroundColor
      }
      const ctx = makeAppCtx({ mainWindow })
      applyUITheme(ctx, 'default')
      expect(setTitleBarOverlay).toHaveBeenCalledTimes(1)
      expect(setTitleBarOverlay).toHaveBeenCalledWith(
        expect.objectContaining({ symbolColor: '#1A1A1A' })
      )
    })

    it('5. mainWindow 为 null 时跳过标题栏更新', () => {
      const ctx = makeAppCtx({ mainWindow: null })
      expect(() => applyUITheme(ctx, 'default')).not.toThrow()
      // 无 setTitleBarOverlay 可断言，仅验证不抛错
    })

    it('6. mainWindow.isDestroyed() 返回 true 时跳过', () => {
      const setTitleBarOverlay = vi.fn()
      const setBackgroundColor = vi.fn()
      const mainWindow = {
        isDestroyed: vi.fn(() => true),
        setTitleBarOverlay,
        setBackgroundColor
      }
      const ctx = makeAppCtx({ mainWindow })
      applyUITheme(ctx, 'default')
      expect(setTitleBarOverlay).not.toHaveBeenCalled()
      expect(setBackgroundColor).not.toHaveBeenCalled()
    })

    it('7. default 主题背景色 #F5F5F5，soft-pink-luxury 为 #fdf9fb', () => {
      const setBackgroundColorDefault = vi.fn()
      const win1 = {
        isDestroyed: vi.fn(() => false),
        setTitleBarOverlay: vi.fn(),
        setBackgroundColor: setBackgroundColorDefault
      }
      const ctx1 = makeAppCtx({ mainWindow: win1 })
      applyUITheme(ctx1, 'default')
      expect(setBackgroundColorDefault).toHaveBeenCalledWith('#F5F5F5')

      const setBackgroundColorPink = vi.fn()
      const win2 = {
        isDestroyed: vi.fn(() => false),
        setTitleBarOverlay: vi.fn(),
        setBackgroundColor: setBackgroundColorPink
      }
      const ctx2 = makeAppCtx({ mainWindow: win2 })
      applyUITheme(ctx2, 'soft-pink-luxury')
      expect(setBackgroundColorPink).toHaveBeenCalledWith('#fdf9fb')
    })

    it('8. 未知主题回退到 #F5F5F5', () => {
      const setBackgroundColor = vi.fn()
      const mainWindow = {
        isDestroyed: vi.fn(() => false),
        setTitleBarOverlay: vi.fn(),
        setBackgroundColor
      }
      const ctx = makeAppCtx({ mainWindow })
      // 强制类型转换传入未知主题（绕过 TS 类型检查模拟运行时容错）
      ;(applyUITheme as (c: unknown, t: string) => void)(ctx, 'unknown-theme')
      expect(setBackgroundColor).toHaveBeenCalledWith('#F5F5F5')
    })
  })

  describe('setupThemeListener', () => {
    it('9. setupThemeListener 注册 nativeTheme.on("updated", ...)', () => {
      const ctx = makeAppCtx()
      setupThemeListener(ctx)
      // 验证 on 被调用，第一参数为 'updated'
      // nativeThemeMock.on 是普通函数，通过触发事件验证注册成功
      const send = vi.fn()
      const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
      ctx.setMainWindow(win)
      nativeThemeMock._emit('updated')
      // send 被调用即证明 'updated' 监听器已注册
      expect(send).toHaveBeenCalled()
    })

    it('10. updated 事件触发时向渲染层广播 theme:changed 含 shouldUseDarkColors', () => {
      const send = vi.fn()
      const mainWindow = {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send }
      }
      const ctx = makeAppCtx({ mainWindow })
      setupThemeListener(ctx)

      nativeThemeMock._setShouldUseDarkColors(true)
      nativeThemeMock._emit('updated')
      expect(send).toHaveBeenCalledWith('theme:changed', { shouldUseDarkColors: true })

      nativeThemeMock._setShouldUseDarkColors(false)
      nativeThemeMock._emit('updated')
      expect(send).toHaveBeenLastCalledWith('theme:changed', { shouldUseDarkColors: false })
    })
  })
})
