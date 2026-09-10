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

/** 最近一次成功登记标记的元素（G3）。独立于 markedSources，供关闭路径 O(1) 复用 */
let lastMarkedSource: HTMLElement | null = null

function resetName(el: HTMLElement): void {
  try {
    el.style.viewTransitionName = ''
  } catch {
    // style 只读 / 元素异常等场景下静默，清理失败不得阻断全屏开关
  }
}

/**
 * 读取系统「减弱动画」偏好（prefers-reduced-motion: reduce）。
 *
 * 与 `html.reduce-motion` 手动开关互补：后者只覆盖应用内设置（App.tsx 读
 * display.reduceMotion），系统级「显示动画关闭」（Windows 辅助功能 / macOS
 * Reduce Motion）只能从媒体查询拿到。且 `::view-transition-*` 伪元素动画
 * 不受 globals.css 的 `@media (prefers-reduced-motion: reduce)` 规则约束
 * （选择器不匹配伪元素），必须在 JS 侧判定后直接不启动 View Transitions。
 *
 * matchMedia 缺失（SSR / node 测试环境）或抛错时视为「未减弱」，不阻断全屏开关。
 */
function prefersReducedMotion(doc: Document): boolean {
  try {
    const mq =
      typeof doc.defaultView?.matchMedia === 'function'
        ? doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)')
        : null
    return mq?.matches === true
  } catch {
    return false
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
  // G1：系统级动效减弱同样走降级路径（无动画直接开关）
  if (prefersReducedMotion(target)) return false
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
    // G3：同步记忆最近一次有效登记，供关闭路径 O(1) 复用
    lastMarkedSource = target
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

/**
 * 当前进行中的 View Transition 的「结束」Promise（G2）。
 *
 * 原图换源必须等它落定：若只等 decode()，冷加载的 4K 图可能在 ~220ms
 * 共享元素动画窗口内完成解码并触发换源重绘，直接吃掉动画帧。
 * 未注册任何过渡（降级路径 / 直接 setState 的测试路径）时为 null，
 * 此时换源不受过渡约束，行为与 Phase 1 之前完全一致。
 */
let activeTransitionFinished: Promise<void> | null = null
const SETTLED_PROMISE: Promise<void> = Promise.resolve()

/**
 * 注册当前进行中的 View Transition；传 null 清空。
 *
 * @param transition 含 `finished` Promise 的过渡对象；null/undefined 或缺少
 *   可用的 `finished` 时清空注册表。内部统一吸收 finished 的拒绝，
 *   保证 skipTransition / DOM 异常不产生未处理 Promise 拒绝
 */
export function setActiveTransition(transition: { finished: Promise<void> } | null): void {
  const finished = transition?.finished
  if (!finished || typeof finished.then !== 'function') {
    activeTransitionFinished = null
    return
  }
  activeTransitionFinished = finished.catch(() => undefined)
}

/** 取得「当前过渡已结束」的 Promise；无活动过渡时返回已 resolve 的 Promise */
export function whenTransitionSettled(): Promise<void> {
  return activeTransitionFinished ?? SETTLED_PROMISE
}

/**
 * 取得最近登记过且仍连接在文档中的源元素（G3）。
 *
 * 关闭全屏时需要知道「缩到哪张卡片」：打开路径已经把被点击卡片的 img 登记过，
 * 按引用复用即可把原先关闭前的全文档 `querySelector('img[data-media-id=…]')`
 * 属性选择器遍历降为 O(1)——该遍历发生在旧快照拍摄的临界窗口内。
 * 元素已被虚拟列表回收（isConnected === false）时返回 null，由调用方回落查询。
 */
export function getLastFullscreenSource(): HTMLElement | null {
  try {
    return lastMarkedSource?.isConnected ? lastMarkedSource : null
  } catch {
    return null
  }
}

/** 释放记忆的源元素引用（幂等），避免长期持有已卸载节点 */
export function releaseFullscreenSource(): void {
  lastMarkedSource = null
}
