import { useEffect } from 'react'
import { luminanceToTone, parseRgbLuminance, progressFromScroll } from '../utils/liquidGlass'

/**
 * 液态玻璃全局信号 hook（AppShell 挂载一次，服务 Sidebar / TitleBar / StatusBar）：
 *
 * 1. 滚动联动：capture 阶段被动监听 document 上的 scroll（页内滚动容器的
 *    scroll 事件不冒泡、但 capture 可拦截），rAF 合帧后把 [0,1] 进度写入
 *    html 根的 `--glass-scroll-progress`，供三处玻璃件的边缘高光消费。
 * 2. 亮度档位：用隐藏探针元素读取 `--bg-secondary`（玻璃底色）的计算色，
 *    判定明/暗基调写入 `data-glass-tone`；html class 变化（主题/玻璃档位
 *    切换）时经 MutationObserver 重算。
 *
 *技法来源：滚动进度→CSS 变量与混合模式自适应均为社区成熟方案
 *（MDN mix-blend-mode / kube.io liquid glass），非自创轮子。
 */

const SCROLL_PROGRESS_VAR = '--glass-scroll-progress'
const SCROLL_IGNORE_ATTR = 'data-glass-scroll-ignore'

/** 每个 Document 复用单个隐藏探针，避免重复插 DOM */
const toneProbes = new WeakMap<Document, HTMLDivElement>()

function computeTone(doc: Document): 'light' | 'dim' | null {
  let probe = toneProbes.get(doc)
  if (!probe) {
    probe = doc.createElement('div')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText =
      'position:fixed;top:-9999px;left:-9999px;visibility:hidden;pointer-events:none;'
    doc.documentElement.appendChild(probe)
    toneProbes.set(doc, probe)
  }
  probe.style.backgroundColor = 'var(--bg-secondary)'
  const computed = doc.defaultView?.getComputedStyle(probe).backgroundColor
  if (!computed) return null
  const luminance = parseRgbLuminance(computed)
  return luminance === null ? null : luminanceToTone(luminance)
}

export function useGlassScrollSignal(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const doc = document
    const root = doc.documentElement
    const view = doc.defaultView

    let rafId: number | null = null
    let pendingProgress: number | null = null

    const flush = () => {
      rafId = null
      if (pendingProgress === null) return
      root.style.setProperty(SCROLL_PROGRESS_VAR, pendingProgress.toFixed(4))
      pendingProgress = null
    }

    const schedule = () => {
      if (rafId !== null) return
      if (typeof view?.requestAnimationFrame === 'function') {
        rafId = view.requestAnimationFrame(flush)
      } else {
        flush()
      }
    }

    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(`[${SCROLL_IGNORE_ATTR}]`)) return
      pendingProgress = progressFromScroll(
        target.scrollTop,
        target.scrollHeight,
        target.clientHeight
      )
      schedule()
    }

    const applyTone = () => {
      const tone = computeTone(doc)
      if (tone) root.setAttribute('data-glass-tone', tone)
    }

    doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
    applyTone()
    // 主题类 / 玻璃档位类均挂在 html 上，class 变化即重算基调
    const observer = new MutationObserver(applyTone)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => {
      doc.removeEventListener('scroll', onScroll, { capture: true })
      observer.disconnect()
      if (rafId !== null && view && typeof view.cancelAnimationFrame === 'function') {
        view.cancelAnimationFrame(rafId)
        rafId = null
      }
      pendingProgress = null
    }
  }, [])
}
