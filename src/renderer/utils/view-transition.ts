/**
 * 全屏预览共享元素过渡（View Transitions API）的能力判定与标记生命周期管理。
 *
 * 存在理由（根因 RC3）：`openFullscreen` / `closeFullscreen` 原先在 View Transitions
 * 回调里用 `document.querySelectorAll('[style*="view-transition-name"]')` 做全文档属性
 * 子串扫描来清理标记，并逐个写内联样式。该开销发生在新快照拍摄之前，且每次写样式都会
 * 使样式失效，是可在动画起点直接观测到的同步卡顿。本模块改为「登记已知元素引用 →
 * 按引用 O(1) 清理」，把快照前的 DOM 成本从 O(全文档节点数) 降为 O(1)。
 *
 * 同时把原先散在 `GalleryPage`（存在性判定）、`uiStore.openFullscreen`、
 * `uiStore.closeFullscreen` 三处的重复判定收敛为 `canUseViewTransition()`，便于单测覆盖。
 */

/** 全屏共享元素使用的 view-transition-name（与 CSS 侧 keep 一致，勿改） */
export const FULLSCREEN_VT_NAME = 'fullscreen-media'

/** 当前持有标记的候选元素。同一时刻至多一个，切换时旧引用被自动清理 */
const markedSources = new Set<HTMLElement>()

function resetName(el: HTMLElement): void {
  try {
    el.style.viewTransitionName = ''
  } catch {
    // style 只读 / 元素异常等场景下静默，清理失败不得阻断全屏开关
  }
}

/**
 * 判定当前环境能否使用共享元素过渡。
 *
 * @param doc 待测 document；省略时取全局 `document`，全局缺失则视为不可用
 * @returns 支持 `startViewTransition` 且未开启动效减弱时为 true
 */
export function canUseViewTransition(doc?: Document | null): boolean {
  // 显式传 null 表示「无 document」而非「取默认」：用 === undefined 区分，
  // 否则 `null ?? fallback` 会误把 null 当作缺省而回落到全局 document
  const target = doc === undefined ? (typeof document === 'undefined' ? null : document) : doc
  if (!target) return false
  if (target.documentElement?.classList.contains('reduce-motion')) return false
  return (
    typeof (target as Document & { startViewTransition?: unknown }).startViewTransition ===
    'function'
  )
}

/**
 * 登记参与共享元素过渡的源/目标元素（写入 view-transition-name）。
 *
 * @param el 目标元素；null / undefined 时空操作。重复调用会先清理旧登记项
 */
export function markFullscreenSource(el: Element | null | undefined): void {
  if (!el) return
  clearFullscreenSource()
  try {
    const target = el as HTMLElement
    target.style.viewTransitionName = FULLSCREEN_VT_NAME
    markedSources.add(target)
  } catch {
    // 写入失败不登记，后续无过渡但不影响全屏开关
  }
}

/** 清理已登记元素上的 view-transition-name（仅按引用清理，不扫全文档） */
export function clearFullscreenSource(): void {
  if (markedSources.size === 0) return
  markedSources.forEach((el) => resetName(el))
  markedSources.clear()
}
